// The made-up worlds the development server (dev.ts) answers with, one per
// scene. Typed with the contract, so that a change to the API's shapes fails
// the type check here as well as in the UI. Nothing in them is real: the
// repository is public (AGENTS.md).
//
// Times are written on the day the scene is made (or the day before), or as
// minutes before it, so that the screens always read as today's.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type {
  Activity,
  AgentResponse,
  HistoryEntry,
  RecordRow,
  RecordTurn,
  ReplyImage,
  ScheduleEntry,
  StreamEvent,
  SubAgent,
  Trigger,
} from "@penelope/contract";

import { MEMORY_TURN, type MemoryScene, memoryScene } from "./memory.ts";
import { MORNING_TRIGGERS, morning } from "./morning.ts";

export type Scene = {
  agent: AgentResponse;
  /** Oldest first. */
  history: HistoryEntry[];
  agents: SubAgent[];
  schedules: ScheduleEntry[];
  /** The rows of the activity record's list, in any order. */
  record: RecordRow[];
  /** The turns of the nightly switch: on the night's page only, never rows of the list (docs/ui-api.md). */
  nightTurns: RecordTurn[];
  memory?: MemoryScene;
  unseen: number;
  /** When the owner opened the record before, as POST /api/record/seen answers. */
  previousSeenAt: string;
  /** Kept as the backend keeps them, and replayed to each connection of the stream. */
  stream: StreamEvent[];
  /** Sent once, after the first connection, each so many milliseconds after the one before. */
  script: Array<{ afterMs: number; event: StreamEvent }>;
};

/**
 * The picture of the 11:32 reply. The owner keeps it outside the repository's
 * history; without it the mock answers a drawn stand-in (mock.ts).
 */
export const DAY_IMAGE = path.join(import.meta.dirname, "assets/day.jpg");
export const PLACEHOLDER_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="617" viewBox="0 0 480 617"><rect width="480" height="617" fill="#c9d6c2"/><rect x="0" y="420" width="480" height="197" fill="#8fb0c8"/><circle cx="240" cy="210" r="60" fill="#6b7f4e"/><rect x="170" y="260" width="140" height="230" rx="40" fill="#556b3a"/><text x="240" y="590" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#334">dev/assets/day.jpg</text></svg>';

const FACES = ["neutral", "happy", "laughing", "surprised", "thinking", "worried", "sad", "sleepy", "angry"];

/**
 * The avatar the mock shows: one of the repository's own (assets/avatars/),
 * penelope unless AVATAR names another. Her name and the faces she has come
 * from its avatar.json; a face is served from its file (mock.ts). Without
 * that folder the mock keeps the name and draws the faces itself.
 */
export const AVATAR_DIR = path.join(import.meta.dirname, "../../../assets/avatars", process.env.AVATAR ?? "penelope");
const avatar = ((): { name?: string; icons?: Record<string, string> } => {
  const file = path.join(AVATAR_DIR, "avatar.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
})();
/** The file of each face the avatar has, by expression. */
export const AVATAR_ICONS: Record<string, string> = avatar.icons ?? {};

export const agent: AgentResponse = {
  name: avatar.name ?? "ペネロペ",
  icons: Object.fromEntries((avatar.icons ? Object.keys(avatar.icons) : FACES).map((face) => [face, `/api/agent/icons/${face}`])),
};

type When = Partial<{ hour: number; minute: number; weekday: number; month: number; day: number }>;
type Clock = {
  ago: (minutes: number) => string;
  /** A local time today, or that many days before. */
  at: (hour: number, minute: number, daysBefore?: number) => string;
  next: (when: When) => string;
};

function clock(now: number): Clock {
  return {
    ago: (minutes) => new Date(now - minutes * 60_000).toISOString(),
    at: (hour, minute, daysBefore = 0) => {
      const at = new Date(now);
      at.setDate(at.getDate() - daysBefore);
      at.setHours(hour, minute, 0, 0);
      return at.toISOString();
    },
    // The next local time that matches, a day at a time from now: good enough for a few schedules.
    next: ({ hour = 0, minute = 0, weekday, month, day }) => {
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      for (let i = 0; i < 400; i++) {
        if (at.getTime() > now && (weekday === undefined || at.getDay() === weekday) && (month === undefined || at.getMonth() === month - 1) && (day === undefined || at.getDate() === day)) break;
        at.setDate(at.getDate() + 1);
      }
      return at.toISOString();
    },
  };
}

const reply = (id: string, at: string, text: string, extra: { trigger?: Trigger; turn_id?: string } = {}): HistoryEntry => ({
  kind: "agent",
  id,
  at,
  text,
  agent: "main",
  expression: "normal",
  ...extra,
});

const owner = (id: string, at: string, text: string): HistoryEntry => ({ kind: "owner", id, at, text });

const LONG_ALERT = "[FIRING warning] HighMemoryUsage namespace=batch pod=report-7d9f container=worker memory 1.8Gi of 2Gi (90%) for more than 15 minutes";
const LONG_SELF =
  "2 件の独立したレビューを終え、証跡と投稿案を `notes/review/` に保存しました。**どちらも承認相当で、今回の差分に起因する blocker は見つかっていません。** 細かな指摘が 3 点あり、いずれも次の PR で直せる範囲なので、まとめて issue にしておきます。";

function image(): ReplyImage {
  const size = existsSync(DAY_IMAGE) ? statSync(DAY_IMAGE).size : Buffer.byteLength(PLACEHOLDER_IMAGE);
  return { id: "day", mime_type: "image/jpeg", size, name: "day.jpg" };
}

/** The day before: the cases the screen has to hold, out of the way of this morning. */
function yesterday({ at }: Clock): HistoryEntry[] {
  return [
    reply("y-1", at(9, 0, 1), "おはよう、ユウ。夜のあいだに再起動が 2 回あったけれど、いまはすべて Running に戻っているよ。", {
      trigger: { source: "cron", summary: "毎朝 9:00" },
      turn_id: "t-y-0900",
    }),
    reply(
      "y-2",
      at(14, 12, 1),
      "メモリの使用量が上がっていたのは、バッチの Job が重なったためだったよ。\n\n- いまは下がっている\n- 上限の見直しが要るかは、明日の同じ時間帯を見てから決める\n- PR はこちら: https://example.com/sample/repo/pull/12\n\n```\nkubectl top pod -n batch\nNAME          CPU(cores)   MEMORY(bytes)\nreport-7d9f   412m         1830Mi\n```",
      { trigger: { source: "alertmanager", summary: LONG_ALERT }, turn_id: "t-y-1412" },
    ),
    owner("y-3", at(14, 30, 1), "上限は 2Gi のままでいいよ。変更は PR にしてね"),
    // A reply from before the backend kept the turn: it has no turn_id.
    reply("y-4", at(14, 31, 1), "了解、そうするね。"),
    reply("y-5", at(17, 5, 1), "レビューが 2 件とも終わったよ。どちらも承認相当。投稿案も見る？", {
      trigger: { source: "self", summary: LONG_SELF },
      turn_id: "t-y-1705",
    }),
  ];
}

function conversation(c: Clock): HistoryEntry[] {
  return [...yesterday(c), ...morning((hour, minute) => c.at(hour, minute), image())];
}

function schedules({ next }: Clock): ScheduleEntry[] {
  return [
    { id: "s-1", reason: "朝の予定確認。予定の係へ今日から 7 日分を頼み、朝の挨拶で伝える。", cron: "0 6 * * *", next_at: next({ hour: 6 }) },
    { id: "s-2", reason: "朝のニュース収集", cron: "0 8 * * *", next_at: next({ hour: 8 }) },
    { id: "s-3", reason: "週のまとめを書く。閉じた PR と issue を数えて、来週の予定と並べる。", cron: "0 18 * * 0", next_at: next({ hour: 18, weekday: 0 }) },
    { id: "s-4", reason: "依存の更新の PR を見直す", cron: "0 10 * * 3", next_at: next({ hour: 10, weekday: 3 }) },
    { id: "s-5", reason: "年のはじめの棚卸し。使っていないボリュームとイメージを洗い出す。", cron: "0 9 5 1 *", next_at: next({ hour: 9, month: 1, day: 5 }) },
    // A cron the UI has no words for, shown as it is.
    { id: "s-6", reason: "平日の昼にキューの長さを見る", cron: "0 12 * * 1-5", next_at: next({ hour: 12 }) },
    { id: "s-7", reason: "午後の出社の 30 分前に知らせる。傘が要るかも添える。", at: next({ hour: 14, minute: 30 }), next_at: next({ hour: 14, minute: 30 }) },
  ];
}

/** A turn of the main agent that ended `seconds` after it started. */
function turnRow(id: string, start: string, seconds: number, extra: Partial<RecordTurn> = {}): RecordTurn {
  return {
    id,
    kind: "turn",
    at: start,
    agent: "main",
    started_at: start,
    ended_at: new Date(Date.parse(start) + seconds * 1000).toISOString(),
    seconds,
    result: "done",
    triggers: [],
    trigger_count: 0,
    tools: 3,
    replies: 0,
    ...extra,
  };
}

let seq = 100;
const given = (source: string, summary: string) => ({ triggers: [{ seq: seq++, source, summary }], trigger_count: 1 });

/** A turn for each reply that names one, started a little before it. */
function turnsOfReplies(history: HistoryEntry[]): RecordTurn[] {
  return history.flatMap((entry) => {
    if (entry.kind !== "agent" || entry.turn_id === undefined) return [];
    const trigger = entry.trigger ?? MORNING_TRIGGERS[entry.turn_id] ?? { source: "self", summary: "自分で続けていたこと" };
    const seconds = 20 + (entry.text.length % 200);
    const start = new Date(Date.parse(entry.at) - seconds * 1000).toISOString();
    return [turnRow(entry.turn_id, start, seconds, { ...given(trigger.source, trigger.summary), tools: 2 + (entry.text.length % 7), replies: 1 })];
  });
}

/** A normal day: the turns of the conversation, quiet hours, a job, a closed sub-agent and a night that went well. */
function normalDay(c: Clock, history: HistoryEntry[]): Pick<Scene, "record" | "nightTurns"> {
  const { at } = c;
  const night = "n-1";
  return {
    record: [
      ...turnsOfReplies(history),
      turnRow("t-y-1430", at(14, 30, 1), 40, { ...given("ui", "上限は 2Gi のままでいいよ。変更は PR にしてね"), tools: 6, replies: 1 }),
      turnRow("t-hb-1", at(10, 0), 20, { ...given("heartbeat", "120 分なにもない"), tools: 1 }),
      turnRow("t-mail-job", at(7, 2), 30, { ...given("ui", "メールの係へ、昨日7時〜今朝7時のメールを頼む"), tools: 2 }),
      turnRow("t-doc-1", at(9, 10), 75, { agent: "closet-notes", tools: 6 }),
      turnRow("t-doc-2", at(9, 40), 60, { agent: "closet-notes", tools: 4 }),
      {
        id: "closet-notes",
        kind: "sub_agent",
        at: at(9, 45),
        agent: "closet-notes",
        purpose: "11月の服の記事を読み、手持ちと合いそうな組み合わせを書き出す",
        started_at: at(9, 8),
        closed_at: at(9, 45),
        turns: 2,
        failed_turns: 0,
      },
      { id: "j-1", kind: "job", at: at(7, 8), command: "a2a-wait --agent mail --timeout 600", started_at: at(7, 2), ended_at: at(7, 8), seconds: 361, end: "exited", exit_code: 0 },
      {
        id: night,
        kind: "night",
        at: at(3, 0),
        scheduled_at: at(3, 0),
        started_at: at(3, 0),
        ended_at: at(3, 9),
        seconds: 540,
        result: "done",
        stages: {
          reflection: { result: "done", memory_change: { files: 0, added: 0, removed: 0, handoff_changed: false } },
          verifier: { result: "done", memory_change: { files: 1, added: 6, removed: 2 } },
          curator: { result: "done", memory_change: { files: 3, added: 18, removed: 40 } },
          session: { result: "done" },
        },
      },
    ],
    nightTurns: [
      turnRow("t-n1-reflection", at(3, 0), 230, { night: { id: night, stage: "reflection" }, tools: 0 }),
      turnRow("t-n1-verifier", at(3, 4), 58, { night: { id: night, stage: "verifier" }, tools: 3 }),
      turnRow("t-n1-curator", at(3, 5), 230, { night: { id: night, stage: "curator" }, tools: 8 }),
    ],
  };
}

/** A failed turn, a failed job, a night whose curator failed, and an earlier missed night. */
function badDay(c: Clock, history: HistoryEntry[]): Pick<Scene, "record" | "nightTurns"> {
  const { at, ago } = c;
  const night = "n-2";
  return {
    record: [
      ...normalDay(c, history).record.filter((row) => row.kind !== "night"),
      turnRow("t-fail", ago(45), 33, {
        ...given("alertmanager", "[FIRING critical] PodCrashLooping"),
        result: "failed",
        reason: "モデルの呼び出しが 3 回続けて落ちた",
        failed_at: ago(44),
        tools: 2,
      }),
      {
        id: "j-2",
        kind: "job",
        at: ago(30),
        command: "go test ./... -run TestIntegration -count=1",
        started_at: ago(36),
        ended_at: ago(30),
        seconds: 361,
        end: "exited",
        exit_code: 1,
        failed_at: ago(30),
      },
      {
        id: night,
        kind: "night",
        at: at(3, 0),
        scheduled_at: at(3, 0),
        started_at: at(3, 0),
        ended_at: at(3, 8),
        seconds: 480,
        result: "failed",
        failed_at: at(3, 8),
        stages: {
          reflection: { result: "done" },
          verifier: { result: "done", memory_change: { files: 0, added: 0, removed: 0 } },
          curator: { result: "failed", reason: "整理の途中で /memory への書き込みが拒まれた", memory_change: { files: 1, added: 2, removed: 1 } },
          session: { result: "done" },
        },
      },
      { id: "missed-1", kind: "missed_night", at: at(3, 0, 2), scheduled_at: at(3, 0, 2), failed_at: at(3, 1, 2) },
    ],
    nightTurns: [
      turnRow("t-n2-reflection", at(3, 0), 220, { night: { id: night, stage: "reflection" }, tools: 4 }),
      turnRow("t-n2-verifier", at(3, 4), 50, { night: { id: night, stage: "verifier" }, tools: 2 }),
      turnRow("t-n2-curator", at(3, 5), 190, { night: { id: night, stage: "curator" }, tools: 6, result: "failed", reason: "/memory への書き込みが拒まれた" }),
    ],
  };
}

const main = (activity: Activity): StreamEvent => ({ event: "activity", data: { agent: "main", activity } });

/** The rows of the record that the memory's changes name: the turn of the day's change, and the night of last night's. */
function memoryRows(c: Clock, memory: MemoryScene): { turn: RecordTurn; night: Extract<RecordRow, { kind: "night" }> } | undefined {
  const night = memory.overview.last_night;
  if (!night) return undefined;
  const stage = (key: "reflection" | "verifier" | "curator") => {
    const change = night.changes.find(({ change }) => change.writer.kind === "night" && change.writer.stage === key)!.change;
    return { result: "done" as const, memory_change: { files: change.files, added: change.added, removed: change.removed } };
  };
  return {
    turn: turnRow(MEMORY_TURN, c.at(9, 39), 60, { ...given("cron", "朝の道具の点検"), tools: 2 }),
    night: {
      id: night.id, kind: "night", at: night.at, started_at: night.at, ended_at: night.ended_at, seconds: 480, result: "done",
      stages: { reflection: stage("reflection"), verifier: stage("verifier"), curator: stage("curator"), session: { result: "done" } },
    },
  };
}

/**
 * What every scene but `empty` has: the conversation, the schedules, a normal
 * day and the memory of an ordinary day, whose last night is the day's night.
 */
function ordinary(now: number): Scene {
  const c = clock(now);
  const history = conversation(c);
  const day = normalDay(c, history);
  const memory = memoryScene(now, "normal", { id: "n-1", daysBefore: 0 });
  const rows = memoryRows(c, memory)!;
  const record = [...day.record.map((row) => row.kind === "night" && row.id === rows.night.id ? { ...row, stages: rows.night.stages } : row), rows.turn];
  return { agent, history, schedules: schedules(c), ...day, record, memory, previousSeenAt: c.ago(600), agents: [], unseen: 0, stream: [], script: [] };
}

function withMemory(now: number, state: "normal" | "over" | "broken" | "empty" = "normal"): Scene {
  const memory = memoryScene(now, state);
  const c = clock(now);
  const rows = memoryRows(c, memory);
  return {
    agent, memory, history: [], schedules: [], nightTurns: [], agents: [], unseen: 0, previousSeenAt: c.ago(600), stream: [], script: [],
    record: rows ? [rows.turn, rows.night] : [],
  };
}

export type SceneDef = { about: string; make: (now: number) => Scene };

export const scenes: Record<string, SceneDef> = {
  default: {
    about: "this morning's conversation, schedules and a normal day in the activity record",
    make: ordinary,
  },
  empty: {
    about: "no history, no schedules, no record",
    // Nothing has happened yet, so the memory is what she starts with: personality.md alone.
    make: (now) => ({ ...ordinary(now), history: [], schedules: [], record: [], nightTurns: [], memory: memoryScene(now, "empty"), previousSeenAt: new Date(now).toISOString() }),
  },
  busy: {
    about: "she is in a turn; the stream sends her thoughts and tools over a few seconds",
    make: (now) => {
      const scene = ordinary(now);
      const c = clock(now);
      const turn = "t-busy";
      const asked = "クラスタのノードの空きを見ておいて";
      // The mock stamps each with the time it is sent.
      const at = c.ago(0);
      return {
        ...scene,
        history: [...scene.history, owner("o-busy", c.ago(1), asked)],
        record: [...scene.record, { ...turnRow(turn, c.ago(1), 0, { ...given("ui", asked), tools: 0 }), result: "running", ended_at: undefined, seconds: undefined }],
        stream: [{ event: "state", data: { agent: "main", state: "thinking" } }, main({ kind: "turn_start", at: c.ago(1), turn_id: turn })],
        script: [
          { afterMs: 1500, event: main({ turn_id: turn, kind: "thinking", at, text: "ノードごとの空きを見る。まず使用量の一覧を取る。" }) },
          { afterMs: 1500, event: main({ turn_id: turn, kind: "tool_call", at, call_id: "c-1", name: "bash", arguments: { command: "kubectl top nodes" } }) },
          {
            afterMs: 1500,
            event: main({ turn_id: turn, kind: "tool_result", at, call_id: "c-1", is_error: false, output: "NAME     CPU(cores)   MEMORY(bytes)\nnode-a   1210m        11Gi\nnode-b   380m         4Gi" }),
          },
          { afterMs: 1000, event: main({ turn_id: turn, kind: "thinking", at, text: "node-a が混んでいる。上に載っている Pod を見る。" }) },
          // Left open, so that she stays in the tool.
          { afterMs: 1000, event: main({ turn_id: turn, kind: "tool_call", at, call_id: "c-2", name: "bash", arguments: { command: "kubectl get pods -A --field-selector spec.nodeName=node-a" } }) },
        ],
      };
    },
  },
  subagents: {
    about: "three sub-agents: two running, one waiting",
    make: (now) => {
      const c = clock(now);
      const running = (name: string, turn: string, text: string, command: string): StreamEvent[] => [
        { event: "activity", data: { agent: name, activity: { kind: "turn_start", at: c.ago(4), turn_id: turn } } },
        { event: "activity", data: { agent: name, activity: { kind: "thinking", at: c.ago(3), turn_id: turn, text } } },
        { event: "activity", data: { agent: name, activity: { kind: "tool_call", at: c.ago(2), turn_id: turn, call_id: `${turn}-c1`, name: "bash", arguments: { command } } } },
      ];
      return {
        ...ordinary(now),
        agents: [
          { agent: "bench-run", purpose: "ベンチマークを 3 回まわして、前の版と比べる", state: "thinking", started_at: c.ago(25), state_since: c.ago(4) },
          { agent: "changelog", purpose: "前のリリースからの変更を読み、リリースノートの下書きを作る", state: "thinking", started_at: c.ago(15), state_since: c.ago(4) },
          { agent: "inbox-sort", purpose: "届いた通知を種類ごとに分ける", state: "waiting", started_at: c.ago(50), state_since: c.ago(12) },
        ],
        stream: [
          ...running("bench-run", "t-bench-1", "2 回目が終わった。3 回目をまわす。", "npm run bench -- --runs 1"),
          ...running("changelog", "t-cl-1", "閉じた PR を新しい順に読む。", "git log --oneline v0.4.0..HEAD"),
        ],
      };
    },
  },
  memory: { about: "memory: an ordinary day, a night with moves, a year of diaries", make: withMemory },
  "memory-over": { about: "memory: the always-read layer exceeds its target", make: (now) => withMemory(now, "over") },
  "memory-broken": { about: "memory: two missing link destinations", make: (now) => withMemory(now, "broken") },
  "memory-empty": { about: "memory: only personality.md, no night yet", make: (now) => withMemory(now, "empty") },
  "memory-review": {
    about: "a weekly review with two curator turns, an over-target prompt layer and dropped records",
    make: (now) => {
      const scene = ordinary(now);
      const { at } = clock(now);
      const content = turnRow("t-n1-review-content", at(3, 5), 120, { night: { id: "n-1", stage: "curator" } });
      const structure = turnRow("t-n1-review-structure", at(3, 7), 110, { night: { id: "n-1", stage: "curator" } });
      return {
        ...scene,
        record: scene.record.map((row) => row.kind !== "night" ? row : {
          ...row,
          stages: {
            ...row.stages,
            verifier: { ...row.stages.verifier, dropped_records: 2 },
            curator: {
              ...row.stages.curator,
              always_read_over_target: { total_bytes: 18240, target_bytes: 16384 },
              review: {
                content: { result: "done", turn_id: content.id, memory_change: { files: 2, added: 24, removed: 3 } },
                structure: { ...row.stages.curator, turn_id: structure.id },
              },
            },
          },
        }),
        nightTurns: [...scene.nightTurns.filter((turn) => turn.night?.stage !== "curator"), content, structure],
      };
    },
  },
  failures: {
    about: "a failed turn, a failed job, a night whose curator failed, a missed night; 3 unseen",
    make: (now) => {
      const scene = ordinary(now);
      const c = clock(now);
      // Opened before last night, so that the night, the turn and the job are new to her; the missed night is older.
      // Last night's curator failed, so the memory's last night is the one before, which went well.
      const memory = memoryScene(now, "normal", { id: "n-0", daysBefore: 1 });
      const rows = memoryRows(c, memory)!;
      const bad = badDay(c, scene.history);
      return { ...scene, ...bad, record: [...bad.record, rows.turn, rows.night], memory, unseen: 3, previousSeenAt: c.at(2, 0) };
    },
  },
};
