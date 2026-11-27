import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";

const TOKEN_FILE = "/run/secrets/penelope-receivers/alertmanager-token";

function load(config: unknown, files: Record<string, string> = {}) {
  const all: Record<string, string> = { "/etc/receivers.json": typeof config === "string" ? config : JSON.stringify(config), [TOKEN_FILE]: "token\n", ...files };
  return loadConfig({ PENELOPE_RECEIVERS_CONFIG: "/etc/receivers.json" }, (path) => {
    const text = all[path];
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
    return text;
  });
}

function refused(config: unknown, pattern: RegExp, files?: Record<string, string>) {
  assert.throws(() => load(config, files), (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.match(error.message, pattern);
    assert.equal(error.message.includes("\n"), false, "one line");
    return true;
  });
}

const fraction = { name: "fraction", plugin: "alertmanager", settings: { token_file: TOKEN_FILE } };

describe("the receivers' settings", () => {
  test("are read from /etc/penelope/receivers/config.json unless PENELOPE_RECEIVERS_CONFIG says otherwise", () => {
    assert.equal(DEFAULT_CONFIG_FILE, "/etc/penelope/receivers/config.json");
    const read: string[] = [];
    loadConfig({}, (path) => {
      read.push(path);
      return "{}";
    });
    assert.deepEqual(read, [DEFAULT_CONFIG_FILE]);
  });

  test("have the defaults of docs/receivers.md", () => {
    const config = load({});
    assert.deepEqual(
      { listen: config.listen, intake: config.intake, intakeTimeoutMs: config.intakeTimeoutMs, activations: config.activations },
      { listen: { host: "0.0.0.0", port: 8081 }, intake: "/run/penelope/intake/backend.sock", intakeTimeoutMs: 10_000, activations: [] },
    );
  });

  test("take the example of docs/receivers.md, with source defaulting to the plugin's name", () => {
    const config = load({ plugins: [fraction] });
    assert.equal(config.activations.length, 1);
    const [activation] = config.activations;
    assert.deepEqual([activation!.name, activation!.plugin, activation!.source, activation!.kind], ["fraction", "alertmanager", "alertmanager", "webhook"]);
    assert.equal(activation!.kind === "webhook" && typeof activation!.handle, "function");
  });

  test("take the GitHub plugin of the example of docs/receivers.md beside Alertmanager", () => {
    const secret = "/run/secrets/penelope-receivers/github-webhook-secret";
    const githubPlugin = { name: "github", plugin: "github", settings: { secret_file: secret, authors: ["renovate[bot]", "example-bot[bot]"], reviewers: ["example-operator"] } };
    const config = load({ plugins: [fraction, githubPlugin] }, { [secret]: "secret\n" });
    assert.deepEqual(config.activations.map((activation) => [activation.name, activation.plugin, activation.source, activation.kind]), [
      ["fraction", "alertmanager", "alertmanager", "webhook"],
      ["github", "github", "github", "webhook"],
    ]);
    refused({ plugins: [fraction, { ...githubPlugin, settings: { ...githubPlugin.settings, reviewers: [] } }] }, /^plugins\[1\]\.settings\.reviewers: /, { [secret]: "secret\n" });
  });

  test("take two of one plugin under other names and sources", () => {
    const config = load({ plugins: [fraction, { ...fraction, name: "lab", source: "alertmanager-lab" }] });
    assert.deepEqual(config.activations.map((activation) => activation.source), ["alertmanager", "alertmanager-lab"]);
  });

  test("take listen, intake and intake_timeout_seconds", () => {
    const config = load({ listen: "[::]:9000", intake: "/tmp/intake.sock", intake_timeout_seconds: 3 });
    assert.deepEqual([config.listen, config.intake, config.intakeTimeoutMs], [{ host: "::", port: 9000 }, "/tmp/intake.sock", 3000]);
    assert.deepEqual(load({ listen: "127.0.0.1:0" }).listen, { host: "127.0.0.1", port: 0 });
  });
});

describe("the receivers do not start on settings", () => {
  test("that cannot be read or are not a JSON object", () => {
    assert.throws(() => loadConfig({ PENELOPE_RECEIVERS_CONFIG: "/nowhere.json" }, () => { throw new Error("ENOENT"); }), ConfigError);
    refused("{", /JSON/);
    refused([], /object/);
  });

  test("with a field they do not know, at the top or in a plugin's activation", () => {
    refused({ listn: "0.0.0.0:8081" }, /^listn: /);
    refused({ plugins: [{ ...fraction, setting: {} }] }, /^plugins\[0\]\.setting: /);
  });

  test("with a field it does not know in a plugin's settings", () => {
    refused({ plugins: [{ ...fraction, settings: { ...fraction.settings, tokn: "x" } }] }, /^plugins\[0\]\.settings\.tokn: /);
  });

  test("with a listen, an intake or an intake_timeout_seconds they cannot use", () => {
    for (const listen of ["8081", "0.0.0.0", "0.0.0.0:http", "0.0.0.0:70000", "::8081", ":8081", 8081]) refused({ listen }, /^listen: /);
    for (const intake of ["", 1]) refused({ intake }, /^intake: /);
    for (const seconds of [0, -1, 1.5, "10"]) refused({ intake_timeout_seconds: seconds }, /^intake_timeout_seconds: /);
    refused({ plugins: {} }, /^plugins: /);
  });

  test("with a plugin they do not know", () => {
    refused({ plugins: [{ ...fraction, plugin: "irc" }] }, /^plugins\[0\]\.plugin: /);
    refused({ plugins: [{ name: "fraction" }] }, /^plugins\[0\]\.plugin: /);
  });

  test("with a name they cannot use in the URL, or one given twice", () => {
    for (const name of ["", "-fraction", "Fraction", "a_b", "a.b", "a".repeat(33), 1]) refused({ plugins: [{ ...fraction, name }] }, /^plugins\[0\]\.name: /);
    refused({ plugins: [fraction, { ...fraction, source: "other" }] }, /^plugins\[1\]\.name: /);
    load({ plugins: [{ ...fraction, name: "a".repeat(32) }] });
  });

  test("with a source outside the envelope's letters, one of the backend's own, or one given twice", () => {
    for (const source of ["Alertmanager", ".am", "a/b", "", 1]) refused({ plugins: [{ ...fraction, source }] }, /^plugins\[0\]\.source: /);
    for (const source of ["ui", "cron", "a2a", "self", "control", "heartbeat", "wake"]) refused({ plugins: [{ ...fraction, source }] }, /^plugins\[0\]\.source: /);
    refused({ plugins: [fraction, { ...fraction, name: "lab" }] }, /^plugins\[1\]\.source: /);
  });

  test("with settings that are not an object", () => {
    refused({ plugins: [{ ...fraction, settings: [] }] }, /^plugins\[0\]\.settings: /);
  });

  test("whose key file cannot be read, saying which field without the key", () => {
    refused({ plugins: [{ ...fraction, settings: { token_file: "/missing" } }] }, /^plugins\[0\]\.settings\.token_file: /);
    refused({ plugins: [fraction] }, /^plugins\[0\]\.settings\.token_file: /, { [TOKEN_FILE]: "\n" });
  });
});
