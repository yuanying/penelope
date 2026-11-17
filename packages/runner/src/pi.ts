// Opening Pi's sessions: hers, which persists and goes on after a restart, and
// the curator's, which starts empty every night. Pi's own tools are kept as
// Pi sets them; the backend's tools are added beside them.

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

import type { Config } from "./config.ts";

export interface PiSetup {
  config: Config;
  modelRuntime: ModelRuntime;
  /** Pi's settings. A deployment reads them from Pi's directory. */
  settings: () => SettingsManager;
  tools: ToolDefinition[];
  /** Given to Pi as they are; nothing is loaded from disk. */
  extensions: ExtensionFactory[];
}

/** Which session is hers, and the last nightly event that switched it. */
export interface SessionState {
  file: string;
  nightly?: number;
}

const stateFile = (config: Config) => join(config.sessionDir, "current.json");

export async function readState(config: Config): Promise<SessionState | undefined> {
  try {
    const state = JSON.parse(await readFile(stateFile(config), "utf8")) as SessionState;
    await access(state.file);
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

/**
 * A session with the given system prompt, over `sessionManager`, working in
 * `cwd` (HOME unless given). The skills are found from HOME whatever `cwd` is.
 */
export async function openSession(
  setup: PiSetup,
  systemPrompt: string,
  sessionManager: SessionManager,
  cwd = setup.config.home,
): Promise<AgentSession> {
  const { config, modelRuntime } = setup;
  const settingsManager = setup.settings();
  // Pi keeps the first skill of a name: the owner's, then her own, then the image's (ADR-0035).
  const skillPaths = [];
  for (const dir of [config.ownerSkillsDir, join(config.memoryDir, "skills"), config.imageSkillsDir]) {
    if (dir && (await exists(dir))) skillPaths.push(dir);
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.home,
    agentDir: config.agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: setup.extensions,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
    systemPrompt,
  });
  await resourceLoader.reload();
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
    customTools: setup.tools,
  });
  return session;
}

export function openFile(config: Config, file: string): SessionManager {
  return SessionManager.open(file, config.sessionDir, config.home);
}

/** The curator's sessions are kept beside hers, for the record. */
export function curatorManager(config: Config): SessionManager {
  return SessionManager.create(config.home, join(config.sessionDir, "curator"));
}
