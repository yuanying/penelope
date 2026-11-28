import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { startBackend } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { run } from "../src/main.ts";
import { ask, tempDir } from "./support.ts";

describe("the backend", () => {
  it("takes an event in, hands it to the runner and commits the memory", async (t) => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, "token"), "real-token\n");
    const config = loadConfig(
      {
        PENELOPE_DATABASE: path.join(dir, "state/backend.sqlite"),
        PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
        PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
        PENELOPE_INTAKE_SOCKET: path.join(dir, "intake/backend.sock"),
        PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox/backend.sock"),
        PENELOPE_LISTEN: "127.0.0.1:0",
        PENELOPE_SANDBOX_TOKEN_FILE: path.join(dir, "token"),
      },
      (file) => execFileSync("cat", [file], { encoding: "utf8" }),
    );
    const backend = await startBackend(config, { log: () => {} });
    t.after(() => backend.close());

    const intake = { socketPath: config.intakeSocket };
    const sandbox = { socketPath: config.sandboxSocket };
    const auth = { authorization: "Bearer real-token" };

    const sent = await ask(intake, "/v1/events", {
      json: { source: "github", id: "d-1", occurred_at: "2026-11-14T09:00:00Z", summary: "a push", delivery: "now", payload: {} },
    });
    assert.equal(sent.status, 202);

    const { events } = (await ask(sandbox, "/v1/events?agent=main&wait=5", { headers: auth })).json();
    assert.deepEqual(events.map((e: { summary: string }) => e.summary), ["a push"]);
    assert.ok(existsSync(events[0].appended.path));

    writeFileSync(path.join(config.memoryDir, "diary.md"), "a push came\n");
    assert.equal((await ask(sandbox, "/v1/turns/end", { headers: auth, json: { agent: "main", turn_id: "t-1" } })).status, 204);
    assert.equal((await ask(sandbox, "/v1/events/ack", { headers: auth, json: { agent: "main", seqs: [events[0].seq] } })).status, 204);

    const log = execFileSync("git", ["-c", `safe.directory=${config.memoryDir}`, "log", "--format=%s"], {
      cwd: config.memoryDir,
      encoding: "utf8",
    });
    assert.equal(log, "Turn t-1\n");
    assert.equal(backend.metricsPort, undefined);
    // The UI's port answers, and without a login it lets no one in.
    const ui = { port: backend.port };
    assert.equal((await ask(ui, "/healthz")).status, 200);
    assert.equal((await ask(ui, "/api/record/unseen")).status, 401);
  });
});

it("serves metrics on their own port without exposing either API there", async (t) => {
  const dir = tempDir(t);
  const config = loadConfig({
    PENELOPE_DATABASE: path.join(dir, "backend.sqlite"),
    PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
    PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
    PENELOPE_INTAKE_SOCKET: path.join(dir, "intake.sock"),
    PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox.sock"),
    PENELOPE_LISTEN: "127.0.0.1:0",
    PENELOPE_METRICS_LISTEN: "127.0.0.1:0",
  }, () => assert.fail("no files to read"));
  const backend = await startBackend(config, { log: () => {} });
  t.after(() => backend.close());

  assert.ok(backend.metricsPort);
  const metrics = { port: backend.metricsPort };
  const scrape = await ask(metrics, "/metrics");
  assert.equal(scrape.status, 200);
  assert.match(scrape.headers["content-type"] ?? "", /^text\/plain; version=0\.0\.4\b/);
  assert.equal((await ask(metrics, "/healthz")).status, 404);
  assert.equal((await ask(metrics, "/v1/status")).status, 404);
  assert.equal((await ask({ port: backend.port }, "/metrics")).status, 404);
});

describe("the backend's avatar", () => {
  // Guards against: what she changed in her avatar never reaching the UI, or the UI showing it before it is committed.
  it("serves the faces of /memory/avatar, and what she changed in it once the turn's end commits it", async (t) => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, "token"), "real-token\n");
    const avatar = path.join(dir, "memory/avatar");
    mkdirSync(avatar, { recursive: true });
    const webp = (text: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(`WEBP${text}`)]);
    writeFileSync(path.join(avatar, "neutral.webp"), webp("neutral"));
    writeFileSync(path.join(avatar, "happy.webp"), webp("happy"));
    writeFileSync(path.join(avatar, "avatar.json"), JSON.stringify({ name: "Iris", icons: { neutral: "neutral.webp" } }));
    const config = loadConfig(
      {
        PENELOPE_DATABASE: path.join(dir, "state/backend.sqlite"),
        PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
        PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
        PENELOPE_INTAKE_SOCKET: path.join(dir, "intake/backend.sock"),
        PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox/backend.sock"),
        PENELOPE_LISTEN: "127.0.0.1:0",
        PENELOPE_SANDBOX_TOKEN_FILE: path.join(dir, "token"),
      },
      (file) => execFileSync("cat", [file], { encoding: "utf8" }),
    );
    const backend = await startBackend(config, { log: () => {} });
    t.after(() => backend.close());
    const ui = { port: backend.port };
    assert.deepEqual((await ask(ui, "/api/agent")).json(), { name: "Iris", icons: { neutral: "/api/agent/icons/neutral.webp" } });
    assert.ok((await ask(ui, "/api/agent/icons/neutral")).body.includes("neutral"));

    writeFileSync(path.join(avatar, "avatar.json"), JSON.stringify({ name: "Iris", icons: { neutral: "neutral.webp", happy: "happy.webp" } }));
    assert.equal((await ask(ui, "/api/agent/icons/happy")).status, 404);
    const end = await ask({ socketPath: config.sandboxSocket }, "/v1/turns/end", { headers: { authorization: "Bearer real-token" }, json: { agent: "main", turn_id: "t-1" } });
    assert.equal(end.status, 204);
    assert.ok((await ask(ui, "/api/agent/icons/happy")).body.includes("happy"));
  });
});

describe("the backend that cannot listen", () => {
  // Guards against: a backend that runs on without one of the Unix sockets of ADR-0014,
  // where the sandbox could not reach it or the receivers could not hand it events.
  // `backend serve` runs as its own process: what is looked at is that it ends.
  for (const [which, name] of [
    ["PENELOPE_INTAKE_SOCKET", "intake"],
    ["PENELOPE_SANDBOX_SOCKET", "sandbox"],
  ] as const) {
    it(`does not start without its ${name} socket`, async (t) => {
      const dir = tempDir(t);
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        PENELOPE_DATABASE: path.join(dir, "backend.sqlite"),
        PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
        PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
        PENELOPE_INTAKE_SOCKET: path.join(dir, "intake.sock"),
        PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox.sock"),
        PENELOPE_LISTEN: "127.0.0.1:0",
        // A Unix socket's path is at most about 100 bytes; this one cannot be listened on.
        [which]: path.join(dir, `${"s".repeat(120)}.sock`),
      };
      const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
      const child = spawn(process.execPath, [main, "serve"], { env, stdio: "ignore" });
      t.after(() => child.kill("SIGKILL"));
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the backend went on without its socket")), 20_000);
        child.on("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      assert.notEqual(code, 0);
    });
  }

  // Guards against: a start that fails part way and leaves the ways in it had opened, still
  // taking events, in a process that goes on (a test, or a caller that tries again).
  function configIn(dir: string, env: Record<string, string> = {}) {
    return loadConfig(
      {
        PENELOPE_DATABASE: path.join(dir, "backend.sqlite"),
        PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
        PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
        PENELOPE_INTAKE_SOCKET: path.join(dir, "intake.sock"),
        PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox.sock"),
        PENELOPE_LISTEN: "127.0.0.1:0",
        ...env,
      },
      (file) => execFileSync("cat", [file], { encoding: "utf8" }),
    );
  }

  async function refused(socketPath: string): Promise<boolean> {
    return ask({ socketPath }, "/healthz").then(
      () => false,
      () => true,
    );
  }

  it("closes the intake when the sandbox's socket cannot be listened on", async (t) => {
    const dir = tempDir(t);
    const config = configIn(dir, { PENELOPE_SANDBOX_SOCKET: path.join(dir, `${"s".repeat(120)}.sock`) });
    await assert.rejects(startBackend(config, { log: () => {} }));
    assert.ok(await refused(config.intakeSocket), "the intake still answers");
  });

  it("closes both sockets when the UI's port cannot be listened on", async (t) => {
    const dir = tempDir(t);
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const config = configIn(dir, { PENELOPE_LISTEN: `127.0.0.1:${(taken.address() as net.AddressInfo).port}` });
    await assert.rejects(startBackend(config, { log: () => {} }));
    assert.ok(await refused(config.intakeSocket), "the intake still answers");
    assert.ok(await refused(config.sandboxSocket), "the sandbox's API still answers");
  });
});

describe("the command", () => {
  it("prints the version from PENELOPE_VERSION", () => {
    assert.deepEqual(run(["version"], { PENELOPE_VERSION: "v1.2.3" }), { code: 0, stdout: "v1.2.3\n", stderr: "" });
  });

  it("prints dev when no version was given", () => {
    assert.equal(run(["version"], {}).stdout, "dev\n");
  });

  it("prints the usage and exits with 2 for anything else", () => {
    const result = run(["nonsense"], {});
    assert.equal(result.code, 2);
    assert.match(result.stderr, /usage/);
  });
});
