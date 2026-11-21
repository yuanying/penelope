import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, readConfig } from "../src/config.ts";

const required = {
  HOME: "/home/agent",
  PENELOPE_BACKEND_URL: "https://backend.example.com",
  PENELOPE_BACKEND_TOKEN: "surrogate-example-0002",
  PENELOPE_NAME: "Example",
  PENELOPE_ROLE: "the operator of a Kubernetes cluster",
  PENELOPE_OWNER: "Owner",
};

test("the required settings and the defaults", () => {
  const config = readConfig(required);
  assert.deepEqual(config, {
    agent: "main",
    backend: { url: "https://backend.example.com", token: "surrogate-example-0002" },
    identity: { name: "Example", role: "the operator of a Kubernetes cluster", owner: "Owner" },
    home: "/home/agent",
    memoryDir: "/memory",
    sourcesDir: "/sources",
    agentDir: "/home/agent/.pi/agent",
    sessionDir: "/home/agent/.pi/agent/sessions/main",
    subAgentDir: "/home/agent/.pi/agent/sessions/agents",
    jobDir: "/home/agent/jobs",
    jobs: { max: 5, maxSeconds: 86400, tailChars: 4000 },
    promptFileMaxBytes: 65536,
    promptLayerTargetBytes: 16384,
    nightCarryDays: 7,
    imageMaxBytes: 5242880,
    pollWaitSeconds: 30,
    turnFold: true,
    slack: { sources: [], maxChars: 6000 },
    imageSkillsDir: "/opt/penelope/skills",
  });
});

test("the optional settings", () => {
  const config = readConfig({
    ...required,
    PENELOPE_MODEL: "anthropic/claude-opus-5-5",
    PENELOPE_THINKING: "high",
    PENELOPE_MEMORY: "/m",
    PENELOPE_SOURCES: "/s",
    PI_CODING_AGENT_DIR: "/pi",
    PENELOPE_SESSIONS: "/sessions",
    PENELOPE_SUB_AGENTS: "/agents",
    PENELOPE_JOBS: "/jobs",
    PENELOPE_JOBS_MAX: "2",
    PENELOPE_JOB_MAX_SECONDS: "600",
    PENELOPE_JOB_TAIL_CHARS: "100",
    PENELOPE_PROMPT_FILE_MAX_BYTES: "100",
    PENELOPE_POLL_WAIT_SECONDS: "5",
    PENELOPE_IMAGE_MAX_BYTES: "1000",
    PENELOPE_TURN_FOLD: "off",
    PENELOPE_OWNER_SKILLS_DIR: "/skills",
    PENELOPE_CONNECTORS_DIR: "/etc/penelope/connectors",
  });
  assert.equal(config.connectorsDir, "/etc/penelope/connectors");
  assert.equal(config.turnFold, false);
  assert.equal(config.ownerSkillsDir, "/skills");
  assert.equal(config.imageMaxBytes, 1000);
  assert.deepEqual(config.model, { provider: "anthropic", id: "claude-opus-5-5" });
  assert.equal(config.thinkingLevel, "high");
  assert.equal(config.memoryDir, "/m");
  assert.equal(config.sourcesDir, "/s");
  assert.equal(config.agentDir, "/pi");
  assert.equal(config.sessionDir, "/sessions");
  assert.equal(config.subAgentDir, "/agents");
  assert.equal(config.jobDir, "/jobs");
  assert.deepEqual(config.jobs, { max: 2, maxSeconds: 600, tailChars: 100 });
  assert.equal(config.promptFileMaxBytes, 100);
  assert.equal(config.pollWaitSeconds, 5);
});

test("the sessions follow Pi's directory when only that is given", () => {
  assert.equal(readConfig({ ...required, PI_CODING_AGENT_DIR: "/pi" }).sessionDir, "/pi/sessions/main");
});

test("a missing setting is named", () => {
  const { PENELOPE_BACKEND_TOKEN: _, PENELOPE_OWNER: __, ...rest } = required;
  assert.throws(() => readConfig(rest), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /PENELOPE_BACKEND_TOKEN/);
    assert.match(error.message, /PENELOPE_OWNER/);
    return true;
  });
});

test("a model is provider/id", () => {
  assert.throws(() => readConfig({ ...required, PENELOPE_MODEL: "opus" }), ConfigError);
});

test("a thinking level is one Pi knows", () => {
  assert.throws(() => readConfig({ ...required, PENELOPE_THINKING: "very" }), ConfigError);
});

test("numbers are positive integers", () => {
  assert.throws(() => readConfig({ ...required, PENELOPE_PROMPT_FILE_MAX_BYTES: "-1" }), ConfigError);
  assert.throws(() => readConfig({ ...required, PENELOPE_POLL_WAIT_SECONDS: "x" }), ConfigError);
  assert.throws(() => readConfig({ ...required, PENELOPE_JOBS_MAX: "0" }), ConfigError);
  assert.throws(() => readConfig({ ...required, PENELOPE_JOB_MAX_SECONDS: "1h" }), ConfigError);
});

test("folding is on or off", () => {
  assert.equal(readConfig({ ...required, PENELOPE_TURN_FOLD: "on" }).turnFold, true);
  assert.throws(() => readConfig({ ...required, PENELOPE_TURN_FOLD: "yes" }), ConfigError);
});

test("the sources drawn with Slack's drawing and the limit of their text", () => {
  // Guards against: a deployment whose Slack source is named otherwise left undrawn, or a limit it cannot set (ADR-0029).
  const config = readConfig({ ...required, PENELOPE_SLACK_SOURCES: "slack, slack-home", PENELOPE_SLACK_MAX_CHARS: "3000" });
  assert.deepEqual(config.slack, { sources: ["slack", "slack-home"], maxChars: 3000 });
  assert.throws(() => readConfig({ ...required, PENELOPE_SLACK_SOURCES: "slack,../x" }), ConfigError);
  assert.throws(() => readConfig({ ...required, PENELOPE_SLACK_MAX_CHARS: "0" }), ConfigError);
});
