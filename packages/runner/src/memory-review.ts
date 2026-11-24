import type { MemoryFile } from "./night-memory.ts";
import { PROMPT_FILES } from "./prompts.ts";

const nonTopics = new Set<string>([...PROMPT_FILES, "INDEX.md"]);

/** The map stays whole; only the set of topic bodies to review has a byte budget. */
export function reviewTopics(
  files: readonly Pick<MemoryFile, "path" | "bytes">[], lastReviews: ReadonlyMap<string, string>, maxBytes: number,
): string[] {
  const topics = files.filter(({ path }) => /\.md$/i.test(path) && !nonTopics.has(path) && !/^(diary|archive|goals|skills|agents|extensions)\//.test(path));
  topics.sort((a, b) =>
    (lastReviews.get(a.path) ?? "").localeCompare(lastReviews.get(b.path) ?? "")
    || b.bytes - a.bytes
    || a.path.localeCompare(b.path)
  );
  const selected: string[] = [];
  let remaining = maxBytes;
  for (const { path, bytes } of topics) {
    if (bytes > remaining) {
      if (selected.length === 0) return [path];
      continue;
    }
    selected.push(path);
    remaining -= bytes;
  }
  return selected;
}

/** Seven local calendar dates ending on the scheduled night; use UTC arithmetic on the date labels. */
export function weekDiary(paths: readonly string[], reviewDate: string): string[] {
  const files = new Set(paths);
  const day = new Date(`${reviewDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 6);
  const entries: string[] = [];
  for (let i = 0; i < 7; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    const path = `diary/${day.toISOString().slice(0, 10)}.md`;
    if (files.has(path)) entries.push(path);
  }
  return entries;
}

export type ArchivePlan = { current: string; groups: { into: string; from: string[] }[] };

/** Plan consolidation from calendar periods in filenames; the curator reads and summarises their contents. */
export function planArchive(paths: readonly string[], reviewDate: string): ArchivePlan {
  const currentMonth = Number(reviewDate.slice(0, 4)) * 12 + Number(reviewDate.slice(5, 7)) - 1;
  const current = `archive/${reviewDate.slice(0, 7)}.md`;
  const groups = new Map<string, string[]>();
  for (const path of [...paths].sort()) {
    const match = /^archive\/(\d{4})-(?:(0[1-9]|1[0-2])|Q[1-4])\.md$/.exec(path);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    let into: string;
    if (currentMonth >= (year + 1) * 12 + 9) {
      // Annual compaction takes precedence, including any months not yet compacted.
      into = `archive/${match[1]}.md`;
    } else {
      if (!month) continue;
      const quarter = Math.ceil(month / 3);
      if (currentMonth < year * 12 + quarter * 3 - 1 + 3) continue;
      into = `archive/${match[1]}-Q${quarter}.md`;
    }
    const from = groups.get(into) ?? [];
    from.push(path);
    groups.set(into, from);
  }
  return { current, groups: [...groups].map(([into, from]) => ({ into, from })) };
}
