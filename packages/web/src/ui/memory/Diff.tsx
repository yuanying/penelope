import type { MemoryFileDiff } from "@penelope/contract";

export function Diff({ diff }: { diff: MemoryFileDiff }) {
  if (diff.kind !== "text") return <p className="memory-diff-note muted">{diff.kind === "image" ? "画像が替わりました。" : diff.kind === "binary" ? "バイナリファイルが変わりました。" : "差分が大きいため表示できません。"}</p>;
  return <div className="memory-diff-content">
    {!diff.hunks.length ? <p className="memory-diff-note muted">本文の差分はありません。</p> : null}
    {diff.hunks.map((hunk, i) => <div key={i}>
      {i > 0 || Math.max(hunk.old_start, hunk.new_start) > 1 ? <p className="memory-diff-note muted">… {hunk.new_start || hunk.old_start} 行目から</p> : null}
      {hunk.lines.map((line, j) => <div className="memory-diff-line" data-kind={line.kind} key={j}>
        <span aria-hidden="true">{"old_line" in line ? line.old_line : ""}</span><span aria-hidden="true">{"new_line" in line ? line.new_line : ""}</span>
        {line.kind === "context" ? <span aria-hidden="true" /> : <span role="img" aria-label={line.kind === "added" ? "足した行" : "消した行"}>{line.kind === "added" ? "+" : "−"}</span>}
        <code>{line.text || " "}</code>
      </div>)}
    </div>)}
    {diff.truncated ? <p className="memory-diff-note muted">差分の一部を表示しています。</p> : null}
  </div>;
}
