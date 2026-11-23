import { diffLines } from "diff";

import type { MemoryDiffLine, MemoryFileDiff } from "@penelope/contract";

/** Bound the work and rendering of a draft diff independently of the save limit. */
export function diffMemoryText(before: string, after: string): { diff: MemoryFileDiff; added?: number; removed?: number } {
  if (before === after) return { diff: { kind: "text", hunks: [], truncated: false }, added: 0, removed: 0 };
  if (Math.max(before.length, after.length) > 1024 * 1024) return { diff: { kind: "too_large" } };
  const parts = diffLines(before, after, { timeout: 50, maxEditLength: 20000 });
  if (!parts) return { diff: { kind: "too_large" } };
  const hunks: Extract<MemoryFileDiff, { kind: "text" }>["hunks"] = [];
  let old = 1, next = 1, shown = 0, added = 0, removed = 0;
  let truncated = false;
  let lines: MemoryDiffLine[] | undefined;
  for (const [i, part] of parts.entries()) {
    if (part.added) added += part.count;
    if (part.removed) removed += part.count;
    const body = part.value.split("\n");
    if (part.value.endsWith("\n")) body.pop();
    for (const [j, text] of body.entries()) {
      const context = !part.added && !part.removed;
      const show = !context || (i > 0 && j < 3) || (i < parts.length - 1 && j >= body.length - 3);
      if (!show) lines = undefined;
      else if (shown === 2000) truncated = true;
      else {
        if (!lines) hunks.push({ old_start: old, new_start: next, lines: lines = [] });
        lines.push(part.added ? { kind: "added", new_line: next, text } : part.removed ? { kind: "removed", old_line: old, text } : { kind: "context", old_line: old, new_line: next, text });
        shown++;
      }
      if (!part.added) old++;
      if (!part.removed) next++;
    }
  }
  return { diff: { kind: "text", hunks, truncated }, added, removed };
}
