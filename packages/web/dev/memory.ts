// Invented, stable links and text for the read-only memory scenes.
import type { MemoryChangeResponse, MemoryDiffLine, MemoryFile, MemoryFileChange, MemoryFileDiff, MemoryOverviewResponse, MemoryWriter } from "@penelope/contract";

const oid = (number: number) => number.toString(16).padStart(40, "0");
export const MEMORY_DAY = oid(900);
export const MEMORY_NIGHT = oid(898);
export const MEMORY_TURN = "t-memory-day";
export const MEMORY_NIGHT_RECORD = "n-memory";
export const TOPIC = "machines/storage/notes.md";
export const LONG_PATH = `archive/${"a-long-archive-path-".repeat(9)}notes.md`;

export type MemoryScene = {
  overview: MemoryOverviewResponse;
  changes: MemoryChangeResponse[];
  text: Record<string, string>;
};

/** `lastNight` is the record's night that her last night's changes belong to, and how many days before today it ran. */
export function memoryScene(now: number, state: "normal" | "over" | "broken" | "empty" = "normal", lastNight_: { id: string; daysBefore: number } = { id: MEMORY_NIGHT_RECORD, daysBefore: 1 }): MemoryScene {
  const { id: nightId, daysBefore: nightDay } = lastNight_;
  const at = (hour: number, minute: number, daysBefore = 0) => {
    const t = new Date(now);
    t.setDate(t.getDate() - daysBefore);
    t.setHours(hour, minute, 0, 0);
    return t.toISOString();
  };
  const day = (daysBefore: number) => {
    const t = new Date(now);
    t.setDate(t.getDate() - daysBefore);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  const text: Record<string, string> = {
    "personality.md": "# 話し方\n\n短く、具体的に話す。\n",
  };
  const file = (path: string, added = 4, removed = 2, info: Pick<MemoryFileChange, "kind" | "from"> = { kind: "modified" }): MemoryFileChange => ({ path, added, removed, ...info });
  const change = (number: number, at: string, writer: MemoryWriter, files: MemoryFileChange[], moves: MemoryChangeResponse["moves"] = []): MemoryChangeResponse => ({
    change: {
      id: oid(number), at, writer, paths: files.map((f) => f.path), files: files.length,
      added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
    },
    files,
    moves,
  });
  const owner = change(1, at(9, 0, 400), { kind: "owner" }, [file("personality.md", 3, 0, { kind: "added" })]);
  const changes = [owner];
  const dayWriter: MemoryWriter = { kind: "daytime", agent: "main", turn_id: MEMORY_TURN, trigger: { seq: 1, source: "cron", summary: "朝の道具の点検" } };
  const dates: Record<string, string> = {};
  let lastNight: MemoryOverviewResponse["last_night"] = null;
  if (state !== "empty") {
    Object.assign(text, {
      "PURPOSE.md": "# 目的\n\n小さな工房で、道具の記録と点検の予定を保つ。\n",
      "always.md": "# いつも\n\n作業台の片付けを終えてから記録する。\n" + (state === "over" ? "- 棚のラベルと点検表の控えを照合する。\n".repeat(400) : ""),
      "handoff.md": "# 引き継ぎ\n\n明日は棚の番号を確認する。\n",
      "INDEX.md": `# 探す場所\n\n- [道具の控え](${TOPIC})\n- [日記](diary/${day(0)}.md)\n`,
      "goals/today.md": "# 今日\n\n- [棚の点検](../machines/storage/notes.md)\n- ラベルを替える\n",
      "skills/shelves/SKILL.md": "# 棚の点検\n\n上段から順に番号を確かめる。\n",
      "howto/labels.md": "# ラベルの付け方\n\n1. 文字を中央に置く。\n2. 控えを保管する。\n",
      "notes.md": "# 次の候補\n\n次回は棚の並び方を見直す。\n",
      [TOPIC]: "# 道具の控え\n\n## 置き場所\n\n- 上段: 予備の箱。\n- 下段: 紙の控え。\n\n点検が済んだら、[目標と今日のこと](../../goals/today.md)へ。\n\n> 鉛筆で棚番号を書き添える。\n",
      [LONG_PATH]: "# 箱の控え\n\n    " + "ながい記述".repeat(45) + "\n",
    });
    for (let i = 0; i < 365; i++) {
      const path = `diary/${day(i)}.md`;
      dates[path] = at(22, 0, i);
      text[path] = `# ${day(i)} の日記\n\n${i < 3 ? "棚の点検をして、紙の控えを残した。" : "工房を閉める前に作業台を片付けた。"}\n`;
    }
    for (let i = 1; i <= 31; i++) text[`archive/box-${i}.md`] = `# 箱 ${i}\n\n以前の点検表を保管した。\n`;
    if (state === "broken") text[TOPIC] += "\n[移す前の控え](old.md) と [古い索引](../../old-index.md)。\n";
    const night = (stage: "reflection" | "verifier" | "curator"): MemoryWriter => ({ kind: "night", stage, night_id: nightId, night_seq: 7 });
    const moves = [{ from: "machines/notes.md", to: TOPIC }];
    const nightChanges = [
      change(894, at(3, 1, nightDay), night("reflection"), [file("handoff.md", 4, 1)]),
      change(896, at(3, 3, nightDay), night("verifier"), [file("INDEX.md", 3, 1)]),
      change(898, at(3, 6, nightDay), night("curator"), [file(TOPIC, 4, 2, { kind: "moved", from: moves[0]!.from }), ...Array.from({ length: 31 }, (_, i) => file(`archive/box-${i + 1}.md`)), file("always.md", 12, 37), file("avatar/sample.png", 0, 0)], moves),
      change(899, at(3, 7, nightDay), { kind: "system", operation: "reference_repair", night_id: nightId, night_seq: 7 }, [file("goals/today.md", 1, 1)], moves),
    ];
    lastNight = {
      id: nightId, at: at(3, 0, nightDay), ended_at: at(3, 8, nightDay), changes: nightChanges,
      files: new Set(nightChanges.flatMap((c) => c.change.paths)).size,
      added: nightChanges.reduce((n, c) => n + c.change.added, 0), removed: nightChanges.reduce((n, c) => n + c.change.removed, 0),
    };
    changes.unshift(change(900, at(9, 40), dayWriter, [file(LONG_PATH, 2, 1), file("goals/today.md", 2, 1)]));
    for (let i = 0; i < 18; i++) changes.push(change(880 - i, at(9, 38 - i), i % 3 === 0 ? { kind: "owner" } : { kind: "daytime", agent: "main" }, [file(i % 2 ? TOPIC : "goals/today.md")]));
    changes.push(...nightChanges.toReversed());
    for (let i = 0; i < 55; i++) changes.push(change(700 - i, at(14, 25, 2 + Math.floor(i / 8)), i % 3 === 0 ? { kind: "owner" } : { kind: "daytime", agent: "main" }, [file(TOPIC, 4, 1)]));
    changes.splice(changes.indexOf(owner), 1);
    changes.push(owner);
  }
  const files = [...Object.keys(text), ...(state === "empty" ? [] : ["avatar/sample.png"])].map((path): MemoryFile => {
    const match = changes.find((entry) => entry.change.paths.includes(path))?.change;
    return {
      path, bytes: Buffer.byteLength(text[path] ?? "sample image"),
      always_read: ["PURPOSE.md", "always.md", "handoff.md", "personality.md"].includes(path),
      last_change: match ? { at: match.at, id: match.id, writer: match.writer } : { at: dates[path] ?? at(9, 0, 4), id: owner.change.id, writer: owner.change.writer },
      reads: state === "empty" ? null : { count_30_days: path === TOPIC ? 12 : path === LONG_PATH ? 0 : 2, last_day: path === LONG_PATH ? null : day(1) },
    };
  });
  return {
    text, changes,
    overview: {
      head: changes[0]!.change.id, files, last_night: lastNight,
      always_read: { bytes: files.filter((f) => f.always_read).reduce((n, f) => n + f.bytes, 0), target_bytes: 16384, file_limit_bytes: 65536, over_target_nights: state === "over" ? [day(1), day(2)] : [] },
      broken_links: state === "broken" ? [{ path: TOPIC, line: 13, destination: "old.md" }, { path: TOPIC, line: 13, destination: "../../old-index.md" }] : [], links_incomplete: false,
    },
  };
}

export function memoryDiff(path: string): MemoryFileDiff {
  if (path === "avatar/sample.png") return { kind: "image" };
  const lines: MemoryDiffLine[] = path === LONG_PATH ? [
    { kind: "context", old_line: 1, new_line: 1, text: "# 箱の控え" },
    { kind: "removed", old_line: 2, text: "- 古い点検表の控え" },
    { kind: "added", new_line: 2, text: "    " + "very-long-unbroken-archive-entry".repeat(18) },
    { kind: "added", new_line: 3, text: "- 点検表を新しい箱に入れた。" },
  ] : [
    { kind: "context", old_line: 1, new_line: 1, text: "# 道具の控え" },
    { kind: "removed", old_line: 2, text: "- 道具は右の棚へ。" },
    { kind: "added", new_line: 2, text: "- 道具は下段の箱へ。" },
  ];
  return { kind: "text", truncated: false, hunks: [
    { old_start: 1, new_start: 1, lines },
    { old_start: 9, new_start: 9, lines: [{ kind: "context", old_line: 9, new_line: 9, text: "最後に点検表を確認する。" }] },
  ] };
}
