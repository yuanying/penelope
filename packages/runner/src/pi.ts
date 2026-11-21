// Opening Pi's sessions: hers, which persists and goes on after a restart, and
// the nightly workers', which start empty every night with file tools only.

import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  type ExtensionFactory,
  SessionManager,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { NightTurnStage, TurnResult } from "@penelope/contract";

import type { Config } from "./config.ts";
import { imageLimitExtension } from "./image-limit.ts";
import type { TurnModels } from "./model-settings.ts";
import type { DaytimeRecords, MemoryFile } from "./night-memory.ts";
import type { MemoryRead } from "./memory-reads.ts";
import { type ExtensionNotice, type MemoryExtensionTrials, SessionExtensions } from "./extensions.ts";

export interface PiSetup {
  config: Config;
  modelRuntime: ModelRuntime;
  turnModels: TurnModels;
  /** Pi's settings. A deployment reads them from Pi's directory. */
  settings: () => SettingsManager;
  log: (line: string) => void;
  tools: ToolDefinition[];
  /** The runner's own factories, given to Pi as they are. */
  extensions: ExtensionFactory[];
  imageLimits?: ReadonlyMap<string, number> | undefined;
  /** Night workers use only the supplied file tools, with no skills or other resources. */
  fileOnly?: boolean;
  /** Opt in to owner and memory extensions, only for the main session. */
  diskExtensions?: { trials: MemoryExtensionTrials; log: (line: string) => void };
}

/** Which session is hers, and the last nightly event that switched it. */
export interface SessionState {
  file: string;
  nightly?: number;
  verifierMemory?: MemoryFile[];
  curatorMemory?: MemoryFile[];
  unverifiedRecords?: DaytimeRecords[];
  memoryReads?: MemoryRead[];
  lastTopicReviews?: [path: string, date: string][];
}

const stateFile = (config: Config) => join(config.sessionDir, "current.json");

export async function readState(config: Config): Promise<SessionState | undefined> {
  try {
    const { nightMemory, ...state } = JSON.parse(await readFile(stateFile(config), "utf8")) as SessionState & { nightMemory?: MemoryFile[] };
    await access(state.file);
    if (nightMemory !== undefined) {
      state.verifierMemory ??= nightMemory;
      state.curatorMemory ??= nightMemory;
    }
    return state;
  } catch {
    return undefined;
  }
}

export async function writeState(config: Config, state: SessionState): Promise<void> {
  const path = stateFile(config);
  await writeFile(`${path}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/**
 * A new session file of hers. Pi writes the file only after the first answer,
 * so its header is written here: a restart before that still finds it.
 */
export async function newSessionFile(config: Config): Promise<string> {
  return newSessionFileIn(config.home, config.sessionDir);
}

/** A new session file in `dir`, of a session working in `cwd`. */
export async function newSessionFileIn(cwd: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const manager = SessionManager.create(cwd, dir);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi did not make a session file");
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface OpenSession {
  session: AgentSession;
  /** Refresh changed disk extensions and return any new diagnostics for this turn. */
  beforeTurn(): Promise<ExtensionNotice[]>;
  finishTurn(result: TurnResult): Promise<void>;
}

/**
 * A session with the given system prompt, over `sessionManager`, working in
 * `cwd` (HOME unless given). The skills are found from HOME whatever `cwd` is.
 */
export async function openSession(
  setup: Omit<PiSetup, "turnModels"> & { turnModels?: TurnModels },
  systemPrompt: string,
  sessionManager: SessionManager,
  cwd = setup.config.home,
): Promise<OpenSession> {
  const { config, modelRuntime, diskExtensions, fileOnly } = setup;
  const settingsManager = setup.settings();
  const skillPaths: string[] = [];
  async function refreshSkillPaths(): Promise<void> {
    skillPaths.length = 0;
    // Pi keeps the first skill of a name: the owner's, then her own, then the image's.
    for (const dir of [config.ownerSkillsDir, join(config.memoryDir, "skills")]) {
      if (dir && (await exists(dir))) skillPaths.push(dir);
    }
    if (config.imageSkills === undefined) {
      if (await exists(config.imageSkillsDir)) skillPaths.push(config.imageSkillsDir);
      return;
    }
    // Pi accepts individual Markdown files, so only the selected image skills are loaded.
    for (const name of new Set(config.imageSkills)) {
      if (/^[a-z0-9-]+$/.test(name)) {
        const file = join(config.imageSkillsDir, name, "SKILL.md");
        if ((await stat(file).catch(() => undefined))?.isFile()) {
          skillPaths.push(file);
          continue;
        }
      }
      setup.log(`PENELOPE_IMAGE_SKILLS: image skill ${JSON.stringify(name)} not found; skipping`);
    }
  }
  if (!fileOnly) await refreshSkillPaths();
  const disk = diskExtensions && new SessionExtensions(
    config.ownerExtensionsDir,
    resolve(config.memoryDir, "extensions"),
    diskExtensions.trials,
    diskExtensions.log,
  );
  let loaded = await disk?.prepare();
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.home,
    agentDir: config.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: fileOnly === true,
    extensionFactories: setup.imageLimits?.size
      ? [...setup.extensions, imageLimitExtension(setup.imageLimits)]
      : setup.extensions,
    ...(disk ? { additionalExtensionPaths: disk.paths } : {}),
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: skillPaths,
    systemPrompt,
  });
  function reportLoadErrors(): void {
    if (!disk) return;
    for (const { path, error } of resourceLoader.getExtensions().errors) disk.report("load_error", path, error);
  }
  await resourceLoader.reload();
  reportLoadErrors();
  let model;
  if (config.model) {
    model = modelRuntime.getModel(config.model.provider, config.model.id);
    if (!model) throw new Error(`Pi has no model ${config.model.provider}/${config.model.id}`);
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir: config.agentDir,
    modelRuntime,
    ...(model ? { model } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    settingsManager,
    resourceLoader,
    sessionManager,
    ...(fileOnly ? { noTools: "all" as const, tools: setup.tools.map((tool) => tool.name) } : {}),
    customTools: setup.tools,
  });
  if (disk) {
    await session.bindExtensions({
      onError: ({ extensionPath, event, error }) => disk.report("handler_error", extensionPath, `${event}: ${error}`),
    });
  }
  setup.turnModels?.remember(session, disk !== undefined);
  return {
    session,
    async beforeTurn() {
      if (!disk) return [];
      const key = await disk.prepare();
      if (key !== loaded) {
        // The loader retains the paths arrays and resolves them again on reload.
        loaded = undefined;
        await refreshSkillPaths();
        await session.waitForIdle();
        await session.reload();
        loaded = key;
        reportLoadErrors();
      }
      return disk.takeNotes();
    },
    async finishTurn(result) {
      await disk?.finish(result);
    },
  };
}

type Message = AgentSession["messages"][number];
export type Assistant = Extract<Message, { role: "assistant" }>;

/** The last answer of the model in the session. */
export function lastAssistant(messages: readonly Message[]): Assistant | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant") return messages[i] as Assistant;
  return undefined;
}

export function openFile(config: Config, file: string): SessionManager {
  return SessionManager.open(file, config.sessionDir, config.home);
}

/** The nightly workers' transcripts are kept beside hers. */
export function nightManager(config: Config, role: Exclude<NightTurnStage, "reflection">): SessionManager {
  return SessionManager.create(config.memoryDir, join(config.sessionDir, role));
}
