// The made-up worlds the development server (dev.ts) answers with, one per
// scene. Typed with the contract, so that a change to the API's shapes fails
// the type check here as well as in the UI. Nothing in them is real: the
// repository is public (AGENTS.md).
//
// Times are written on the day the scene is made (or the day before), or as
// minutes before it, so that the screens always read as today's.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AgentResponse, AgentStatus, RecordRow, RecordTurn, ScheduleEntry, SubAgent } from "@penelope/contract";

import { allowMemoryEdit, MEMORY_TURN, type MemoryScene, memoryScene } from "./memory.ts";

export type Scene = {
  agent: AgentResponse;
  status?: AgentStatus;
  agents?: SubAgent[];
  schedules?: ScheduleEntry[];
  /** The rows of the activity record's list, in any order. */
  record: RecordRow[];
  /** The turns of the nightly switch: on the night's page only, never rows of the list (docs/ui-api.md). */
  nightTurns: RecordTurn[];
  memory?: MemoryScene;
  unseen: number;
  /** When the owner opened the record before, as POST /api/record/seen answers. */
  previousSeenAt: string;

};

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

type Clock = {
  ago: (minutes: number) => string;
  /** A local time today, or that many days before. */
  at: (hour: number, minute: number, daysBefore?: number) => string;
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
  };
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

function normalDay(c: Clock): Pick<Scene, "record" | "nightTurns"> {
  const { at } = c;
  const night = "n-1";
  return {
    record: [
      turnRow("t-y-0900", at(9, 0, 1), 45, { ...given("cron", "毎朝 9:00"), replies: 1 }),
      turnRow("t-y-1412", at(14, 12, 1), 60, { ...given("alertmanager", "[FIRING warning] HighMemoryUsage namespace=batch pod=worker"), replies: 1 }),
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
function badDay(c: Clock): Pick<Scene, "record" | "nightTurns"> {
  const { at, ago } = c;
  const night = "n-2";
  return {
    record: [
      ...normalDay(c).record.filter((row) => row.kind !== "night"),
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

function ordinary(now: number): Scene {
  const c = clock(now);
  const day = normalDay(c);
  const memory = memoryScene(now, "normal", { id: "n-1", daysBefore: 0 });
  const rows = memoryRows(c, memory)!;
  const record = [...day.record.map((row) => row.kind === "night" && row.id === rows.night.id ? { ...row, stages: rows.night.stages } : row), rows.turn];
  return {
    agent, ...day, record, memory, previousSeenAt: c.ago(600), unseen: 0,
    status: { sleep: { state: "awake" }, sleepiness: 42, awake_seconds: 18_000, mood: "落ち着いている" },
    agents: [{ agent: "reviewer", purpose: "記事を読む", state: "thinking", started_at: c.ago(7), state_since: c.ago(3) }],
    schedules: [
      { id: "s-1", reason: "朝の予定を確かめる。終わったら知らせる。", cron: "0 6 * * *", next_at: c.at(6, 0, -1) },
      { id: "s-2", reason: "記事の続きを読む", at: c.at(11, 0, -1), next_at: c.at(11, 0, -1) },
    ],
  };
}

function withMemory(now: number, state: "normal" | "over" | "broken" | "empty" = "normal"): Scene {
  const memory = memoryScene(now, state);
  const c = clock(now);
  const rows = memoryRows(c, memory);
  return {
    agent, memory, nightTurns: [], unseen: 0, previousSeenAt: c.ago(600),
    record: rows ? [rows.turn, rows.night] : [],
  };
}

function withMemoryEditing(now: number, mode?: "conflict" | "worktree" | "limit"): Scene {
  const scene = withMemory(now);
  const memory = scene.memory!;
  if (mode === "limit") {
    const file = memory.overview.files.find((f) => f.path === "always.md")!;
    const limit = memory.overview.always_read.file_limit_bytes;
    const padding = "\n<!--\n" + "  記録用の控え。\n".repeat(1000) + "-->\n";
    memory.text[file.path] += padding + " ".repeat(limit - file.bytes - Buffer.byteLength(padding));
    memory.overview.always_read.bytes += limit - file.bytes;
    file.bytes = limit;
  }
  allowMemoryEdit(memory, mode === "limit" ? undefined : mode);
  return scene;
}

export type SceneDef = { about: string; make: (now: number) => Scene };

export const scenes: Record<string, SceneDef> = {
  default: {
    about: "memory and a normal day in the activity record",
    make: ordinary,
  },
  empty: {
    about: "only the starting memory, no activity record",
    // Nothing has happened yet, so the memory is what she starts with: personality.md alone.
    make: (now) => ({ ...ordinary(now), record: [], nightTurns: [], agents: [], schedules: [], memory: memoryScene(now, "empty"), previousSeenAt: new Date(now).toISOString() }),
  },
  memory: { about: "memory: an ordinary day, a night with moves, a year of diaries", make: withMemory },
  "memory-over": { about: "memory: the always-read layer exceeds its target", make: (now) => withMemory(now, "over") },
  "memory-broken": { about: "memory: two missing link destinations", make: (now) => withMemory(now, "broken") },
  "memory-empty": { about: "memory: only personality.md, no night yet", make: (now) => withMemory(now, "empty") },
  "memory-edit": { about: "memory: save, restore, or save an unchanged draft", make: withMemoryEditing },
  "memory-edit-conflict": { about: "memory: an agent can commit while editing (see dev/README.md)", make: (now) => withMemoryEditing(now, "conflict") },
  "memory-edit-worktree": { about: "memory: the agent is still writing the topic file", make: (now) => withMemoryEditing(now, "worktree") },
  "memory-edit-limit": { about: "memory: always.md is at its per-file limit", make: (now) => withMemoryEditing(now, "limit") },
  "memory-read-only": { about: "memory: editing is disabled for this deployment", make: withMemory },
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
      const bad = badDay(c);
      return { ...scene, ...bad, record: [...bad.record, rows.turn, rows.night], memory, unseen: 3, previousSeenAt: c.at(2, 0) };
    },
  },
};
