import { Heading } from "@astryxdesign/core/Heading";
import { Markdown } from "@astryxdesign/core/Markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MemoryChange, MemoryFileResponse, MemorySaveResponse } from "@penelope/contract";

import { diffMemoryText } from "../../model/memory-diff.ts";
import { dateTimeOf } from "../record.ts";
import { sizeOf } from "../words.ts";
import { Diff } from "./Diff.tsx";
import { Lines, ReadBody, useMemory, useReading, writerName } from "./shared.tsx";

export type EditTarget = { path: string; version?: MemoryChange };
type Outcome = Extract<MemorySaveResponse, { kind: "saved" | "unchanged" }>;
type HeadConflict = Extract<MemorySaveResponse, { kind: "head_conflict" }>;
type Failure = Exclude<MemorySaveResponse, Outcome> | { kind: "unknown" };
type Base = MemoryFileResponse & { edit: NonNullable<MemoryFileResponse["edit"]>; text: string };
const editable = (file: MemoryFileResponse): file is Base => file.edit !== null && file.text !== undefined;
const limitOf = (bytes: number) => sizeOf(bytes).replace(/\.0(?= [KM]B$)/, "");

export function EditMemory({ target: { path, version }, close, complete }: { target: EditTarget; close: () => void; complete: (outcome: Outcome) => void }) {
  const { api, onFail } = useMemory();
  const read = useCallback(async () => {
    const [current, past] = await Promise.all([api.memoryFile(path), version ? api.memoryFile(path, version.id) : undefined]);
    return { current, past };
  }, [api, path, version]);
  const result = useReading(read, onFail);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return <>
    <div ref={heading} tabIndex={-1}>
      <Heading level={1}><code>{path}</code></Heading>
    </div>
    <ReadBody result={result}>{({ current, past }) => editable(current) && (!version || past?.text !== undefined)
      ? <EditForm initial={current} draft={past?.text ?? current.text} version={version} close={close} complete={complete} />
      : <p role="status" className="muted">{editable(current) ? "この版の本文を読み込めませんでした。" : "現在、このファイルには保存できません。"}</p>}
    </ReadBody>
    {!result?.value || !editable(result.value.current) || (version && result.value.past?.text === undefined)
      ? <button type="button" className="memory-hit" onClick={close}>やめる</button> : null}
  </>;
}

function EditForm({ initial, draft, version, close, complete }: { initial: Base; draft: string; version: MemoryChange | undefined; close: () => void; complete: (outcome: Outcome) => void }) {
  const { api, onFail } = useMemory();
  const [base, setBase] = useState(initial);
  const [text, setText] = useState(draft);
  const [earlierDraft, setEarlierDraft] = useState<string>();
  const [view, setView] = useState<"source" | "preview" | "diff">("source");
  const [failure, setFailure] = useState<Failure>();
  const [reloadError, setReloadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const limit = failure?.kind === "text_too_large" || failure?.kind === "prompt_file_limit" ? failure.max_bytes : base.edit.max_bytes;
  const overLimit = new TextEncoder().encode(text).length > limit;
  const nul = text.includes("\0");
  const conflict = failure?.kind === "head_conflict" ? failure : undefined;
  const blocked = conflict || failure?.kind === "unknown" || failure?.kind === "editing_disabled" || failure?.kind === "file_not_editable";
  const diff = useMemo(() => diffMemoryText(base.text, text), [base.text, text]);
  const problem = useRef<HTMLDivElement>(null);
  useEffect(() => problem.current?.focus(), [failure]);
  const last = base.file.last_change;
  const path = base.file.path;

  async function save(against = base) {
    if (new TextEncoder().encode(text).length > against.edit.max_bytes || nul) return;
    setBusy(true);
    setReloadError(false);
    try {
      const answer = await api.memorySave({ path, base_head: against.head, text });
      if (answer.kind === "saved" || answer.kind === "unchanged") complete(answer);
      else {
        setFailure(answer);
        if (answer.kind === "head_conflict" || answer.kind === "worktree_conflict") setView("source");
      }
    } catch (error) {
      onFail(error);
      setFailure({ kind: "unknown" });
      setView("source");
    } finally {
      setBusy(false);
    }
  }

  async function readAgain(overwrite?: HeadConflict) {
    setBusy(true);
    setReloadError(false);
    try {
      // An overwrite is permission to replace the version the owner just saw,
      // not a later unseen change. The save endpoint checks that version again.
      const fresh = await api.memoryFile(path, overwrite?.head);
      if (!editable(fresh)) { setFailure({ kind: "file_not_editable" }); return; }
      setBase(fresh);
      setFailure(undefined);
      if (overwrite) await save(fresh);
      else if (!version && fresh.text !== base.text && fresh.text !== text) {
        setEarlierDraft(text);
        setText(fresh.text);
        setView("source");
      }
    } catch (error) {
      onFail(error);
      setReloadError(true);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {version ? <h2>{dateTimeOf(version.at)} の版に戻しますか</h2> : <p className="muted">直しています ・ {last ? `元にしたのは ${dateTimeOf(last.at)} の版（${writerName(last.writer)}）` : "元にした版の書き手と日時は不明"}</p>}
    {conflict ? <section className="memory-card">
      <div role="alert" ref={problem} tabIndex={-1}>
        <strong>保存していません。直している間に、このファイルが書き換わりました。</strong>
        <p className="muted">{conflict.last_change ? `${dateTimeOf(conflict.last_change.at)} ・ ${writerName(conflict.last_change.writer)}` : "変更の日時と書き手は不明です。"}</p>
        {!conflict.exists ? <p className="muted">現在の版にはこのファイルがありません。</p> : null}
      </div>
      <h3>元にした版から変わったところ</h3>
      <Diff diff={conflict.diff} />
      <div className="memory-controls">
        {conflict.exists ? <>
          <button type="button" disabled={busy} onClick={() => void readAgain()}>{version ? "新しい版で戻す内容を確認する" : "新しい版を取り込んで、直しを続ける"}</button>
          {!version ? <button type="button" disabled={busy || overLimit || nul} onClick={() => void readAgain(conflict)}>自分の文で上書きする</button> : null}
        </> : null}
        <button type="button" disabled={busy} onClick={close}>{version ? "やめる" : "直しを捨てる"}</button>
      </div>
    </section> : null}
    {failure?.kind === "worktree_conflict" ? <p className="memory-card muted" role="alert">エージェントが今このファイルを書いています。終わってから、もう一度保存してください。</p> : null}
    {failure?.kind === "unknown" ? <div className="memory-card">
      <p className="muted" role="alert">保存できたか確認できませんでした。もう一度試す前に、現在の版を読み直してください。</p>
      <button type="button" className="memory-hit" disabled={busy} onClick={() => void readAgain()}>現在の版を読み直す</button>
    </div> : null}
    {failure?.kind === "editing_disabled" || failure?.kind === "file_not_editable" ? <p role="alert" className="muted">現在、このファイルには保存できません。</p> : null}
    {reloadError ? <p role="alert" className="muted">現在の版を読み直せませんでした。もう一度お試しください。</p> : null}
    {version ? (!conflict ? <section className="memory-card">
      <p>戻るのはこのファイルだけです。消える行は履歴に残り、復元はオーナーの変更として 1 つ記録します。</p>
      <h3>戻すと変わるところ</h3>
      <Diff diff={diff.diff} />
    </section> : null) : <>
      <div className="memory-controls" role="group" aria-label="直している文の表示">
        <button type="button" aria-pressed={view === "source"} onClick={() => setView("source")}>元の文を直す</button>
        <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>仕上がりを見る</button>
        <button type="button" aria-pressed={view === "diff"} onClick={() => setView("diff")}>変えたところ {diff.added !== undefined && diff.removed !== undefined ? <Lines added={diff.added} removed={diff.removed} /> : null}</button>
      </div>
      {view === "source" ? <textarea className="memory-editor" aria-label="元の文" value={text} readOnly={busy} onChange={(event) => setText(event.target.value)} /> : view === "diff" ? <Diff diff={diff.diff} /> : <div className="memory-card memory-document">
        {base.kind === "markdown" ? <Markdown headingLevelStart={2} components={{ link: ({ children }) => <span>{children}</span>, image: ({ alt }) => <span>{alt}</span> }}>{text}</Markdown> : <pre className="memory-plain-preview">{text}</pre>}
      </div>}
      {earlierDraft !== undefined ? <details className="memory-card memory-draft">
        <summary>取り込む前に書いた文</summary>
        <p className="muted">欄には新しい版が入っています。ここから必要な直しを写せます。</p>
        <textarea className="memory-editor" aria-label="取り込む前に書いた文" value={earlierDraft} readOnly />
      </details> : null}
      <p className="muted">オーナーの変更として、このファイルだけを記録します。</p>
      {base.file.always_read ? <p className="muted">ここでの直しは、次の夜に新しいセッションが開いたときから効きます。</p> : null}
    </>}
    {overLimit ? <p role="status" className="muted">{base.file.always_read ? `${limitOf(limit)} を超えるとエージェントが読めなくなります。` : `保存する本文は ${limitOf(limit)} までです。`}</p> : null}
    {nul ? <p role="status" className="muted">本文に NUL 文字は含められません。</p> : null}
    <div className="memory-controls">
      {!conflict ? <>
        <button type="button" className="memory-primary" disabled={busy || Boolean(blocked) || overLimit || nul} onClick={() => void save()}>{version ? "この版に戻す" : "保存する"}</button>
        <button type="button" disabled={busy} onClick={close}>やめる</button>
      </> : null}
    </div>
    {busy ? <p className="muted" role="status">処理中…</p> : null}
  </>;
}
