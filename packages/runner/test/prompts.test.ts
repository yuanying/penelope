import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  curatorSystemPrompt,
  FOLDING,
  foldAskInput,
  readPromptFiles,
  subAgentSystemPrompt,
  systemPrompt,
  type Places,
} from "../src/prompts.ts";

const identity = { name: "Example", role: "the operator of a Kubernetes cluster", owner: "Owner" };

async function memory(files: Record<string, string>): Promise<Places> {
  const dir = await mkdtemp(join(tmpdir(), "memory-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return { memory: dir, sources: "/sources", home: "/home/agent" };
}

// What the prompts say is looked at by the facts in them (ADR-0008), not by their wording.

test("the system prompt says who she is and where", async () => {
  // Guards against: a system prompt that loses her name, role or owner, or one of the places she works in.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.ok(prompt.includes(identity.name));
  assert.ok(prompt.includes(identity.role));
  assert.ok(prompt.includes(identity.owner));
  assert.ok(prompt.includes(places.memory));
  assert.ok(prompt.includes("/sources"));
  assert.ok(prompt.includes("/home/agent"));
  assert.match(prompt, /Sentinel/);
  assert.match(prompt, /reply/);
});

test("the system prompt says commands can run in the background and their ends come as job events", async () => {
  // Guards against: background jobs she is not told of, or an end that she does not know will arrive (ADR-0030).
  const places = await memory({});
  const prompt = systemPrompt(identity, places, []);
  assert.ok(prompt.includes("job_start"));
  assert.match(prompt, /source `job`/);
});

test("a sub-agent is not told of background jobs, which it does not have", async () => {
  const places = await memory({});
  const prompt = subAgentSystemPrompt(identity, places, { name: "a", purpose: "p", cwd: "/home/agent/agents/a" });
  assert.ok(!prompt.includes("job_start"));
});

test("personality, always and handoff follow as they are, in that order", async () => {
  const places = await memory({
    "personality.md": "やさしく話す。",
    "always.md": "毎朝 CI を見る。",
    "handoff.md": "明日は版上げ。",
  });
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  const personality = prompt.indexOf("やさしく話す。");
  const always = prompt.indexOf("毎朝 CI を見る。");
  const handoff = prompt.indexOf("明日は版上げ。");
  assert.ok(personality > 0 && always > personality && handoff > always);
  assert.ok(prompt.includes(`${join(places.memory, "personality.md")}`));
});

test("a file that is not there is left out", async () => {
  const places = await memory({ "always.md": "a" });
  const files = await readPromptFiles(places.memory, 1000);
  assert.deepEqual(
    files.map((file) => file.name),
    ["always.md"],
  );
});

test("a file over the limit is not added, and the prompt says so", async () => {
  const places = await memory({ "always.md": "x".repeat(2000), "handoff.md": "short" });
  const files = await readPromptFiles(places.memory, 1000);
  const prompt = systemPrompt(identity, places, files);
  // Guards against: a long file filling the prompt, or left out without a word (ADR-0006).
  assert.ok(!prompt.includes("x".repeat(1001)));
  assert.ok(prompt.includes(join(places.memory, "always.md")), "the file left out is named");
  assert.match(prompt, /\b2000\b/, "with its size");
  assert.ok(prompt.includes("short"));
});

test("the curator has no personality and is told whose memory it is", async () => {
  const places = await memory({ "personality.md": "やさしく話す。" });
  const prompt = curatorSystemPrompt(identity, places);
  assert.ok(!prompt.includes("やさしく話す。"));
  assert.match(prompt, /Example/);
  assert.ok(prompt.includes(places.memory));
});

test("with folding on, the system prompt says what folding leaves", async () => {
  const places = await memory({});
  const files = await readPromptFiles(places.memory, 1000);
  const folding = systemPrompt(identity, places, files, { folding: true });
  assert.ok(folding.includes(FOLDING));
  assert.ok(!systemPrompt(identity, places, files, { folding: false }).includes(FOLDING));
});

test("the request before folding names no way to answer it", () => {
  // Guards against: a request that tells her how or what to keep, or points her at a tool (ADR-0015).
  const ask = foldAskInput();
  assert.match(ask, /fold/i, "it says the turn is about to be folded");
  for (const tool of ["reply", "bash", "write", "schedule_add", "self_event"]) assert.ok(!ask.includes(tool), tool);
  assert.ok(!ask.includes("\n"), "one short request");
});

test("the system prompt says what the fields of <events> are", async () => {
  // Guards against: an input of JSON lines whose fields she has to guess, such as which number `reply` answers to.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.match(prompt, /<events>/);
  for (const field of ["seq", "source", "stream", "delivery", "occurred_at", "summary", "text", "attachments", "appended", "kind", "count", "seqs", "in_reply_to"]) {
    assert.ok(prompt.includes(`\`${field}\``), field);
  }
});

test("the system prompt says that other agents ask over A2A and how they are answered", async () => {
  // Guards against: an \`a2a\` event she cannot tell from the others, or an agent answered with \`reply\`, which only her owner reads.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.ok(prompt.includes("`a2a`"));
  assert.ok(prompt.includes("`reply_to_agent`"));
});

test("the system prompt says what a heartbeat event is, and nothing of what to do with it", async () => {
  // Guards against: a \`heartbeat\` event she cannot tell from the others (ADR-0031).
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  const lines = prompt.split("\n").filter((line) => line.includes("`heartbeat`"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /no turn/);
});

test("the owner's skills are named with their place, which she cannot change", async () => {
  // Guards against: skills she finds listed without knowing where they are, or taking them for hers to edit.
  const places = { ...(await memory({})), ownerSkills: "/skills" };
  const files = await readPromptFiles(places.memory, 1000);
  const line = systemPrompt(identity, places, files).split("\n").find((l) => l.includes("/skills/"));
  assert.ok(line, "a line names /skills/");
  assert.match(line, /read-only/);
  assert.ok(line.includes(`${places.memory}/skills/`), "beside the skills of the memory");
  assert.ok(line.includes("your owner's skills"));
});

test("the image's skills are named with their place, and which of a name is listed", async () => {
  // Guards against: skills she finds listed without knowing where they come from, or which copy of a name is listed.
  const places = { ...(await memory({})), ownerSkills: "/skills", imageSkills: "/opt/penelope/skills" };
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  const line = prompt.split("\n").find((l) => l.includes("/opt/penelope/skills/"));
  assert.ok(line, "a line names the image's skills");
  assert.match(line, /your owner's, then the memory's, then the image's/);
});

test("without the owner's skills, the prompt names none", async () => {
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.ok(!/'s skills/.test(prompt));
});

const github = {
  name: "github",
  description: "GitHub through gh & git.",
  hosts: ["api.github.com", "github.com"],
  path: "/etc/penelope/connectors/github.md",
};

test("the connectors are listed with their hosts and where their documents are", async () => {
  // Guards against: a stand-in she holds without knowing which host takes it, or a document she cannot find.
  const places = await memory({});
  const files = await readPromptFiles(places.memory, 1000);
  const prompt = systemPrompt(identity, places, files, { connectors: { dir: "/etc/penelope/connectors", list: [github] } });
  assert.ok(prompt.includes("/etc/penelope/connectors"));
  assert.ok(prompt.includes("<name>github</name>"));
  assert.ok(prompt.includes("GitHub through gh &amp; git."), "the description, escaped");
  assert.ok(prompt.includes("api.github.com"));
  assert.ok(prompt.includes("github.com"));
  assert.ok(prompt.includes("<location>/etc/penelope/connectors/github.md</location>"));
  assert.ok(prompt.indexOf("<connectors>") < prompt.indexOf("# Memory"), "before her memory files");
});

test("without connectors the prompt has no section for them", async () => {
  // Guards against: a section that names a directory the deployment did not give, or an empty list.
  const places = await memory({});
  const files = await readPromptFiles(places.memory, 1000);
  for (const options of [{}, { connectors: { dir: "/etc/penelope/connectors", list: [] } }]) {
    const prompt = systemPrompt(identity, places, files, options);
    assert.ok(!prompt.includes("# Connectors"));
    assert.ok(!prompt.includes("<connectors>"));
    assert.ok(!prompt.includes("/etc/penelope/connectors"));
  }
});

test("the system prompt does not say the sandbox holds no real key, since she makes her own ssh key", async () => {
  // Guards against: a fact made untrue by ADR-0021, her own ssh key in her home.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, await readPromptFiles(places.memory, 1000));
  assert.ok(!prompt.includes("there are no real keys in the sandbox"));
  assert.match(prompt, /stand-in/);
});

test("the memory's shape names agents/, where the roles of sub-agents are", async () => {
  // Guards against: her not knowing where the roles of her sub-agents are kept, or which one is used without a role.
  const places = await memory({});
  const prompt = systemPrompt(identity, places, []);
  assert.match(prompt, /agents\/<role>\.md/);
  assert.match(prompt, /default\.md/);
});

test("a sub-agent's system prompt states what it is, its purpose and place, and has the role's body after it", () => {
  const places = { memory: "/memory", sources: "/sources", home: "/home/agent" };
  const prompt = subAgentSystemPrompt(identity, places, {
    name: "alerts",
    purpose: "Look at today's alerts",
    cwd: "/home/agent/agents/alerts",
    role: { path: "/memory/agents/default.md", body: "頼まれた仕事だけをする。" },
  });
  // Guards against: a sub-agent that does not know who started it, what for, where it works, or where its words go.
  assert.ok(prompt.includes("sub-agent"));
  assert.ok(prompt.includes(identity.name));
  assert.ok(prompt.includes("Look at today's alerts"));
  assert.ok(prompt.includes("/home/agent/agents/alerts"));
  assert.match(prompt, /Sentinel/);
  assert.match(prompt, /question/);
  assert.ok(prompt.trimEnd().endsWith("頼まれた仕事だけをする。"), "the role's body comes last");
  assert.ok(prompt.includes("/memory/agents/default.md"));
  // It is not told the shape of her memory, nor how she answers her owner.
  assert.ok(!prompt.includes("personality.md"));
  assert.ok(!prompt.includes("handoff.md"));
  assert.ok(!/\breply\b/.test(prompt));
});

test("a sub-agent's system prompt without a role's body is the fixed part alone", () => {
  const places = { memory: "/memory", sources: "/sources", home: "/home/agent" };
  const prompt = subAgentSystemPrompt(identity, places, { name: "bare", purpose: "p", cwd: "/home/agent/agents/bare" });
  assert.ok(!prompt.includes("/memory/agents/"));
});

test("with Slack's sources, the system prompt says how their events come and names the CLI", async () => {
  // Guards against: drawn Slack text she cannot tell from a payload, or a CLI she does not know is there (ADR-0029).
  const places = await memory({});
  const prompt = systemPrompt(identity, places, [], { slackSources: ["slack", "slack-home"] });
  assert.ok(prompt.includes("`slack`") && prompt.includes("`slack-home`"), "the sources are named");
  assert.ok(prompt.includes("slackctl"));
  assert.ok(!systemPrompt(identity, places, []).includes("slackctl"), "nothing of Slack without its sources");
});
