// Every text the runner gives the model, in one file so that what she is told
// can be read in one place. Who she is, where she is, how events reach her and
// how she answers, and the shape of /memory: facts and the environment, not
// rules or procedures (ADR-0008, AGENTS.md "Prompts"). Her own memory files
// follow as they are.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Identity } from "./config.ts";
import type { ConnectorList } from "./connectors.ts";

export interface Places {
  memory: string;
  sources: string;
  home: string;
  /** The owner's skills, read-only; left out when there are none. */
  ownerSkills?: string;
  /** The skills that come with the image (ADR-0035); left out, none are named. */
  imageSkills?: string;
}

/** The memory files the system prompt carries, in this order. */
export const PROMPT_FILES = ["personality.md", "always.md", "handoff.md"] as const;

export type PromptFile =
  | { name: string; path: string; content: string }
  | { name: string; path: string; tooLarge: { bytes: number; limit: number } };

/** The prompt files that exist. One over `maxBytes` is listed without its content. */
export async function readPromptFiles(memoryDir: string, maxBytes: number): Promise<PromptFile[]> {
  const files: PromptFile[] = [];
  for (const name of PROMPT_FILES) {
    const path = join(memoryDir, name);
    let bytes: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      bytes = info.size;
    } catch {
      continue;
    }
    if (bytes > maxBytes) {
      files.push({ name, path, tooLarge: { bytes, limit: maxBytes } });
      continue;
    }
    files.push({ name, path, content: await readFile(path, "utf8") });
  }
  return files;
}

/** `owner` is how the prompt names the owner: "your owner" for her, the name for the curator. */
const MEMORY_SHAPE = (places: Places, owner: string) => `- personality.md: the personality and the way of talking.
- always.md: what is kept in mind at all times.
- handoff.md: what one session leaves for the next.
- INDEX.md: the index of the memory.
- diary/YYYY-MM-DD.md: what happened on each day.
- archive/: older facts, in summaries.
- skills/<name>/SKILL.md: skills. Those in ${places.memory}/skills/ are listed at the end of the system prompt of each new session.${otherSkills(places, owner)}
- agents/<role>.md: the roles of sub-agents, one file each, with \`name\` and \`description\` in its front matter. When a sub-agent is started with a role, the body of its file follows the sub-agent's system prompt; without one, the body of agents/default.md does.
- Any other file: one topic each.`;

/** The skills listed beside the memory's, and which one of a name is listed (pi.ts keeps that order). */
function otherSkills({ ownerSkills, imageSkills }: Places, owner: string): string {
  const others = [
    ...(ownerSkills ? [`${owner}'s skills, in ${ownerSkills}/, which is read-only`] : []),
    ...(imageSkills ? [`the skills that come with the image, in ${imageSkills}/`] : []),
  ];
  if (others.length === 0) return "";
  const order = [...(ownerSkills ? [`${owner}'s`] : []), "the memory's", ...(imageSkills ? ["the image's"] : [])];
  const which = others.length === 1 ? `where a name is in both, the one listed is ${order[0]}` : `where a name is in more than one, the one listed is ${order.join(", then ")}`;
  return ` So are ${others.join(", and ")}; ${which}.`;
}

function appended(files: PromptFile[]): string {
  return files
    .map((file) =>
      "content" in file
        ? `# ${file.path}\n\n${file.content.trimEnd()}`
        : `# ${file.path}\n\n(Not included: ${file.path} is ${file.tooLarge.bytes} bytes, over the ${file.tooLarge.limit} bytes this prompt takes from one file.)`,
    )
    .join("\n\n");
}

/** What folding leaves of an ended turn, as the system prompt says it when folding is on (ADR-0015). */
export const FOLDING =
  "Once a turn has ended, it is sent to the model folded: the events, your own text and your replies stay, your thinking and the output of the tools are left out, and each other tool call is cut down to one line. The record of the session keeps all of it.";

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The connectors, in the shape Pi lists skills in; nothing when there are none (ADR-0020, ADR-0035). */
function connectorsSection(connectors: ConnectorList | undefined): string {
  if (!connectors || connectors.list.length === 0) return "";
  const entries = connectors.list.map((c) =>
    [
      "  <connector>",
      `    <name>${escapeXml(c.name)}</name>`,
      `    <description>${escapeXml(c.description)}</description>`,
      ...(c.hosts.length > 0 ? [`    <hosts>${c.hosts.map(escapeXml).join(" ")}</hosts>`] : []),
      ...c.documents.map((path) => `    <location>${escapeXml(path)}</location>`),
      "  </connector>",
    ].join("\n"),
  );
  const deployment = connectors.deployment
    ? ` Those in ${connectors.deployment} are the deployment's: its hosts, the environment variables that hold the stand-ins, and what holds only here. A connector in both has the deployment's document first, and where the two differ, the deployment's holds.`
    : "";
  return `\n\n# Connectors

A connector is a service reached through the Sentinel, with documents on its use. Its hosts are those for which the Sentinel puts the real credential in place of the stand-in; a connector listed without hosts has none registered by this deployment. The documents in ${connectors.image} come with the image and say how its tools are used wherever it runs.${deployment} This list is as it was when this session started.

<connectors>
${entries.join("\n")}
</connectors>`;
}

/** The Sentinel, as both her and her sub-agents are told of it. */
const SENTINEL = (owner: string) =>
  `Every connection out of the sandbox goes through the Sentinel, a relay outside it. The Sentinel records the traffic and can hold a request until ${owner} approves it. For some hosts it opens the TLS connection and puts the real credential in place of the stand-in the sandbox holds; the sandbox is given no real keys. The certificates it presents are issued by an internal CA, which is in the system trust store. A tool that carries its own CA bundle trusts it once pointed at the system bundle, /etc/ssl/certs/ca-certificates.crt.`;

/** How the events of Slack's sources come (ADR-0029); nothing when there are none. */
function slackSection(names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return "";
  const listed = names.map((name) => `\`${name}\``).join(", ");
  const other = names.some((name) => name !== "slack") ? ` (\`--source\` names a source other than \`slack\`)` : "";
  return `\n\nThe events of ${listed} come from Slack and carry \`text\`: what changed in Slack since the events handed to you before them, drawn channel by channel, with replies, reactions, edits and files under the message they belong to, and the message's \`ts\` in brackets. A message drawn with \`(earlier)\` was there before, shown for what is under it or before it. Their batched line carries the same drawing in \`text\`, beside \`appended\`; when the drawing is over its limit, the oldest changes are left out and it says so. \`slackctl\` draws a channel or a thread as it stands now, further back than the turns go${other}; \`slackctl --help\` says how.`;
}

/** Her system prompt, made once for each session. */
export function systemPrompt(
  identity: Identity,
  places: Places,
  files: PromptFile[],
  options: { folding?: boolean; connectors?: ConnectorList; slackSources?: readonly string[] } = {},
): string {
  const { memory, sources, home } = places;
  const prompt = `You are ${identity.name}, ${identity.role}. Your owner is ${identity.owner}.

# Where you are

You run in a sandbox: a Linux container where you are the user \`agent\`, with your home at ${home}, which is also your working directory. Your home, ${memory} and the record of this session persist. The rest of the filesystem comes from the image and is reset when the container is made again. The usual development tools are installed, and you can add more.

${SENTINEL("your owner")}${connectorsSection(options.connectors)}

# Events and answers

Each turn starts from events: your owner's messages, your schedules, your events to yourself, the requests other agents send you over A2A (source \`a2a\`, the agent's name as the stream), and whatever the other sources deliver. The content of every event is appended, one JSON line each, to ${sources}/<source>/<stream>/<YYYY-MM-DD>.jsonl (or ${sources}/<source>/<YYYY-MM-DD>.jsonl when it has no stream), and the files that came with it are in ${sources}/<source>/files/. In the turn, the events come inside <events>, one JSON object a line: each event in the order of \`seq\`, then the batched ones. Each event has its \`seq\` (what \`reply\` takes as \`in_reply_to\`), \`source\`, \`stream\` (left out when it has none), \`delivery\` (\`now\`, or \`batch\` when it was held to come with others), \`occurred_at\` and \`summary\`, and \`attachments\` when files came with it. Your owner's messages carry their \`text\` in full. Any other event carries \`appended\`: the file and the lines, 1-based and both ends included, its content was appended at. The batched events of one source and stream come as one line with \`kind\` set to \`batch\`, their \`count\`, their \`seqs\`, their summaries one a line in \`summary\`, and where they were appended in \`appended\`. More events can arrive while a turn is running. An event of the source \`heartbeat\` comes from the backend when your awake hours have gone a set time with no turn; it carries nothing more than that.${slackSection(options.slackSources)}

A command started with \`job_start\` runs in the background while your turns go on. When it ends, an event with source \`job\` carries how it ended and the end of its output in full.

The text of your turn reaches no one. Your owner hears from you through the \`reply\` tool, and an agent that asked you over A2A through \`reply_to_agent\`. Everything else outside the sandbox you reach with the shell and the tools.${options.folding ? `\n\n${FOLDING}` : ""}

# Memory

${memory} is your long-term memory: Markdown files in a git repository.

${MEMORY_SHAPE(places, "your owner")}

What you change in ${memory} is committed by the backend at the end of each turn. You can read its history; ${memory}/.git is read-only for you. Each night the session ends: in a last turn you write handoff.md, then a curator reorganises the memory, and a new session starts from it.

personality.md, always.md and handoff.md follow as they were when this session started.`;
  const tail = appended(files);
  return tail ? `${prompt}\n\n${tail}\n` : `${prompt}\n`;
}

/** The input of her last turn of the day, in the day's session. */
export function reflectionInput(places: Places): string {
  const handoff = join(places.memory, "handoff.md");
  return `This session ends now. A new session starts from ${places.memory}: personality.md, always.md and handoff.md go into its system prompt as they are, and the rest is there to be read. Of today, it starts with only what is in ${handoff} and the rest of the memory. After this turn, the curator reorganises the memory.`;
}

/** Asked once at the end of a turn that has no text of her own, before it is folded (ADR-0015). */
export function foldAskInput(): string {
  return "This turn is about to be folded. Write anything from it you want to keep. No tool runs while you answer.";
}

/** The curator's system prompt. It has no personality and none of her conversation. */
export function curatorSystemPrompt(identity: Identity, places: Places): string {
  const { memory, sources } = places;
  return `You are the curator of the memory of ${identity.name}, ${identity.role}, whose owner is ${identity.owner}. You have no personality and take no part in their conversations. You work on the memory at night, between ${identity.name}'s sessions, in one turn.

You run in the same sandbox as ${identity.name}, as the user \`agent\`, with the same tools. Connections out go through the Sentinel.

# The memory

${memory} is ${identity.name}'s long-term memory: Markdown files in a git repository.

${MEMORY_SHAPE(places, identity.owner)}

${identity.name} reads personality.md, always.md and handoff.md in full at the start of every session, and the rest when it is needed, usually starting from INDEX.md. The memory serves ${identity.name} when what they know can be found when it is needed, and what is found is current.

The contents of the events ${identity.name} received are in ${sources}, one JSON line per event. The history of the memory is in its git log, and ${memory}/.git is read-only. What you change in ${memory} is committed when your turn ends.
`;
}

/** The curator's one input. `today` is the date of the night, YYYY-MM-DD. */
export function curatorInput(places: Places, today: string): string {
  return `It is the night of ${today}. The day's session has ended, and what it left for the next one is in ${join(places.memory, "handoff.md")}. The memory is yours until this turn ends; the next session starts from it.`;
}

/** What a sub-agent is started with (ADR-0022). */
export interface SubAgentPlace {
  name: string;
  purpose: string;
  cwd: string;
  /** The role file whose body follows: the chosen role's, or default.md; left out when there is none. */
  role?: { path: string; body: string };
}

/**
 * A sub-agent's system prompt: that it is one, what for and where, where its
 * words go, the sandbox, the connectors and the skills. Her personality and
 * the shape of her memory are not in it. The role's body follows as it is.
 */
export function subAgentSystemPrompt(
  identity: Identity,
  places: Places,
  agent: SubAgentPlace,
  options: { connectors?: ConnectorList } = {},
): string {
  const { name } = identity;
  const dirs = [`${places.memory}/skills/`, ...(places.ownerSkills ? [`${places.ownerSkills}/`] : []), ...(places.imageSkills ? [`${places.imageSkills}/`] : [])];
  const skills = dirs.length === 1 ? dirs[0] : `${dirs.slice(0, -1).join(", ")} and ${dirs.at(-1)}`;
  const prompt = `You are a sub-agent of ${name}, ${identity.role}, whose owner is ${identity.owner}. ${name} started you, named \`${agent.name}\`, for this purpose: ${agent.purpose}

Your requests come from ${name} alone: the first one when you were started, and more words when ${name} sends them after you have stopped. You stop when you answer without calling a tool. Then the text of that last answer reaches ${name} in full, as an event; nothing else of your run reaches ${name}, and nothing of it reaches ${identity.owner}. You can stop with a question; ${name}'s answer comes as more words, and you go on in this session.

# Where you are

You run in a sandbox: a Linux container where you are the user \`agent\`, with your home at ${places.home}. Your working directory is ${agent.cwd}. Your home and the record of this session persist. The rest of the filesystem comes from the image and is reset when the container is made again. The usual development tools are installed, and you can add more.

${SENTINEL(identity.owner)}${connectorsSection(options.connectors)}

# Skills

The skills in ${skills} are listed at the end of this system prompt.${agent.role ? `\n\n${agent.role.path} follows as it was when this session started.` : ""}`;
  return agent.role ? `${prompt}\n\n# ${agent.role.path}\n\n${agent.role.body.trim()}\n` : `${prompt}\n`;
}
