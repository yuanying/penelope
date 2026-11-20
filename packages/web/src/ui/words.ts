// The words of the screens (docs/design/README.md) and how times and
// sources are written. Kept in one place so that they change together.
import type { Source } from "@penelope/contract";

import type { Status } from "../model/store.ts";

export const words = {
  places: { talk: "会話", log: "活動の記録", memory: "記憶", events: "出来事と予約", settings: "設定" },
  placeholderTitle: "まだありません",
  placeholderBody: "この場所は、これから作ります。",
  emptyTitle: "まだ会話はありません",
  emptyBody: "下の欄から話しかけてください。",
  offline: "接続が切れました。つなぎ直しています。書いたものは、つながってから送られます。",
  inputLabel: "メッセージ",
  inputPlaceholder: "メッセージを書く",
  attach: "画像やファイルを添付",
  attachments: "添付",
  dropHere: "ここに落とすと添付になります",
  removeFile: (name: string) => `${name} を外す`,
  openImage: (name: string) => `${name} を大きく見る`,
  duringTurn: "考えている最中に届きました",
  thinkingDots: "考えている",
  writingDots: "書いている途中",
  panel: "いまのエージェント",
  togglePanel: "いまのエージェントを開く・閉じる",
  openSheet: "いまのエージェントを開く",
  menu: "メニュー",
  approvals: "承認待ち",
  approvalsNone: "いまはありません",
  main: "本体",
  subAgents: "サブエージェント",
  subCount: (n: number) => `サブ ${n}`,
  idle: "いまは何もしていません。次の出来事を待っています。",
  turnStart: "ターンの始まり",
  trigger: "きっかけ",
  thought: "思考",
  thoughtOpen: "全文を開く",
  thoughtClose: "畳む",
  tool: "ツール",
  result: "結果",
  resultError: "結果（失敗）",
  message: "返答",
  interrupt: "割り込み",
  ownerMessage: "オーナーのメッセージ",
  writing: "思考（途中）",
  login: "GitHub でログイン",
  loginNote: "オーナーだけが入れます。",
  logout: "ログアウト",
  push: {
    off: "通知を受ける",
    on: "通知を止める",
    busy: "通知を設定しています",
    failed: "通知を受けられませんでした。もう一度試す",
    denied: "通知はブラウザで止められています",
    unsupported: "このブラウザでは通知を受けられません（iPhone はホーム画面に置いてから）",
    unavailable: "この配置では通知を使えません",
  },
  schedules: "予約",
  schedulesNone: "予約はありません",
  schedulesNoneBody: "エージェントが予約を足すと、ここに並びます。",
  schedulesFailed: "予約を読めませんでした。",
  scheduleOnce: "1 回だけ",
  scheduleNext: "次は",
  scheduleCount: (n: number) => `${n} 件`,
  scheduleRemove: "取り消す",
  scheduleRemoveOf: (lead: string) => `「${lead}」を取り消す`,
  scheduleKeep: "やめる",
  scheduleConfirm: "この予約を取り消しますか？",
  /** With how it comes: the cron in words, or else the cron itself; neither for a one-time one. */
  scheduleConfirmBody: (lead: string, rhythm: string | undefined, cron: string | undefined) =>
    `「${lead}」の予約を消します。${
      rhythm !== undefined ? `${rhythm} に繰り返す予約です` : cron !== undefined ? `cron「${cron}」で繰り返す予約です` : "1 回だけの予約です"
    }。エージェントには知らせません。`,
  scheduleRemoveFailed: "取り消せませんでした。もう一度試してください。",
  today: "今日",
  yesterday: "昨日",
  tomorrow: "明日",
  /** The activity record (docs/design/README.md, 15). */
  record: {
    title: "活動の記録",
    back: "活動の記録",
    unseenBanner: (n: number) => `前に見たあとの失敗が ${n} 件あります`,
    railLabel: (n: number) => `活動の記録（まだ見ていない失敗 ${n} 件）`,
    menuLabel: (n: number) => `メニュー（まだ見ていない失敗 ${n} 件）`,
    fresh: "新しい",
    onlyFailures: "失敗だけ",
    who: "誰の",
    kind: "種類",
    all: "すべて",
    kinds: { turn: "ターン", night: "夜の切り替え", job: "裏の仕事", sub_agent: "閉じたサブエージェント" },
    footer: "一覧は 1 年残ります。ターンの中の流れは 30 日で消えます。",
    emptyTitle: "まだ記録はありません",
    emptyBody: "エージェントが動くと、ターンや夜の切り替えがここに並びます。",
    noMatch: "当てはまる記録はありません。",
    failedToRead: "活動の記録を読めませんでした。",
    turns: (n: number) => `ターン ${n}`,
    failures: (n: number) => (n === 0 ? "失敗なし" : `失敗 ${n}`),
    hour: (h: number) => `${h}時台`,
    others: (n: number) => `ほか ${n}`,
    moreEvents: (n: number) => `ほか ${n} 件`,
    together: (noun: string, n: number) => `${noun} ${n} 件をまとめて`,
    ownerNoun: "発言",
    eventNoun: "出来事",
    fromMain: "本体から",
    unknownTrigger: "きっかけ不明",
    nightTurn: "夜の切り替え",
    night: "夜の切り替え",
    missedNight: "逃した夜",
    missedNote: (time: string) => `${time} の予定の切り替えが行われませんでした。`,
    job: "裏の仕事",
    jobEnd: "裏の仕事の終わり",
    closedSub: "閉じたサブエージェント",
    stages: { reflection: "振り返り", verifier: "照合係", curator: "整理係", session: "新しいセッション" },
    stageWord: { done: "済み", failed: "失敗", skipped: "行われなかった", unknown: "分からない" },
    stageFailed: (stage: string) => `${stage}が失敗`,
    failed: "失敗した",
    stopped: "止められた",
    done: "ふつうに終わった",
    running: "考えている",
    unknown: "結果は分かりません",
    nightDone: "済んだ",
    nightUnknown: "段の結果は分かりません",
    closed: "閉じた",
    open: "閉じていない",
    reply: "返事",
    tools: (n: number) => `ツール ${n}`,
    timedOut: "時間切れ",
    signal: (s: string) => `シグナル ${s}`,
    exit: (n: number) => `exit ${n}`,
    jobStopped: "止めた",
    jobInterrupted: "切れた",
    startedAt: (time: string) => `${time} に起こした`,
    subTurnCount: (n: number, failed: number) => `ターン ${n}${failed > 0 ? `（失敗 ${failed}）` : ""}`,
    facts: { time: "時刻", who: "誰の", tools: "ツール", replies: "返事", due: "予定", purpose: "目的", started: "起こした", closed: "閉じた", turns: "ターン" },
    toolTimes: (n: number) => `${n} 回`,
    replyCount: (n: number) => (n === 0 ? "なし" : `${n} 通`),
    subTurnFacts: (n: number, failed: number) => `${n}（${failed === 0 ? "失敗なし" : `失敗 ${failed}`}）`,
    flow: "流れ",
    expired: "このターンの流れは 30 日で消えました。残っているのは上の要約だけです。",
    replies: "このターンで出した返事",
    noReplies: "このターンでは返事を出していません。",
    toTalk: "会話でこの返事を見る",
    seeTurn: (time: string) => `${time} ・ このターンを見る`,
    subTurns: (n: number) => `このサブエージェントのターン ・ ${n}`,
    moreTurns: (n: number) => `残りの ${n} 件を見る`,
    openResult: (lines: number, size: string) => `結果を開く（${lines} 行 ・ ${size}）`,
    openErrorResult: (lines: number, size: string) => `結果（失敗）を開く（${lines} 行 ・ ${size}）`,
    resultGone: "この結果は残っていません。",
    resultFailed: "結果を読めませんでした。",
    notFound: "この記録は見つかりません。",
  },
} as const;

export function statusWord(status: Status): string {
  switch (status.kind) {
    case "offline":
      return "接続なし";
    case "waiting":
      return "待っている";
    case "thinking":
      return "考えている";
    case "tool":
      return "ツールを使っている";
  }
}

/** The state of a sub-agent: it waits stopped until the main agent speaks to it. */
export function subAgentWord(status: Status): string {
  return status.kind === "waiting" ? "止まって待っている" : statusWord(status);
}

/** How many sub-agents run and wait, as the head of their column says it. */
export function subCountWord(running: number, waiting: number): string {
  return waiting > 0 ? `走っている ${running} ・ 待っている ${waiting}` : `走っている ${running}`;
}

/** Since when a sub-agent has waited: the time today, else the day too. */
export function sinceOf(at: string, now: number = Date.now()): string {
  const day = dayOf(at, now);
  if (day === words.today) return `${timeOf(at)} から`;
  if (day === words.yesterday) return `${day} ${timeOf(at)} から`;
  return `${day}から`;
}

/** The words of the faces of an avatar (ADR-0016). One it does not know is read as neutral. */
const FACES: Partial<Record<string, string>> = {
  neutral: "いつもどおり",
  happy: "うれしい",
  laughing: "笑っている",
  surprised: "驚いた",
  thinking: "考え中",
  worried: "心配",
  sad: "悲しい",
  sleepy: "眠い",
  angry: "怒っている",
};

export function faceWord(expression: string): string {
  return FACES[expression] ?? FACES.neutral!;
}

const SOURCES: Partial<Record<string, string>> = { cron: "予約", self: "自分から", a2a: "A2A", control: "制御", ui: "オーナー" };

export function sourceWord(source: Source): string {
  return SOURCES[source] ?? source;
}

/**
 * The words of what made her speak, as its mark shows them: without the
 * marks of Markdown (the mark has no style of its own inside it), and on one
 * line. What is not a mark, such as the _ inside a name or a lone *, stays.
 */
export function triggerWords(summary: string): string {
  const lines = summary.split(/\r?\n/).map((line) =>
    line
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""),
  );
  return lines
    .join("\n")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(?<!\*)\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString("ja-JP", { hour: "numeric", minute: "2-digit" });
}

/** The label of the day a line falls on: today, yesterday, or its date. */
export function dayOf(at: string, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return words.today;
  if (diff === 1) return words.yesterday;
  return day.toLocaleDateString("ja-JP", { year: day.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "long", day: "numeric", weekday: "short" });
}

/** When a schedule comes due: today, tomorrow or its date, and the time. */
export function dueOf(at: string, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const label = Math.round((startOf(day) - startOf(today)) / 86_400_000) === 1 ? words.tomorrow : dayOf(at, now);
  return `${label} ${timeOf(at)}`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** A whole number written plainly, from min to max; anything else is undefined. */
function single(field: string, min: number, max: number): number | undefined {
  if (!/^\d{1,2}$/.test(field)) return undefined;
  const n = Number(field);
  return n >= min && n <= max ? n : undefined;
}

/**
 * A cron in words: every day, every week (one weekday), every month (one day)
 * or every year (one month and day), at one minute of one hour. The rest is
 * undefined, and only its expression is shown. The numbers are the
 * expression's own, read by the backend in its time zone, so they are not
 * turned into the browser's.
 */
export function rhythmOf(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
  const minute = single(minuteField, 0, 59);
  const hour = single(hourField, 0, 23);
  if (minute === undefined || hour === undefined) return undefined;
  const time = `${hour}:${String(minute).padStart(2, "0")}`;
  const any = (field: string) => field === "*";
  if (any(dayField) && any(monthField)) {
    if (any(weekdayField)) return `毎日 ${time}`;
    const weekday = single(weekdayField, 0, 7);
    return weekday === undefined ? undefined : `毎週 ${WEEKDAYS[weekday % 7]}曜 ${time}`;
  }
  if (!any(weekdayField)) return undefined;
  const day = single(dayField, 1, 31);
  if (day === undefined) return undefined;
  if (any(monthField)) return `毎月 ${day}日 ${time}`;
  const month = single(monthField, 1, 12);
  return month === undefined ? undefined : `毎年 ${month}月${day}日 ${time}`;
}

/** A reason as a lead (up to its first 。, without it) and the rest, if any. */
export function splitReason(reason: string): { lead: string; rest?: string } {
  const end = reason.indexOf("。");
  if (end < 0) return { lead: reason };
  const rest = reason.slice(end + 1).trim();
  return rest === "" ? { lead: reason.slice(0, end) } : { lead: reason.slice(0, end), rest };
}

/** The day schedules are grouped under: today or tomorrow before the date, and the year when it is not this one. */
export function scheduleDayOf(at: string, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const date = `${day.getFullYear() === today.getFullYear() ? "" : `${day.getFullYear()}年`}${day.getMonth() + 1}月${day.getDate()}日(${WEEKDAYS[day.getDay()]})`;
  const diff = Math.round((startOf(day) - startOf(today)) / 86_400_000);
  if (diff === 0) return `${words.today} ・ ${date}`;
  if (diff === 1) return `${words.tomorrow} ・ ${date}`;
  return date;
}

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
