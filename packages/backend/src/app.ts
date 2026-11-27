// The backend put together: one SQLite file, /sources and /memory, and the HTTP servers (docs/pod.md).
import { mkdirSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { GatedAssertion, TokenReview, type SenderCheck } from "@penelope/service-account-auth";

import { a2aHandler } from "./a2a/endpoint.ts";
import { Inbox } from "./a2a/inbox.ts";
import { Senders } from "./a2a/senders.ts";
import { SubAgents } from "./agents.ts";
import { Assets } from "./assets.ts";
import { AgentAvatar, seedAvatar } from "./avatar.ts";
import type { Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { openDatabase } from "./db.ts";
import { Feed } from "./feed.ts";
import { Heartbeat } from "./heartbeat.ts";
import { close, listenTcp, listenUnix } from "./http.ts";
import { intakeHandler } from "./intake.ts";
import { AppTokens } from "./login/app-tokens.ts";
import { type GitHubEndpoints, GitHubLogin } from "./login/github.ts";
import { LoginSessions } from "./login/sessions.ts";
import { MemoryView } from "./memory-view.ts";
import { Memory } from "./memory.ts";
import { metricsHandler } from "./metrics.ts";
import { ModelSettings } from "./model-settings.ts";
import { ApnsChannel, ApnsClient } from "./push/apns.ts";
import { ApnsRegistrations } from "./push/apns-registrations.ts";
import { noticeChannel, Notifier, PushSubscriptions } from "./push/notifier.ts";
import { vapidKeyOf, type WebPushRequest, WebPushChannel } from "./push/web-push.ts";
import { Queue } from "./queue.ts";
import { ActivityRecord } from "./record.ts";
import { sandboxHandler } from "./sandbox-api.ts";
import { Scheduler, Schedules } from "./schedules.ts";
import { Sleep } from "./sleep.ts";
import { Sleepiness } from "./sleepiness.ts";
import { Sources } from "./sources.ts";
import { uiHandler } from "./ui-api.ts";
import { webHandler } from "./web.ts";

export type Backend = { port: number; metricsPort: number | undefined; close: () => Promise<void> };

export async function startBackend(
  config: Config,
  {
    log = console.error,
    now = Date.now,
    githubEndpoints,
    sendWebPush,
  }: { log?: (line: string) => void; now?: () => number; githubEndpoints?: GitHubEndpoints; sendWebPush?: (request: WebPushRequest) => Promise<number> } = {},
): Promise<Backend> {
  for (const dir of [path.dirname(config.databasePath), config.assetsDir, config.sourcesDir, config.memoryDir, path.dirname(config.intakeSocket), path.dirname(config.sandboxSocket)]) {
    mkdirSync(dir, { recursive: true });
  }
  const memory = new Memory(config.memoryDir, config.gitAuthor);
  const avatar = new AgentAvatar(await seedAvatar(config.avatar, config.memoryDir, memory, log), config.avatar.name, log);
  // What she changed in her avatar is shown once it is committed, at the end of the turn.
  memory.afterCommit(() => avatar.reload());
  const agent = avatar.settings();
  const db = openDatabase(config.databasePath);
  const memoryView = new MemoryView(config.memoryDir, db, { ...config.memoryView, now, timeZone: config.timeZone, backendEmail: config.gitAuthor.email });
  const warmMemory = () => { void memoryView.warmLastChanges().catch(() => log("memory: last changes could not be prepared")); };
  memory.afterCommit(warmMemory);
  const modelSettings = new ModelSettings(db, now);
  const sleepiness = new Sleepiness(db, now, config.timeZone);
  const queue = new Queue(db, new Sources(config.sourcesDir, config.timeZone), {
    now,
    inline: config.inline,
    builtinDelivery: config.builtinDelivery,
    batch: config.batch,
    timeZone: config.timeZone,
    redeliverMs: config.redeliverMs,
  });
  const feed = new Feed();
  const assets = new Assets(db, config.assetsDir, { now });
  const conversation = new Conversation(db, feed, { now, assets });
  const agents = new SubAgents(db, feed, conversation, { now });
  const schedules = new Schedules(db, { now, timeZone: config.timeZone });
  const scheduler = new Scheduler(schedules, queue, { now, log });
  const record = new ActivityRecord(db, feed, {
    now,
    timeZone: config.timeZone,
    sleepReportTimeoutMs: config.sleep.reportTimeoutMs,
    ...(config.github === undefined ? {} : { owner: config.github.ownerId }),
    log,
  });
  const sessions = new LoginSessions(db, { now });
  const appTokens = new AppTokens(db, { now });
  const inbox = new Inbox(db, queue, { assets, now, limits: config.a2a?.limits ?? { deadlineMs: 24 * 3_600_000, maxOpenTasks: 3 } });
  const heartbeat = new Heartbeat(queue, conversation, { now, quietMs: config.heartbeatMs, inbox, record, sleepiness, log });
  const sleep = new Sleep(db, queue, sleepiness, {
    now, timeZone: config.timeZone, limits: config.sleep, notes: (at, since) => heartbeat.notes(at, since), log,
  });
  const login = new GitHubLogin({ settings: config.github, ...(githubEndpoints ? { endpoints: githubEndpoints } : {}), sessions, now, log });
  const subscriptions = new PushSubscriptions(db, { now });
  const vapid = config.webPush === undefined ? undefined : vapidKeyOf(config.webPush.vapidKey);
  const apnsRegistrations = new ApnsRegistrations(db, { now, ownerId: config.github?.ownerId });
  const apns = config.apns === undefined ? undefined : new ApnsClient(config.apns, now);
  const channels = [];
  if (config.webPush !== undefined && vapid !== undefined) {
    channels.push(noticeChannel("web-push", subscriptions, new WebPushChannel({ vapid, subject: config.webPush.subject, now, ...(sendWebPush ? { send: sendWebPush } : {}) })));
  }
  if (config.apns !== undefined && apns !== undefined) {
    channels.push(noticeChannel("apns", apnsRegistrations, new ApnsChannel(config.apns.url, (request) => apns.send(request))));
  }
  const notifier = new Notifier({ feed, agentName: agent.name, channels, log });

  // A start that fails part way closes what it had opened, and the database.
  const opened: http.Server[] = [];
  const opening = async (listening: Promise<http.Server>): Promise<http.Server> => {
    const server = await listening;
    opened.push(server);
    return server;
  };
  let ui: http.Server;
  let metricsPort: number | undefined;
  try {
    await opening(listenUnix(intakeHandler(queue, { log }), config.intakeSocket, log));
    await opening(
      listenUnix(
        sandboxHandler({ token: config.sandboxToken, queue, conversation, agents, schedules, memory, memoryView, inbox, record, modelSettings, sleepiness, sleep, now, log }),
        config.sandboxSocket,
        log,
      ),
    );
    ui = await opening(
      listenTcp(
        uiHandler({
          queue,
          conversation,
          assets,
          agents,
          schedules,
          record,
          memory,
          memoryView,
          feed,
          login,
          sessions,
          appTokens,
          apnsRegistrations,
          modelSettings,
          sleepiness,
          ownerId: config.github?.ownerId,
          publicUrl: config.publicUrl,
          agent: () => avatar.settings(),
          web: webHandler({ dir: config.webDir, agent: () => avatar.settings() }),
          ...(config.a2a === undefined ? {} : { a2a: a2aOf(config.a2a, agent.name, inbox, now, log) }),
          ...(vapid === undefined ? {} : { push: { publicKey: vapid.publicKey, subscriptions } }),
          now,
        }),
        config.listen.host,
        config.listen.port,
        log,
      ),
    );
    if (config.metricsListen !== undefined) {
      const { host, port } = config.metricsListen;
      const metrics = await opening(listenTcp(metricsHandler(db, sleepiness, now), host, port, log));
      metricsPort = (metrics.address() as AddressInfo).port;
      log(`backend: metrics on ${host}:${metricsPort}`);
    }
  } catch (error) {
    await Promise.all(opened.map(close));
    db.close();
    throw error;
  }
  warmMemory();
  const stopSleep = sleep.start();
  const stopScheduler = scheduler.start();
  const stopRecord = record.start();
  const stopHeartbeat = heartbeat.start();
  const stopNotifier = channels.length === 0 ? () => {} : notifier.start();

  if (config.sandboxToken === undefined) log("backend: no PENELOPE_SANDBOX_TOKEN_FILE; the sandbox's API refuses every request");
  if (config.github === undefined) log("backend: no GitHub login set up; no one can sign in to the UI");
  if (config.a2a === undefined) log("backend: no A2A senders; /a2a/ is closed");
  if (config.webPush === undefined) log("backend: no PENELOPE_WEB_PUSH_VAPID_KEY_FILE; no Web Push notices are sent");
  const port = (ui.address() as AddressInfo).port;
  log(`backend: intake on ${config.intakeSocket}, sandbox's API on ${config.sandboxSocket}, UI on ${config.listen.host}:${port}`);

  return {
    port,
    metricsPort,
    close: async () => {
      stopSleep();
      stopScheduler();
      stopRecord();
      stopHeartbeat();
      stopNotifier();
      apns?.close();
      await Promise.all(opened.map(close));
      db.close();
    },
  };
}

/** The A2A way in of the settings: the checks they chose, onto one allow-list. */
function a2aOf(settings: NonNullable<Config["a2a"]>, name: string, inbox: Inbox, now: () => number, log: (line: string) => void) {
  const checks: SenderCheck[] = [];
  if (settings.gated) checks.push(new GatedAssertion({ ...settings.gated, now, log: (line) => log(`a2a: ${line}`) }));
  if (settings.tokenReview) checks.push(new TokenReview(settings.tokenReview.kubernetes, settings.tokenReview.audiences));
  return a2aHandler({
    inbox,
    checks,
    senders: new Senders(settings.senders),
    card: { name, description: settings.description, url: settings.url },
    log,
  });
}
