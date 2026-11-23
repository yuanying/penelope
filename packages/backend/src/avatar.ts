// Her avatar, kept in /memory/avatar/ where she grows it (ADR-0036). At the
// start, when it is not there, the backend copies the avatar the deployment
// chose and commits it; when it is there, it is left as it is. The backend
// reads it at the start and again after each commit of /memory, and does
// not check it: what it cannot use is left out, and `avatar check` tells
// the agent why.
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { type Avatar, readAvatar, readInside } from "@penelope/avatar";

import { type AvatarSettings, ConfigError } from "./config.ts";
import type { Memory } from "./memory.ts";

/** The place in /memory of her avatar. */
export const AVATAR_DIR = "avatar";

/**
 * What the UI shows of the agent: her name, and the file of each face of her
 * avatar by expression and the PNG of the faces that have one, relative to
 * `dir`; none when she has no avatar.
 */
export type AgentSettings = {
  name: string;
  dir: string;
  icons: Readonly<Record<string, string>>;
  pngIcons?: Readonly<Record<string, string>>;
};

/**
 * Copies the chosen avatar into /memory/avatar/ when nothing is there by
 * that name, and commits it. Gives the directory to read her avatar from:
 * /memory/avatar/, or the chosen avatar where it was found when it could not
 * be copied; none when there is no avatar. A chosen avatar that none of the
 * places has stops the start, as a setting that cannot be used.
 */
export async function seedAvatar(
  settings: AvatarSettings,
  memoryDir: string,
  memory: Memory,
  log: (line: string) => void,
): Promise<string | undefined> {
  const dest = path.join(memoryDir, AVATAR_DIR);
  if (exists(dest)) return dest;
  if (settings.chosen === undefined) return undefined;
  const source = settings.from.map((dir) => path.join(dir, settings.chosen!)).find((dir) => existsSync(path.join(dir, "avatar.json")));
  if (source === undefined) throw new ConfigError(`PENELOPE_AVATAR: no avatar ${settings.chosen} in ${settings.from.join(" or ")}`);

  // Copied beside it and moved in whole, so that a stop part way leaves no half an avatar there.
  const copying = path.join(memoryDir, `.${AVATAR_DIR}.copying`);
  try {
    rmSync(copying, { recursive: true, force: true });
    // A volume's files are links into its hidden ..data; the files are copied, not the links.
    cpSync(source, copying, { recursive: true, dereference: true, filter: (from) => from === source || !path.basename(from).startsWith("..") });
    // She edits it from the sandbox, a user of the Pod's shared group, the group of /memory (docs/pod.md).
    groupWritable(copying, statSync(memoryDir).gid);
    renameSync(copying, dest);
  } catch (error) {
    // The faces are still shown, from where they were found; the copy is tried again at the next start.
    log(`avatar: ${source} not copied to ${dest}, shown from where it is: ${error instanceof Error ? error.message : String(error)}`);
    rmSync(copying, { recursive: true, force: true });
    return source;
  }
  log(`avatar: copied ${source} to ${dest}`);
  try {
    await memory.commitPaths([AVATAR_DIR], [`Avatar ${settings.chosen}`, `Copied from ${source}`]);
  } catch {
    // Committed with the end of the next turn instead.
    log("avatar: the copy could not be committed");
  }
  return dest;
}

/** Her avatar as last read from `dir` (none without one), and its faces' bytes when asked. */
export class AgentAvatar {
  readonly dir: string | undefined;
  private readonly name: string;
  private readonly log: (line: string) => void;
  private avatar: Avatar;

  /** Her name is taken at the start: the deployment's, else her avatar's (ADR-0036). */
  constructor(dir: string | undefined, name: string | undefined, log: (line: string) => void) {
    this.dir = dir;
    this.log = log;
    this.avatar = this.read();
    this.name = name ?? this.avatar.name ?? "Agent";
  }

  /** Reads avatar.json and the faces again. */
  reload(): void {
    this.avatar = this.read();
  }

  settings(): AgentSettings {
    const { icons, pngIcons } = this.avatar;
    return { name: this.name, dir: this.dir ?? "", icons, ...(Object.keys(pngIcons).length === 0 ? {} : { pngIcons }) };
  }

  private read(): Avatar {
    if (this.dir === undefined || !exists(this.dir)) return { name: undefined, icons: {}, pngIcons: {} };
    const { avatar, problems } = readAvatar(this.dir);
    if (problems.length > 0) this.log(`avatar: ${problems.length} problem(s) in ${this.dir}, left out (avatar check says which): ${problems[0]}`);
    return avatar;
  }
}

/** The bytes of a face's file, read as `avatar check` reads it. */
export function faceBytes(agent: AgentSettings, file: string): Buffer {
  return readInside(agent.dir, file);
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every directory and file in group `gid`, the directories rwxrwsr-x and the
 * files rw-rw-r--, whatever the source's owner and mode were and whether or
 * not /memory's set-group-ID was passed on. The group is changed before the
 * mode, since a change of group may clear the set-group-ID.
 */
function groupWritable(dir: string, gid: number): void {
  chownSync(dir, -1, gid);
  chmodSync(dir, 0o2775);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) groupWritable(file, gid);
    else {
      chownSync(file, -1, gid);
      chmodSync(file, 0o664);
    }
  }
}
