import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { RecordDayResponse, RecordKind } from "@penelope/contract";

import { type Api, type RecordQuery, Unauthorized } from "../model/api.ts";
import { ChevronDownIcon } from "./icons.tsx";
import { foldDay, isFresh, recordDayOf } from "./record.ts";
import { RecordDetail } from "./RecordDetail.tsx";
import { RecordGroupView, RecordRowView } from "./RecordRow.tsx";
import type { RecordPage } from "./route.ts";
import { words } from "./words.ts";

const w = words.record;

export type RecordPlaceProps = {
  api: Api;
  onUnauthorized: () => void;
  /** The page of one row, or the list. */
  page: RecordPage | undefined;
  onSeen: () => void;
};

/** What the owner has seen: when she looked before this visit, and how many failures came since. */
type Seen = { previous: string; count: number };

export function RecordPlace({ api, onUnauthorized, page, onSeen }: RecordPlaceProps) {
  const [seen, setSeen] = useState<Seen | undefined>(undefined);
  const telling = useRef(false);
  const tell = useCallback(async () => {
    if (telling.current) return;
    telling.current = true;
    try {
      const answer = await api.recordSeen();
      onSeen();
      // The time she looked before stays that of the visit's start: a failure that comes while she looks is new too.
      setSeen((now) => ({ previous: now?.previous ?? answer.previous_seen_at, count: (now?.count ?? 0) + answer.unseen }));
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
    } finally {
      telling.current = false;
    }
  }, [api, onSeen, onUnauthorized]);
  useEffect(() => { void tell(); }, [tell]);

  const fail = useCallback((error: unknown) => (error instanceof Unauthorized ? onUnauthorized() : undefined), [onUnauthorized]);
  return (
    <div className="page">
      <div hidden={page !== undefined}>
        <RecordList api={api} onFail={fail} onRefresh={tell} seen={seen} />
      </div>
      {page === undefined ? null : <RecordDetail key={`${page.kind}/${page.id}`} api={api} onFail={fail} page={page} previousSeenAt={seen?.previous} />}
    </div>
  );
}

type Filter = { failed: boolean; agent: string; kind: RecordKind | "" };
const ALL: Filter = { failed: false, agent: "", kind: "" };

function queryOf(filter: Filter, day?: string): RecordQuery {
  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(day === undefined ? {} : { day }),
    ...(filter.failed ? { failed: true } : {}),
    ...(filter.agent === "" ? {} : { agent: filter.agent }),
    ...(filter.kind === "" ? {} : { kind: filter.kind }),
  };
}

function RecordList({ api, onFail, onRefresh, seen }: { api: Api; onFail: (error: unknown) => void; onRefresh: () => Promise<void>; seen: Seen | undefined }) {
  const [filter, setFilter] = useState<Filter>(ALL);
  const [days, setDays] = useState<RecordDayResponse[] | undefined>(undefined);
  const [agents, setAgents] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const loading = useRef(false);
  // Each narrowing reads anew; an answer to an older one is dropped.
  const generation = useRef(0);
  const id = useId();

  const read = useCallback(
    async (day?: string) => {
      const mine = generation.current;
      try {
        const answer = await api.record(queryOf(filter, day));
        if (mine !== generation.current) return undefined;
        setAgents(answer.agents);
        setFailed(false);
        return answer;
      } catch (error) {
        if (mine === generation.current) {
          setFailed(true);
          onFail(error);
        }
        return undefined;
      }
    },
    [api, filter, onFail],
  );

  useEffect(() => {
    generation.current++;
    setDays(undefined);
    void read().then((answer) => (answer === undefined ? undefined : setDays([answer])));
  }, [read]);

  const refresh = async () => {
    const answer = await read();
    if (answer === undefined) return;
    setDays((now) => (now === undefined ? [answer] : now[0]?.day === answer.day ? [answer, ...now.slice(1)] : [answer, ...now]));
    await onRefresh();
  };

  const older = days?.at(-1)?.before;
  const readOlder = useCallback(async () => {
    if (older === undefined || loading.current) return;
    loading.current = true;
    const answer = await read(older);
    loading.current = false;
    if (answer !== undefined) setDays((now) => (now === undefined || now.some((d) => d.day === answer.day) ? now : [...now, answer]));
  }, [older, read]);
  const end = useNearEnd(older === undefined ? undefined : readOlder);

  const narrowed = filter.failed || filter.agent !== "" || filter.kind !== "";
  const shown = (days ?? []).filter((day) => day.rows.length > 0);
  const nothing = days !== undefined && shown.length === 0 && older === undefined;
  const toggle = (key: string) =>
    setOpened((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="page-body record-page" aria-labelledby={`${id}-heading`}>
      <div className="record-toolbar">
        <Heading level={1}><span id={`${id}-heading`}>{w.title}</span></Heading>
        <Button label="読み直す" size="sm" variant="secondary" onClick={() => void refresh()} />
      </div>
      {failed ? <Banner status="error" title={w.failedToRead} /> : null}
      {nothing && !narrowed ? (
        <EmptyState title={w.emptyTitle} description={w.emptyBody} headingLevel={2} />
      ) : (
        <>
          {seen !== undefined && seen.count > 0 ? <Banner status="error" title={w.unseenBanner(seen.count)} /> : null}
          <div className="record-filters">
            <ToggleButton label={w.onlyFailures} isPressed={filter.failed} onPressedChange={(failed) => setFilter((f) => ({ ...f, failed }))} size="md">
              {w.onlyFailures}
            </ToggleButton>
            <Choice
              label={w.who}
              value={filter.agent}
              options={[
                ["", w.all],
                ["main", words.main],
                ...agents.map((a): [string, string] => [a, a]),
              ]}
              onChange={(agent) => setFilter((f) => ({ ...f, agent }))}
            />
            <Choice
              label={w.kind}
              value={filter.kind}
              options={[["", w.all], ...(Object.entries(w.kinds) as Array<[RecordKind, string]>)]}
              onChange={(kind) => setFilter((f) => ({ ...f, kind: kind as RecordKind | "" }))}
            />
          </div>
          {nothing ? <p className="muted">{w.noMatch}</p> : null}
          {shown.map((day, index) => (
            <section key={day.day} className="record-day" aria-labelledby={`${id}-day-${index}`}>
              <div className="record-day-head">
                <h2 id={`${id}-day-${index}`}>{recordDayOf(day.day)}</h2>
                <span>
                  {w.turns(day.turns)} ・ {w.failures(day.failures)}
                </span>
              </div>
              <ul className="record-rows" aria-labelledby={`${id}-day-${index}`}>
                {foldDay(day.day, day.rows).map((entry) =>
                  entry.type === "row" ? (
                    <RecordRowView key={`${entry.row.kind}/${entry.row.id}`} row={entry.row} fresh={isFresh(entry.row, seen?.previous)} />
                  ) : (
                    <RecordGroupView key={entry.group.key} group={entry.group} open={opened.has(entry.group.key)} onToggle={() => toggle(entry.group.key)} />
                  ),
                )}
              </ul>
            </section>
          ))}
          <div ref={end} className="record-end" />
          {days !== undefined && older === undefined ? <p className="record-footer">{w.footer}</p> : null}
        </>
      )}
    </section>
  );
}

/** A narrowing to pick from, as a round button that opens the browser's own list. */
function Choice({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  const current = options.find(([v]) => v === value)?.[1] ?? options[0]?.[1] ?? "";
  return (
    <label className="record-choice">
      <span aria-hidden>
        {label}: {current}
      </span>
      <ChevronDownIcon width={14} height={14} />
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Calls `onReach` whenever the element it is given comes into sight, while one is given. */
function useNearEnd(onReach: (() => void) | undefined): (element: HTMLElement | null) => void {
  const reach = useRef(onReach);
  reach.current = onReach;
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const element = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Seen again after each day read, while the end is still in sight.
    if (onReach === undefined || element.current === null) return;
    observer.current?.disconnect();
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) reach.current?.();
    }, { rootMargin: "400px 0px" });
    observer.current.observe(element.current);
    return () => observer.current?.disconnect();
  }, [onReach]);
  return useCallback((el: HTMLElement | null) => {
    element.current = el;
  }, []);
}
