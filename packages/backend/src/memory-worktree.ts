import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Check raw bytes and Git's executable bit; replace only an unchanged regular file. */
export function replaceMemoryFile(root: string, path: string, original: Buffer, executable: boolean, body?: Buffer): boolean {
  // In the Linux backend, pin each directory before opening its children. A
  // symlink swapped into the work tree must never redirect backend writes.
  const names = path.split("/");
  const parents: Array<{ fd: number; name: string }> = [];
  const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const openDir = (name: string) => { const fd = openSync(name, directory); parents.push({ fd, name }); return `/proc/self/fd/${fd}`; };
  let temporary: string | undefined;
  let file: number | undefined;
  try {
    let dir = openDir(root);
    for (const name of names.slice(0, -1)) dir = openDir(`${dir}/${name}`);
    const target = `${dir}/${names.at(-1)!}`;
    if (body !== undefined) {
      const name = `${dir}/.penelope-save-${randomUUID()}`;
      const fd = openSync(name, "wx", 0o600);
      temporary = name;
      try {
        const gid = fstatSync(parents[0]!.fd).gid;
        if (fstatSync(fd).gid !== gid) fchownSync(fd, -1, gid);
        writeFileSync(fd, body);
        fchmodSync(fd, executable ? 0o770 : 0o660);
      } finally { closeSync(fd); }
    }
    // O_NONBLOCK prevents a FIFO from making the check wait for a writer.
    file = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(original.length) || Boolean(before.mode & 0o100n) !== executable) return false;
    const seen = Buffer.alloc(original.length);
    for (let offset = 0; offset < seen.length;) {
      const n = readSync(file, seen, offset, seen.length - offset, offset);
      if (!n) return false;
      offset += n;
    }
    if (!seen.equals(original)) return false;
    for (const { fd, name } of parents) {
      const opened = fstatSync(fd, { bigint: true });
      const linked = lstatSync(name, { bigint: true });
      if (opened.dev !== linked.dev || opened.ino !== linked.ino) return false;
    }
    const linked = lstatSync(target, { bigint: true });
    if (before.dev !== linked.dev || before.ino !== linked.ino || before.ctimeNs !== linked.ctimeNs) return false;
    if (temporary !== undefined) {
      renameSync(temporary, target);
      temporary = undefined;
    }
    return true;
  } catch (error) {
    // Moving or deleting a file (or a parent directory) leaves no safe target.
    if (["ENOENT", "ELOOP", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    try {
      if (temporary !== undefined) unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (file !== undefined) closeSync(file);
      for (const { fd } of parents.reverse()) closeSync(fd);
    }
  }
}
