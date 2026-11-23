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

`memory-review` は活動の記録の既存の棚卸し場面。記憶の閲覧には上の `memory`・`memory-*` を使う。
