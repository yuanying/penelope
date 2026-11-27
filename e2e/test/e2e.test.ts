// The Pod end to end (e2e/README.md): the owner signs in and talks, the
// sandbox's runner makes turns with the fake model, the memory is committed,
// the sandbox's traffic goes through the Sentinel, a receiver's events reach
// a turn, the night switches the session, and ended turns are folded.
//
// The scenarios share one Pod and go in order; each starts from where the one
// before left it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createDecipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, hkdfSync, randomUUID, verify } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { RecordDayResponse, RecordNight, RecordTurn, TurnBatch, TurnEvent, TurnLine } from "@penelope/contract";

import { E2E_PNG } from "../outside/model.ts";
import {
  a2aCall,
  Browser,
  compose,
  composeEnv,
  E2E_DIR,
  eventually,
  exec,
  fromOutside,
  type ModelCall,
  outside,
  pod,
  RUN_DIR,
  sentinelRecords,
  sleep,
  Stream,
  type StreamEvent,
  textOf,
  where,
} from "./support.ts";

const TAG = process.env.PENELOPE_E2E_TAG;
const KEEP = process.env.PENELOPE_E2E_KEEP === "1";
const MODEL_SURROGATE = "e2e-surrogate-model-0001";
const BACKEND_SURROGATE = "e2e-surrogate-backend-0001";

const browser = new Browser();
let stream = new Stream();
let failed = false;

/** The model calls whose last input carries `marker`, at the given step of the turn. */
async function callsFor(marker: string, steps?: number): Promise<ModelCall[]> {
  return (await outside.modelCalls()).filter((call) => {
    const at = where(call);
    return at.input.includes(marker) && (steps === undefined || at.steps === steps);
  });
}

function streamed(event: string, test: (data: Record<string, unknown>) => boolean): StreamEvent | undefined {
  return stream.events.find((entry) => entry.event === event && test(entry.data as Record<string, unknown>));
}

function eventLines(input: string): TurnLine[] {
  const block = /^<events>\n([\s\S]*?)\n<\/events>(?:\n|$)/.exec(input)?.[1];
  assert.ok(block !== undefined, `an <events> block: ${JSON.stringify(input)}`);
  return block.split("\n").map((line) => JSON.parse(line) as TurnLine);
}

/** A scenario that, when it fails, has the logs of every container written out at the end. */
function track(scenario: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await scenario();
    } catch (error) {
      failed = true;
      throw error;
    }
  };
}

async function send(text: string): Promise<void> {
  const { status, body } = await browser.json("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  // A refusal says who refused it and why, with the cookie the browser sent.
  assert.equal(status, 202, `${text}: ${JSON.stringify(body)}, cookie ${browser.cookie?.split("=")[0] ?? "none"}`);
}

const replied = (text: string, timeoutMs = 120_000) =>
  eventually(`the reply ${text} on the stream`, () => streamed("reply", (data) => data.text === text), timeoutMs);

/** The log of /memory, as the backend's git sees it: subject, body and the files of each commit. */
function memoryLog(): string {
  return exec("backend", "cd /memory && git -c safe.directory=/memory log --format='--%n%s%n%b' --name-only 2>&1 || true").stdout;
}

function intake(envelope: Record<string, unknown>): string {
  return exec("receivers", "node /e2e/sender/send.ts", { input: JSON.stringify(envelope) }).stdout.trim();
}

/** The address Docker gave a container of the test, on its default bridge. */
function address(service: string): string {
  const id = compose(["ps", "--quiet", service]).stdout.trim();
  const run = spawnSync("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id], { encoding: "utf8" });
  const ip = run.stdout.trim();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `the address of ${service}`);
  return ip;
}

before(async () => {
  assert.ok(TAG, "PENELOPE_E2E_TAG names the images to test (make e2e sets it)");
  composeEnv.PENELOPE_E2E_TAG = TAG;
  rmSync(RUN_DIR, { recursive: true, force: true });
  const certs = spawnSync(join(E2E_DIR, "certs.sh"), [RUN_DIR], { encoding: "utf8" });
  assert.equal(certs.status, 0, certs.stderr);
  compose(["down", "--volumes", "--remove-orphans"], { check: false });
  // The outside first: the Pod asks its name server. Then the Pod's namespace,
  // whose address is the backend's public URL. Then the rest.
  compose(["up", "--detach", "--build", "outside"]);
  writeFileSync(join(RUN_DIR, "resolv.conf"), `nameserver ${address("outside")}\noptions ndots:1\n`);
  compose(["up", "--detach", "pod"]);
  pod.url = `http://${address("pod")}:8080`;
  composeEnv.PENELOPE_E2E_PUBLIC_URL = pod.url;
  compose(["up", "--detach"]);
  await eventually("the backend's health", async () => ((await browser.request("/healthz")).status === 200 ? true : undefined));
});

after(() => {
  stream.close();
  if (failed || KEEP) {
    process.stderr.write(compose(["logs", "--no-color", "--timestamps"], { check: false }).stdout);
  }
  if (!KEEP) compose(["down", "--volumes", "--remove-orphans"], { check: false });
});

describe("the Pod end to end", () => {
  it("lets the owner in through GitHub's OAuth", track(async () => {
    // Guards against: the owner not getting in, or someone other than the owner's GitHub account getting a session.
    const start = await browser.request("/auth/github/start");
    assert.equal(start.status, 302);
    const location = new URL(start.headers.location!);
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");

    // The owner's browser at GitHub, which sends it back with a code.
    const { code, state, redirect_uri } = await outside.authorize(location.search);
    assert.equal(redirect_uri, `${pod.url}/auth/github/callback`);
    const callback = await browser.request(`/auth/github/callback?${new URLSearchParams({ code, state })}`);
    assert.equal(callback.status, 302, callback.text);
    assert.equal(callback.headers.location, "/");
    assert.ok(browser.cookie?.startsWith("penelope_session="));

    const history = await browser.json<{ entries: unknown[] }>("/api/history");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.entries, []);
    await stream.open(browser.cookie!);
  }));

  it("serves the Web UI from the backend, named from the settings", track(async () => {
    // Guards against: the backend's image without the built UI or the avatars, or the UI not learning the agent's name from the settings.
    const page = await browser.request("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"] ?? "", /^text\/html/);
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    const styles = /href="(\/assets\/[^"]+\.css)"/.exec(page.text)?.[1];
    assert.ok(script && styles, "the page loads its script and its styles");
    for (const asset of [script, styles]) assert.equal((await browser.request(asset)).status, 200, asset);
    // The login screen and the home screen read these before anyone signs in.
    const agent = new Browser().json<{ name: string; icons?: Record<string, string> }>("/api/agent");
    assert.equal(agent.status, 200);
    assert.equal(agent.body.name, "E2E Agent");
    // The avatar the settings chose is in the image, a face for each expression.
    const happy = new Browser().request(agent.body.icons?.happy ?? "/api/agent/icons/happy");
    assert.equal(happy.status, 200);
    assert.equal(happy.headers["content-type"], "image/webp");
    const manifest = JSON.parse((await new Browser().request("/manifest.webmanifest")).text) as { name: string };
    assert.equal(manifest.name, "E2E Agent");
  }));

  it("makes a turn of the owner's message and streams the reply and what happened", track(async () => {
    // Guards against: a message not reaching a turn, the reply or the activity not reaching the UI, or the model getting the surrogate.
    await send("E2E-TURN-1 こんにちは");
    const reply = await replied("E2E-REPLY-1", 180_000);
    assert.equal((reply.data as { agent: string }).agent, "main");

    const states = () => stream.events.filter((event) => event.event === "state").map((event) => (event.data as { state: string }).state);
    await eventually("the agent waiting again", () => (states().at(-1) === "waiting" ? true : undefined));
    assert.ok(states().includes("thinking"));
    const activity = stream.events
      .filter((event) => event.event === "activity")
      .map((event) => (event.data as { activity: { kind: string; name?: string } }).activity);
    for (const kind of ["turn_start", "tool_call", "tool_result", "message", "turn_end"]) {
      assert.ok(activity.some((entry) => entry.kind === kind), `an activity of kind ${kind} on the stream`);
    }
    assert.deepEqual(
      activity.filter((entry) => entry.kind === "tool_call").map((entry) => entry.name),
      ["write", "bash", "reply"],
    );

    const history = await browser.json<{ entries: { kind: string; text: string }[] }>("/api/history");
    assert.deepEqual(
      history.body.entries.map((entry) => [entry.kind, entry.text]),
      [
        ["agent", "E2E-REPLY-1"],
        ["owner", "E2E-TURN-1 こんにちは"],
      ],
    );

    // The activity record has the turn as the runner told it: done, from the owner's message, with its reply (ADR-0038).
    const record = browser.json<RecordDayResponse>("/api/record?kind=turn&agent=main");
    const turn = record.body.rows.find(
      (row): row is RecordTurn => row.kind === "turn" && row.triggers.some((trigger) => trigger.summary.includes("E2E-TURN-1")),
    );
    assert.ok(turn, `the turn in the record: ${JSON.stringify(record.body)}`);
    assert.deepEqual([turn.result, turn.triggers.map((trigger) => trigger.source), turn.replies], ["done", ["ui"], 1]);

    // The model's key: the sandbox sent its surrogate, the model got the real one.
    const calls = await outside.modelCalls();
    assert.ok(calls.length >= 4);
    assert.deepEqual(new Set(calls.map((call) => call.credential)), new Set(["real"]));
  }));

  it("commits /memory even after a turn leaves private modes, and the sandbox cannot write its .git", track(async () => {
    // Guards against: a turn's memory left uncommitted, the sandbox rewriting the history, or the history unreadable to her.
    const log = await eventually("the turn's commit", () => {
      const text = memoryLog();
      return text.includes("notes/e2e.md") ? text : undefined;
    });
    assert.match(log, /^Turn [0-9a-f-]{36}\nAgent: main\n/m);
    assert.equal(exec("backend", "cat /memory/notes/e2e.md").stdout, "# E2E\n\nWritten in the first turn.\n");

    exec("backend", "test -w /memory/notes/e2e.md && test -w /memory/notes && test -g /memory/notes");

    const write = exec("sandbox", "touch /memory/.git/e2e 2>&1", { check: false });
    assert.notEqual(write.status, 0);
    assert.match(write.stdout, /Read-only file system/);
    // It can still read the history.
    assert.match(exec("sandbox", "cd /memory && git log --format=%s -1").stdout, /^Turn /);
  }));

  it("copies the chosen avatar into /memory at the start, for her to grow and check", track(async () => {
    // Guards against: the avatar not reaching /memory, its copy left uncommitted, her unable to edit it, or `avatar check` or sdctl missing from the sandbox.
    assert.match(memoryLog(), /^Avatar penelope\nCopied from \/app\/avatars\/penelope\n+avatar\//m);
    assert.match(exec("sandbox", "avatar check").stdout, /^ok: \/memory\/avatar\n/);
    assert.equal(exec("sandbox", "test -w /memory/avatar/appearance.yaml && test -w /memory/avatar/icons", { check: false }).status, 0);
    assert.equal(exec("sandbox", "sdctl --help >/dev/null", { check: false }).status, 0);
  }));

  it("folds the first turn in the second turn's input to the model", track(async () => {
    // Guards against: ended turns sent whole again, with their thinking and tool output, or her replies folded away.
    // The first turn, whole, while it ran: the tool's output was there.
    const during = await callsFor("E2E-TURN-1", 2);
    assert.ok(JSON.stringify(during[0]!.messages).includes("E2E-BASH-42"));

    await send("E2E-TURN-2");
    await replied("E2E-REPLY-2");
    const [first] = await callsFor("E2E-TURN-2", 0);
    assert.ok(first, "the model was called for the second turn");
    const sent = JSON.stringify(first.messages);
    // The event and the reply stay, her text stays, the other calls are one line each, and no tool output is left.
    assert.ok(sent.includes("E2E-TURN-1 こんにちは"));
    assert.ok(sent.includes("E2E-TEXT-1"));
    // A folded call is read by its mark and its tool's name only; how the rest of the line looks is not the contract.
    const folded = first.messages.map((message) => textOf(message.content)).filter((text) => text.includes("(folded)"));
    assert.ok(folded.some((text) => /\bwrite\b/.test(text)), `write, folded: ${sent}`);
    assert.ok(folded.some((text) => /\bbash\b/.test(text)), `bash, folded: ${sent}`);
    assert.ok(!sent.includes("E2E-BASH-42"), "the output of bash is folded away");
    assert.ok(!sent.includes("Successfully wrote"), "the output of write is folded away");
    const kept = first.messages.filter((message) => message.tool_calls?.some((call) => call.function.name === "reply"));
    assert.equal(kept.length, 1, "the reply is kept whole");
  }));

  it("sends a notice of her reply to the owner's push subscriptions, and drops one that is gone", track(async () => {
    // Guards against: a reply the owner is not told of, a notice the push service could read, the VAPID key not the
    // deployment's, a subscription kept after its push service said it is gone, or the notice sent through the Sentinel.
    const { body: settings } = browser.json<{ web_push?: { public_key: string } }>("/api/push");
    const { x, y } = createPublicKey(createPrivateKey(readFileSync(join(RUN_DIR, "vapid.pem"), "utf8"))).export({ format: "jwk" });
    const vapidKey = Buffer.concat([Buffer.from([4]), Buffer.from(x!, "base64url"), Buffer.from(y!, "base64url")]);
    assert.equal(settings.web_push?.public_key, vapidKey.toString("base64url"));

    // Two browsers: one whose push service takes the notice, one whose push service has ended the subscription.
    const phone = createECDH("prime256v1");
    phone.generateKeys();
    const auth = Buffer.alloc(16, 9);
    const subscribe = (endpoint: string) =>
      browser.request("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "web-push", endpoint, keys: { p256dh: phone.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }),
      }).status;
    assert.equal(subscribe("https://push.example.com/send/phone"), 204);
    assert.equal(subscribe("https://push.example.com/send/gone-pc"), 204);

    await send("E2E-TURN-3");
    const reply = await replied("E2E-REPLY-3");
    const pushes = await eventually("the notices at the push service", async () => {
      const taken = (await outside.pushes()).filter((push) => push.path === "/send/phone" || push.path === "/send/gone-pc");
      return taken.length >= 2 ? taken : undefined;
    });
    const push = pushes.find((taken) => taken.path === "/send/phone")!;
    assert.equal(push.encoding, "aes128gcm");
    assert.ok(Number(push.ttl) > 0);

    // The browser opens it with its own key (RFC 8291); what is in it is the notice of ui-api.md.
    const body = Buffer.from(push.body, "base64url");
    const serverKey = body.subarray(21, 21 + body[20]!);
    const record = body.subarray(21 + body[20]!);
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), phone.getPublicKey(), serverKey]);
    const ikm = Buffer.from(hkdfSync("sha256", phone.computeSecret(serverKey), auth, info, 32));
    const salt = body.subarray(0, 16);
    const decipher = createDecipheriv("aes-128-gcm", Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16)), Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12)));
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plaintext = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]).subarray(0, -1);
    assert.deepEqual(JSON.parse(plaintext.toString("utf8")), { id: (reply.data as { id: string }).id, agent: "E2E Agent", text: "E2E-REPLY-3" });

    // Named by the deployment's VAPID key, for the push service's origin (RFC 8292).
    const vapid = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(push.authorization);
    assert.ok(vapid, push.authorization);
    assert.equal(vapid[4], vapidKey.toString("base64url"));
    assert.equal(JSON.parse(Buffer.from(vapid[2]!, "base64url").toString()).aud, "https://push.example.com");
    const jwk = { kty: "EC", crv: "P-256", x: x!, y: y! };
    assert.ok(verify("sha256", Buffer.from(`${vapid[1]}.${vapid[2]}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(vapid[3]!, "base64url")));

    // The one that is gone is dropped: the next reply goes to the phone only. The log names neither text nor endpoint.
    await send("E2E-TURN-6");
    await replied("E2E-REPLY-6");
    await eventually("the next notice", async () => ((await outside.pushes()).filter((taken) => taken.path === "/send/phone").length >= 2 ? true : undefined));
    assert.equal((await outside.pushes()).filter((taken) => taken.path === "/send/gone-pc").length, 1);
    const backendLog = compose(["logs", "--no-log-prefix", "--no-color", "backend"]).stdout;
    assert.match(backendLog, /push: subscription \d+ \(web-push\): removed, its service answered 410/);
    assert.ok(!/push: .*(push\.example\.com|E2E-REPLY)/.test(backendLog), "the push lines name no endpoint and no text");

    // The backend sends it itself: the Sentinel has no record of the push service.
    assert.ok(!sentinelRecords().some((entry) => JSON.stringify(entry).includes("push.example.com")));
  }));

  it("shows the owner the image of a reply, copied by the backend, and refuses a reply whose image is none", track(async () => {
    // Guards against: an image she sends not reaching the owner, reaching anyone without the owner's login, reaching
    // them as other bytes, or a reply reaching the owner without the image it was sent with (ADR-0032).
    await send("E2E-IMAGE draw");
    const reply = await replied("E2E-REPLY-IMAGE");
    const images = (reply.data as { images?: { id: string; mime_type: string; size: number; name: string }[] }).images ?? [];
    const png = Buffer.from(E2E_PNG, "base64");
    assert.deepEqual(images.map(({ mime_type, size, name }) => ({ mime_type, size, name })), [{ mime_type: "image/png", size: png.length, name: "e2e.png" }]);
    const [image] = images;

    // The reply whose file is no image did not reach the owner; the tool said why.
    const history = await browser.json<{ entries: { text: string; images?: { id: string }[] }[] }>("/api/history");
    assert.ok(!history.body.entries.some((entry) => entry.text === "E2E-REPLY-IMAGE-REFUSED"));
    assert.deepEqual(history.body.entries.find((entry) => entry.text === "E2E-REPLY-IMAGE")?.images?.map((kept) => kept.id), [image!.id]);
    const refused = streamed("activity", (data) => {
      const activity = data.activity as { kind: string; is_error?: boolean; output?: string };
      return activity.kind === "tool_result" && activity.is_error === true && (activity.output ?? "").includes("notes.png");
    });
    assert.ok(refused, "the refusal came back to the reply's call");

    // The owner reads its bytes by its id; no one else does.
    const asset = browser.request(`/api/assets/${image!.id}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-type"], "image/png");
    assert.equal(asset.headers["content-length"], String(png.length));
    assert.equal(new Browser().request(`/api/assets/${image!.id}`).status, 401);
    // What the backend keeps is the sandbox's file as it was sent, in the backend's own place.
    const sum = (service: string, file: string) => exec(service, `sha256sum ${file}`).stdout.split(" ")[0];
    assert.equal(sum("backend", `/var/lib/penelope/assets/${image!.id}.png`), sum("sandbox", "/home/agent/draw/e2e.png"));
    assert.equal(exec("sandbox", "ls /var/lib/penelope 2>&1", { check: false }).status === 0, false, "the sandbox does not see the copies");
  }));

  it("sends the sandbox's traffic through the Sentinel, and records it", track(async () => {
    // Guards against: a surrogate leaking out, traffic leaving unrecorded, or the sandbox's loopback being redirected.
    // A host the Sentinel does not open: passed through, the outside's own certificate.
    const passed = exec("sandbox", "curl -sS --insecure https://plain.example.net/");
    assert.equal(passed.stdout, "plain over https\n");
    // Plain HTTP with a surrogate to a host that is not registered: refused before it leaves.
    const leak = exec(
      "sandbox",
      `curl -sS -o /dev/null -w '%{http_code} %header{penelope-sentinel}' -H 'Authorization: Bearer ${MODEL_SURROGATE}' http://plain.example.net/leak`,
    );
    assert.equal(leak.stdout, "403 deny");
    // A name under a wildcard registration: opened, and its surrogate swapped for the real key.
    const app = exec("sandbox", "curl -sS -H 'Authorization: Bearer e2e-surrogate-apps-0001' https://a.apps.example.com/app");
    assert.equal(app.stdout, "app a.apps.example.com real\n");
    // Link-local, and the Sentinel's own port reached directly: refused.
    exec("sandbox", "curl -sS -m 5 http://169.254.169.254/latest/meta-data/", { check: false });
    exec("sandbox", "curl -sS -m 5 http://127.0.0.1:15001/", { check: false });
    // The sandbox's loopback is its own: neither redirected nor recorded.
    const loopback = exec(
      "sandbox",
      "python3 -m http.server 18999 --bind 127.0.0.1 --directory /tmp >/dev/null 2>&1 & pid=$!; " +
        "for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:18999/ && break; sleep 0.1; done; " +
        "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18999/; kill $pid",
    );
    assert.equal(loopback.stdout, "200");

    const records = await eventually("the Sentinel's records", () => {
      const all = sentinelRecords();
      return all.some((record) => record.reason === "direct") && all.some((record) => record.host === "plain.example.net" && record.kind === "tcp")
        ? all
        : undefined;
    });
    const has = (what: Record<string, unknown>) =>
      records.some((record) => Object.entries(what).every(([key, value]) => record[key] === value));
    assert.ok(has({ kind: "tcp", action: "passthrough", host: "plain.example.net", port: 443, uid: 1000 }), "the passthrough");
    assert.ok(has({ kind: "http", action: "open", host: "model.example.com", method: "POST", path: "/v1/chat/completions", uid: 1000 }), "the model");
    assert.ok(has({ kind: "http", action: "open", host: "backend.example.com", method: "POST", path: "/v1/replies", uid: 1000 }), "the backend");
    assert.ok(has({ kind: "http", action: "open", host: "a.apps.example.com", method: "GET", path: "/app", status: 200 }), "the wildcard's name");
    assert.ok(has({ kind: "dns", host: "plain.example.net", qtype: "A" }), "the name lookup");
    assert.ok(has({ action: "deny", reason: "surrogate-out-of-place", host: "plain.example.net" }), "the surrogate");
    assert.ok(has({ action: "deny", reason: "link-local", addr: "169.254.169.254" }), "link-local");
    assert.ok(has({ action: "deny", reason: "direct" }), "direct");
    assert.ok(!records.some((record) => record.port === 18999), "the loopback is not recorded");
    assert.ok(!JSON.stringify(records).includes(MODEL_SURROGATE), "no surrogate in the record");
    assert.ok(!(await outside.seen()).some((entry) => entry.path === "/leak"), "the surrogate never reached the outside");
  }));

  it("has no real key in the sandbox, and only its surrogates", track(async () => {
    // Guards against: a real key, or the intake, becoming reachable from the sandbox.
    const keys = ["model-key", "backend-token", "github-client-secret", "kube-token", "sender-token", "stranger-token", "alertmanager-token", "github-webhook-secret", "slack-app-token", "slack-bot-token", "sentinel-ca.key", "outside-ca.key", "outside.key"]
      .map((name) => readFileSync(join(RUN_DIR, name), "utf8").trim().split("\n").filter((line) => line && !line.startsWith("-----")))
      .flat();
    const found = exec(
      "sandbox",
      "grep -rlF -f /dev/stdin /home/agent /memory /sources /etc /tmp /opt/penelope /proc/1/environ 2>/dev/null; true",
      { input: `${keys.join("\n")}\n` },
    );
    assert.equal(found.stdout, "");
    assert.match(exec("sandbox", "cat /proc/1/environ | tr '\\0' '\\n'").stdout, new RegExp(`PENELOPE_BACKEND_TOKEN=${BACKEND_SURROGATE}`));
    // The intake's and the Sentinel's sockets are not in the sandbox.
    assert.equal(exec("sandbox", "ls /run/penelope 2>&1; true").stdout.includes("intake"), false);
    // The backend's port for the UI is reached over loopback, and asks for the same login.
    assert.equal(exec("sandbox", "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/history").stdout, "401");
  }));

  it("takes a receiver's events into /sources, and brings the batch along with a now", track(async () => {
    // Guards against: a batch overtaken by a now and left behind, or an event pointing at the wrong place in /sources.
    const occurred = new Date().toISOString();
    const batch = { source: "e2e", stream: "feed", id: "batch-1", occurred_at: occurred, summary: "E2E-BATCH one", delivery: "batch", payload: { n: 1 } };
    assert.equal(intake(batch), "202");
    assert.equal(intake(batch), "202", "a duplicate is taken as received");
    assert.match(intake({ ...batch, source: "control", id: "night", payload: { kind: "nightly" } }), /^400 /);

    const day = occurred.slice(0, 10);
    const lines = exec("sandbox", `cat /sources/e2e/feed/${day}.jsonl`).stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!).payload, { n: 1 });

    // The batch waits for its quiet minutes; nothing of it reaches the model yet.
    await sleep(3000);
    assert.equal((await callsFor("/sources/e2e/feed/")).length, 0);

    const answer_via = { tool: "reply" };
    const now = { source: "e2e", stream: "feed", id: "now-1", occurred_at: new Date().toISOString(), summary: "E2E-NOW ping", delivery: "now", answer_via, payload: { n: 2 } };
    assert.equal(intake(now), "202");
    await replied("E2E-REPLY-EVENTS");
    // Both reach one turn as lines of its <events>, each pointing at where it was appended
    // (docs/events.md, "ターンに入る形"): the now with its summary, the batch as one line of its stream.
    const calls = await callsFor("E2E-NOW", 0);
    assert.equal(calls.length, 1, "one turn for the now and the batch");
    const file = `/sources/e2e/feed/${day}.jsonl`;
    const turn = eventLines(where(calls[0]!).input);
    // The batch is line 1 of the file and the now line 2.
    const nowLine = turn.find((line) => line.kind === undefined);
    assert.ok(nowLine && nowLine.kind === undefined, JSON.stringify(turn));
    assert.deepEqual(
      [nowLine.source, nowLine.stream, nowLine.delivery, nowLine.summary, nowLine.appended],
      ["e2e", "feed", "now", "E2E-NOW ping", { path: file, lines: [2, 2] }],
    );
    const batchLine = turn.find((line) => line.kind === "batch");
    assert.ok(batchLine && batchLine.kind === "batch", JSON.stringify(turn));
    assert.deepEqual(
      [batchLine.source, batchLine.stream, batchLine.count, batchLine.summary, batchLine.appended],
      ["e2e", "feed", 1, "E2E-BATCH one", [{ path: file, lines: [1, 1] }]],
    );
    assert.ok(batchLine.seqs[0]! < nowLine.seq, "the batch came before the now");
    assert.deepEqual(nowLine.answer_via, answer_via, "the intake preserves the answer route through to the model");
    const saved = exec("sandbox", `tail -n 1 ${file}`).stdout;
    assert.deepEqual(JSON.parse(saved).answer_via, answer_via);
  }));

  it("takes Alertmanager's webhook in the receivers, and brings a critical alert into a turn", track(async () => {
    // Guards against: an alert reaching the agent without the sender's token, a critical one not starting a turn,
    // a resend written twice, or the agent's own alert coming back to her.
    const token = readFileSync(join(RUN_DIR, "alertmanager-token"), "utf8").trim();
    const url = new URL("/v1/webhooks/fraction", pod.url);
    url.port = "8081";
    const startsAt = new Date().toISOString();
    const alert = (fingerprint: string, labels: Record<string, string>) => ({
      status: "firing",
      labels: { alertname: "KubePodCrashLooping", severity: "critical", namespace: "default", pod: "web-0", ...labels },
      annotations: { summary: "E2E-ALERT Pod default/web-0 is crash looping." },
      startsAt,
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "https://prometheus.example.com/graph",
      fingerprint,
    });
    const body = JSON.stringify({
      version: "4",
      groupKey: "{}:{alertname=\"KubePodCrashLooping\"}",
      status: "firing",
      receiver: "penelope",
      externalURL: "https://alertmanager.example.com",
      alerts: [alert("e2e0000000000001", {}), alert("e2e0000000000002", { sender: "penelope" })],
    });
    const webhook = (authorization: string) =>
      fromOutside("POST", url.href, { authorization, "content-type": "application/json" }, body).status;

    assert.equal(webhook("Bearer wrong"), 401);
    assert.equal(fromOutside("GET", new URL("/healthz", url).href).text, "ok");
    assert.equal(webhook(`Bearer ${token}`), 200);
    await replied("E2E-REPLY-ALERT");
    assert.equal(webhook(`Bearer ${token}`), 200, "Alertmanager's resend is taken as received");

    const day = startsAt.slice(0, 10);
    const file = `/sources/alertmanager/kubepodcrashlooping/${day}.jsonl`;
    const lines = exec("sandbox", `cat ${file}`).stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "one line: the resend is a duplicate and the agent's own alert is dropped");
    assert.equal(lines[0].id, `e2e0000000000001/firing/${startsAt}`);
    assert.equal(lines[0].payload.externalURL, "https://alertmanager.example.com");
    assert.equal(lines[0].payload.labels.alertname, "KubePodCrashLooping");

    const calls = await callsFor("E2E-ALERT", 0);
    assert.equal(calls.length, 1, "one turn for the alert");
    const [line] = eventLines(where(calls[0]!).input);
    assert.ok(line && line.kind === undefined, JSON.stringify(line));
    assert.deepEqual(
      [line.source, line.stream, line.delivery, line.summary, line.appended],
      ["alertmanager", "kubepodcrashlooping", "now", "[FIRING critical] KubePodCrashLooping: E2E-ALERT Pod default/web-0 is crash looping.", { path: file, lines: [1, 1] }],
    );
  }));

  it("takes GitHub's request for a review in the receivers, and brings it into a turn as a batch", track(async () => {
    // Guards against: a delivery reaching the agent without GitHub's signature, a request for a review not reaching a
    // turn as a batch, a redelivery written twice, or a pull request outside the authors coming in.
    const secret = readFileSync(join(RUN_DIR, "github-webhook-secret"), "utf8").trim();
    const url = new URL("/v1/webhooks/github", pod.url);
    url.port = "8081";
    const repo = { id: 1, name: "example-repo", full_name: "example-org/example-repo", owner: { login: "example-org", type: "Organization" } };
    const reviewRequested = (author: string) => ({
      action: "review_requested",
      number: 7,
      pull_request: {
        html_url: "https://github.com/example-org/example-repo/pull/7",
        number: 7,
        state: "open",
        title: "E2E-GITHUB Update dependency example to v1.2.3",
        user: { login: author, type: "Bot" },
        body: "This PR contains the following updates.",
        head: { ref: "renovate/example-1.x", sha: "0123456789abcdef0123456789abcdef01234567", repo },
        base: { ref: "main", sha: "89abcdef0123456789abcdef0123456789abcdef", repo },
      },
      requested_reviewer: { login: "example-operator", type: "User" },
      repository: repo,
      sender: { login: author, type: "Bot" },
    });
    const deliver = (event: string, delivery: string, body: string, signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`) =>
      fromOutside("POST", url.href, {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": signature,
      }, body).status;

    const body = JSON.stringify(reviewRequested("renovate[bot]"));
    const delivery = randomUUID();
    assert.equal(deliver("pull_request", delivery, body, `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`), 401);
    assert.equal(deliver("ping", randomUUID(), JSON.stringify({ zen: "Design for failure.", hook_id: 1 })), 200);
    assert.equal(deliver("pull_request", randomUUID(), JSON.stringify(reviewRequested("someone-else"))), 200, "not an author's: taken and dropped");
    const sent = new Date().toISOString();
    assert.equal(deliver("pull_request", delivery, body), 200);
    assert.equal(deliver("pull_request", delivery, body), 200, "a redelivery is taken as received");

    const file = `/sources/github/example-org.example-repo/${sent.slice(0, 10)}.jsonl`;
    const lines = exec("sandbox", `cat ${file}`).stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "one line: the redelivery is a duplicate and the other author's is dropped");
    assert.deepEqual([lines[0].id, lines[0].payload.delivery, lines[0].payload.reviewer, lines[0].payload.author], [delivery, delivery, "example-operator", "renovate[bot]"]);
    assert.equal(JSON.stringify(lines[0]).includes("This PR contains"), false, "the body of the pull request is left out");

    // The batch waits for its quiet minutes; a now brings it along, as the receiver's batch was brought, rather than
    // the test waiting them out. The batch's own wait is the queue's unit tests'.
    assert.equal(intake({ source: "e2e", stream: "github", id: "github-now", occurred_at: new Date().toISOString(), summary: "E2E-GITHUB-NOW ping", delivery: "now", payload: {} }), "202");
    await replied("E2E-REPLY-GITHUB");
    const calls = await callsFor("E2E-GITHUB", 0);
    assert.equal(calls.length, 1, "one turn for the request and the now");
    const turn = eventLines(where(calls[0]!).input);
    assert.ok(turn.some((line) => line.kind === undefined && line.summary === "E2E-GITHUB-NOW ping"), JSON.stringify(turn));
    const line = turn.find((line) => line.kind === "batch");
    assert.ok(line && line.kind === "batch", JSON.stringify(turn));
    assert.deepEqual(
      [line.source, line.stream, line.count, line.summary, line.appended],
      ["github", "example-org.example-repo", 1, "[review requested] example-org/example-repo#7: E2E-GITHUB Update dependency example to v1.2.3", [{ path: file, lines: [1, 1] }]],
    );
  }));

  it("receives Slack over Socket Mode, fills in after a reconnection, and acknowledges what the intake took", track(async () => {
    // Guards against: the receivers not reaching Slack under its own names, an envelope acknowledged before the intake
    // took it, a retry written twice, a file not sent beside its message, the fill-in after a reconnection missing
    // what was said while away, the turn given Slack's payloads rather than their drawing, or the reading CLI not
    // drawing it in the sandbox.
    const connected = await eventually("the Slack connection", async () => {
      const seen = await outside.slack();
      return seen.open > 0 ? seen : undefined;
    });
    const tokenOf = (method: string) => connected.calls.find((call) => call.method === method)?.token;
    assert.equal(tokenOf("apps.connections.open"), "app", "the connection is opened with the app-level token");
    assert.equal(tokenOf("auth.test"), "bot", "the bot is asked who it is with the bot token");

    // Said while the receivers were away: fetched again after the reconnection Slack asks for.
    const now = Date.now() / 1000;
    const away = `${Math.floor(now) - 120}.000100`;
    await outside.slackHistory([{ type: "message", user: "U0ALICE", text: "E2E-SLACK-AWAY said while away", ts: away }]);
    await outside.slackDisconnect();
    await eventually("the second connection", async () => ((await outside.slack()).connections >= connected.connections + 1 ? true : undefined));

    // A mention with an image, sent twice as Slack retries it.
    const ts = `${Math.floor(now)}.000200`;
    const envelope = {
      envelope_id: "e2e-envelope-1",
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload: {
        token: "e2e-verification-token",
        team_id: "T0E2E",
        api_app_id: "A0E2E",
        type: "event_callback",
        event_id: "Ev0E2E0001",
        event_time: Math.floor(now),
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C0DEV",
          channel_type: "channel",
          user: "U0ALICE",
          text: "<@U0E2E> E2E-SLACK-MENTION what is this?",
          ts,
          files: [{ id: "F0E2E", name: "e2e.png", mimetype: "image/png", size: 70, url_private_download: "https://files.slack.com/files-pri/T0E2E-F0E2E/e2e.png" }],
        },
      },
    };
    await outside.slackSend(envelope);
    await eventually("the ack", async () => ((await outside.slack()).acks.includes("e2e-envelope-1") ? true : undefined));
    await outside.slackSend({ ...envelope, envelope_id: "e2e-envelope-2", retry_attempt: 1, retry_reason: "timeout" });
    await eventually("the retry's ack", async () => ((await outside.slack()).acks.includes("e2e-envelope-2") ? true : undefined));
    assert.ok((await outside.slack()).downloads.every((download) => download.token === "bot"), "the file is fetched with the bot token");

    const file = `/sources/slack/work.dev/${new Date().toISOString().slice(0, 10)}.jsonl`;
    const lines = exec("sandbox", `cat ${file}`).stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.id, line.payload.type, line.payload.fetched ?? false]),
      [
        [`work/C0DEV/${away}`, "message", true],
        [`work/C0DEV/${ts}`, "message", false],
      ],
      "one line each: the retry is a duplicate",
    );
    assert.equal(lines[1].attachments.length, 1);
    assert.equal(exec("sandbox", `head -c 8 ${lines[1].attachments[0]} | od -An -tx1`).stdout.trim(), "89 50 4e 47 0d 0a 1a 0a", "the image is beside it");

    // The mention is now, and brings the fetched message with it.
    await replied("E2E-REPLY-SLACK");
    const [call] = await callsFor("E2E-SLACK-MENTION", 0);
    // The mention is inline, so its image goes in beside the text of this input.
    const user = call!.messages.findLast((message) => message.role === "user");
    assert.ok(Array.isArray(user?.content) && user.content.some((part) =>
      part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,")), "the image goes in beside the text");
    const events = eventLines(where(call!).input);
    const mention = events.find((line): line is TurnEvent => line.kind === undefined && line.source === "slack" && line.delivery === "now");
    assert.ok(mention?.text !== undefined, JSON.stringify(events));

    // Both come drawn from /sources (ADR-0029): the mention with what led up to it, the fetched message in its batch line.
    assert.equal(mention.appended, undefined, "an inline event carries its text");
    assert.match(mention.text, /^work #dev \(channel C0DEV, stream work\.dev\)\n/);
    assert.match(mention.text, /E2E U0ALICE \[[0-9.]+\] \(earlier\): "E2E-SLACK-AWAY said while away"/);
    assert.match(mention.text, /: @E2E U0E2E E2E-SLACK-MENTION what is this\?\n {2}file e2e\.png: \/sources\/slack\/files\/\d+-e2e\.png\n/);
    const batch = events.find((line): line is TurnBatch => line.kind === "batch" && line.source === "slack");
    assert.ok(batch?.text !== undefined, JSON.stringify(events));
    assert.equal(batch.count, 1);
    assert.match(batch.text, /^work #dev [^\n]*\n- [^\n]*E2E U0ALICE \[[0-9.]+\]: E2E-SLACK-AWAY said while away\n$/);

    // The CLI in the sandbox draws the channel as it stands.
    const drawn = exec("sandbox", "TZ=UTC slackctl history work.dev").stdout;
    assert.match(drawn, /^work #dev \(channel C0DEV, stream work\.dev\)\n/);
    assert.match(drawn, /E2E U0ALICE \[[0-9.]+\]: E2E-SLACK-AWAY said while away/);
    assert.match(drawn, /: @E2E U0E2E E2E-SLACK-MENTION what is this\?\n {2}file e2e\.png: \/sources\/slack\/files\/\d+-e2e\.png\n/);
  }));

  it("posts to Slack from the sandbox with slackctl: the text, in a thread, with a face, and images in three steps", track(async () => {
    // Guards against: a post not reaching Slack with the real bot token, its text changed on the way, the face's URL
    // not being one the outside can fetch, or a token sent to where the images go up (ADR-0033).
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    exec("sandbox", `echo ${pixel} | base64 -d > /home/agent/e2e-post.png`, { check: true });
    const text = "E2E-SLACK-POST おはよう。\n今日の予定は *2 件*。";
    const posted = exec("sandbox", "slackctl post --channel '#dev' --thread 1794821000.000200 --face happy --image /home/agent/e2e-post.png", { input: `${text}\n`, check: false });
    assert.equal(posted.status, 0, posted.stderr);
    const [message, file] = posted.stdout.trim().split("\n").map((line) => line.split("\t"));
    assert.deepEqual(message!.slice(0, 2), ["message", "C0DEV"]);
    assert.match(message![3] ?? "", /^https:\/\/e2e\.slack\.com\/archives\/C0DEV\/p\d+$/);
    assert.deepEqual(file!.slice(0, 1).concat(file!.slice(2)), ["file", "e2e-post.png"]);

    const slack = await outside.slack();
    const calls = slack.calls.filter((call) => ["users.conversations", "chat.postMessage", "files.getUploadURLExternal", "files.completeUploadExternal"].includes(call.method) && call.token !== "app");
    const post = calls.find((call) => call.method === "chat.postMessage");
    assert.ok(post, JSON.stringify(slack.calls.map((call) => call.method)));
    assert.equal(post.token, "bot", "the Sentinel put the real bot token in place of the surrogate");
    assert.equal(post.args.text, text);
    assert.equal(post.args.channel, "C0DEV");
    assert.equal(post.args.thread_ts, "1794821000.000200");
    const complete = calls.find((call) => call.method === "files.completeUploadExternal");
    assert.equal(complete?.token, "bot");
    assert.equal(complete.args.channel_id, "C0DEV");
    assert.equal(complete.args.thread_ts, "1794821000.000200");
    assert.equal(complete.args.icon_url, post.args.icon_url);
    assert.equal(calls.find((call) => call.method === "files.getUploadURLExternal")?.args.filename, "e2e-post.png");
    assert.deepEqual(slack.uploads.map(({ token, length, png }) => ({ token, length, png })), [{ token: "none", length: 70, png: true }]);

    // The icon is the PNG of the avatar's face at the public URL, which Slack fetches from the outside.
    const icon = new URL(post.args.icon_url ?? "");
    assert.equal(icon.origin, new URL(pod.url).origin);
    assert.match(icon.pathname, /^\/api\/agent\/icons\/happy\.png$/);
    const face = new Browser().request(icon.pathname);
    assert.equal(face.status, 200);
    assert.equal(face.headers["content-type"], "image/png");
    assert.match(exec("sandbox", "slackctl faces").stdout, new RegExp(`^happy\\t${icon.href.replaceAll(".", "\\.")}$`, "m"));
  }));

  it("takes an A2A request, asks back, and returns the image the sender provides in its answer", track(async () => {
    // Guards against: a request of an allowed ServiceAccount, checked by TokenReview or by gated's assertion, not reaching
    // a turn; her question or answer not reaching the sender's task; or a ServiceAccount not on the allow-list getting in.
    const token = (name: string) => readFileSync(join(RUN_DIR, name), "utf8").trim();
    const host = new URL(pod.url).hostname;
    const bearer = { authorization: `Bearer ${token("sender-token")}` };
    const gated = async (subject = "system:serviceaccount:e2e:claude") => ({ "gated-assertion": await outside.assertion(subject, host) });
    const message = (id: string, text: string, more: Record<string, string> = {}) => ({ message: { messageId: id, role: "ROLE_USER", parts: [{ text }], ...more } });

    // The card, without a token: who she is and where to call.
    const card = JSON.parse(fromOutside("GET", new URL("/.well-known/agent-card.json", pod.url).href).text) as {
      name: string;
      description: string;
      supportedInterfaces: { url: string }[];
    };
    assert.equal(card.name, "E2E Agent");
    assert.equal(card.description, "The end-to-end test's agent.");
    assert.equal(card.supportedInterfaces[0]!.url, `${pod.url}/a2a/`);

    // A ServiceAccount that is not a sender is refused, by either check; so is a call with nothing.
    const strangers: Record<string, string>[] = [{ authorization: `Bearer ${token("stranger-token")}` }, await gated("system:serviceaccount:e2e:stranger"), {}];
    for (const headers of strangers) {
      const refused = a2aCall("SendMessage", message("e2e-stranger", "E2E-A2A-STRANGER"), headers);
      assert.equal(refused.status, 401, JSON.stringify(headers));
    }

    // The sender asks with its ServiceAccount token, which the backend reviews.
    const sent = a2aCall("SendMessage", message("e2e-a2a-1", "E2E-A2A-ASK look at the alerts"), bearer);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    // SendMessage answers with the task under `task` (or a message under `message`); GetTask with the task itself.
    const task = sent.body.result?.task as { id: string; contextId: string; status: { state: string } };
    assert.equal(task?.status?.state, "TASK_STATE_WORKING", JSON.stringify(sent.body));
    const getTask = async (headers: Record<string, string>) => a2aCall("GetTask", { id: task.id }, headers).body.result;

    // Her turn asks back; the sender reads the question from its task.
    const asking = await eventually("her question", async () => {
      const now = await getTask(bearer);
      return now.status.state === "TASK_STATE_INPUT_REQUIRED" ? now : undefined;
    }, 180_000);
    assert.equal(asking.status.message.parts[0].text, "E2E-A2A-QUESTION");

    // The sender answers through gated, which took its token off and put its assertion in place.
    const reply = message("e2e-a2a-2", "E2E-A2A-ANSWER the backend", { taskId: task.id, contextId: task.contextId });
    const answered = a2aCall("SendMessage", {
      message: { ...reply.message, parts: [...reply.message.parts, { raw: E2E_PNG, mediaType: "image/png", filename: "diagram.png" }] },
    }, await gated());
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.result?.task?.id, task.id, JSON.stringify(answered.body));

    const done = await eventually("her answer", async () => {
      const now = await getTask(await gated());
      return now.status.state === "TASK_STATE_COMPLETED" ? now : undefined;
    }, 180_000);
    const [words, image] = done.artifacts[0].parts;
    assert.equal(words.text, "E2E-A2A-DONE");
    assert.equal(image.raw, E2E_PNG);
    assert.equal(image.mediaType, "image/png");
    assert.match(image.filename, /^\d+-diagram\.png$/);

    // Both messages are a2a events of the sender's stream, appended to /sources, each naming the task.
    const day = new Date().toISOString().slice(0, 10);
    const lines = exec("sandbox", `cat /sources/a2a/claude/${day}.jsonl`).stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.source, line.stream, line.payload.kind, line.payload.task_id, line.payload.text]),
      [
        ["a2a", "claude", "request", task.id, "E2E-A2A-ASK look at the alerts"],
        ["a2a", "claude", "answer", task.id, "E2E-A2A-ANSWER the backend"],
      ],
    );
    // The API server was asked with the backend's own token, and never for the strangers' way in through gated.
    const reviews = await outside.reviews();
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((review) => review.caller === "backend"), JSON.stringify(reviews));
  }));

  it("has a sub-agent started, stopped with a question, told more and closed by the main agent", track(async () => {
    // Guards against: a sub-agent's last words not reaching the main agent as a `self` event, more words not going on
    // in its session, its memory left uncommitted, or the UI not told it was started and closed.
    await send("E2E-SUB-START");
    await replied("E2E-REPLY-SUB", 180_000);

    const agents = stream.events.filter((event) => event.event === "agent").map((event) => event.data);
    assert.deepEqual(agents, [
      { agent: "e2e-sub", purpose: "E2E-SUB-PURPOSE", closed: false },
      { agent: "e2e-sub", purpose: "E2E-SUB-PURPOSE", closed: true },
    ]);
    const own = stream.events
      .filter((event) => event.event === "activity" && (event.data as { agent: string }).agent === "e2e-sub")
      .map((event) => (event.data as { activity: { kind: string } }).activity.kind);
    assert.equal(own.filter((kind) => kind === "turn_start").length, 2, "two runs of the sub-agent on the stream");
    assert.deepEqual((await browser.json<{ agents: unknown[] }>("/api/agents")).body.agents, [], "closed, it is not listed");

    // Each time it stopped, its last words were appended to /sources/self/<name>/ for the main agent.
    const day = new Date().toISOString().slice(0, 10);
    const lines = exec("sandbox", `cat /sources/self/e2e-sub/${day}.jsonl`).stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.source, line.stream, line.id, line.payload]),
      [
        ["self", "e2e-sub", "e2e-sub/1", { reason: "stopped", purpose: "E2E-SUB-PURPOSE", text: "E2E-SUB-QUESTION: which branch?" }],
        ["self", "e2e-sub", "e2e-sub/2", { reason: "stopped", purpose: "E2E-SUB-PURPOSE", text: "E2E-SUB-RESULT: the build is fixed." }],
      ],
    );

    // The sub-agent: its own system prompt and working directory, none of the main agent's tools, one session.
    const sub = (await outside.modelCalls()).filter((call) => where(call).system.includes("You are a sub-agent"));
    assert.ok(sub.length >= 4, "two runs, the first with tool calls");
    assert.ok(where(sub[0]!).system.includes("E2E-SUB-PURPOSE"));
    assert.ok(where(sub[0]!).system.includes("/home/agent/agents/e2e-sub"));
    for (const tool of ["reply", "reply_to_agent", "self_event", "subagent_start"]) {
      assert.ok(!sub.some((call) => call.tools.includes(tool)), `the sub-agent has no ${tool}`);
    }
    assert.ok(JSON.stringify(sub.at(-1)!.messages).includes("E2E-SUB-FIRST"), "more words go on in the same session");

    // What it wrote to /memory was committed at the end of its turn, as its own.
    const log = await eventually("the sub-agent's commit", () => {
      const text = memoryLog();
      return text.includes("notes/e2e-sub.md") ? text : undefined;
    });
    assert.match(log, /Turn [0-9a-f-]{36}\nAgent: e2e-sub\n+notes\/e2e-sub\.md\n/);
  }));

  it("runs a background job and brings its end, with the tail of its output, into a turn", track(async () => {
    // Guards against: a job_start that holds the turn until the command ends, or an end that does not reach the main
    // agent inline with how it ended and its output (ADR-0030).
    await send("E2E-JOB-START");
    await replied("E2E-REPLY-JOB", 180_000);

    // job_start answered with the job and its file, not with what the command printed.
    const [started] = await callsFor("E2E-JOB-START", 1);
    assert.ok(started, "the turn that started the job");
    const result = JSON.stringify(started.messages.filter((message) => message.role === "tool"));
    assert.match(result, /\/home\/agent\/jobs\/[0-9a-f]+\/output\.log/);
    assert.ok(!result.includes("E2E-JOB-42"));

    // The end came as an inline `job` event: its payload, tail and all, is in the turn.
    const [ended] = await callsFor("E2E-JOB-42", 0);
    assert.ok(ended, "a turn from the job's end");
    const line = eventLines(where(ended).input).find((entry) => entry.kind === undefined && entry.source === "job");
    assert.ok(line && line.kind === undefined && line.text !== undefined, where(ended).input);
    assert.equal(line.delivery, "now");
    assert.equal(line.appended, undefined, "inline, so no place to read it from");
    const payload = JSON.parse(line.text) as Record<string, unknown>;
    assert.deepEqual(
      [payload.end, payload.exit_code, payload.command, payload.tail, payload.tail_truncated],
      ["exited", 0, "sleep 2; echo E2E-JOB-$((6 * 7))", "E2E-JOB-42\n", false],
    );
    assert.match(String(payload.output), /^\/home\/agent\/jobs\/[0-9a-f]+\/output\.log$/);
    assert.equal(exec("sandbox", `cat ${payload.output}`).stdout, "E2E-JOB-42\n");

    // And it was appended to /sources/job/ like any other event.
    const day = new Date().toISOString().slice(0, 10);
    const lines = exec("sandbox", `cat /sources/job/${day}.jsonl`).stdout.trim().split("\n").map((text) => JSON.parse(text));
    assert.deepEqual(
      lines.map((entry) => [entry.source, entry.id, entry.summary]),
      [["job", payload.job, "[exit 0] sleep 2; echo E2E-JOB-$((6 * 7))"]],
    );
  }));

  it("asks a named agent in a job and receives its reply with a saved image", track(async () => {
    await send("E2E-ASK-AGENT-START");
    const ended = await eventually("ask-agent's job event", async () => (await callsFor("Describe this diagram", 0))[0], 180_000);
    const line = eventLines(where(ended).input).find((entry) => entry.kind === undefined && entry.source === "job");
    assert.ok(line && line.kind === undefined && line.text);
    const payload = JSON.parse(line.text) as { exit_code: number; tail: string };
    assert.equal(payload.exit_code, 0, payload.tail);
    assert.match(payload.tail, /Reply:\nE2E-ASK-AGENT-DONE\nAgent: E2E Helper \(helper\)\nState: completed\nTask ID: e2e-helper-task/);
    const [path] = JSON.parse(payload.tail.match(/Images: (.+)/)![1]!) as string[];
    assert.match(path!, /^\/home\/agent\/a2a\/e2e-helper-task\/result-\w+\/diagram\.png$/);
    assert.equal(exec("sandbox", `base64 -w0 ${path}`).stdout, E2E_PNG);
  }));

  it("lists a schedule she made in the UI's API, and removes it there for her schedule_list too", track(async () => {
    // Guards against: the UI's list of the schedules not being what her schedule_list sees, or a removal from the UI
    // that she still finds (docs/ui-api.md, "予約").
    await send("E2E-SCHEDULE-ADD");
    await replied("E2E-REPLY-SCHEDULE-ADD");
    const [added] = await callsFor("E2E-SCHEDULE-ADD", 1);
    assert.ok(added, "the turn that added the schedule");
    const made = JSON.parse(textOf(added.messages.findLast((message) => message.role === "tool")!.content)) as { id: string };

    type Entry = { id: string; reason: string; cron?: string; at?: string; next_at: string };
    const listed = browser.json<{ schedules: Entry[] }>("/api/schedules");
    assert.equal(listed.status, 200);
    const [entry] = listed.body.schedules;
    assert.equal(listed.body.schedules.length, 1, JSON.stringify(listed.body));
    assert.deepEqual([entry!.id, entry!.reason, entry!.cron, entry!.at], [made.id, "E2E-SCHEDULE-REASON", "0 9 1 1 *", undefined]);
    assert.ok(Date.parse(entry!.next_at) > Date.now(), `comes due next: ${entry!.next_at}`);

    assert.equal(browser.request(`/api/schedules/${encodeURIComponent(made.id)}`, { method: "DELETE" }).status, 204);
    assert.equal(browser.request(`/api/schedules/${encodeURIComponent(made.id)}`, { method: "DELETE" }).status, 404);
    assert.deepEqual(browser.json<{ schedules: Entry[] }>("/api/schedules").body.schedules, []);

    // She was not told; she finds it gone when she lists them.
    await send("E2E-SCHEDULE-LIST");
    await replied("E2E-REPLY-SCHEDULE-LIST");
    const [list] = await callsFor("E2E-SCHEDULE-LIST", 1);
    assert.ok(list, "the turn that listed the schedules");
    assert.equal(textOf(list.messages.findLast((message) => message.role === "tool")!.content), "[]");
  }));

  it("makes a turn of a heartbeat after the quiet time, and asks nothing before folding it", track(async () => {
    // Guards against: no heartbeat after a quiet stretch (ADR-0031), or a heartbeat's turn with no tool
    // costing a second call for the request before folding. That a second one
    // is counted again from the end of the first one's turn is the backend's unit tests' (test/heartbeat.test.ts).
    // The backend is made again with a heartbeat after a few quiet seconds; the next scenario makes it again without.
    composeEnv.PENELOPE_E2E_HEARTBEAT_SECONDS = "5";
    try {
      stream.close();
      compose(["up", "--detach", "--no-deps", "backend"]);
      await eventually("the backend's health", async () => ((await browser.request("/healthz")).status === 200 ? true : undefined));

      const isHeartbeat = (call: ModelCall) => where(call).input.includes('"source":"heartbeat"');
      const first = await eventually("a heartbeat's turn", async () => (await outside.modelCalls()).find(isHeartbeat));

      const lines = eventLines(where(first!).input);
      assert.equal(lines.length, 1, "the heartbeat alone");
      const [line] = lines as (TurnLine & Record<string, unknown>)[];
      assert.equal(line!.source, "heartbeat");
      assert.equal(line!.delivery, "now");
      assert.equal(line!.summary, "no turn for 5 seconds");
      assert.match(String((line!.appended as { path: string }).path), /^\/sources\/heartbeat\/\d{4}-\d{2}-\d{2}\.jsonl$/);
      assert.ok(where(first!).system.includes("`heartbeat`"), "the system prompt says what a heartbeat is");

      // No turn of the test is asked (outside/model.ts), so any request before folding is the heartbeat's.
      assert.ok(!(await outside.modelCalls()).some((call) => where(call).input.includes("about to be folded")), "no request before folding");
    } finally {
      delete composeEnv.PENELOPE_E2E_HEARTBEAT_SECONDS;
    }
  }));

  it("runs the four stages after sleep and handles a queued message with the wake notice", track(async () => {
    stream.close();
    compose(["up", "--detach", "--no-deps", "backend"]);
    await eventually("the backend's health", async () => ((await browser.request("/healthz")).status === 200 ? true : undefined));
    stream = new Stream();
    await stream.open(browser.cookie!);
    await send("E2E-SLEEP");
    await replied("E2E-SLEEPING");
    await send("E2E-TURN-4");

    await eventually(
      "the curator's turn",
      async () => ((await outside.modelCalls()).some((call) => where(call).system.includes("You are the curator")) ? true : undefined),
      240_000,
    );
    const log = await eventually("handoff.md committed", () => {
      const text = memoryLog();
      return text.includes("handoff.md") && text.includes("INDEX.md") ? text : undefined;
    });
    const reflectionCommit = /Turn [0-9a-f-]{36}\nAgent: main\n+Night-stage: reflection\nNight: ([1-9]\d*)\n+handoff\.md\n/.exec(log);
    assert.ok(reflectionCommit, "the handoff commit identifies the reflection and its night");
    const curatorCommit = /Turn [0-9a-f-]{36}\nAgent: main\n+Night-stage: curator\nNight: ([1-9]\d*)\n+INDEX\.md\n/.exec(log);
    assert.equal(curatorCommit?.[1], reflectionCommit[1], "the curator committed the index in the same night");
    const state = await eventually("the new session", () => {
      const text = exec("sandbox", "cat /home/agent/.pi/agent/sessions/main/current.json", { check: false }).stdout;
      return text.includes('"nightly"') ? (JSON.parse(text) as { file: string; nightly: number }) : undefined;
    });
    assert.equal(typeof state.nightly, "number");
    // The activity record has the night with each of its steps as the runner told them (ADR-0038).
    const night = await eventually("the night in the activity record", () =>
      browser.json<RecordDayResponse>("/api/record?kind=night").body.rows.find((row): row is RecordNight => row.kind === "night"),
    );
    const { reflection, verifier, curator, session } = night.stages;
    assert.deepEqual([reflection.result, verifier.result, curator.result, session.result], ["done", "done", "done", "done"]);

    await replied("E2E-REPLY-4");
    const [first] = await callsFor("E2E-TURN-4", 0);
    const sent = where(first!);
    assert.ok(eventLines(sent.input).some((event) => event.source === "wake"), "the queued message reaches the wake turn");
    assert.ok(sent.system.includes("E2E-HANDOFF: the next session starts from here."), "handoff.md is in the new system prompt");
    assert.ok(!JSON.stringify(first!.messages).includes("E2E-TURN-1"), "the day's session is left behind");
  }));
});
