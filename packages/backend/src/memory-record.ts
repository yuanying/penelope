import type { DatabaseSync } from "node:sqlite";

import type { MemoryNightStage, MemoryReadsSnapshot, NightTurnStage, RecordNight, RecordTrigger } from "@penelope/contract";

import { HttpError } from "./http.ts";
import { memoryPath } from "./memory-git.ts";

export const DAY_MS = 86_400_000;
const isDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
};

export function readSnapshot(value: unknown): MemoryReadsSnapshot {
  const invalid = () => new HttpError(400, "memory_reads needs a UTC day and distinct memory paths with UTC read dates");
  if (typeof value !== "object" || value === null) throw invalid();
  const { day, files } = value as Partial<MemoryReadsSnapshot>;
  if (!isDay(day) || !Array.isArray(files)) throw invalid();
  const paths = new Set<string>();
  const entries = files.map((entry: MemoryReadsSnapshot["files"][number]) => {
    if (typeof entry !== "object" || entry === null) throw invalid();
    const { path, dates } = entry;
    if (!memoryPath(path) || paths.has(path) || !Array.isArray(dates) || !dates.length ||
      !dates.every((date) => isDay(date) && date <= day)) throw invalid();
    paths.add(path);
    return { path, dates };
  });
  return { day, files: entries };
}

type NightRow = { row: number; seq: number | null; at: string; started_at: string; stages: string | null; memory_head: string | null };
export type MemoryRecordNight = { id: string; seq: number | null; at: string; ended_at: string; head: string | null; phases: Map<string, MemoryNightStage> };
export type MemoryRecordTurn = { stage: NightTurnStage; night_id?: string };

export class MemoryRecord {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  saveReads(seq: number, snapshot: MemoryReadsSnapshot): void {
    this.db.prepare(`INSERT INTO memory_reads VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET seq = excluded.seq, snapshot = excluded.snapshot
      WHERE excluded.seq >= memory_reads.seq`).run(seq, JSON.stringify(snapshot));
  }

  reads(): MemoryReadsSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot FROM memory_reads WHERE singleton = 1").get() as { snapshot: string } | undefined;
    return row && JSON.parse(row.snapshot) as MemoryReadsSnapshot;
  }

  saveNightHead(seq: number, head: string | null): void {
    this.db.prepare("UPDATE session_rotations SET memory_head = ? WHERE seq = ?").run(head ?? "", seq);
  }

  nights(): MemoryRecordNight[] {
    return (this.db.prepare(`SELECT row, seq, at, coalesce(started_at,at) AS started_at, stages, memory_head
      FROM session_rotations WHERE agent = 'main' ORDER BY at DESC, row DESC`).all() as NightRow[]).map((row) => {
      const review = row.stages === null ? undefined : (JSON.parse(row.stages) as RecordNight["stages"]).curator.review;
      const phases = new Map<string, MemoryNightStage>();
      for (const key of ["content", "structure"] as const) {
        const id = review?.[key].turn_id;
        if (id) phases.set(id, key);
      }
      return { id: String(row.row), seq: row.seq, at: row.started_at, ended_at: row.at, head: row.memory_head, phases };
    });
  }

  nightTurns(): Map<string, MemoryRecordTurn> {
    const rows = this.db.prepare(`SELECT t.turn_id, t.stage, n.row AS night_row
      FROM turns t LEFT JOIN session_rotations n ON n.seq = t.night_seq
      WHERE t.night_seq IS NOT NULL AND t.stage IS NOT NULL AND t.agent = 'main'`).all() as Array<{
      turn_id: string; stage: NightTurnStage; night_row: number | null;
    }>;
    return new Map(rows.map(({ turn_id, stage, night_row }) => [turn_id, { stage, ...(night_row === null ? {} : { night_id: String(night_row) }) }]));
  }

  trigger(id: string, agent: string): { trigger?: RecordTrigger } | undefined {
    const row = this.db.prepare("SELECT triggers FROM turns WHERE turn_id = ? AND agent = ?").get(id, agent) as { triggers: string } | undefined;
    if (!row) return undefined;
    const [trigger] = JSON.parse(row.triggers) as RecordTrigger[];
    return trigger === undefined ? {} : { trigger };
  }

}
