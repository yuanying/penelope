import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

const VAPID = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const files: Record<string, string> = {
  "/secrets/vapid.pem": VAPID,
  "/secrets/not-a-key.pem": "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
  "/secrets/sandbox-token": "real-token\n",
  "/secrets/github-secret": "client-secret\n",
  "/sa/token": "backend-sa-token\n",
  "/sa/ca.crt": "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
};
const read = (file: string) => {
  const content = files[file];
  if (content === undefined) throw new Error(`ENOENT: ${file}`);
  return content;
};

describe("the configuration", () => {
  it("has a default for everything but the secrets and the owner", () => {
    const config = loadConfig({}, read);
    assert.deepEqual(config, {
      databasePath: "/var/lib/penelope/backend.sqlite",
      assetsDir: "/var/lib/penelope/assets",
      sourcesDir: "/sources",
      memoryDir: "/memory",
      intakeSocket: "/run/penelope/intake/backend.sock",
      sandboxSocket: "/run/penelope/sandbox/backend.sock",
      listen: { host: "0.0.0.0", port: 8080 },
      publicUrl: undefined,
      sandboxToken: undefined,
      github: undefined,
      timeZone: "UTC",
      awakeHours: "07:00-23:00",
      nightly: "0 4 * * *",
      reviewWeekday: 0,
      batch: { quietMs: 5 * 60_000, maxMs: 30 * 60_000 },
      redeliverMs: 5 * 60_000,
      heartbeatMs: undefined,
      builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now", job: "now" },
      inline: new Set(["ui", "job", "control"]),
      gitAuthor: { name: "penelope-backend", email: "backend@penelope.invalid" },
      memoryView: { ownerEmail: undefined, ownerName: undefined, targetBytes: 16384, fileLimitBytes: 65536 },
      avatar: { name: undefined, chosen: undefined, from: ["/app/avatars"] },
      webDir: "/app/web",
      a2a: undefined,
      webPush: undefined,
    });
  });

  it("reads every setting from its variable and the secrets from their files", () => {
    const config = loadConfig(
      {
        PENELOPE_DATABASE: "/data/b.sqlite",
        PENELOPE_SOURCES_DIR: "/s",
        PENELOPE_ASSETS_DIR: "/data/assets",
        PENELOPE_MEMORY_DIR: "/m",
        PENELOPE_INTAKE_SOCKET: "/run/i.sock",
        PENELOPE_SANDBOX_SOCKET: "/run/s.sock",
        PENELOPE_LISTEN: "[::]:9090",
        PENELOPE_PUBLIC_URL: "https://penelope.example.com/",
        PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/sandbox-token",
        PENELOPE_GITHUB_CLIENT_ID: "client",
        PENELOPE_GITHUB_CLIENT_SECRET_FILE: "/secrets/github-secret",
        PENELOPE_OWNER_GITHUB_ID: "4242",
        PENELOPE_TIME_ZONE: "Asia/Tokyo",
        PENELOPE_AWAKE_HOURS: "08:00-22:00",
        PENELOPE_NIGHTLY_CRON: "30 3 * * *",
        PENELOPE_BATCH_QUIET_MINUTES: "2",
        PENELOPE_BATCH_MAX_MINUTES: "10",
        PENELOPE_REDELIVER_MINUTES: "3",
        PENELOPE_DELIVERY_CRON: "batch",
        PENELOPE_DELIVERY_JOB: "batch",
        PENELOPE_INLINE_SOURCES: "ui, self",
        PENELOPE_GIT_AUTHOR_NAME: "backend",
        PENELOPE_GIT_AUTHOR_EMAIL: "backend@example.com",
        PENELOPE_AVATARS_DIR: "/avatars",
        PENELOPE_AVATAR: "iris",
        PENELOPE_WEB_DIR: "/srv/web",
      },
      read,
    );
    assert.equal(config.databasePath, "/data/b.sqlite");
    assert.equal(config.assetsDir, "/data/assets");
    assert.deepEqual(config.listen, { host: "::", port: 9090 });
    assert.equal(config.publicUrl, "https://penelope.example.com");
    assert.equal(config.sandboxToken, "real-token");
    assert.deepEqual(config.github, {
      clientId: "client",
      clientSecret: "client-secret",
      ownerId: 4242,
      callbackUrl: "https://penelope.example.com/auth/github/callback",
    });
    assert.equal(config.timeZone, "Asia/Tokyo");
    assert.deepEqual(config.batch, { quietMs: 2 * 60_000, maxMs: 10 * 60_000 });
    assert.equal(config.redeliverMs, 3 * 60_000);
    assert.equal(config.builtinDelivery.cron, "batch");
    assert.equal(config.builtinDelivery.job, "batch");
    assert.equal(config.builtinDelivery.ui, "now");
    // control is always inline: the runner needs what it says.
    assert.deepEqual(config.inline, new Set(["ui", "self", "control"]));
    assert.deepEqual(config.gitAuthor, { name: "backend", email: "backend@example.com" });
    // The deployment's avatars are looked in before the image's (ADR-0036).
    assert.deepEqual(config.avatar, { name: undefined, chosen: "iris", from: ["/avatars", "/app/avatars"] });
    assert.equal(config.webDir, "/srv/web");
  });

  it("takes the agent's name from the settings, and looks for the avatar in the image alone without a place of the deployment's", () => {
    assert.deepEqual(loadConfig({ PENELOPE_AGENT_NAME: " Kestrel ", PENELOPE_AVATAR: "iris" }, read).avatar, { name: "Kestrel", chosen: "iris", from: ["/app/avatars"] });
  });

  it("takes the time zone from TZ when it has none of its own", () => {
    assert.equal(loadConfig({ TZ: "Europe/Paris" }, read).timeZone, "Europe/Paris");
  });

  it("refuses a login half set up, naming what is missing", () => {
    assert.throws(
      () => loadConfig({ PENELOPE_GITHUB_CLIENT_ID: "client", PENELOPE_PUBLIC_URL: "https://penelope.example.com" }, read),
      (error: unknown) =>
        error instanceof ConfigError &&
        /PENELOPE_GITHUB_CLIENT_SECRET_FILE/.test(error.message) &&
        /PENELOPE_OWNER_GITHUB_ID/.test(error.message),
    );
  });

  it("has a heartbeat only when its minutes are set (ADR-0031)", () => {
    assert.equal(loadConfig({ PENELOPE_HEARTBEAT_MINUTES: "60" }, read).heartbeatMs, 60 * 60_000);
  });

  it("takes the heartbeat in seconds for the tests, but not with its minutes too", () => {
    assert.equal(loadConfig({ PENELOPE_HEARTBEAT_SECONDS: "5" }, read).heartbeatMs, 5_000);
    assert.throws(() => loadConfig({ PENELOPE_HEARTBEAT_MINUTES: "1", PENELOPE_HEARTBEAT_SECONDS: "5" }, read), ConfigError);
  });

  it("takes a nightly cron with a field of seconds first, for the tests", () => {
    assert.equal(loadConfig({ PENELOPE_NIGHTLY_CRON: "*/10 * * * * *" }, read).nightly, "*/10 * * * * *");
  });

  it("refuses values it cannot use", () => {
    for (const env of [
      { PENELOPE_LISTEN: "8080" },
      { PENELOPE_TIME_ZONE: "Mars/Olympus" },
      { PENELOPE_AWAKE_HOURS: "morning" },
      { PENELOPE_NIGHTLY_CRON: "at night" },
      { PENELOPE_BATCH_QUIET_MINUTES: "-1" },
      { PENELOPE_HEARTBEAT_MINUTES: "0" },
      { PENELOPE_HEARTBEAT_MINUTES: "an hour" },
      { PENELOPE_HEARTBEAT_SECONDS: "0" },
      { PENELOPE_HEARTBEAT_SECONDS: "1.5" },
      { PENELOPE_NIGHTLY_CRON: "0 0 4 * * * *" },
      { PENELOPE_DELIVERY_UI: "later" },
      { PENELOPE_OWNER_GITHUB_ID: "someone" },
      { PENELOPE_PUBLIC_URL: "not a url" },
      { PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/missing" },
      // An avatar is named as a directory, never a path.
      { PENELOPE_AVATARS_DIR: "/avatars", PENELOPE_AVATAR: "../secrets" },
    ]) {
      assert.throws(() => loadConfig(env, read), ConfigError, JSON.stringify(env));
    }
  });

  it("refuses an empty secret", () => {
    files["/secrets/empty"] = "\n";
    assert.throws(() => loadConfig({ PENELOPE_SANDBOX_TOKEN_FILE: "/secrets/empty" }, read), ConfigError);
  });

  describe("Web Push", () => {
    it("is set up with the VAPID key's file, and names the backend by its public URL", () => {
      const config = loadConfig({ PENELOPE_PUBLIC_URL: "https://penelope.example.com/", PENELOPE_WEB_PUSH_VAPID_KEY_FILE: "/secrets/vapid.pem" }, read);
      assert.deepEqual(config.webPush, { vapidKey: VAPID.trim(), subject: "https://penelope.example.com" });
    });

    it("does not start with a key it cannot use, or without the public URL", () => {
      for (const env of [
        { PENELOPE_PUBLIC_URL: "https://penelope.example.com", PENELOPE_WEB_PUSH_VAPID_KEY_FILE: "/secrets/missing.pem" },
        { PENELOPE_PUBLIC_URL: "https://penelope.example.com", PENELOPE_WEB_PUSH_VAPID_KEY_FILE: "/secrets/not-a-key.pem" },
        { PENELOPE_PUBLIC_URL: "https://penelope.example.com", PENELOPE_WEB_PUSH_VAPID_KEY_FILE: "/secrets/github-secret" },
        { PENELOPE_WEB_PUSH_VAPID_KEY_FILE: "/secrets/vapid.pem" },
      ]) {
        assert.throws(() => loadConfig(env, read), ConfigError, JSON.stringify(env));
      }
    });
  });

  describe("the A2A way in", () => {
    const base = { PENELOPE_PUBLIC_URL: "https://penelope.example.com", PENELOPE_A2A_SENDERS: "agents/claude, natsumi/natsumi" };
    const gated = { PENELOPE_A2A_AUTH: "gated-assertion", PENELOPE_A2A_GATED_ISSUER: "https://auth.example.com", PENELOPE_A2A_GATED_JWKS_URL: "https://auth.example.com/__gated/jwks.json" };
    const cluster = { KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443", PENELOPE_KUBERNETES_TOKEN_FILE: "/sa/token", PENELOPE_KUBERNETES_CA_FILE: "/sa/ca.crt" };

    it("is closed without senders", () => {
      // Guards against: the way in opened by a check set up with nobody allowed (ADR-0010).
      assert.equal(loadConfig({ ...gated, PENELOPE_PUBLIC_URL: "https://penelope.example.com" }, read).a2a, undefined);
    });

    it("checks gated's assertion for the public host, with the limits' defaults", () => {
      const { a2a } = loadConfig({ ...base, ...gated }, read);
      assert.deepEqual(a2a, {
        senders: ["agents/claude", "natsumi/natsumi"],
        gated: { issuer: "https://auth.example.com", jwksUrl: "https://auth.example.com/__gated/jwks.json", audience: "penelope.example.com" },
        tokenReview: undefined,
        description: "",
        url: "https://penelope.example.com/a2a/",
        limits: { deadlineMs: 24 * 3_600_000, maxOpenTasks: 3 },
      });
    });

    it("reviews tokens with the API server of the cluster it runs in, for the audiences set", () => {
      const { a2a } = loadConfig({ ...base, ...cluster, PENELOPE_A2A_AUTH: "tokenreview", PENELOPE_A2A_AUDIENCES: "https://penelope.example.com, https://auth.example.com" }, read);
      assert.deepEqual(a2a?.tokenReview, {
        kubernetes: { url: "https://10.0.0.1:443", tokenFile: "/sa/token", ca: files["/sa/ca.crt"] },
        audiences: ["https://penelope.example.com", "https://auth.example.com"],
      });
      assert.equal(a2a?.gated, undefined);
    });

    it("may check both ways at once, and reads the limits and the description", () => {
      const { a2a } = loadConfig(
        {
          ...base,
          ...gated,
          ...cluster,
          PENELOPE_A2A_AUTH: "gated-assertion,tokenreview",
          PENELOPE_A2A_AUDIENCES: "https://penelope.example.com",
          PENELOPE_KUBERNETES_URL: "https://kubernetes.example.com:6443",
          PENELOPE_A2A_DESCRIPTION: "The cluster's operator.",
          PENELOPE_A2A_DEADLINE_HOURS: "6",
          PENELOPE_A2A_MAX_OPEN_TASKS: "1",
        },
        read,
      );
      assert.ok(a2a?.gated && a2a.tokenReview);
      assert.equal(a2a.tokenReview.kubernetes.url, "https://kubernetes.example.com:6443");
      assert.deepEqual(a2a.tokenReview.audiences, ["https://penelope.example.com"]);
      assert.equal(a2a.description, "The cluster's operator.");
      assert.deepEqual(a2a.limits, { deadlineMs: 6 * 3_600_000, maxOpenTasks: 1 });
    });

    it("does not start with senders but no way to check them, or a check it cannot make", () => {
      // Guards against: a way in that lets everyone in, or nobody, without saying so at the start.
      for (const env of [
        { ...base },
        { ...base, PENELOPE_A2A_AUTH: "password" },
        { ...base, PENELOPE_A2A_AUTH: "gated-assertion" },
        { ...base, ...gated, PENELOPE_PUBLIC_URL: undefined },
        { ...base, PENELOPE_A2A_AUTH: "tokenreview", PENELOPE_A2A_AUDIENCES: "https://penelope.example.com" },
        { ...base, ...cluster, PENELOPE_A2A_AUTH: "tokenreview", PENELOPE_A2A_AUDIENCES: "https://penelope.example.com", PENELOPE_KUBERNETES_TOKEN_FILE: "/sa/missing" },
        // Without an audience of its own, the API server's would let in the token every Pod of the ServiceAccount is given.
        { ...base, ...cluster, PENELOPE_A2A_AUTH: "tokenreview" },
        { ...base, ...gated, PENELOPE_A2A_SENDERS: "claude" },
        { ...base, ...gated, PENELOPE_A2A_SENDERS: "a/claude,b/claude" },
        { ...base, ...gated, PENELOPE_A2A_MAX_OPEN_TASKS: "0" },
      ]) {
        assert.throws(() => loadConfig(env, read), ConfigError, JSON.stringify(env));
      }
    });
  });
});
