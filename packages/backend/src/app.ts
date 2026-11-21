// The backend put together: one SQLite file, /sources and /memory, and three
// servers: the intake and the sandbox's API on Unix sockets, the UI's API on
// TCP (docs/pod.md).
import { mkdirSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { a2aHandler } from "./a2a/endpoint.ts";
import { GatedAssertion } from "./a2a/gated.ts";
import { Inbox } from "./a2a/inbox.ts";
import { type SenderCheck, Senders } from "./a2a/senders.ts";
import { TokenReview } from "./a2a/tokenreview.ts";
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
import { type GitHubEndpoints, GitHubLogin } from "./login/github.ts";
import { LoginSessions } from "./login/sessions.ts";
import { Memory } from "./memory.ts";
import { ModelSettings } from "./model-settings.ts";
import { Notifier, PushSubscriptions } from "./push/notifier.ts";
import { vapidKeyOf, type WebPushRequest, WebPushChannel } from "./push/web-push.ts";
import { Queue } from "./queue.ts";
import { ActivityRecord } from "./record.ts";
import { sandboxHandler } from "./sandbox-api.ts";
import { cronOf, Scheduler, Schedules } from "./schedules.ts";
import { Sources } from "./sources.ts";
import { AwakeHours } from "./time.ts";
import { uiHandler } from "./ui-api.ts";
import { webHandler } from "./web.ts";

export type Backend = { port: number; close: () => Promise<void> };

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
  const modelSettings = new ModelSettings(db, now);
  const awake = new AwakeHours(config.awakeHours, config.timeZone);
  const queue = new Queue(db, new Sources(config.sourcesDir, config.timeZone), {
    now,
    inline: config.inline,
    builtinDelivery: config.builtinDelivery,
    batch: config.batch,
    awake,
    redeliverMs: config.redeliverMs,
  });
  const feed = new Feed();
  const assets = new Assets(db, config.assetsDir, { now });
  const conversation = new Conversation(db, feed, { now, assets });
  const agents = new SubAgents(db, feed, conversation, { now });
  const schedules = new Schedules(db, { now, timeZone: config.timeZone });
  const scheduler = new Scheduler(schedules, queue, { now, timeZone: config.timeZone, nightly: config.nightly, reviewWeekday: config.reviewWeekday, log });
  const record = new ActivityRecord(db, feed, {
    now,
    timeZone: config.timeZone,
    nightly: cronOf(config.nightly, config.timeZone, { seconds: true }),
    ...(config.github === undefined ? {} : { owner: config.github.ownerId }),
    log,
  });
  const sessions = new LoginSessions(db, { now });
  const inbox = new Inbox(db, queue, { assets, now, limits: config.a2a?.limits ?? { deadlineMs: 24 * 3_600_000, maxOpenTasks: 3 } });
  const login = new GitHubLogin({ settings: config.github, ...(githubEndpoints ? { endpoints: githubEndpoints } : {}), sessions, now, log });
  const subscriptions = new PushSubscriptions(db, { now });
  const vapid = config.webPush === undefined ? undefined : vapidKeyOf(config.webPush.vapidKey);
  const notifier =
    config.webPush === undefined || vapid === undefined
      ? undefined
      : new Notifier({
          feed,
          subscriptions,
          agentName: agent.name,
          channels: { "web-push": new WebPushChannel({ vapid, subject: config.webPush.subject, now, ...(sendWebPush ? { send: sendWebPush } : {}) }) },
          log,
        });

  // A start that fails part way closes what it had opened, and the database.
  const opened: http.Server[] = [];
  const opening = async (listening: Promise<http.Server>): Promise<http.Server> => {
    const server = await listening;
    opened.push(server);
    return server;
  };
  let intake: http.Server;
  let sandbox: http.Server;
  let ui: http.Server;
  try {
    intake = await opening(listenUnix(intakeHandler(queue, { log }), config.intakeSocket, log));
    sandbox = await opening(
      listenUnix(
        sandboxHandler({ token: config.sandboxToken, queue, conversation, agents, schedules, memory, inbox, record, modelSettings, now, log }),
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
          feed,
          login,
          sessions,
          modelSettings,
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
  } catch (error) {
    await Promise.all(opened.map((server) => close(server)));
    db.close();
    throw error;
  }
  const stopScheduler = scheduler.start();
  const stopRecord = record.start();
  const stopHeartbeat =
    config.heartbeatMs === undefined ? () => {} : new Heartbeat(queue, conversation, { now, quietMs: config.heartbeatMs, awake, log }).start();
  const stopNotifier = notifier?.start() ?? (() => {});

  if (config.sandboxToken === undefined) log("backend: no PENELOPE_SANDBOX_TOKEN_FILE; the sandbox's API refuses every request");
  if (config.github === undefined) log("backend: no GitHub login set up; no one can sign in to the UI");
  if (config.a2a === undefined) log("backend: no A2A senders; /a2a/ is closed");
  if (config.webPush === undefined) log("backend: no PENELOPE_WEB_PUSH_VAPID_KEY_FILE; no notices of the replies are sent");
  const port = (ui.address() as AddressInfo).port;
  log(`backend: intake on ${config.intakeSocket}, sandbox's API on ${config.sandboxSocket}, UI on ${config.listen.host}:${port}`);

  return {
    port,
    close: async () => {
      stopScheduler();
      stopRecord();
      stopHeartbeat();
      stopNotifier();
      await Promise.all([close(intake), close(sandbox), close(ui)]);
      db.close();
    },
  };
}

/** The A2A way in of the settings: the checks they chose, onto one allow-list. */
function a2aOf(settings: NonNullable<Config["a2a"]>, name: string, inbox: Inbox, now: () => number, log: (line: string) => void) {
  const checks: SenderCheck[] = [];
  if (settings.gated) checks.push(new GatedAssertion({ ...settings.gated, now, log }));
  if (settings.tokenReview) checks.push(new TokenReview(settings.tokenReview.kubernetes, settings.tokenReview.audiences));
  return a2aHandler({
    inbox,
    checks,
    senders: new Senders(settings.senders),
    card: { name, description: settings.description, url: settings.url },
    log,
  });
}
