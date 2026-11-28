// A runner over a home, a memory and a fake backend of its own, with the
// scripted model. The places stay when the runner is stopped, so that a test
// can start another runner over them, as after a restart.

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Activity, ActivityRequest, DeliveredEvent } from "@penelope/contract";

import { Backend } from "../src/backend.ts";
import type { Config } from "../src/config.ts";
import { readImageLimits } from "../src/image-limit.ts";
import { Runner } from "../src/runner.ts";
import { FakeBackend, TOKEN } from "./fake-backend.ts";
import { type Call, fakeRuntime, MODEL, PROVIDER, type Script } from "./fake-model.ts";

export const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

export interface World {
  fake: FakeBackend;
  config: Config;
  calls: Call[];
  /** The runner's log lines. */
  logs: string[];
  /** Start a runner over the same places; stop it with the function it returns. */
  start(script: Script): Promise<() => Promise<void>>;
}

export async function world(options: { turnFold?: boolean; ownerSkills?: boolean; connectors?: boolean; slackSources?: string[] } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "runner-"));
  const home = join(root, "home");
  const memoryDir = join(root, "memory");
  await mkdir(home, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  const fake = new FakeBackend();
  closers.push(() => fake.close());
  const config: Config = {
    agent: "main",
    backend: { url: await fake.url, token: TOKEN },
    identity: { name: "Example", role: "an operator", owner: "Owner" },
    model: { provider: PROVIDER, id: MODEL },
    home,
    memoryDir,
    sourcesDir: join(root, "sources"),
    agentDir: join(home, ".pi", "agent"),
    sessionDir: join(home, ".pi", "agent", "sessions", "main"),
    subAgentDir: join(home, ".pi", "agent", "sessions", "agents"),
    jobDir: join(home, "jobs"),
    jobs: { max: 5, maxSeconds: 86400, tailChars: 4000 },
    promptFileMaxBytes: 65536,
    promptLayerTargetBytes: 16384,
    nightCarryDays: 7,
    reviewTopicMaxBytes: 100000,
    imageMaxBytes: 1_000_000,
    pollWaitSeconds: 1,
    turnFold: options.turnFold ?? true,
    slack: { sources: options.slackSources ?? [], maxChars: 6000 },
    imageSkillsDir: join(root, "image", "skills"),
    ...(options.ownerSkills ? { ownerSkillsDir: join(root, "skills") } : {}),
    ...(options.connectors ? { connectorsDir: join(root, "connectors") } : {}),
  };
  const calls: Call[] = [];
  const logs: string[] = [];
  return {
    fake,
    config,
    calls,
    logs,
    async start(script) {
      const modelRuntime = await fakeRuntime(root, (call) => {
        calls.push(call);
        return script(call);
      });
      const controller = new AbortController();
      const runner = new Runner({
        config,
        backend: new Backend({ url: config.backend.url, token: TOKEN, agent: "main" }),
        house: { origin: new URL(config.backend.url), token: TOKEN },
        modelRuntime,
        imageLimits: await readImageLimits(join(config.agentDir, "models.json")),
        settings: () => SettingsManager.inMemory({ retry: { enabled: false } }),
        log: (line) => logs.push(line),
        retryMs: 50,
      });
      const running = runner.run(controller.signal);
      const stop = async () => {
        controller.abort();
        await running;
      };
      closers.push(stop);
      return stop;
    },
  };
}

export function ui(seq: number, text: string, delivery: "now" | "batch" = "now"): DeliveredEvent {
  return {
    seq,
    source: "ui",
    id: `m-${seq}`,
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: text,
    delivery,
    inline: true,
    payload: { text },
    appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [seq, seq] },
  };
}

export function heartbeat(seq: number): Extract<DeliveredEvent, { inline: false }> {
  return {
    seq,
    source: "heartbeat",
    id: `heartbeat@2026-11-14T10:00:00.000Z`,
    occurred_at: "2026-11-14T10:00:00.000Z",
    received_at: "2026-11-14T10:00:00.000Z",
    summary: "no turn for 60 minutes",
    delivery: "now",
    inline: false,
    appended: { path: "/sources/heartbeat/2026-11-14.jsonl", lines: [seq, seq] },
  };
}

/** The activities, with the agent each was sent for. */
export function activities(fake: FakeBackend, agent = "main"): Activity[] {
  return (fake.sent("POST", "/v1/activity") as ActivityRequest[])
    .filter((request) => request.agent === agent)
    .flatMap((request) => request.activities);
}

export const acked = (fake: FakeBackend) => (fake.sent("POST", "/v1/events/ack") as { seqs: number[] }[]).flatMap((a) => a.seqs);
