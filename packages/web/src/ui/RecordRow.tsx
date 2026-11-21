// One row of the activity record (docs/design/README.md, 15): its time, its
// mark, its heading with the small words at its end, and the reason of a
// failure under it. A row that opens is a link as a whole; a folded hour is
// a button as a whole that opens it in place.
import { Badge } from "@astryxdesign/core/Badge";
import { Code } from "@astryxdesign/core/Code";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import type { ComponentType, ReactNode, SVGProps } from "react";

import type { RecordRow } from "@penelope/contract";

import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DashIcon,
  FailIcon,
  LinesIcon,
  MoonIcon,
  StopIcon,
  SubAgentIcon,
  TerminalIcon,
  UnknownIcon,
  WarnIcon,
} from "./icons.tsx";
import { durationOf, type Group, headlineOf, jobMeta, jobNote, mixOf, nightNote, nightTitle, nightWarnings, type Stage, stagesOf, subMeta, timeOfDay, turnMeta, turnNote } from "./record.ts";
import { hashOf, type RecordPage } from "./route.ts";
import { words } from "./words.ts";

const w = words.record;

type Mark = "ok" | "fail" | "stop" | "warn" | "night" | "job" | "sub" | "group" | "unknown" | "running";

/** A mark: its shape says what it marks, and its word is read aloud. Only the decoration is hidden. */
export function RecordMark({ mark }: { mark: Mark }) {
  const one = (Icon: ComponentType<SVGProps<SVGSVGElement>>, label: string | undefined, size = 16) =>
    label === undefined ? (
      <Icon width={size} height={size} />
    ) : (
      <span role="img" aria-label={label} className="record-mark-img">
        <Icon width={size} height={size} />
      </span>
    );
  switch (mark) {
    case "ok":
      return one(CheckIcon, w.done);
    case "fail":
      return one(FailIcon, w.failed, 18);
    case "stop":
      return one(StopIcon, w.stopped, 14);
    case "warn":
      return one(WarnIcon, w.missedNight, 18);
    case "unknown":
      return one(UnknownIcon, w.unknown);
    case "running":
      return <StatusDot variant="accent" label={w.running} isPulsing />;
    case "night":
      return one(MoonIcon, undefined);
    case "job":
      return one(TerminalIcon, undefined);
    case "sub":
      return one(SubAgentIcon, undefined);
    case "group":
      return one(LinesIcon, undefined);
  }
}

const TURN_MARKS = { done: "ok", failed: "fail", stopped: "stop", unknown: "unknown", running: "running" } as const;

/** Where a row opens, if it opens. */
export function pageOf(row: RecordRow): RecordPage | undefined {
  switch (row.kind) {
    case "turn":
      return { kind: "turn", id: row.id };
    case "night":
      return { kind: "night", id: row.id };
    case "sub_agent":
      return { kind: "sub_agent", id: row.id };
    default:
      return undefined;
  }
}

type Shape = { mark: Mark; kind: string; who?: string; text?: ReactNode; mono?: string; more?: string; meta: string; note?: string; warning?: string; bad: boolean };

function shapeOf(row: RecordRow, showWho: boolean): Shape {
  switch (row.kind) {
    case "turn": {
      const h = headlineOf(row);
      const note = turnNote(row);
      return {
        mark: TURN_MARKS[row.result],
        kind: h.kind,
        ...(showWho && h.who !== undefined ? { who: h.who } : {}),
        ...(h.text === "" ? {} : { text: h.text }),
        ...(h.more === undefined ? {} : { more: h.more }),
        meta: turnMeta(row),
        ...(note === undefined ? {} : { note }),
        bad: row.result === "failed",
      };
    }
    case "night": {
      const note = nightNote(row);
      const warning = nightWarnings(row);
      return {
        mark: row.result === "failed" ? "fail" : "night",
        kind: nightTitle(row),
        ...(warning === undefined ? {} : { warning }),
        text: <Stages stages={stagesOf(row)} />,
        meta: durationOf(row.seconds),
        ...(note === undefined ? {} : { note }),
        bad: row.result === "failed",
      };
    }
    case "missed_night":
      return { mark: "warn", kind: w.missedNight, meta: "", note: w.missedNote(timeOfDay(row.scheduled_at)), bad: false };
    case "job": {
      const note = jobNote(row);
      return { mark: note === undefined ? "job" : "fail", kind: w.job, mono: row.command, meta: jobMeta(row), ...(note === undefined ? {} : { note }), bad: note !== undefined };
    }
    case "sub_agent":
      return { mark: "sub", kind: w.closedSub, who: row.agent, meta: subMeta(row), note: row.purpose, bad: false };
  }
}

/** The steps of a night, with the recorded memory change beside each result. */
export function Stages({ stages }: { stages: Stage[] }) {
  return (
    <span className="record-stages">
      {stages.map((stage, index) => (
        <span key={stage.key} className="record-stage" data-result={stage.result}>
          {index > 0 ? <ArrowRightIcon width={12} height={12} className="record-stage-sep" /> : null}
          <StageMark result={stage.result} />
          <span>{stage.name}</span>
          <StageMemory stage={stage} />
        </span>
      ))}
    </span>
  );
}

export function StageMemory({ stage }: { stage: Stage }) {
  if (stage.key === "session" || stage.result === "skipped" || stage.review !== undefined) return null;
  const change = stage.memory_change;
  const label = change === undefined ? w.memoryUnknown : change.files === 0 ? w.memoryUnchanged : w.memoryChanged(change.files, change.added, change.removed);
  return <span className="record-stage-memory">{label}{change?.handoff_changed === false ? ` ・ ${w.handoffUnchanged}` : ""}</span>;
}

export function StageMark({ result, size = 14 }: { result: Stage["result"]; size?: number }) {
  const Icon = result === "done" ? CheckIcon : result === "failed" ? FailIcon : result === "skipped" ? DashIcon : UnknownIcon;
  return (
    <span role="img" aria-label={w.stageWord[result]} className="record-mark-img">
      <Icon width={size} height={size} />
    </span>
  );
}

export function RecordRowView({ row, fresh = false, showWho = true }: { row: RecordRow; fresh?: boolean; showWho?: boolean }) {
  const shape = shapeOf(row, showWho);
  const page = pageOf(row);
  const body = (
    <>
      <span className="record-time">{timeOfDay(row.at)}</span>
      <span className="record-mark" data-mark={shape.mark}>
        <RecordMark mark={shape.mark} />
      </span>
      <span className="record-main">
        <span className="record-head">
          <span className="record-kind">{shape.kind}</span>
          {fresh ? <Badge variant="error" label={w.fresh} /> : null}
          {shape.who === undefined ? null : (
            <Code color="inherit" className="record-who">
              {shape.who}
            </Code>
          )}
          {shape.text === undefined ? null : <span className="record-text">{shape.text}</span>}
          {shape.mono === undefined ? null : (
            <Code color="inherit" className="record-mono">
              {shape.mono}
            </Code>
          )}
          {shape.more === undefined ? null : <span className="record-more">{shape.more}</span>}
          {shape.meta === "" ? null : <span className="record-meta">{shape.meta}</span>}
        </span>
        {shape.note === undefined ? null : (
          <span className="record-note" data-bad={shape.bad || undefined}>
            {shape.note}
          </span>
        )}
        {shape.warning === undefined ? null : <span className="record-note">{shape.warning}</span>}
      </span>
      <span className="record-open" aria-hidden>
        {page === undefined ? null : <ChevronRightIcon width={16} height={16} />}
      </span>
    </>
  );
  return (
    <li className="record-row" data-kind={row.kind}>
      {page === undefined ? (
        <div className="record-row-body">{body}</div>
      ) : (
        <a className="record-row-body" href={hashOf({ place: "log", page })}>
          {body}
        </a>
      )}
    </li>
  );
}

/** An hour of turns that did not fail, folded into one row that opens in place. None of them is fresh: only failures are. */
export function RecordGroupView({ group, open, onToggle }: { group: Group; open: boolean; onToggle: () => void }) {
  return (
    <li className="record-group">
      <button type="button" className="record-row-body" aria-expanded={open} onClick={onToggle}>
        <span className="record-time">{w.hour(group.hour)}</span>
        <span className="record-mark" data-mark="group">
          <RecordMark mark="group" />
        </span>
        <span className="record-main">
          <span className="record-head">
            <span className="record-kind">{w.turns(group.turns.length)}</span>
            <span className="record-meta">{mixOf(group.turns)}</span>
          </span>
        </span>
        <span className="record-open" aria-hidden>
          <ChevronDownIcon width={16} height={16} className={open ? "record-open-up" : undefined} />
        </span>
      </button>
      {open ? (
        <ul className="record-rows record-group-rows">
          {group.turns.map((turn) => (
            <RecordRowView key={turn.id} row={turn} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
