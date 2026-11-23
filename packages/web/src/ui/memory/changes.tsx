import { Heading } from "@astryxdesign/core/Heading";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useCallback, useEffect, useRef, useState } from "react";

import type { MemoryChange, MemoryChangeResponse, MemoryChangesResponse, MemoryFileChange, MemoryHistoryResponse, MemoryWriterFilter } from "@penelope/contract";

import { ChevronRightIcon } from "../icons.tsx";
import { dateTimeOf, recordDayOf, timeOfDay } from "../record.ts";
import { RecordMark } from "../RecordRow.tsx";
import { hashOf, type MemoryPage } from "../route.ts";
import { words } from "../words.ts";
import { Diff } from "./Diff.tsx";
import { PathPreview } from "./files.tsx";
import { Counts, fileHash, groupBy, Lines, MemoryBack, MemoryLink, memoryHash, ReadBody, ReadError, replaceHash, TZ, useFocusNew, useMemory, useReading, WriterMark, writerName, writerSummary } from "./shared.tsx";

const CHANGES = memoryHash({ kind: "changes" });
const FILTERS: Record<MemoryWriterFilter, string> = { all: "すべて", daytime: "日中", night: "夜", owner: "オーナー" };
const FILES_PER_BATCH = 8;
const changeHash = (id: string) => memoryHash({ kind: "change", id });

/** The writer the list is narrowed to is in the address, so that it comes back the same after a reload. */
export function ChangesView({ writer }: { writer: MemoryWriterFilter }) {
  const setWriter = (kind: MemoryWriterFilter) => replaceHash(memoryHash({ kind: "changes", ...(kind === "all" ? {} : { writer: kind }) }));
  return <>
    <div className="record-filters memory-controls" role="group" aria-label="書き手で絞る">
      {(Object.entries(FILTERS) as Array<[MemoryWriterFilter, string]>).map(([kind, label]) => <ToggleButton key={kind} label={label} isPressed={kind === writer} onPressedChange={() => setWriter(kind)}>{label}</ToggleButton>)}
    </div>
    <FilteredChanges key={writer} writer={writer} />
  </>;
}

function FilteredChanges({ writer }: { writer: MemoryWriterFilter }) {
  const { api, overview, onFail } = useMemory();
  const head = overview?.head ?? undefined;
  const read = useCallback(() => api.memoryChanges(writer, TZ, head), [api, writer, head]);
  const result = useReading(read, onFail);
  return <ReadBody result={result}>{(first) => <ChangeDays key={first.head} first={first} writer={writer} />}</ReadBody>;
}

function ChangeDays({ first, writer }: { first: MemoryChangesResponse; writer: MemoryWriterFilter }) {
  const { api } = useMemory();
  const paging = usePages(first, (before) => api.memoryChanges(writer, TZ, first.head ?? undefined, before));
  const days = new Map<string, MemoryChangesResponse["days"][number]>();
  for (const page of paging.pages) {
    for (const day of page.days) {
      const prev = days.get(day.day);
      days.set(day.day, prev ? { ...day, items: [...prev.items, ...day.items] } : day);
    }
  }
  const { root, remember } = useFocusNew<HTMLDivElement>(paging.pages.length);
  return <div className="memory-group" ref={root}>
    {!days.size ? <p className="muted">変更はありません。</p> : null}
    {[...days.values()].map((day) => <section className="record-day" key={day.day}>
      <div className="record-day-head"><h2>{recordDayOf(day.day)}</h2><span>変更 {day.changes} ・ {day.files} ファイル</span></div>
      <ul className="record-rows">{changeRows(day.items)}</ul>
    </section>)}
    <More paging={paging} label="前の変更を表示" onMore={remember} />
  </div>;
}

function changeRows(items: MemoryChange[]) {
  const nightKey = ({ writer }: MemoryChange) => writer.kind === "night" || (writer.kind === "system" && writer.operation === "reference_repair") ? writer.night_id ?? writer.night_seq?.toString() : undefined;
  const groups = groupBy(items, nightKey);
  return items.map((change) => {
    const key = nightKey(change);
    const group = key === undefined ? undefined : groups.get(key);
    if (!group) return <li key={change.id}><ChangeRow change={change} showPaths /></li>;
    if (group[0] !== change) return null;
    return <li key={`night-${key}`}>
      <div className="record-row-body"><time className="record-time" dateTime={change.at}>{timeOfDay(change.at)}</time><span className="record-mark"><RecordMark mark="night" /></span><strong>{words.record.night}</strong></div>
      <ul className="record-rows record-group-rows">{group.map((item) => <li key={item.id}><ChangeRow change={item} showPaths /></li>)}</ul>
    </li>;
  });
}

function ChangeRow({ change, showPaths }: { change: MemoryChange; showPaths?: boolean }) {
  const summary = writerSummary(change.writer);
  return <MemoryLink className="record-row-body memory-change-row" href={changeHash(change.id)}>
    <time className="record-time" dateTime={change.at}>{timeOfDay(change.at)}</time><WriterMark writer={change.writer} />
    <span className="record-main"><span className="record-head"><strong>{writerName(change.writer)}</strong>{summary ? <span className="record-text">{summary}</span> : null}<span className="record-meta"><Counts of={change} /></span></span>
      {showPaths ? <PathPreview paths={change.paths} /> : null}
    </span><ChevronRightIcon width={16} height={16} />
  </MemoryLink>;
}

export function ChangeView({ page }: { page: Extract<MemoryPage, { kind: "change" }> }) {
  const { api, onFail } = useMemory();
  const read = useCallback(() => api.memoryChange(page.id), [api, page.id]);
  const result = useReading(read, onFail);
  return <>
    <MemoryBack fallback={CHANGES} label={page.from ? page.from.kind === "night" ? "活動の記録の夜へ戻る" : "活動の記録のターンへ戻る" : "変更に戻る"} {...(page.from ? { origin: { place: "log", page: page.from } } : {})} />
    <ReadBody result={result}>{(data) => <ChangeBody data={data} />}</ReadBody>
  </>;
}

function ChangeBody({ data: { change, files, moves } }: { data: MemoryChangeResponse }) {
  const { writer } = change;
  const [limit, setLimit] = useState(FILES_PER_BATCH);
  const day = writer.kind === "daytime";
  const night = writer.kind === "night" || (writer.kind === "system" && writer.operation === "reference_repair");
  const title = [night ? words.record.night : undefined, writerName(writer), writerSummary(writer)].filter(Boolean).join(" ・ ");
  const nightId = "night_id" in writer ? writer.night_id : undefined;
  const turnId = "turn_id" in writer ? writer.turn_id : undefined;
  const ordered = files.toSorted((a, b) => Number(b.kind === "moved") - Number(a.kind === "moved"));
  const rest = ordered.length - limit;
  const { root, remember } = useFocusNew<HTMLDivElement>(limit);
  return <div className="memory-group" ref={root}>
    <Heading level={1}>{title}</Heading>
    <div className="memory-section-head"><span className="muted">{dateTimeOf(change.at)} ・ <Counts of={change} /></span></div>
    {nightId || turnId ? <nav className="memory-controls" aria-label="活動の記録">
      {turnId ? <a className="memory-hit" href={hashOf({ place: "log", page: { kind: "turn", id: turnId } })}>このターンを活動の記録で見る</a> : null}
      {!day && nightId ? <a className="memory-hit" href={hashOf({ place: "log", page: { kind: "night", id: nightId } })}>この夜を活動の記録で見る</a> : null}
    </nav> : null}
    {moves.length ? <section className="memory-card"><h2>移動</h2><ul className="memory-moves">{moves.map(({ from, to }, i) => <li key={i}><code>{from}</code> → <MemoryLink href={fileHash(to)}><code>{to}</code></MemoryLink></li>)}</ul></section> : null}
    {ordered.slice(0, limit).map((file, i) => <FileDiff key={file.path} id={change.id} file={file} initialOpen={i === 0} />)}
    {rest > 0 ? <button className="memory-hit" type="button" onClick={() => { remember(); setLimit(limit + FILES_PER_BATCH); }}>
      {rest > FILES_PER_BATCH ? `次の ${FILES_PER_BATCH} ファイルを表示（残り ${rest}）` : `残りの ${rest} ファイルを表示`}
    </button> : null}
  </div>;
}

function FileDiff({ id, file, initialOpen }: { id: string; file: MemoryFileChange; initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [requested, setRequested] = useState(initialOpen);
  const note = file.kind === "moved" ? <><code>{file.from}</code> から移動</> : file.kind === "added" ? "新しいファイル" : file.kind === "deleted" ? "削除されたファイル" : null;
  return <section className="memory-diff">
    <div className="memory-diff-head">
      <button type="button" className="memory-hit" aria-label={`${file.path} の差分`} aria-expanded={open} onClick={() => { setOpen(!open); setRequested(true); }}><ChevronRightIcon width={16} height={16} /></button>
      <div className="memory-diff-title">{file.kind === "deleted" ? <code>{file.path}</code> : <MemoryLink href={fileHash(file.path)}><code>{file.path}</code></MemoryLink>}{note ? <span className="muted">{note}</span> : null}</div>
      <span className="muted"><Lines added={file.added} removed={file.removed} /></span>
    </div>
    {requested ? <div hidden={!open}><ReadDiff id={id} path={file.path} /></div> : null}
  </section>;
}

function ReadDiff({ id, path }: { id: string; path: string }) {
  const { api, onFail } = useMemory();
  const read = useCallback(() => api.memoryDiff(id, path), [api, id, path]);
  return <ReadBody result={useReading(read, onFail)}>{(diff) => <Diff diff={diff} />}</ReadBody>;
}

export function HistoryView({ path, compare }: { path: string; compare: [older: string, newer: string] | undefined }) {
  const { api, overview, onFail } = useMemory();
  const head = overview?.head ?? undefined;
  const read = useCallback(() => api.memoryHistory(path, head), [api, path, head]);
  const result = useReading(read, onFail);
  return <>
    <MemoryBack fallback={fileHash(path)} label="ファイルに戻る" />
    <Heading level={1}><code>{path}</code> の履歴</Heading>
    <ReadBody result={result}>{(first) => <Versions key={first.head} first={first} path={path} compare={compare} />}</ReadBody>
  </>;
}

function Versions({ first, path, compare }: { first: MemoryHistoryResponse; path: string; compare: [older: string, newer: string] | undefined }) {
  const { api } = useMemory();
  const paging = usePages(first, (before) => api.memoryHistory(path, first.head ?? undefined, before));
  const [selected, setSelected] = useState<string[]>(compare ?? []);
  const changes = paging.pages.flatMap((page) => page.changes);
  const [newer, older] = changes.filter((change) => selected.includes(change.id));
  // The two versions compared are in the address, so that the comparison comes back after a reload.
  const select = (ids: string[]) => {
    setSelected(ids);
    const [to, from] = changes.filter((change) => ids.includes(change.id));
    replaceHash(memoryHash({ kind: "history", path, ...(from && to ? { compare: [from.id, to.id] } : {}) }));
  };
  const { root, remember } = useFocusNew<HTMLUListElement>(paging.pages.length);
  return <>
    {changes.length ? <p className="muted">版を 2 つ選ぶと比較できます。3 つ目を選ぶには、どちらかを外します。版の行を押すと、その変更を開きます。</p> : <p className="muted">このパスの履歴はありません。</p>}
    <ul className="record-rows" ref={root}>{changes.map((change) => <li className="memory-version" key={change.id}>
      <label className="memory-hit"><input type="checkbox" aria-label={`${dateTimeOf(change.at)} ${writerName(change.writer)} の版を比較に選ぶ`} checked={selected.includes(change.id)} disabled={selected.length === 2 && !selected.includes(change.id)} onChange={(event) => select(event.target.checked ? [...selected, change.id] : selected.filter((id) => id !== change.id))} /></label>
      <MemoryLink className="record-row-body" href={changeHash(change.id)}><WriterMark writer={change.writer} /><span className="record-main"><strong>{dateTimeOf(change.at)} ・ {writerName(change.writer)}</strong><span className="muted">{writerSummary(change.writer)}</span></span><span className="muted"><Lines added={change.added} removed={change.removed} /></span></MemoryLink>
    </li>)}</ul>
    <More paging={paging} label="前の版を表示" onMore={remember} />
    {older && newer ? <Comparison key={`${older.id}/${newer.id}`} path={path} older={older} newer={newer} /> : null}
  </>;
}

function Comparison({ path, older, newer }: { path: string; older: MemoryChange; newer: MemoryChange }) {
  const { api, onFail, beginEdit } = useMemory();
  const read = useCallback(() => api.memoryCompare(path, older.id, newer.id), [api, path, older.id, newer.id]);
  const result = useReading(read, onFail);
  // It comes out under a list that may be long: bring it into view, and say so.
  const section = useRef<HTMLElement>(null);
  useEffect(() => section.current?.scrollIntoView?.({ block: "nearest" }), []);
  return <section className="memory-card" ref={section}>
    <div className="memory-section-head">
      <h2>{dateTimeOf(older.at)} の版と {dateTimeOf(newer.at)} の版の違い</h2>
      {beginEdit ? <RevertAction path={path} version={older} /> : null}
    </div>
    <ReadBody result={result}>{({ diff, changes, added, removed }) => <><p className="muted" role="status">間に {changes} 回の変更 <Lines added={added} removed={removed} /></p><Diff diff={diff} /></>}</ReadBody>
  </section>;
}

function RevertAction({ path, version }: { path: string; version: MemoryChange }) {
  const { api, onFail, beginEdit } = useMemory();
  const read = useCallback(async () => {
    const [current, past] = await Promise.all([api.memoryFile(path), api.memoryFile(path, version.id)]);
    return current.edit !== null && past.text !== undefined;
  }, [api, path, version.id]);
  const eligible = useReading(read, onFail);
  return beginEdit && eligible?.value ? <button className="memory-hit" type="button" onClick={(event) => beginEdit({ path, version }, event.currentTarget)}>{dateTimeOf(version.at)} の版に戻す</button> : null;
}

function usePages<T extends { next?: string }>(first: T, read: (before: string) => Promise<T>) {
  const { onFail } = useMemory();
  const [pages, setPages] = useState([first]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ value: unknown }>();
  const next = pages.at(-1)?.next;
  const more = async () => {
    if (next === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await read(next);
      setPages((pages) => [...pages, page]);
    } catch (error) {
      onFail(error);
      setError({ value: error });
    } finally {
      setBusy(false);
    }
  };
  return { pages, more, next, busy, error };
}

function More({ paging, label, onMore }: { paging: { more: () => Promise<void>; next: string | undefined; busy: boolean; error?: { value: unknown } | undefined }; label: string; onMore: () => void }) {
  return <>{paging.error ? <ReadError error={paging.error.value} /> : null}{paging.next !== undefined ? <button className="memory-hit" type="button" disabled={paging.busy} onClick={() => { onMore(); void paging.more(); }}>{paging.busy ? "読み込み中…" : label}</button> : null}</>;
}
