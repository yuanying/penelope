import { constants } from "node:fs";
import { chmod, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

// Linux O_PATH pins an entry without opening it for I/O: it also works on a
// mode-000 file, and with O_NOFOLLOW a final symlink is pinned, not followed.
const entry = 0o10000000 | constants.O_NOFOLLOW;
const proc = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

/** Restore shared-group access without sharing files outside the work tree. */
export async function shareMemory(root: string, log: (line: string) => void): Promise<void> {
  const uid = process.geteuid?.();
  let repaired = 0;
  let unrepaired = 0;

  async function visit(path: string, volume?: { dev: number; gid: number }): Promise<void> {
    try {
      const handle = await open(path, entry);
      try {
        const info = await handle.stat();
        const directory = info.isDirectory();
        if (volume === undefined && !directory) { unrepaired++; return; }
        if (!directory && !info.isFile()) return;

        const { dev, gid } = volume ?? info;
        if (info.dev !== dev) { unrepaired++; return; }

        const needed = directory ? 0o070 : 0o060;
        if ((info.mode & needed) !== needed) {
          // A hard link may name a private file outside /memory, and a
          // different group is not necessarily shared with the backend.
          if (info.uid !== uid || info.gid !== gid || (!directory && info.nlink !== 1)) {
            unrepaired++;
          } else {
            await chmod(proc(handle), (info.mode & 0o7777) | needed);
            repaired++;
          }
        }
        if (directory) {
          for (const name of await readdir(proc(handle))) {
            if (name.toLowerCase() === ".git") continue;
            await visit(join(proc(handle), name), { dev, gid });
          }
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Best effort: siblings are still checked and Git still gets a turn.
      unrepaired++;
    }
  }

  await visit(root);
  if (repaired || unrepaired) log(`memory: permissions repaired=${repaired} unrepaired=${unrepaired}`);
}
