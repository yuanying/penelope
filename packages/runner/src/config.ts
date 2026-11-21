// The runner's settings, all from the environment. The deployment sets them;
// nothing here names a character (ADR-0001).

import { join } from "node:path";

import { A2A_IMAGE_MAX_BYTES, type AgentId } from "@penelope/contract";
import { DEFAULT_MAX_CHARS, SEGMENT } from "@penelope/slack";

/** Where the sandbox's image carries the skills of the repository (Dockerfile, docs/pod.md). */
export const IMAGE_SKILLS_DIR = "/opt/penelope/skills";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Who she is. Goes into the system prompt as it is. */
export interface Identity {
  name: string;
  role: string;
  owner: string;
}

export interface Config {
  /** Only the main agent for now (docs/sandbox-api.md). */
  agent: AgentId;
  /** The backend's API for the sandbox, through the Sentinel; the token is the surrogate. */
  backend: { url: string; token: string };
  identity: Identity;
  /** Left out, Pi's own settings choose the model. */
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  /** HOME: the working directory of the session (ADR-0011). */
  home: string;
  memoryDir: string;
  /** The owner's skills, mounted read-only; left out, there are none. */
  ownerSkillsDir?: string;
  /** The owner's Pi extensions, mounted read-only; left out, there are none. */
  ownerExtensionsDir?: string;
  /** The connectors' documents, one <name>.md each (ADR-0020); left out, there are none. */
  connectorsDir?: string;
  /** The skills that come with the image, listed after the owner's and the memory's; not set by the deployment. */
  imageSkillsDir: string;
  /** Which image skills to list. Undefined lists all; an empty list lists none. */
  imageSkills?: string[];
  sourcesDir: string;
  /** Pi's directory: its settings, credentials, models and skills. */
  agentDir: string;
  /** Where the session records are kept; persistent. */
  sessionDir: string;
  /** Where each sub-agent's record and session are kept, one directory a name; persistent (ADR-0022). */
  subAgentDir: string;
  /** Where each background job's record and output are kept, one directory a job; persistent (ADR-0030). */
  jobDir: string;
  jobs: JobLimits;
  /** A memory file larger than this is not put into the system prompt. */
  promptFileMaxBytes: number;
  /** Advisory target for the combined size of the always-read layer. */
  promptLayerTargetBytes: number;
  /** UTC days of unverified daytime records to carry into later nights. */
  nightCarryDays: number;
  /** Topic body budget for one weekly content review. */
  reviewTopicMaxBytes: number;
  /** An image of the owner's message larger than this is left as a path. */
  imageMaxBytes: number;
  pollWaitSeconds: number;
  /** Whether ended turns are folded before they are sent to the model (ADR-0015). */
  turnFold: boolean;
  slack: SlackSettings;
}

/** The sources whose events are drawn with the Slack plugin's drawing (ADR-0029). */
export interface SlackSettings {
  /** The sources, as the deployment named them; none, and no event is drawn. */
  sources: string[];
  /** The most characters of drawn Slack text one input carries. */
  maxChars: number;
}

/** The limits on background jobs (ADR-0030 Decision 3). */
export interface JobLimits {
  /** How many run at once. */
  max: number;
  /** The longest one runs, and the time limit of one started without its own. */
  maxSeconds: number;
  /** The characters of the end of the output that the job's event carries. */
  tailChars: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function positiveInteger(env: Env, name: string, fallback: number, problems: string[]): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  return Number(value);
}

export function readConfig(env: Env): Config {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };
  const home = required("HOME");
  const backend = { url: required("PENELOPE_BACKEND_URL"), token: required("PENELOPE_BACKEND_TOKEN") };
  const identity = { name: required("PENELOPE_NAME"), role: required("PENELOPE_ROLE"), owner: required("PENELOPE_OWNER") };

  let model: Config["model"];
  if (env.PENELOPE_MODEL) {
    const slash = env.PENELOPE_MODEL.indexOf("/");
    if (slash <= 0 || slash === env.PENELOPE_MODEL.length - 1) {
      problems.push("PENELOPE_MODEL must be <provider>/<model>");
    } else {
      model = { provider: env.PENELOPE_MODEL.slice(0, slash), id: env.PENELOPE_MODEL.slice(slash + 1) };
    }
  }
  let thinkingLevel: ThinkingLevel | undefined;
  if (env.PENELOPE_THINKING) {
    if ((THINKING_LEVELS as readonly string[]).includes(env.PENELOPE_THINKING)) {
      thinkingLevel = env.PENELOPE_THINKING as ThinkingLevel;
    } else {
      problems.push(`PENELOPE_THINKING must be one of ${THINKING_LEVELS.join(", ")}`);
    }
  }
  const promptFileMaxBytes = positiveInteger(env, "PENELOPE_PROMPT_FILE_MAX_BYTES", 65536, problems);
  const promptLayerTargetBytes = positiveInteger(env, "PENELOPE_PROMPT_LAYER_TARGET_BYTES", 16384, problems);
  const nightCarryDays = positiveInteger(env, "PENELOPE_NIGHT_CARRY_DAYS", 7, problems);
  const reviewTopicMaxBytes = positiveInteger(env, "PENELOPE_REVIEW_TOPIC_MAX_BYTES", 100000, problems);
  const imageMaxBytes = positiveInteger(env, "PENELOPE_IMAGE_MAX_BYTES", A2A_IMAGE_MAX_BYTES, problems);
  const pollWaitSeconds = positiveInteger(env, "PENELOPE_POLL_WAIT_SECONDS", 30, problems);
  const jobs: JobLimits = {
    max: positiveInteger(env, "PENELOPE_JOBS_MAX", 5, problems),
    maxSeconds: positiveInteger(env, "PENELOPE_JOB_MAX_SECONDS", 24 * 60 * 60, problems),
    tailChars: positiveInteger(env, "PENELOPE_JOB_TAIL_CHARS", 4000, problems),
  };
  const fold = env.PENELOPE_TURN_FOLD || "on";
  if (fold !== "on" && fold !== "off") problems.push("PENELOPE_TURN_FOLD must be on or off");
  const slackSources = (env.PENELOPE_SLACK_SOURCES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of slackSources) if (!SEGMENT.test(name)) problems.push(`PENELOPE_SLACK_SOURCES: ${name} is not a source`);
  const slackMaxChars = positiveInteger(env, "PENELOPE_SLACK_MAX_CHARS", DEFAULT_MAX_CHARS, problems);
  if (problems.length > 0) throw new ConfigError(problems.join("; "));

  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const imageSkills = env.PENELOPE_IMAGE_SKILLS?.split(",").map((name) => name.trim()).filter(Boolean);
  return {
    agent: "main",
    backend,
    identity,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    home,
    memoryDir: env.PENELOPE_MEMORY || "/memory",
    ...(env.PENELOPE_OWNER_SKILLS_DIR ? { ownerSkillsDir: env.PENELOPE_OWNER_SKILLS_DIR } : {}),
    ...(env.PENELOPE_OWNER_EXTENSIONS_DIR ? { ownerExtensionsDir: env.PENELOPE_OWNER_EXTENSIONS_DIR } : {}),
    ...(env.PENELOPE_CONNECTORS_DIR ? { connectorsDir: env.PENELOPE_CONNECTORS_DIR } : {}),
    sourcesDir: env.PENELOPE_SOURCES || "/sources",
    agentDir,
    sessionDir: env.PENELOPE_SESSIONS || join(agentDir, "sessions", "main"),
    subAgentDir: env.PENELOPE_SUB_AGENTS || join(agentDir, "sessions", "agents"),
    jobDir: env.PENELOPE_JOBS || join(home, "jobs"),
    jobs,
    promptFileMaxBytes,
    promptLayerTargetBytes,
    nightCarryDays,
    reviewTopicMaxBytes,
    imageMaxBytes,
    pollWaitSeconds,
    turnFold: fold !== "off",
    slack: { sources: slackSources, maxChars: slackMaxChars },
    imageSkillsDir: IMAGE_SKILLS_DIR,
    ...(imageSkills !== undefined ? { imageSkills } : {}),
  };
}
