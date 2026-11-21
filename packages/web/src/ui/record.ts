// How the activity record is written on the screen (docs/design/README.md,
// 15): a turn's heading from what started it, the small words at the end of
// a row, the turns that went as usual folded an hour at a time, and the days
// and times. Plain functions, so that the tests read them without a DOM.
import type { RecordJob, RecordNight, RecordRow, RecordSubAgent, RecordTurn, Source } from "@penelope/contract";

import { sourceWord, triggerWords, words } from "./words.ts";

const w = words.record;

/** The kind of an event in the record, as a turn's heading starts with it. */
export function recordSourceWord(source: Source): string {
  return source === "job" ? w.jobEnd : sourceWord(source);
}

/**
 * A turn's heading: the kind of what started it in bold, its words cut to one
 * line, and how many more there were. A sub-agent's turn came from the main
 * agent, and is named by the sub-agent.
 */
export type Headline = { kind: string; text: string; more?: string; who?: string };

export function headlineOf(turn: RecordTurn): Headline {
  if (turn.night !== undefined) return { kind: w.nightTurn, text: w.stages[turn.night.stage] };
  if (turn.agent !== "main") return { kind: w.fromMain, text: "", who: turn.agent };
  const [first] = turn.triggers;
  if (first === undefined) return { kind: w.unknownTrigger, text: "" };
  const kind = recordSourceWord(first.source);
  const count = Math.max(turn.trigger_count, turn.triggers.length);
  if (count === 1) return { kind, text: triggerWords(first.summary) };
  if (turn.triggers.every((t) => t.source === first.source)) return { kind, text: w.together(first.source === "ui" ? w.ownerNoun : w.eventNoun, count) };
  return { kind, text: triggerWords(first.summary), more: w.moreEvents(count - 1) };
}

/** The kind a folded turn is counted under. */
function kindOf(turn: RecordTurn): string {
  return headlineOf(turn).kind;
}

/** "48 秒", "2 分 10 秒", "1 時間 5 分". */
export function durationOf(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return s % 60 === 0 ? `${Math.floor(s / 60)} 分` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${Math.floor(s / 3600)} 時間` : `${Math.floor(s / 3600)} 時間 ${m} 分`;
}

const join = (parts: Array<string | undefined | false>) => parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ・ ");

/** The small words at the end of a turn's row. */
export function turnMeta(turn: RecordTurn): string {
  const time = turn.seconds === undefined ? undefined : durationOf(turn.seconds);
  switch (turn.result) {
    case "stopped":
      return join([w.stopped, time]);
    case "running":
      return join([w.running, w.tools(turn.tools)]);
    case "unknown":
      return join([w.unknown, time, w.tools(turn.tools)]);
    default:
      return join([time, w.tools(turn.tools), turn.replies > 0 && w.reply]);
  }
}

/** The second line of a failed turn: that it failed, and why when the runner said. */
export function turnNote(turn: RecordTurn): string | undefined {
  return turn.result === "failed" ? join([w.failed, turn.reason]) : undefined;
}

export type Stage = RecordNight["stages"]["curator"] & { key: keyof RecordNight["stages"]; name: string };

export function nightTitle(night: RecordNight): string {
  return night.stages.curator.review === undefined ? w.night : w.reviewNight;
}

export function nightWarnings(night: RecordNight): string | undefined {
  const over = night.stages.curator.always_read_over_target;
  const dropped = night.stages.verifier.dropped_records;
  return join([
    over === undefined ? undefined : w.layerOverTarget(over.total_bytes, over.target_bytes),
    dropped === undefined ? undefined : w.droppedRecords(dropped),
  ]);
}

export function stagesOf(night: RecordNight): Stage[] {
  return (["reflection", "verifier", "curator", "session"] as const).map((key) => {
    return { key, name: w.stages[key], ...night.stages[key] };
  });
}

/** The first failed step, even if the night went on. */
export function failedStageOf(night: RecordNight): Stage | undefined {
  return stagesOf(night).find((stage) => stage.result === "failed");
}

export function nightNote(night: RecordNight): string | undefined {
  const stage = failedStageOf(night);
  return stage === undefined ? undefined : join([w.stageFailed(stage.name), stage.reason]);
}

/** A job is a failure when it ended with an exit code other than 0, by its time limit, or by a signal. */
export function jobNote(job: RecordJob): string | undefined {
  if (job.failed_at === undefined) return undefined;
  if (job.end === "timed-out") return join([w.failed, w.timedOut]);
  if (job.end === "signaled") return join([w.failed, job.signal === undefined ? undefined : w.signal(job.signal)]);
  return join([w.failed, job.exit_code === undefined ? undefined : w.exit(job.exit_code)]);
}

export function jobMeta(job: RecordJob): string {
  const time = durationOf(job.seconds);
  if (job.failed_at !== undefined) return time;
  if (job.end === "stopped") return join([w.jobStopped, time]);
  if (job.end === "interrupted") return join([w.jobInterrupted, time]);
  return join([w.exit(job.exit_code ?? 0), time]);
}

export function subMeta(sub: RecordSubAgent): string {
  return join([w.subTurnCount(sub.turns, sub.failed_turns), sub.started_at === undefined ? undefined : w.startedAt(timeOfDay(sub.started_at))]);
}

/** Whether a row is a failure, or a missed night, the backend learned of after the owner last opened the record. */
export function isFresh(row: RecordRow, previousSeenAt: string | undefined): boolean {
  return row.failed_at !== undefined && previousSeenAt !== undefined && Date.parse(row.failed_at) > Date.parse(previousSeenAt);
}

/** A turn that stands on its own row: one that failed. The rest are folded an hour at a time. */
function foldable(row: RecordRow): row is RecordTurn {
  return row.kind === "turn" && row.result !== "failed";
}

export type Group = { key: string; hour: number; turns: RecordTurn[] };
export type Entry = { type: "row"; row: RecordRow } | { type: "group"; group: Group };

/**
 * A day's rows as the list shows them, newest first: the turns that did not
 * fail are folded into one row for each hour that has two or more of them,
 * standing at the start of the hour; the others keep their own rows.
 */
export function foldDay(day: string, rows: readonly RecordRow[]): Entry[] {
  const groups = new Map<number, Group>();
  const entries: Array<{ entry: Entry; at: number }> = [];
  for (const row of rows) {
    if (!foldable(row)) {
      entries.push({ entry: { type: "row", row }, at: Date.parse(row.at) });
      continue;
    }
    const at = new Date(row.at);
    const hour = at.getHours();
    let group = groups.get(hour);
    if (group === undefined) {
      group = { key: `${day}T${hour}`, hour, turns: [] };
      groups.set(hour, group);
      const start = new Date(at);
      start.setMinutes(0, 0, 0);
      entries.push({ entry: { type: "group", group }, at: start.getTime() });
    }
    group.turns.push(row);
  }
  const unfolded = entries.map(({ entry, at }) =>
    entry.type === "group" && entry.group.turns.length === 1 ? { entry: { type: "row", row: entry.group.turns[0]! } as Entry, at: Date.parse(entry.group.turns[0]!.at) } : { entry, at },
  );
  // Newest first; at the same time, a row before the hour that starts then.
  return unfolded
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.at - a.at || (a.entry.type === "row" ? 0 : 1) - (b.entry.type === "row" ? 0 : 1) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** What a folded hour holds, by the kind of what started its turns: the three most, then the rest. */
export function mixOf(turns: readonly RecordTurn[]): string {
  const counts = new Map<string, number>();
  for (const turn of turns) counts.set(kindOf(turn), (counts.get(kindOf(turn)) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = sorted.length > 3 ? sorted.slice(0, 3) : sorted;
  const rest = sorted.slice(shown.length).reduce((sum, [, n]) => sum + n, 0);
  return join([...shown.map(([kind, n]) => `${kind} ${n}`), rest > 0 && w.others(rest)]);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The heading of a day (`YYYY-MM-DD`, in the browser's time zone): today and yesterday before the date, and the year when it is not this one. */
export function recordDayOf(day: string, now: number = Date.now()): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const today = new Date(now);
  const date = `${y === today.getFullYear() ? "" : `${y}年`}${m}月${d}日(${weekday})`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day === localDay(today)) return `${words.today} ・ ${date}`;
  if (day === localDay(yesterday)) return `${words.yesterday} ・ ${date}`;
  return date;
}

/** "14:12". */
export function timeOfDay(at: string): string {
  const t = new Date(at);
  return `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** "14:12:31". */
function secondsOf(at: string): string {
  const t = new Date(at);
  return `${timeOfDay(at)}:${String(t.getSeconds()).padStart(2, "0")}`;
}

/** "11月17日(火)". */
export function dateOf(at: string): string {
  const t = new Date(at);
  return `${t.getMonth() + 1}月${t.getDate()}日(${WEEKDAYS[t.getDay()]})`;
}

/** "11月17日(火) 9:02". */
export function dateTimeOf(at: string): string {
  return `${dateOf(at)} ${timeOfDay(at)}`;
}

/** "11月17日(火) 14:12:31 〜 14:13:19（48 秒）", the end's date again when it is another day. */
export function spanOf(start: string | undefined, end: string | undefined, seconds: number | undefined): string {
  if (start === undefined) return end === undefined ? "" : `${dateOf(end)} 〜 ${secondsOf(end)}`;
  const head = `${dateOf(start)} ${secondsOf(start)}`;
  if (end === undefined) return `${head} 〜`;
  const tail = dateOf(end) === dateOf(start) ? secondsOf(end) : `${dateOf(end)} ${secondsOf(end)}`;
  return `${head} 〜 ${tail}${seconds === undefined ? "" : `（${durationOf(seconds)}）`}`;
}

/** The whole heading of a turn, for its page's title and the name of its link. */
export function headlineText(turn: RecordTurn): string {
  const h = headlineOf(turn);
  return [h.who, h.kind, h.text === "" ? undefined : `・ ${h.text}`, h.more].filter((p) => p !== undefined).join(" ");
}
