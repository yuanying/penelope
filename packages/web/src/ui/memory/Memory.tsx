import { Heading } from "@astryxdesign/core/Heading";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type Api, Unauthorized } from "../../model/api.ts";
import type { MemoryPage } from "../route.ts";
import { ChangeView, ChangesView, HistoryView } from "./changes.tsx";
import { FileView, HomeView, SearchView } from "./files.tsx";
import { HOME, MemoryScope, memoryHash, ReadBody, TZ, useReading } from "./shared.tsx";

export function MemoryPlace({ api, onUnauthorized, page, topInset }: { api: Api; onUnauthorized: () => void; page: MemoryPage | undefined; topInset: boolean }) {
  const onFail = useCallback((error: unknown) => { if (error instanceof Unauthorized) onUnauthorized(); }, [onUnauthorized]);
  const read = useCallback(() => api.memory(TZ), [api]);
  const overview = useReading(read, onFail);
  const scope = useMemo(() => ({ api, overview: overview?.value, onFail }), [api, overview, onFail]);
  const ready = overview !== undefined;
  const kind = page?.kind ?? "home";
  // Keep the lists and the last detail of each kind alive when moving between
  // them. Each scroll pane keeps its own position, independently of layout.
  const [visited, setVisited] = useState<Partial<Record<MemoryPage["kind"], MemoryPage>>>({});
  const address = page ? memoryHash(page) : HOME;
  if (page && (!visited[page.kind] || memoryHash(visited[page.kind]!) !== address)) setVisited({ ...visited, [page.kind]: page });
  const file = visited.file?.kind === "file" ? visited.file : undefined;
  const change = visited.change?.kind === "change" ? visited.change : undefined;
  const versions = visited.history?.kind === "history" ? visited.history : undefined;
  const changes = visited.changes?.kind === "changes" ? visited.changes : undefined;
  const list = kind === "home" || kind === "changes" || kind === "search";
  const search = visited.search?.kind === "search" ? visited.search : undefined;

  return <MemoryScope.Provider value={scope}>
    <section className={`memory-place${topInset ? " memory-inset" : ""}`} aria-label="記憶">
      <header className="memory-header">
        {/* A file, a change and a history have a heading of their own: there this is the name of the place. */}
        {list ? <Heading level={1}>記憶</Heading> : <p className="memory-title">記憶</p>}
        <SearchBox address={address} initial={page?.kind === "search" ? page.q : ""} />
      </header>
      {kind === "home" || kind === "changes" ? <nav className="memory-tabs" aria-label="記憶の表示">
        <a href={HOME} aria-current={kind === "home" ? "page" : undefined}>ファイル</a>
        <a href={memoryHash(changes ?? { kind: "changes" })} aria-current={kind === "changes" ? "page" : undefined}>変更</a>
      </nav> : null}
      <div className="memory-scroll" hidden={kind !== "home"}>
        <div className="page-body"><ReadBody result={overview}>{(data) => <HomeView data={data} />}</ReadBody></div>
      </div>
      {changes ? <div className="memory-scroll" hidden={kind !== "changes"}><div className="page-body">{ready ? <ChangesView writer={changes.writer ?? "all"} /> : <Loading />}</div></div> : null}
      {file ? <div key={file.path} className="memory-scroll" hidden={kind !== "file"}><div className="page-body">{ready ? <FileView path={file.path} line={file.line} source={file.source === true || file.line !== undefined} active={kind === "file"} /> : <Loading />}</div></div> : null}
      {change ? <div key={change.id} className="memory-scroll" hidden={kind !== "change"}><div className="page-body"><ChangeView page={change} /></div></div> : null}
      {versions ? <div key={versions.path} className="memory-scroll" hidden={kind !== "history"}><div className="page-body">{ready ? <HistoryView path={versions.path} compare={versions.compare} /> : <Loading />}</div></div> : null}
      {search ? <div key={search.q} className="memory-scroll" hidden={kind !== "search"}><div className="page-body">{ready ? <SearchView q={search.q} /> : <Loading />}</div></div> : null}
    </section>
  </MemoryScope.Provider>;
}

function Loading() {
  return <p role="status" className="muted">読み込み中…</p>;
}

function SearchBox({ initial, address }: { initial: string; address: string }) {
  const [q, setQ] = useState(initial);
  const [composing, setComposing] = useState(false);
  const [previous, setPrevious] = useState(address);
  if (previous !== address) {
    setPrevious(address);
    setQ(initial);
  }
  const search = useCallback(() => {
    if (q === initial || composing || /[\r\n\0]/.test(q) || new TextEncoder().encode(q).length > 512) return;
    const hash = q ? memoryHash({ kind: "search", q }) : HOME;
    if (hash !== location.hash) {
      // Typing a different query replaces the previous search, not the list
      // the owner was reading before it. The input stays focused as it updates.
      const state = initial ? history.state : { memoryFrom: address };
      if (initial) history.replaceState(state, "", hash);
      else history.pushState(state, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, [address, q, initial, composing]);
  useEffect(() => {
    const timer = setTimeout(search, 350);
    return () => clearTimeout(timer);
  }, [search]);
  return <form role="search" onSubmit={(event) => { event.preventDefault(); search(); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}>
    <TextInput type="search" label="記憶を検索" isLabelHidden hasClear value={q} onChange={setQ} placeholder="記憶を検索…" enterKeyHint="search" htmlName="q" autoComplete="off" />
    {new TextEncoder().encode(q).length > 512 ? <p className="muted" role="status">検索語は 512 バイトまでです。</p> : null}
  </form>;
}
