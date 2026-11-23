import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import type { MemoryCounts, MemoryOverviewResponse, MemoryWriter } from "@penelope/contract";

import { type Api, Refused } from "../../model/api.ts";
import { ChevronLeftIcon } from "../icons.tsx";
import { recordSourceWord } from "../record.ts";
import { RecordMark } from "../RecordRow.tsx";
import { hashOf, type MemoryPage, parseRoute, type Route } from "../route.ts";
import { triggerWords, words } from "../words.ts";
import type { EditTarget } from "./Edit.tsx";

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const HOME = "#/memory";
export const memoryHash = (page: MemoryPage) => hashOf({ place: "memory", page });
export const fileHash = (path: string, line?: number) => memoryHash({ kind: "file", path, ...(line === undefined ? {} : { line }) });
/** A number and its unit stay on one line. */
export const unbroken = (text: string) => text.replaceAll(" ", "\u00a0");

/** "+12 −4", read out as lines added and removed. */
export function Lines({ added, removed }: { added: number; removed: number }) {
  return <span role="img" aria-label={`${added} 行足した、${removed} 行消した`}>+{added}{"\u00a0"}−{removed}</span>;
}

export function Counts({ of: { files, added, removed } }: { of: MemoryCounts }) {
  return <>{files}{"\u00a0"}ファイル <Lines added={added} removed={removed} /></>;
}

/** Go to another address of the same screen without adding a step to go back over. */
export function replaceHash(hash: string): void {
  if (hash === location.hash) return;
  history.replaceState(history.state, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), summary";
/**
 * The button that shows more rows may be gone once they are shown, and the
 * focus with it. Call `remember` before showing them: when `count` changes,
 * the first row under `root` that was not there gets the focus.
 */
export function useFocusNew<T extends HTMLElement>(count: number) {
  const root = useRef<T>(null);
  const seen = useRef<Set<Element>>(undefined);
  useEffect(() => {
    const before = seen.current;
    seen.current = undefined;
    if (!before || !root.current) return;
    [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)].find((element) => !before.has(element))?.focus();
  }, [count]);
  const remember = useCallback(() => { seen.current = new Set(root.current?.querySelectorAll(FOCUSABLE)); }, []);
  return { root, remember };
}

export const MemoryScope = createContext<{
  api: Api;
  overview: MemoryOverviewResponse | undefined;
  onFail: (error: unknown) => void;
  beginEdit: ((target: EditTarget, trigger: HTMLButtonElement) => void) | undefined;
}>(null!);
export const useMemory = () => useContext(MemoryScope);

export function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export type Reading<T> = { value: T; error?: never } | { value?: never; error: unknown; retry: () => void };
export function useReading<T>(read: () => Promise<T>, onFail: (error: unknown) => void): Reading<T> | undefined {
  const [result, setResult] = useState<{ read: () => Promise<T>; result: Reading<T> }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const retry = () => { setResult(undefined); setAttempt((n) => n + 1); };
    void read().then(
      (value) => { if (active) setResult({ read, result: { value } }); },
      (error: unknown) => { if (active) { onFail(error); setResult({ read, result: { error, retry } }); } },
    );
    return () => { active = false; };
  }, [read, onFail, attempt]);
  return result?.read === read ? result.result : undefined;
}

/** What is not there stays not there; anything else can be read again. */
export function ReadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const missing = error instanceof Refused && error.status === 404;
  return <div className="memory-controls">
    <p role="status" className="muted">{missing ? "記憶に見つかりませんでした。" : "記憶を読み込めませんでした。"}</p>
    {retry && !missing ? <button type="button" className="memory-hit" onClick={retry}>もう一度読み込む</button> : null}
  </div>;
}

export function ReadBody<T>({ result, children }: { result: Reading<T> | undefined; children: (value: T) => ReactNode }) {
  if (!result) return <p role="status" className="muted">読み込み中…</p>;
  return "retry" in result ? <ReadError error={result.error} retry={result.retry} /> : children(result.value);
}

/** Keep a true back destination per history entry; copied links still have a useful fallback. */
export function MemoryLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a className={className} href={href} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
    event.preventDefault();
    if (href === location.hash) return;
    history.pushState({ memoryFrom: location.hash }, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }}>{children}</a>;
}

export function MemoryBack({ fallback = HOME, label = "記憶に戻る", origin }: { fallback?: string; label?: string; origin?: Route }) {
  const from: unknown = history.state?.memoryFrom;
  const previous = typeof from === "string" && parseRoute(from).place === "memory" && from !== location.hash ? from : undefined;
  return <a className="record-back memory-hit" href={previous ?? (origin ? hashOf(origin) : fallback)} onClick={(event) => {
    if (!previous || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.back();
  }}><ChevronLeftIcon width={16} height={16} />{origin ? label : previous ? "前の画面に戻る" : label}</a>;
}

export function writerName(writer: MemoryWriter): string {
  switch (writer.kind) {
    case "daytime": return writer.trigger ? recordSourceWord(writer.trigger.source) : writer.agent === "main" ? "日中" : writer.agent;
    case "night": return writer.stage === "content" || writer.stage === "structure" ? `整理係（${words.record.review[writer.stage]}）` : words.record.stages[writer.stage];
    case "owner": return "オーナー";
    case "system": return "仕組み";
    case "unknown": return "分からない";
  }
}

export function writerSummary(writer: MemoryWriter): string {
  if (writer.kind === "daytime" && writer.trigger) return triggerWords(writer.trigger.summary);
  return writer.kind === "system" ? writer.operation === "reference_repair" ? "移動に合わせて参照を修正" : "アバターの初期設定" : "";
}

export function WriterMark({ writer }: { writer: MemoryWriter }) {
  return <span className="record-mark" aria-hidden>{writer.kind === "daytime" ? "☼" : writer.kind === "system" ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="m7 5 2-2a3 3 0 0 1 4 4l-2 2m-2 2-2 2a3 3 0 0 1-4-4l2-2m1 3 4-4" /></svg>
  ) : <RecordMark mark={writer.kind === "night" ? "night" : writer.kind === "owner" ? "sub" : "unknown"} />}</span>;
}
