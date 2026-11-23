# Web UI の開発用モック

リポジトリのルートで `make web-dev` を実行し、`http://127.0.0.1:5173/` を開く。ログイン・backend は不要。
`?scene=` を付けて開くと場面を選び直せる。以後は同じブラウザーで場面を保持する。場面の全一覧は起動時にも出る。
ダークは本番と同じく OS の配色に追従する。ブラウザーの開発者ツールで `prefers-color-scheme: dark` をエミュレートしてもよい。

## 記憶（第 1 波）

| 場面と入口 | 確かめられる状態 |
| --- | --- |
| `/?scene=memory#/memory` | ふつうの日。前夜の切り替え、数百のファイル、1 年分の日記。フォルダーを開いてファイルへ。 |
| `/?scene=memory-over#/memory` | 毎回読む層が目安を超えた状態。超えた夜の一覧。 |
| `/?scene=memory-broken#/memory` | 「ファイル」の見出しの下から、切れたリンクを含むファイルの該当行へ。 |
| `/?scene=memory-empty#/memory` | `personality.md` だけ。夜の切り替えはまだない。 |
| `/?scene=memory#/memory/changes` | 日ごとの変更、書き手の絞り込み、続きの読み足し。今日の「朝の道具の点検」が日中の小さな差分。 |
| `/?scene=memory#/memory/changes/0000000000000000000000000000000000000382` | 夜の整理係の差分。移動と数十ファイル、折りたたみ、続きを表示。`avatar/sample.png` は画像の差分。 |
| `/?scene=memory#/memory/files/machines/storage/notes.md` | 描画／元の文、移動の一文、記憶内リンク、履歴（比較、前の版の読み足し）。 |
| `/?scene=memory#/memory/files/PURPOSE.md` | 「毎回読む層」の札とオーナーの同意についての添え書き。 |
| `/?scene=memory#/memory/files/avatar/sample.png` | コミット済み画像。 |
| `/?scene=memory#/memory?q=%E6%8E%A7%E3%81%88` | 「控え」を含む行の検索と、ファイルの行への移動。 |
| `/?scene=memory#/record/turns/t-memory-day` | 活動の記録のターン → 記憶の差分 → ターンに戻る。 |
| `/?scene=memory#/record/nights/n-memory` | 活動の記録の夜 → 段ごとの差分 → 夜に戻る。 |

`?scene=` なしの既定の場面と、記憶以外の場面（`busy`・`subagents`・`memory-review`・`failures`）にも、`memory` と同じ「ふつうの日」の記憶が入る。前夜の切り替えは、その場面の活動の記録の夜につながる（`failures` は整理係が落ちた夜の 1 つ前の夜）。`empty` の記憶は `personality.md` だけ。

`memory-review` は活動の記録の既存の棚卸し場面。記憶の状態ごとの確かめには上の `memory`・`memory-*` を使う。

## 記憶（第 2 波）

編集・復元は PC の幅で確認する。スマートフォンの幅では同じ場面を閲覧できるが、操作ボタンは出ない。

| 場面と入口 | 確かめられる状態 |
| --- | --- |
| `/?scene=memory-edit#/memory/files/machines/storage/notes.md` | 「直す」から本文を変更して保存すると、オーナーの変更と差分を開く。文を変えずに保存すると、何も記録していない旨を表示する。 |
| `/?scene=memory-edit#/memory/history/machines/storage/notes.md` | 版を 2 つ選び、「〜の版に戻す」で古い方を選ぶ。確認には現在の版から戻したときの差分が出る。 |
| `/?scene=memory-edit-conflict#/memory/files/machines/storage/notes.md` | 編集欄を開いてから、下の操作でエージェントの変更を確定させる。保存すると競合と差分が出て、書いた文が残る。 |
| `/?scene=memory-edit-worktree#/memory/files/machines/storage/notes.md` | 保存するとエージェントの書きかけを知らせる。差分は出ない。下の操作で書きかけを終了できる。 |
| `/?scene=memory-edit-limit#/memory/files/always.md` | 本文は 64 KB ちょうど。1 字足すと、保存する前に 1 ファイルの上限を伝える。 |
| `/?scene=memory-read-only#/memory/files/machines/storage/notes.md` | 配置で編集できないため、PC でも「直す」「〜の版に戻す」が出ない。 |
| `/?scene=memory-edit#/memory/files/avatar/sample.png` | 編集可能な配置でも画像には「直す」が出ない。 |

同じページの開発者ツールのコンソールで、編集中または復元の確認中に次を実行する。開き直さずに保存することで、編集中の版との競合を確認できる。

- `memory-edit-conflict`: `await fetch("/api/dev/memory/change", { method: "POST" })`。末尾に `?remove=1` を付けるとファイルが消え、上書きできなくなる。
- `memory-edit-worktree`: `await fetch("/api/dev/memory/finish", { method: "POST" })`。書きかけが終わり、同じ文を保存し直せる。

最初の状態に戻すには、`?scene=` を付けて開き直す。
