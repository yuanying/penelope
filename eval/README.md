# 夜の切り替え前後で、翌日の回答を比べる

[ADR-0044 項 8](../docs/adr/0044-check-memory-against-records-before-nightly-organization.md#8-翌日の回答で効果を確かめる) のための一度きりの比較。夜の段が増えたことではなく、**翌日、途中で変わった決まりを最新の根拠付きで使えるか**を見る。`make test` や CI からは呼ばない。

## 台本と採点

[scenario.ts](scenario.ts) に架空の荷物係の 5 日間・12 件の出来事、質問 6 問、先に決めた採点表を置く。集荷ルールは 1・2・4 日目の通知で二度変わり、引き渡しの署名担当も最終日に変わる。日中のメモと原本には、次の違いを埋めた。

| 小計 | 見ること | 配点 |
| --- | --- | ---: |
| `rule_changes` | 最新と過去の集荷先・締め切り、保留荷物の扱い、最新の署名担当を混同しない | 9 |
| `corrections` | メモに誤記した棚番号と封入数を、道具の結果に照らして直す | 3 |
| `uncertainty` | 耐水・振動試験の未確認を、合格や不合格と断定しない | 3 |
| `added_details` | 道具の出力だけにある封印番号とロッカー番号を拾う | 3 |
| `preservation` | 正しい梱包材と空のスリーブの返却場所を残す | 3 |

道具が読み取るレシートのファイルはその日の夜までに取り除く。道具だけが返す細部の原本は、Pi の畳み込まれていない記録内のツール結果にだけ残る。

機械採点は回答 15 欄と各問の引用 ID の組 6 つで計 21 点。値は完全一致、引用は順不同だが過不足なく一致すれば 1 点。指定の JSON でない応答は 0 点になるので、`answer` の原文と `score.validJSON` を見て、形式エラーと内容の欠落を区別する。引用 ID の一致は原本を本当に読んだ証明ではない。

## 回す

Node.js 24（リポジトリと同じ版）、npm、Git、Bash、tar が必要。2 つの ref を解決して別々の一時ディレクトリに展開し、それぞれの lockfile で依存を一度だけ入れる。ブランチを切り替えず、既存の記憶や Pi の設定を使わない。

偽物だけで配線を確かめる。同じ ref を 2 回指定してもよい。

```sh
EVAL_RUNS=2 bash eval/run.sh fake 97bb688 97bb688
```

偽モデルは採点用の正答を返さないので 0 点が正常。5 日分の原本とメモ、各夜の完了、最後の記憶読み取りまで通ればよい。npm の依存取得は必要だが、モデル API には接続しない。

### 実モデル: OpenAI 互換の Chat Completions

実データや他の資格情報を載せていない使い捨て環境で実行する。**baseline の夜には shell があり、この道具は Pod のファイル・通信の隔離を再現しない。** 到達先を評価専用の API に絞り、短命かつ低い予算上限付きのキーを使う。`EVAL_API_KEY` はシークレットから環境変数に入れ、コマンド履歴や結果には残さない。

```sh
# 評価専用 API のベース URL。/chat/completions 自体は付けない。
export EVAL_BASE_URL=https://model.example.com/v1
export EVAL_PROVIDER=eval-live  # 省略時も eval-live。fake は予約済み。
export EVAL_MODEL=your-chat-model
# EVAL_API_KEY を環境に渡した状態で、4 段の版の ref を指定する。
EVAL_RUNS=3 EVAL_THINKING=high bash eval/run.sh live 97bb688 night-verifier > night-comparison.jsonl
```

API はツール呼び出しに対応した OpenAI 互換のストリーミング Chat Completions を使う。

### 実モデル: Pi の OAuth ログイン

Pi に保存済みの OAuth ログインを使う場合は、`EVAL_BASE_URL` と `EVAL_API_KEY` を設定せず、代わりに `EVAL_PI_AUTH` に元の `auth.json` の絶対パスを指定する。

```sh
EVAL_PI_AUTH="$HOME/.pi/agent/auth.json" EVAL_PROVIDER=openai EVAL_MODEL=gpt-6.1-sol \
  EVAL_RUNS=3 EVAL_THINKING=high bash eval/run.sh live 97bb688 night-verifier > night-comparison.jsonl
```

`openai/gpt-6.1-sol` はこの比較で使う Pi の組み込みモデルで、ChatGPT のサブスクリプションで Responses API に接続する。指定するモデルは、比較する両方の ref の組み込み一覧に必要。`auth.json` はコピーせず、同じファイルを Pi のロック経由で読み書きする。OAuth 更新のためファイルへの書き込みと、隣にロックを作る権限が必要。隣の `models.json`、設定、拡張、skill、`AGENTS.md` やセッションは読み込まない。

**baseline の夜の shell からは、指定した `auth.json` も読みうる。** 台本は架空で外部から届く文を入れないが、ファイルや通信は隔離しない。この制約を許容できる、信頼した ref と環境でのみ実行する。

### 共通の指定と結果

`night-verifier` は取得済みのブランチ名、追跡 ref、またはコミット SHA に置き換えられる。再現には両方の SHA を固定する。

- `EVAL_RUNS`: 各版の試行回数（1〜99、既定 1）。同じ試行番号の base と candidate を順に回す。試行ごとに空の記憶・記録・作業場所から始める。
- `EVAL_THINKING`: `off`（既定）、`minimal`、`low`、`medium`、`high`、`xhigh`。両版の夜と翌日の回答に同じ値を使う。対応するモデル・エンドポイントを選ぶ。Chat Completions モードでは `off` のときに `reasoning_effort` を送らず、それ以外では指定値を送る。台本どおりに再生する日中の思考設定は変えない。

1 試行の 2 版合計で 5〜40 分、入力 20 万〜100 万・出力 2 万〜15 万トークンを計画の目安にする（未計測。思考の深さやツールの往復数で変わる）。たとえば 100 万トークンあたり入力 $2・出力 $10 なら約 $0.60〜$3.50。回数に比例するので 3 試行なら約 $1.80〜$10.50。実際の価格・使用量は provider 側で確認する。1 版・1 試行あたり 30 分で打ち切る。

標準出力は各試行の `kind: "run"` の JSONL と、最後の `kind: "summary"` 1 行。各試行にはコミット SHA、モデル、思考の深さ、夜ごとの段の結果、回答原文、採点内訳がある。集計には版ごとの総得点と種類別の小計がある。段が失敗した場合は比較を中断し、集計を出さない。各回と小計の両方を見て、どの種類の正答が一貫して増えたかを比べる。繰り返しても台本は 1 つなので、一般的な性能差とは見なさない。

## 何を動かすか

`e2e/` は 4 コンテナと偽の外部 API を使い、cron の夜まで通す。ここでは比較対象である **各版の runner と Pi のセッション・道具・折り畳み**をそのまま使う。日中だけは runner のテストと同じ偽モデルを使い、実際の `read` と `write` を毎版同じ順で呼んで、同じ誤記とツール記録を残す。

時計を日ごとに進め、sandbox API の代役から夜の `control` を 1 件ずつ渡す。`Sources` の JSONL とターン終了時の `Memory` の Git コミットは本物。cron、HTTP、Sentinel、Pod の mount は使わない。夜は runner の `ack` と切り替え結果を待つため、段の数は指定しない。

回答は夜の runner を止めた後、会話のない Pi セッションに質問する。そのセッションの道具は、最終時点の Markdown 記憶の一覧と読み取りだけ。原本のイベント、日中の記録、作業場所、Git 履歴にはアクセスできない。
