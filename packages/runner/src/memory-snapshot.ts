import { execFile, spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

/** Diagnostics whose text is safe to show even without --show. */
export class MemoryEvalError extends Error {}

const exec = promisify(execFile);
const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const file = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const proc = (handle: FileHandle, name = "") => join(`/proc/self/fd/${handle.fd}`, name);

// Pin each directory before descending. A concurrent rename or symlink swap in
// live memory must not turn a read into a lookup outside the snapshot's source.
async function withDirectory<T>(path: string, work: (handle: FileHandle) => Promise<T>): Promise<T> {
  let handle = await open(sep, directory);
  try {
    for (const name of resolve(path).split(sep).filter(Boolean)) {
      const next = await open(proc(handle, name), directory);
      await handle.close();
      handle = next;
    }
    return await work(handle);
  } finally {
    await handle.close();
  }
}

async function plainFile(path: string): Promise<FileHandle> {
  const handle = await open(path, file);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("Not a plain file with one link");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readPurpose(memory: string): Promise<string> {
  try {
    return await withDirectory(memory, async (root) => {
      const input = await plainFile(proc(root, "PURPOSE.md"));
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(await input.readFile());
      } finally {
        await input.close();
      }
    });
  } catch {
    throw new MemoryEvalError("Cannot read PURPOSE.md from current memory.");
  }
}

export async function snapshotLive(memory: string, target: string): Promise<void> {
  async function copy(root: FileHandle, destination: string): Promise<void> {
    for (const entry of await readdir(proc(root), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const source = proc(root, entry.name);
      const output = join(destination, entry.name);
      if (entry.isDirectory()) {
        const child = await open(source, directory);
        try {
          await mkdir(output);
          await copy(child, output);
        } finally {
          await child.close();
        }
      } else if (entry.isFile() && (await lstat(source)).nlink === 1) {
        const input = await plainFile(source);
        try {
          await pipeline(input.createReadStream({ autoClose: false }), createWriteStream(output, { flags: "wx", mode: 0o600 }));
        } finally {
          await input.close();
        }
      }
    }
  }
  try {
    await withDirectory(memory, (root) => copy(root, target));
  } catch {
    throw new MemoryEvalError("Cannot safely snapshot current memory.");
  }
}

/** Read blobs directly, without a checkout, Git filters, or archive attributes. */
export async function snapshotCommit(memory: string, target: string, at: string): Promise<string> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(at) ? new Date(`${at}T23:59:59Z`) : undefined;
  if (date ? !Number.isFinite(date.getTime()) || !date.toISOString().startsWith(at) : !/^[0-9a-f]{7,64}$/i.test(at)) {
    throw new MemoryEvalError("Use a commit hash or a UTC date (YYYY-MM-DD) with --at.");
  }
  try {
    const dir = join(resolve(memory), ".git");
    if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw new Error();
    // The backend owns .git in the sandbox. Do not use any caller-supplied Git paths or configuration.
    const args = ["--no-replace-objects", "-c", `safe.directory=${resolve(memory)}`, `--git-dir=${dir}`];
    const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
    const options = { env, maxBuffer: 16 * 1024 * 1024, cwd: target };
    const commit = (await exec("git", [...args, ...(date
      ? ["rev-list", "--first-parent", "--until=" + date.toISOString(), "-1", "HEAD"]
      : ["rev-parse", "--verify", `${at}^{commit}`])], options)).stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error();
    const tree = await exec("git", [...args, "ls-tree", "-rz", commit], { ...options, encoding: "buffer" });
    for (const entry of new TextDecoder("utf-8", { fatal: true }).decode(tree.stdout).split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (!match) continue; // Symlinks and submodules are not memory files.
      const path = match[3]!;
      if (path.split("/").some((part) => !part || [".", "..", ".git"].includes(part))) throw new Error();
      const output = join(target, path);
      await mkdir(dirname(output), { recursive: true });
      const child = spawn("git", [...args, "cat-file", "blob", match[2]!], { env, cwd: target, stdio: ["ignore", "pipe", "ignore"] });
      const done = new Promise<void>((ok, fail) => {
        child.once("error", fail);
        child.once("close", (code) => code === 0 ? ok() : fail(new Error()));
      });
      await Promise.all([pipeline(child.stdout, createWriteStream(output, { flags: "wx", mode: 0o600 })), done]);
    }
    return commit;
  } catch {
    throw new MemoryEvalError("Cannot read the requested memory commit.");
  }
}
