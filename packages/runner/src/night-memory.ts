import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Only paths, lengths and fingerprints are kept between nights, not the file contents. */
export type MemoryFile = { path: string; bytes: number; sha256: string };

export async function memorySnapshot(root: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(join(root, path))) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        files.push({ path, bytes, sha256: hash.digest("hex") });
      }
    }
  }
  await walk("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function memoryChanges(before: MemoryFile[] | undefined, now: MemoryFile[]): string[] {
  if (!before) return now.map((file) => file.path);
  const old = new Map(before.map((file) => [file.path, file.sha256]));
  const changed = now.filter((file) => {
    const hash = old.get(file.path);
    old.delete(file.path);
    return hash !== file.sha256;
  });
  return [...changed.map((file) => file.path), ...old.keys()].sort();
}
