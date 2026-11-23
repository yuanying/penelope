import { Badge } from "@astryxdesign/core/Badge";
import { Heading } from "@astryxdesign/core/Heading";
import { Markdown, type MarkdownComponents } from "@astryxdesign/core/Markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MemoryBrokenLink, MemoryFile, MemoryFileResponse, MemoryOverviewResponse } from "@penelope/contract";

import { ChevronRightIcon } from "../icons.tsx";
import { dateTimeOf, recordDayOf } from "../record.ts";
import { sizeOf } from "../words.ts";
import { Counts, fileHash, groupBy, MemoryBack, MemoryLink, memoryHash, ReadBody, replaceHash, unbroken, useFocusNew, useMemory, useReading, WriterMark, writerName } from "./shared.tsx";

const ROLES = {
  "PURPOSE.md": "このエージェントの目的",
  "always.md": "いつも守ること",
  "personality.md": "話し方と性格",
  "handoff.md": "夜からの引き継ぎ",
};
const PLACES = { goals: "目標と今日のこと", skills: "手順書", diary: "日記", archive: "古い事実の要約", avatar: "アバターの画像と設定" };
const PAGE = 6;

const when = (file: MemoryFile) => file.last_change ? `${dateTimeOf(file.last_change.at)} ・ ${writerName(file.last_change.writer)}` : "変更日時は不明";
const readCount = (file: MemoryFile) => file.reads ? unbroken(`30 日に ${file.reads.count_30_days} 回`) : "読まれた回数は不明";
const size = (bytes: number) => unbroken(sizeOf(bytes));
const byRecent = (a: MemoryFile, b: MemoryFile) => (b.last_change?.at ?? "").localeCompare(a.last_change?.at ?? "") || a.path.localeCompare(b.path);

function FileRow({ file, role }: { file: MemoryFile; role?: string }) {
  return <MemoryLink href={fileHash(file.path)} className="record-row-body memory-file-row">
    <code>{file.path}</code>{role ? <span className="muted">{role}</span> : null}
    <span className="memory-file-meta muted">{size(file.bytes)} ・ {when(file)}{role ? "" : ` ・ ${readCount(file)}`}</span>
    <ChevronRightIcon width={14} height={14} />
  </MemoryLink>;
}

function Broken({ links, incomplete = false, detail = false }: { links: MemoryBrokenLink[]; incomplete?: boolean; detail?: boolean }) {
  if (!links.length && !incomplete) return null;
  return <p className="muted memory-broken">
    {links.length ? <>リンク先のファイルが無いリンクが {links.length} つあります。 {links.map(({ path, line, destination }, i) => <span key={i}>
      {detail ? <code>{line} 行目: {destination}</code> : <MemoryLink href={fileHash(path, line)}><code>{path}:{line}</code></MemoryLink>}{i < links.length - 1 ? "、" : ""}
    </span>)}</> : null}
    {incomplete ? " リンクの確認は一部のファイルに限られます。" : null}
  </p>;
}

export function HomeView({ data }: { data: MemoryOverviewResponse }) {
  const { last_night: night, always_read: layer, files } = data;
  const known = Object.entries(PLACES).map(([name, label]) => ({ name, label, files: files.filter((f) => f.path.startsWith(`${name}/`)) }));
  const topics = files.filter((f) => !f.always_read && f.path !== "INDEX.md" && !known.some(({ name }) => f.path.startsWith(`${name}/`)));
  const index = files.find((f) => f.path === "INDEX.md");
  const ratio = layer.bytes / Math.max(1, layer.target_bytes);
  return <>
    {night ? <section className="memory-card">
      <div className="memory-section-head"><h2>ゆうべ変わったこと</h2><span className="muted">{dateTimeOf(night.ended_at)} ・ <Counts of={night} /></span></div>
      {!night.changes.length ? <p className="muted">記憶の変更なし</p> : null}
      {night.changes.map(({ change, moves }) => <MemoryLink key={change.id} className="record-row-body" href={memoryHash({ kind: "change", id: change.id })}>
        <WriterMark writer={change.writer} /><span className="record-main"><span className="memory-section-head"><strong>{moves.length && change.writer.kind === "system" ? "移動 ・ 仕組み" : writerName(change.writer)}</strong><span className="muted"><Counts of={change} /></span></span><PathPreview paths={change.paths} /></span>
      </MemoryLink>)}
    </section> : null}
    <section className="memory-card">
      <div className="memory-section-head"><h2>毎回読む層</h2><span className="muted">合計 {size(layer.bytes)} ・ 目安 {size(layer.target_bytes)}</span></div>
      <div className="memory-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, 75 * ratio)}%` }} /><i /></div>
      {Object.entries(ROLES).map(([path, role]) => {
        const file = files.find((f) => f.path === path);
        return file ? <FileRow key={path} file={file} role={role} /> : null;
      })}
      {ratio > 1 || layer.over_target_nights.length ? <p className="muted">{ratio > 1 ? "目安を超えています。" : ""}{layer.over_target_nights.length ? ` 超えた夜: ${layer.over_target_nights.map((d) => recordDayOf(d)).join("、")}。` : ""}{ratio > 1 ? " 夜の整理係が、まずここを縮めます。" : ""}</p> : null}
      <p className="muted">ここにあるファイルは、新しいセッションを開いたときにエージェントが丸ごと読みます。1 ファイルは {size(layer.file_limit_bytes)} まで。</p>
    </section>
    <section>
      <div className="memory-section-head"><h2>ファイル</h2><span className="muted">{files.length} ファイル</span></div>
      <Broken links={data.broken_links} incomplete={data.links_incomplete} />
      {index ? <FileRow file={index} /> : null}
      {known.map(({ name, label, files: group }) => group.length ? <Folder key={name} prefix={`${name}/`} label={label} files={group} /> : null)}
      {topics.length ? <section className="memory-topics"><h3>トピック</h3><p className="muted">エージェントが作ったファイル ・ 名前はエージェントが付けたまま</p><FolderContents prefix="" files={topics} /></section> : null}
      {!files.length ? <p className="muted">まだ記憶のファイルはありません。</p> : null}
      <p className="muted">「30 日に何回」は、エージェントが日中にそのファイルを読んだ・探した回数です。読まれないことは、要らないことを意味しません。</p>
    </section>
  </>;
}

export function PathPreview({ paths }: { paths: string[] }) {
  return <span className="memory-paths muted">{paths.slice(0, 3).map((path) => <code key={path}>{path}</code>)}{paths.length > 3 ? <span>ほか {paths.length - 3}</span> : null}</span>;
}

function Fold({ title, children, path, tail }: { title: string; children: React.ReactNode; path?: string; tail?: string }) {
  return <details className="memory-fold"><summary className="record-row-body"><ChevronRightIcon width={16} height={16} />{path ? <><code>{path}</code>{title ? <span className="muted">{title}</span> : null}</> : <span>{title}</span>}{tail ? <span className="muted memory-fold-tail">{tail}</span> : null}</summary><div className="memory-nested">{children}</div></details>;
}

function Folder({ prefix, label = "", files }: { prefix: string; label?: string; files: MemoryFile[] }) {
  return <Fold title={label} path={prefix} tail={`${files.length} ファイル`}>
    {prefix === "diary/" ? <Diary files={files} /> : <FolderContents prefix={prefix} files={files} />}
  </Fold>;
}

function FolderContents({ prefix, files }: { prefix: string; files: MemoryFile[] }) {
  const entries = groupBy(files, (f) => {
    const tail = f.path.slice(prefix.length);
    const slash = tail.indexOf("/");
    return slash < 0 ? "" : tail.slice(0, slash);
  });
  const direct = [...(entries.get("") ?? [])].sort(byRecent);
  return <>
    {[...entries].filter(([name]) => name).sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => <Folder key={name} prefix={`${prefix}${name}/`} files={group} />)}
    {!prefix && direct.length ? <Fold title="フォルダに入っていないファイル" tail={`${direct.length} ファイル`}><FileRows files={direct} /></Fold> : <FileRows files={direct} />}
  </>;
}

function FileRows({ files, capped = true }: { files: MemoryFile[]; capped?: boolean }) {
  const [more, setMore] = useState(false);
  const { root, remember } = useFocusNew<HTMLDivElement>(Number(more));
  return <div className="memory-group" ref={root}>{files.slice(0, !capped || more ? files.length : PAGE).map((file) => <FileRow key={file.path} file={file} />)}
    {capped && !more && files.length > PAGE ? <button type="button" className="memory-hit" onClick={() => { remember(); setMore(true); }}>ほか {files.length - PAGE} を表示</button> : null}</div>;
}

const diaryDay = (path: string) => /^diary\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1];
const diaryOrder = (a: MemoryFile, b: MemoryFile) => b.path.localeCompare(a.path);

function Diary({ files }: { files: MemoryFile[] }) {
  const dated = files.filter((f) => diaryDay(f.path)).sort(diaryOrder);
  const rest = files.filter((f) => !diaryDay(f.path));
  const months = [...groupBy(dated.slice(3), (f) => diaryDay(f.path)!.slice(0, 7))];
  const newest = diaryDay(dated[0]?.path ?? "")?.slice(0, 7);
  const month = ([date, group]: [string, MemoryFile[]]) => {
    const [year, number] = date.split("-");
    return <Fold key={date} title={`${date === newest ? `${Number(number)}月の残り` : `${year}年${Number(number)}月`} ${group.length} 日分`}><FileRows files={group} capped={false} /></Fold>;
  };
  return <><FileRows files={dated.slice(0, 3)} />{months.slice(0, 2).map(month)}
    {months.length > 2 ? <Fold title={`それより前 ${months.slice(2).reduce((n, [, rows]) => n + rows.length, 0)} 日分 ・ 月ごと`}>{months.slice(2).map(month)}</Fold> : null}
    <FolderContents prefix="diary/" files={rest} />
  </>;
}

export function FileView({ path, line, source, active }: { path: string; line: number | undefined; source: boolean; active: boolean }) {
  const { api, overview, onFail, beginEdit } = useMemory();
  const head = overview?.head ?? undefined;
  const canEdit = beginEdit !== undefined;
  // Only offer to edit a file read from the current head, not a pinned snapshot.
  const read = useCallback(() => api.memoryFile(path, canEdit ? undefined : head), [api, path, head, canEdit]);
  const result = useReading(read, onFail);
  return <>
    <MemoryBack />
    <p className="muted memory-breadcrumb">記憶 / <code>{path.split("/").join(" / ")}</code></p>
    <ReadBody result={result}>{(data) => <FileBody data={data} line={line} source={source} active={active} />}</ReadBody>
  </>;
}

function FileBody({ data, line, source, active }: { data: MemoryFileResponse; line: number | undefined; source: boolean; active: boolean }) {
  const { overview, beginEdit } = useMemory();
  const { file, text = "" } = data;
  // The address says which of the two is shown, so that it comes back the same after a reload.
  const raw = source || data.kind === "text";
  const show = (source: boolean) => replaceHash(memoryHash({ kind: "file", path: file.path, ...(source ? { source: true } : {}) }));
  const target = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (active && raw) target.current?.scrollIntoView({ block: "center" });
    // The pane keeps its own position when returning to this file.
  }, [raw, line]);
  const diary = diaryDay(file.path) ? overview?.files.filter((f) => diaryDay(f.path)).sort(diaryOrder) ?? [] : [];
  const at = diary.findIndex((f) => f.path === file.path);
  const previous = at < 0 ? undefined : diary[at + 1];
  const next = at < 1 ? undefined : diary[at - 1];
  const markdown = useMemo((): MarkdownComponents => ({
    link: ({ href, children }) => {
      const path = relativeMemoryPath(file.path, href);
      return path ? <MemoryLink className="memory-text-link" href={fileHash(path)}>{children}</MemoryLink> : /^https?:\/\//i.test(href) ? <a className="memory-text-link" href={href} target="_blank" rel="noopener noreferrer">{children}<span aria-hidden="true">{"\u00a0"}↗</span><span className="memory-unseen">（新しいタブで開く）</span></a> : <span>{children}</span>;
    },
    image: ({ src, alt }) => {
      const path = relativeMemoryPath(file.path, src);
      // Do not fetch images from arbitrary origins when opening a memory file.
      return path?.startsWith("avatar/") ? <img src={`/api/memory/image?${new URLSearchParams({ path, head: data.head })}`} alt={alt} loading="lazy" /> : <span>{alt}</span>;
    },
  }), [file.path, data.head]);
  return <>
    <div className="memory-section-head"><Heading level={1}><code>{file.path}</code></Heading>{file.path === "PURPOSE.md" ? <Badge label="毎回読む層" /> : null}</div>
    <p className="muted">{size(file.bytes)} ・ 最後の変更: {when(file)} ・ {file.reads ? `${readCount(file)}読まれた${file.reads.last_day ? `（最後は ${recordDayOf(file.reads.last_day)}）` : ""}` : readCount(file)}</p>
    {file.path === "PURPOSE.md" ? <p className="muted">オーナーの同意で書くファイルです。</p> : null}
    {data.moved_from ? <p className="muted">ゆうべ <code>{data.moved_from}</code> から移動しました。</p> : null}
    <div className="memory-controls">
      {data.kind === "markdown" ? <><button type="button" aria-pressed={!raw} onClick={() => show(false)}>読む</button><button type="button" aria-pressed={raw} onClick={() => show(true)}>元の文</button></> : null}
      <MemoryLink className="memory-hit" href={memoryHash({ kind: "history", path: file.path })}>履歴 {data.history_count}</MemoryLink>
      {beginEdit && data.edit ? <button type="button" onClick={(event) => beginEdit({ path: file.path }, event.currentTarget)}>直す</button> : null}
    </div>
    <div className="memory-card memory-document">
      {data.kind === "image" && data.image_url?.startsWith("/api/memory/image?") ? <img src={data.image_url} alt={file.path} /> : data.kind === "unavailable" ? <p className="muted">本文を表示できないファイルです。</p> : raw ? (
        <pre className="memory-source">{text.split("\n").map((content, index) => <span key={index} ref={line === index + 1 ? target : null} data-selected={line === index + 1 || undefined} aria-current={line === index + 1 || undefined}><span aria-hidden="true">{index + 1}</span><span>{content || " "}</span></span>)}</pre>
      ) : <Markdown headingLevelStart={2} components={markdown}>{text}</Markdown>}
    </div>
    <Broken links={data.broken_links} detail />
    {previous || next ? <nav className="memory-controls" aria-label="日記の日付">
      {previous ? <MemoryLink className="memory-hit" href={fileHash(previous.path)}>前の日</MemoryLink> : null}
      {next ? <MemoryLink className="memory-hit" href={fileHash(next.path)}>次の日</MemoryLink> : null}
    </nav> : null}
  </>;
}

/** A relative Markdown destination in the same tree, never a browser URL. */
function relativeMemoryPath(from: string, href: string): string | undefined {
  if (!href || /^(?:[a-z][\w+.-]*:|\/|#|\?)/i.test(href)) return;
  try {
    const [part] = href.split(/[?#]/, 1);
    const path = decodeURIComponent(part!);
    if (!path || path.startsWith("/") || /[\\\0]/.test(path)) return;
    const parts = from.split("/").slice(0, -1);
    for (const name of path.split("/")) {
      if (name === "..") { if (!parts.length) return; parts.pop(); }
      else if (name.toLowerCase() === ".git") return;
      else if (name && name !== ".") parts.push(name);
    }
    return parts.length ? parts.join("/") : undefined;
  } catch { return undefined; }
}

export function SearchView({ q }: { q: string }) {
  const { api, overview, onFail } = useMemory();
  const head = overview?.head ?? undefined;
  const read = useCallback(() => api.memorySearch(q, head), [api, q, head]);
  const result = useReading(read, onFail);
  return <><MemoryBack /><h2>検索結果</h2><ReadBody result={result}>{(data) => <>
    <p className="muted" role="status">「{q}」 ・ {data.files.length} ファイルの {data.files.reduce((n, f) => n + f.lines.length, 0)} 行 ・ 文字のとおりに探します。大文字・小文字、全角・半角を区別します。</p>
    {data.truncated ? <p className="muted">結果の一部を表示しています（最大 {data.line_limit} 行）。</p> : null}
    {data.files.length === 0 ? <p className="muted">一致する行はありません。</p> : null}
    {data.files.map(({ path, lines }) => <section className="memory-card" key={path}><h3><MemoryLink href={fileHash(path)}><code>{path}</code></MemoryLink></h3>
      {lines.map(({ line, text }) => <MemoryLink key={line} href={fileHash(path, line)} className="record-row-body memory-search-line"><span className="muted">{line}</span><code>{text.split(q).map((part, i) => <span key={i}>{i ? <mark>{q}</mark> : null}{part}</span>)}</code></MemoryLink>)}
    </section>)}
  </>}</ReadBody></>;
}
