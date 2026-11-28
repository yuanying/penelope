import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { useCallback, useEffect, useId, useState } from "react";

import type { ScheduleEntry } from "@penelope/contract";

import { type Api, Refused, Unauthorized } from "../model/api.ts";
import { RepeatIcon } from "./icons.tsx";
import { dueOf, rhythmOf, scheduleDayOf, splitReason, timeOf, words } from "./words.ts";

export type SchedulesProps = {
  api: Api;
  onUnauthorized: () => void;
};

/** A schedule as the screen shows it. */
type Row = { schedule: ScheduleEntry; lead: string; rest?: string; rhythm?: string };

function rowOf(schedule: ScheduleEntry): Row {
  const rhythm = schedule.cron === undefined ? undefined : rhythmOf(schedule.cron);
  return { schedule, ...splitReason(schedule.reason), ...(rhythm === undefined ? {} : { rhythm }) };
}

/** By when they come next, under the day they come on. */
function daysOf(schedules: ScheduleEntry[]): Array<{ label: string; rows: Row[] }> {
  const sorted = [...schedules].sort((a, b) => Date.parse(a.next_at) - Date.parse(b.next_at));
  const days: Array<{ label: string; rows: Row[] }> = [];
  for (const schedule of sorted) {
    const label = scheduleDayOf(schedule.next_at);
    const last = days.at(-1);
    if (last?.label === label) last.rows.push(rowOf(schedule));
    else days.push({ label, rows: [rowOf(schedule)] });
  }
  return days;
}

export function Schedules({ api, onUnauthorized }: SchedulesProps) {
  const [schedules, setSchedules] = useState<ScheduleEntry[] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [asked, setAsked] = useState<Row | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const id = useId();

  const fail = useCallback(
    (error: unknown, word: string) => {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed(word);
    },
    [onUnauthorized],
  );
  const read = useCallback(async () => {
    try {
      setSchedules((await api.schedules()).schedules);
    } catch (error) {
      fail(error, words.schedulesFailed);
    }
  }, [api, fail]);
  useEffect(() => {
    void read();
  }, [read]);

  const remove = async (schedule: ScheduleEntry) => {
    setRemoving(true);
    setFailed(undefined);
    try {
      await api.removeSchedule(schedule.id);
      setSchedules((now) => now?.filter((s) => s.id !== schedule.id));
    } catch (error) {
      // Gone already: she removed it, or it came due. What is left is read again.
      if (error instanceof Refused && error.status === 404) await read();
      else fail(error, words.scheduleRemoveFailed);
    } finally {
      setRemoving(false);
      setAsked(undefined);
    }
  };

  const days = schedules === undefined ? [] : daysOf(schedules);
  const next = days[0]?.rows[0];

  return (
    <div className="page">
      <section className="page-body schedules-page" aria-labelledby={`${id}-heading`}>
        <div className="schedules-head">
          <Heading level={1}>
            <span id={`${id}-heading`}>{words.schedules}</span>
          </Heading>
          {next === undefined || schedules === undefined ? null : (
            <span className="schedules-summary">
              {words.scheduleCount(schedules.length)} ・ {words.scheduleNext} {dueOf(next.schedule.next_at)}
            </span>
          )}
        </div>
        {failed === undefined ? null : <Banner status="error" title={failed} />}
        {schedules === undefined ? null : schedules.length === 0 ? (
          <EmptyState title={words.schedulesNone} description={words.schedulesNoneBody} headingLevel={2} />
        ) : (
          days.map((day, index) => (
            <section key={day.label} className="schedule-day" aria-labelledby={`${id}-day-${index}`}>
              <h2 id={`${id}-day-${index}`} className="schedule-day-label">
                {day.label}
              </h2>
              <ul className="schedules" aria-labelledby={`${id}-day-${index}`}>
                {day.rows.map((row) => (
                  <ScheduleRow
                    key={row.schedule.id}
                    row={row}
                    open={opened === row.schedule.id}
                    onToggle={() => setOpened((now) => (now === row.schedule.id ? undefined : row.schedule.id))}
                    onRemove={() => setAsked(row)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
      <AlertDialog
        isOpen={asked !== undefined}
        onOpenChange={(open) => {
          if (!open && !removing) setAsked(undefined);
        }}
        title={words.scheduleConfirm}
        description={asked === undefined ? "" : words.scheduleConfirmBody(asked.lead, asked.rhythm, asked.schedule.cron)}
        actionLabel={words.scheduleRemove}
        cancelLabel={words.scheduleKeep}
        isActionLoading={removing}
        onAction={() => {
          if (asked !== undefined) void remove(asked.schedule);
        }}
      />
    </div>
  );
}

/** One schedule: its time, the lead and the rest (whole when open), how it comes, and the button that removes it. */
function ScheduleRow({ row, open, onToggle, onRemove }: { row: Row; open: boolean; onToggle: () => void; onRemove: () => void }) {
  const { schedule } = row;
  return (
    <li className="schedule">
      <span className="schedule-time">{timeOf(schedule.next_at)}</span>
      <button type="button" className="schedule-open" aria-expanded={open} onClick={onToggle}>
        <span className="schedule-lead">{row.lead}</span>
        {row.rest === undefined ? null : <span className={open ? "schedule-rest open" : "schedule-rest"}>{row.rest}</span>}
        <span className="schedule-how">
          {schedule.cron === undefined ? (
            <span>{words.scheduleOnce}</span>
          ) : (
            <>
              <RepeatIcon width={14} height={14} />
              {row.rhythm === undefined ? null : <span>{row.rhythm}</span>}
              <Code color="inherit">{schedule.cron}</Code>
            </>
          )}
        </span>
      </button>
      <Button className="schedule-remove" label={words.scheduleRemoveOf(row.lead)} variant="ghost" onClick={onRemove}>
        {words.scheduleRemove}
      </Button>
    </li>
  );
}
