# UI 向けの API の仕様

各配置の個人のページが backend を呼ぶ API。記憶の閲覧・編集・復元、活動の記録、本体とサブエージェントの状態、予約、モデル設定を扱う。会話と通知は家の担当で、旧 iPhone アプリが各配置に直接つなぐ API も廃止した（[ADR-0079](adr/0079-open-resident-pages-from-the-house.md)・[ADR-0080](adr/0080-connect-the-iphone-app-to-the-house.md)）。型は `packages/contract` の `src/ui.ts` が正である。

## 認証

- 配置の gated を通った後も、backend は GitHub OAuth で配置のオーナーのアカウントだけにセッションを発行する。家の認証は引き継がない。
- 認証が必要な `/api/…` はセッションの cookie を確かめる。cookie が通らないか、`Authorization` ヘッダーがある場合は `401`（body は `{error}`）。
- セッションの寿命と cookie の扱いは [backend.md](backend.md) の「オーナーのログイン」にある。

| 口 | 中身 |
| --- | --- |
| `GET /auth/github/start` | GitHub へ送る（`302`）。ログインが設定されていなければ `503`（`login-not-configured`） |
| `GET /auth/github/callback` | GitHub から戻る口。オーナーなら cookie を付けて `/` へ送る（`302`）。そうでなければ `{error}` で断る |
| `POST /auth/logout` | セッションを取り消し、cookie を消す（`204`） |

- ログインの断りの `error` は、`invalid-state`・`login-expired`・`invalid-request`（`400`）、`github-denied`・`account-not-allowed`（`403`）、`too-many-logins`（`429`）、`github-exchange-failed`・`github-unavailable`（`502`）、`login-not-configured`（`503`）。
- 戻る先は `/` に固定する。URL で戻り先を指定する欄は無い。
- `GET /healthz` は認証なしで `200` を返す（配置の確かめのため）。
- `GET /api/agent` と `GET /api/agent/icons/<表情>` は認証なしで読める（「エージェント」）。ログインの画面とホーム画面のアイコンが、ログインの前にエージェントの名前とアイコンを出すためである。この 2 つにはそれ以外のものを載せない。
- `/.well-known/agent-card.json`、`/a2a`、`/a2a/` の下は A2A の道で、オーナーのログインは使わない。JSON-RPC の呼び出しは受け口が送り手を確かめる（[a2a.md](a2a.md)）。受け口が閉じていれば `404` で、Web UI のページにはならない。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `GET /api/agent`・`GET /api/agent/icons/<表情>[<拡張子>]` | エージェントの名前と表情のアイコン（認証なし） |
| `GET /api/status`・`GET /api/agents` | 本体の状態と開いているサブエージェント（「今の様子」） |
| `GET /api/schedules`・`DELETE /api/schedules/<id>` | 予約の一覧と取り消し |
| `GET /api/settings`・`PUT /api/settings` | モデルと思考の深さの設定 |
| `GET /api/record`・`GET /api/record/<種類>/<id>`・`GET /api/record/unseen`・`POST /api/record/seen` | 活動の記録（「活動の記録」） |
| `GET /api/memory` および `/api/memory/…` | コミット済みの記憶の閲覧（「記憶」） |
| `POST /api/memory/save` | 既存の記憶ファイル 1 つの保存（「保存と復元」） |

## エージェント

- `GET /api/agent` は `{name, icons?}`。`name` は backend の設定のエージェントの名前（[backend.md](backend.md) の `PENELOPE_AGENT_NAME`、無ければアバターの名前）。`icons` は、エージェントのアバター（`/memory/avatar/`、[backend.md](backend.md) の「アバター」）に使える表情があるときだけあり、表情（expression）ごとの画像の道（`/api/agent/icons/<表情><拡張子>`。拡張子は画像のファイルの拡張子を小文字にしたもの。例 `/api/agent/icons/happy.png`）を持つ。`png_icons` は、アバターが表情の PNG を持つとき（`avatar.json` の `pngIcons`、[backend.md](backend.md) の「アバター」）だけあり、その表情ごとの PNG の道（`/api/agent/icons/<表情>.png`）を持つ。Slack への投稿のアイコン（[receivers.md](receivers.md) の「投稿の CLI」）は、URL が画像の拡張子で終わる形にするため、これらの道を使い、PNG があればそちらを使う。Slack が WebP のアイコンを受けるかを確かめていないためである。Web UI は `icons` の画像を使う。
- UI はエージェントの名前とアイコンをここから取る。コードと UI に決め打ちの名前を書かない（[ADR-0001](adr/0001-one-pod-with-pi-inside-the-sandbox.md)）。
- UI はアバターを表情ごとの画像で出す（[ADR-0016](adr/0016-show-the-avatar-and-expression-from-the-first-web-ui.md)）。表情が無いとき、アバターに無い表情のときは `neutral` の画像を出し、それも無ければ build に含めた汎用のアイコンを出す。
- `GET /api/agent/icons/<表情>` と `GET /api/agent/icons/<表情><拡張子>` は、その表情の画像を、拡張子の画像の型で返す。`GET /api/agent/icons/<表情>.png` は、その表情の PNG があればそれを返す。拡張子が画像のファイルのものと違う（PNG があるときの `.png` を除く）、無い表情、読めない画像は `404`。

## Web UI の配り方

- API・ログイン・ヘルスチェック・A2A の道以外では、backend が `PENELOPE_WEB_DIR` にある Web UI の build（`packages/web` の `dist/`）を配る。`/` は `index.html` である。無いファイルは `404`。
- `/manifest.webmanifest` は backend がその場で作る。名前はエージェントの名前、アイコンはアバターの `neutral` の画像（無ければ build の `icon.svg`）である。ホーム画面に置いて開くため（PWA）。
- `assets/` の下のファイルは中身で名前が決まるので、長く cache させる。ほかは毎回確かめさせる。

## 設定

- `GET /api/settings` は `{selection, default, models}`（`SettingsResponse`）。`selection` は保存した `{model, thinking}`、`default` は runner が知らせた本体の既定の組。それぞれ無ければ `null`。
- `model` は `<provider>/<model>`。最初の `/` より後ろ全体がモデルの ID。候補の `models` は runner から届いた `{provider, id, name, context_window, thinking_levels}` の一覧。`context_window` はトークン数。一覧が届いていないか期限切れなら `models: []`、`default: null`。
- `PUT /api/settings` は `{model, thinking}` を配置の設定として保存し、`200` で `GET` と同じ形を返す。候補に無いモデルや、そのモデルが対応しない深さは `400`。いずれもオーナーのログインが必要で、sandbox や A2A の token は使えない。
- PC・スマートフォンとも「場所」の「設定」に置く。保存済みか既定かを示し、候補ごとに名前・provider/ID・コンテキストの大きさ・使える思考の深さを確認できる。保存すると本体・サブエージェント・夜の振り返りと整理係の次のターンから効く。今走っているターンは変わらない。

## 今の様子

- `GET /api/status` は [sandbox 向けの本体の状態](sandbox-api.md#本体の状態) と同じ `AgentStatus` を返す。眠りと起床予定、眠気、起きてからの秒数、コンテキストの使用量（報告があるとき）、気分が分かる。
- `GET /api/agents` は `{agents: [...]}`（`SubAgentsResponse`）。runner が [起こしたと知らせた](sandbox-api.md#サブエージェントの状態) サブエージェントだけを、名前を初めて受けた順に載せる。閉じたものは載せない。
- 1 件は名前（`agent`）、目的（`purpose`）、状態（`state`: `thinking` または `waiting`）、開始時刻（`started_at`）、その状態になった時刻（`state_since`）を持つ。時刻は RFC 3339。状態と `state_since` は最後の `turn_start` または `turn_end` から引く。まだ記録が無ければ `waiting` で、`state_since` は `started_at` と同じ。
- 個人ページの「今の様子」（`#/status`）を開いたときと「読み直す」を押したときに、それぞれ直接読む。サブエージェントの名前から活動の記録を開ける。ここからサブエージェントを操作することはできない。

## 予約

- `GET /api/schedules` は `{schedules: [...]}`（`SchedulesResponse`）。[sandbox 向けの予約一覧](sandbox-api.md#予約) と同じ本体の予約を作った順で返す。1 件（`ScheduleEntry`）には `id`、`reason`、`cron` か `at` の一方、次に来る時刻（`next_at`、RFC 3339 の UTC）がある。cron は配置の時間帯で数えた次の回、1 回だけなら `at` と同じ。
- `DELETE /api/schedules/<id>` は予約を消す。消したら `204`、もう無ければ `404`（`{error}`）。取り消しの出来事は入らない。予約を作るのはエージェントであり、個人ページには作る口を置かない。
- 「出来事と予約」（`#/events`）を開くたびに一覧を読む。次に来る時刻で並べて日ごとに区切り、日付と時刻はブラウザの時間帯で出す。定期予約は cron の式を出し、毎日・毎週・毎月・毎年の単純な式には読み方も添える。
- オーナーが確認してから取り消す。`404` なら一覧を読み直す。ほかの失敗では知らせを出して行を残す。

## 活動の記録

オーナーが、各エージェントがいつ・何をきっかけに・何をしたか、何かが失敗していないかを後から見る場所である（[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)）。失敗は確認済みにできる。型は `packages/contract` の `src/ui.ts` の `Record…`、上限と期間は `src/record.ts`。

- 時刻はすべて RFC 3339 の UTC（`2026-11-14T10:00:00.000Z` の形）。
- 1 行の要約は 1 年、ターンの中の流れは 30 日で backend が消す（[backend.md](backend.md) の「活動の記録」）。

### 失敗

- **失敗** は、`result` が `failed` のターン、`result` が `failed` の夜、`failed_at` を持つ裏の仕事（0 以外の exit code で終わった `exited`、`timed-out`、`signaled`）である。止められたターン（`stopped`）、エージェントが止めた裏の仕事（`stopped`）、runner の立ち上がり直しで切れた裏の仕事（`interrupted`）は失敗でない。
- 夜の切り替えのターン（`night` を持つターン）は、その夜の行の中にあり、一覧のターンの行には出ない。失敗も夜の 1 つとして数える。夜の切り替えの知らせがまだ来ていない夜のターンは、ふつうのターンとして出る。
- 失敗の行は `failed_at`（backend が失敗とした時刻）を持つ。眠れなかった眠りも日ごとの `failures` とまだ見ていない失敗の `unseen` に数える。

### 一覧

`GET /api/record?day=&tz=&failed=&agent=&kind=` は 1 日分の行を返す（型は `RecordDayResponse`）。

| 引数 | 中身 |
| --- | --- |
| `day` | `YYYY-MM-DD`。省くと `tz` での今日 |
| `tz` | 日を区切る時間帯（IANA の名前、例 `Asia/Tokyo`）。省くと backend の `PENELOPE_TIME_ZONE`。Web UI はブラウザの時間帯を渡す |
| `failed` | `1` で失敗の行だけ。`0` か省くと全部 |
| `agent` | `main` で本体の行（本体のターン・夜・眠れなかった眠り・裏の仕事）だけ。サブエージェントの名前で、その人のターンと閉じた行だけ |
| `kind` | `turn`・`night`（眠れなかった眠りも）・`job`・`sub_agent` のどれか |

- 形の違う `day`、知らない `tz`・`kind`、`0` と `1` でない `failed` は `400`。
- 応答は `{day, rows, turns, failures, before?, agents}`。
  - `rows` は行の並びで、`at` の新しい順。`at` は行の位置の時刻で、ターンと夜は始まり、眠れなかった眠りは眠りを求めた時刻、裏の仕事は終わり、閉じたサブエージェントは閉じた時刻である。
  - `turns`・`failures` はその日の全部の数（絞り込みは効かない）。`turns` は夜の切り替えのターンを除いたターンの数。
  - `before` は、同じ絞り込みで行のある、より前の日（`YYYY-MM-DD`）。行の無い日は飛ばす。無ければ欄が無い。Web UI は下までスクロールしたら `day=<before>` で次を読む。
  - `agents` は記録の知っているサブエージェントの名前の一覧（閉じたものも）。「誰の」の絞り込みの選択肢に使う。
- 畳み（1 時間ごと）と、きっかけの見出しの書き方（「最初の 1 件 ＋ ほか n 件」）は Web UI がする。API は行ときっかけの並びを渡すだけである。

行は `kind` で 5 つに分かれる。すべて `id`・`kind`・`at` を持ち、失敗の行は `failed_at` も持つ。

| `kind` | 欄 | 開く口 |
| --- | --- | --- |
| `turn` | `agent`、`started_at`・`ended_at`・`seconds`（分かるときだけ）、`result`、`reason`、`triggers`・`trigger_count`、`tools`、`replies`、`night`（夜の切り替えのターンだけ。夜の行の `id` と段） | `GET /api/record/turns/<id>` |
| `night` | `scheduled_at`（夜の出来事が分かるとき）、`started_at`・`ended_at`・`seconds`、`result`、`stages` | `GET /api/record/nights/<id>` |
| `missed_night` | `scheduled_at` | なし |
| `job` | `command`（頭の `RECORD_COMMAND_MAX`（200）文字）、`started_at`・`ended_at`・`seconds`、`end`、`exit_code`・`signal`（あるときだけ） | なし |
| `sub_agent` | `agent`、`purpose`、`started_at`、`closed_at`、`turns`・`failed_turns` | `GET /api/record/sub-agents/<agent>` |

- ターンの `result` は `done`・`failed`・`stopped`（runner の言ったもの）、`running`（まだ終わっていない）、`unknown`（終わったが runner が結果を言わなかった。結果を送らない runner のターンと、記録より前のターン）。`reason` は runner が言ったときだけある。
- ターンの `triggers` は、渡した出来事を渡した順に、`RECORD_TRIGGERS_MAX`（20）件まで並べたもの。1 件は `{seq, source, stream?, summary}`（型は `RecordTrigger`）。`trigger_count` は全部の数。サブエージェントのターン（頼みは本体から来る）、夜の切り替えのターン、出来事の分からないターンでは空で、`trigger_count` は 0 である。
- 夜の `result` は、段のどれかが失敗なら `failed`、そうでなければ `done`、段の結果が知らされていなければ `unknown`。`stages` は `{reflection, verifier, curator, session}`（振り返り、照合係、整理係、新しいセッション） で、1 つの段は `{result, reason?, memory_change?}`。`result` は `done`・`failed`・`skipped`（行われなかった）・`unknown`。段の結果が知らされていない夜は、`session` が `done` で、ほかは `unknown` である。照合係を持たない旧 runner から段の結果が知らされた夜は、`verifier` が `skipped` になる。
- 夜の `memory_change` は `{files, added, removed, handoff_changed?}`（型は `RecordMemoryChange`）。振り返り・照合係・整理係で計測できたときだけ、その段でコミットした変更ファイル数と増減行数を返す。振り返りでは `handoff_changed` が引き継ぎファイル `handoff.md` を変えたかを示す。変更なしは 3 つの数が 0。旧記録、計測できなかった段、新しいセッションでは欄が無い。段の成否とは別で、失敗した段にも変更量はありうる。
- 任意の `stages.verifier.dropped_records` は持ち越しの上限を超えて照合対象から外れた未照合の記録の件数、`stages.curator.always_read_over_target` は整理前に目安を超えた毎回読む層の合計と目安（`{total_bytes, target_bytes}`）である。どちらも引き継ぎ未更新と同じく失敗には数えない。欄が無ければ表示しない。旧 runner が送らなかった場合も含むため、欄が無いことから件数 0 や目安以内とは判断しない。
- `stages.curator.review` があれば棚卸しの夜で、`{content, structure}` にそれぞれの `{result, reason?, turn_id?, memory_change?}` を持つ。通常の夜や旧記録にはこの欄は無い。夜全体の成否は引き続き 4 段で決め、整理係に失敗があっても夜の失敗は 1 件である。
- **眠れなかった眠り** は、求めてから `PENELOPE_SLEEP_REPORT_TIMEOUT_MINUTES` が経っても切り替えの知らせが来ないもの。行の `kind` は従来の `missed_night` のまま。`at` と `scheduled_at` は眠りを求めた時刻、`failed_at` は知らせの期限。後から知らせが来れば、切り替えの結果の行を代わりに出す。
- 閉じたサブエージェントの `turns` と `failed_turns` は、記録に残っているそのサブエージェントのターンと、うち失敗の数。

### 1 件

- `GET /api/record/turns/<id>` は `{turn, flow, expired}`（型は `RecordTurnResponse`）。
  - `turn` は一覧の行と同じ形。
  - `flow` は、そのターンの途中経過を順に並べたもの（`turn_start` と `turn_end` は除く）。形は sandbox 向けの口の途中経過の 1 件と同じだが、`tool_result` だけは `output` の代わりに大きさ（`lines` 行・`bytes` バイト、UTF-8）を持つ（型は `RecordFlowItem`）。結果の本文は開いたときに下の口で読む。
  - `expired` は、30 日を過ぎて流れが消えたとき `true`（そのとき `flow` は空）。
- `GET /api/record/turns/<id>/results/<call_id>` は `{output}`（型は `RecordResultResponse`）。そのツールの結果の本文の全部（runner が切った 16,000 文字まで）。流れが消えたもの、無いものは `404`。
- `GET /api/record/nights/<id>` は `{night, turns}`（型は `RecordNightResponse`）。`turns` は `{reflection?, verifier?, curator?, content?, structure?}`（一覧の `turn` の行と同じ形）。通常はその段の最後のターン、棚卸しでは `content`・`structure` に報告された各ターンを返し、`curator` は旧 UI 向けにうち最後のものを返す。
- `GET /api/record/sub-agents/<name>?before=` は `{sub_agent, turns, before?}`（型は `RecordSubAgentResponse`）。`sub_agent` は一覧の行と同じ形（閉じていなければ `closed_at` が無い）。`turns` はそのサブエージェントのターンの新しい順で、1 ページ 20 件。`before` は次のページの不透明な cursor で、最後のページには無い。backend の渡していない `before` は `400`。
- 記憶の変更が辿れるときだけ、ターンの詳細に `memory_change`（`MemoryChange`）を、夜の詳細に `memory_changes`（`MemoryChange[]`、コミット順）を加える。後者は参照の修正を含む。リンク先は `GET /api/memory/changes/<id>`（下の「記憶」）。
- 無い `id`・名前は `404`。どの口も GET のほかの method は `405`。

### まだ見ていない失敗と「見た」

- backend は、オーナーが活動の記録の画面を開いた時刻を 1 つ覚える（配置のオーナーごと。ブラウザごとではない）。まだ一度も開いていなければ、記録が始まった時刻を使う。
- **まだ見ていない失敗の数** は、その時刻より後の `failed_at` を持つ失敗の数である。
- `GET /api/record/unseen` は `{unseen}`（型は `RecordUnseenResponse`）。Web UI は、最初に開くときとウィンドウにフォーカスが戻ったときに読み、ナビゲーションの札にする。
- `POST /api/record/seen` は、今を開いた時刻として覚え、`{unseen, previous_seen_at}`（型は `RecordSeenResponse`）を返す。`unseen` は覚える前のまだ見ていない数、`previous_seen_at` は前に開いた時刻（初めてなら記録が始まった時刻）。Web UI は、活動の記録を開いたときと、一覧の「読み直す」を押したときに送り、`unseen` が 1 以上なら「前に見たあとの失敗が n 件あります」を出し、`failed_at` が `previous_seen_at` より後の行に「新しい」の札を付ける。札は画面を離れるまで残す。

### Web UI の活動の記録

- ナビゲーションの「活動の記録」に置く。一覧と詳細は `#/record`、`#/record/turns/<id>`、`#/record/nights/<id>`、`#/record/sub-agents/<名前>` で開ける。
- まだ見ていない失敗の数は、PC のナビゲーションとスマートフォンのメニューに出す。活動の記録を開いている間は札を出さない。一覧の知らせは、活動の記録を開いたときと「読み直す」を押したときに更新する。
- 一覧は、ブラウザの時間帯を `tz` に渡して今日を読む。下までスクロールすると `before` の日を読み、「読み直す」を押すと今日の一覧を取り直す。
- 夜の一覧行と 1 件の画面では、段の結果の横に記憶の変更量を出す。変更が 0 なら「記憶の変更なし」、計測されていなければ「記憶の変更は不明」、振り返りで `handoff_changed` が `false` なら「引き継ぎ未更新」と出す。行われなかった段と新しいセッションには変更量を出さない。毎回読む層の超過と照合対象外の件数は、夜の行と 1 件の画面に注意事項として出す。棚卸しでは一覧でも「棚卸し」と示し、詳細では整理係の下に中身・構成それぞれの成否、理由、変更量とターンへのリンク（ターンがあるとき）を出す。整理係全体の変更量を別に表示しない。
- 畳みは 1 時間ごと（ブラウザの時間帯）で、失敗していないターンが 2 つ以上ある時間帯だけを畳む。畳んだ行はその時間の始まりの位置に置く。きっかけの種類ごとの数は、多い順に 3 つまでと「ほか n」。
- 1 件の画面のツールの結果は、開いたときに `GET /api/record/turns/<id>/results/<call_id>` を読む。`404` なら「この結果は残っていません。」を出す。閉じたサブエージェントのターンは、「残りの n 件を見る」で次のページを読む。

## 記憶

ログインしたオーナーだけが、コミット済みの `/memory` を読み（[ADR-0056](adr/0056-read-committed-memory.md)）、既存ファイルを保存できる（[ADR-0057](adr/0057-edit-existing-memory-in-the-backend.md)）。読み取りは GET、保存と復元は同じ POST を使う。型は `packages/contract/src/ui.ts` の `Memory…`。まだコミットのない配置では、一覧・履歴・検索は `head: null` と空の結果、個別のファイル・変更は `404`。

- パスはルートからの UTF-8 の相対パス。query には `URLSearchParams` で入れる。絶対パス、空の成分、`.`・`..`・`.git`（大文字小文字の違いを含む）、バックスラッシュ、NUL を含むパスは `400`。通常ファイルだけを扱い、リンクやサブモジュールは開かない。
- `head` は各応答が読んだ版。本文・画像・検索・履歴・変更一覧の `head` に一覧で受け取った値を渡せば、途中で新しいコミットができても同じ版を参照できる。省略時は要求ごとにそのときの HEAD を使う。版・変更 ID は完全な Git のオブジェクト ID（小文字の 40 または 64 桁の 16 進数）。形式違いは `400`、現在の HEAD の第一親の履歴にない ID は `404`。
- 以下の `tz` は活動の記録と同じ IANA タイムゾーンで、省略時は backend の設定。無効なら `400`。時刻は RFC 3339（UTC）、日付は `YYYY-MM-DD`。各口のメソッドと異なれば `405`、未認証は `401`、応答は `no-store`。

| 口 | 応答 |
| --- | --- |
| `GET /api/memory?tz=` | `MemoryOverviewResponse`: 全ファイルのメタデータ、毎回読む層、切れたリンク、直近に報告された夜 |
| `GET /api/memory/file?path=&head=` | `MemoryFileResponse`: ファイルのメタデータ、本文または画像への URL、履歴の件数 |
| `GET /api/memory/image?path=&head=` | 画像のバイト列。本文の応答の `image_url` を使う |
| `GET /api/memory/changes?writer=&tz=&head=&before=` | `MemoryChangesResponse`: 変更の一覧（50 件ずつ） |
| `GET /api/memory/changes/<id>` | `MemoryChangeResponse`: 1 変更の見出し、変更したファイルの一覧、移動。差分の本文は含まない |
| `GET /api/memory/changes/<id>/diff?path=` | `MemoryFileDiff`: 1 変更の 1 ファイルの差分。移動は新しい方のパス、削除は消したパスを指定 |
| `GET /api/memory/history?path=&head=&before=` | `MemoryHistoryResponse`: 1 パスを変えたコミット（50 件ずつ） |
| `GET /api/memory/compare?path=&from=&to=` | `MemoryCompareResponse`: 1 パスの 2 版の差分。履歴の変更 ID を古い方から `from`、`to` に指定 |
| `GET /api/memory/search?q=&head=` | `MemorySearchResponse`: 版の本文に一致した行、パスと行番号 |
| `POST /api/memory/save` | `MemorySaveResponse`: 保存した変更の ID、変更なし、または保存を断った理由 |

### ファイルとゆうべの変更

- `files` は `path`・`bytes`・`always_read`・`last_change`（`{id, at, writer}` または不明なら `null`）・`reads`。フォルダの分類や畳みは UI がパスから組み立てる。読まれた記録がまだ届いていなければ `reads: null`。届いていれば `{count_30_days, last_day}`（該当なしなら 0 回・`null`）。パス単位で、移動前の回数は引き継がない。夜の収集時点までに分かった参照を、要求時の UTC の当日と前 29 日に絞って数える。何回かは事実の目安であり、必要性の判定には使わない。
- `always_read` の `bytes` は `PURPOSE.md`・`always.md`・`personality.md`・`handoff.md` の合計。無いファイルは 0、1 ファイルの上限を越えても合計には入る。 `target_bytes` は既定 16384、`file_limit_bytes` は既定 65536。 `over_target_nights` は夜の**終了時点のコミット済みの版**で合計が目安を超えていた夜の開始日（`tz`、新しい報告順・重複なし）。整理前に計った活動の記録の注意事項とは別の数である。最終版の記録がない古い夜は報告時刻以前の Git の版を使う（同じ秒の境目は近似）。
- `broken_links` は Markdown の相対リンク・画像参照のうち、リンク先がその版にないものの `{path, line, destination}`（行番号は 1 始まり。参照形式でも使用箇所の行と宣言されたリンク先を返す）。URL、絶対パス、記憶の外へ出るリンク、ページ内アンカーの有無は調べない。出力は 1000 件まで、読む Markdown は 1 ファイル 1 MiB、総量 32 MiB まで。上限で省いた場合は `links_incomplete: true`。
- `last_night` が `null` なら、報告された夜はない。それ以外は `{id, at, ended_at, files, added, removed, changes}`。 `id` は活動の記録の夜の ID。 `changes` に書き手の段ごとの変更と参照の修正をコミット順で並べる。同じ段の複数の試行もコミットがあれば載る。変更が無い段の行は無い。合計の `files` は各変更のパスの重複を除いた数、加減行は各変更の合計。移動は `changes[].moves` の `{from,to}`。
- `file` の `kind` は `markdown`・`text`（元の UTF-8 の文を `text` に返す）、`image`（`image_url` に認証の必要な画像の URL を返す）、`unavailable`（本文や URL を返さない）のいずれか。本文は 1 MiB まで、画像は `avatar/` 下の PNG・JPEG・GIF・WebP を先頭バイトで判定し 16 MiB まで。画像以外の `avatar/` 下のデータは本文にしない。画像には正しい `content-type` と `x-content-type-options: nosniff` を付ける。ファイルが最新の夜に移動していれば `moved_from` が付く。他の読めるファイルへの相対リンクは UI が解決する。Markdown は信頼できる HTML ではないので、生の HTML は描画しない。

### 保存と復元

- 配置の `can_edit` は一覧 `GET /api/memory` にある。ファイル応答のトップレベルの `edit` は、その版が対象外または配置で保存が無効なら `null`、対象なら `{max_bytes}`。`max_bytes` は保存する本文の UTF-8 バイト数の上限（通常は 1 MiB、毎回読む層なら 1 MiB と `always_read.file_limit_bytes` の小さい方）。対象は閲覧で本文を返せる既存の Markdown・テキストで、`avatar/` は含まない。過去の版の `edit` は今もそのファイルがあることを保証しない。編集・復元のボタンは PC で、**現在の**本文を取得して `edit` が `null` でないときに出す。
- `POST /api/memory/save` に `Content-Type: application/json` と `MemorySaveRequest`（`{path, base_head, text}`）を送る。`path` は記憶の相対パス（最大 4096 UTF-8 バイト）、`base_head` は編集開始時に `GET /api/memory/file?path=…` で受け取った `head`。`text` は置き換える全文（NUL を含まない UTF-8、空でもよい）。改行や末尾の改行は足さず、送ったとおり保存する。毎回読む層の合計の目安は超えても保存する。
- 復元では、現在の本文を取得して確認の起点 `base_head` を控え、同じパスの過去の本文を `GET /api/memory/file?path=…&head=<過去の変更ID>` から取得する。保存の `text` に過去の本文、`base_head` に**確認の起点**を渡す。作る・消す操作はなく、現在の版にないパスは復元できない。

| HTTP | `MemorySaveResponse.kind` | 意味と追加のフィールド |
| --- | --- | --- |
| `200` | `saved` | コミットした。`id` は変更の ID、`head` は保存直後の版（`id` と同じ）。変更へは `GET /api/memory/changes/<id>` を使う |
| `200` | `unchanged` | 本文が同じでコミットしなかった。`head` は判定した現在の版 |
| `409` | `head_conflict` | 起点と判定時の `head` で、そのパスの blob・Git のモード・通常ファイルとしての有無が違う。`exists` は新しい版に通常ファイルがあるか、`last_change` は削除・移動を含むそのパスの直近の変更（`{id, at, writer}` または `null`）、`diff` は起点から新しい版への `MemoryFileDiff`。ほかのパスだけの変更ではぶつからない |
| `409` | `worktree_conflict` | `head` の対象と作業ツリーが一致しない。エージェントが書いている途中、移動・削除など。作業ツリーの本文や差分は返さない |
| `422` | `file_not_editable` | 対象外、または起点の版に対象がない。起点に編集可能なファイルがあり判定時の HEAD で消えていれば `head_conflict` |
| `422` | `text_too_large` | 保存する本文が `max_bytes`（1 MiB）を超えた |
| `422` | `prompt_file_limit` | 毎回読む層の本文が配置の 1 ファイルの上限 `max_bytes` を超えた |
| `403` | `editing_disabled` | 配置にオーナーのメールが設定されていない |

ぶつかったときは保存しない。UI は入力中の本文を保持する。確定版が変わった場合は `diff` で変更を示し、`exists` が真なら本文を読み直してから編集・復元の確認をやり直す。作業ツリーとの衝突なら書きかけがあることを示し、確定後に再確認できるようにする。どちらも無確認で `base_head` を差し替えて再送しない。

一般の失敗（型では `{error}`）は、不正な入力 `400`、到達できない `base_head` `404`、JSON 全体が 6 MiB + 32 KiB を超えた `413`、メディア型が違う `415`、確定に失敗した `500`。`500` や通信切断で結果が不明な場合は、確定版を読み直してから再試行する。成功してもエージェントを起動せず、次のターンや会話にも添えない。

### 変更と差分

- `MemoryChange` は `id`・コミッター時刻の `at`・`writer`・変わったパスの `paths`・`files` 件・`added` 行・`removed` 行。バイナリはファイル数だけに入れる。変更の詳細にはこれに加え、1 ファイルずつの `files`（`kind: added | deleted | modified | moved`、移動なら `from`）と、`moves` がある。移動は Git が見つけたもの、参照の修正コミットでは runner が送った対応を返す。
- `writer.kind` は `daytime`（`agent` は `main` またはサブエージェント名。活動の記録があれば `turn_id` と、最初のきっかけの `trigger` を付ける）、`night`（`stage` は `reflection`・`verifier`・`curator`、棚卸しで区別できれば `content` または `structure`）、`owner`、`system`（`operation: reference_repair | avatar_seed`）、`unknown`。夜と参照の修正には分かる場合だけ `night_seq`、リンクできる場合に `night_id`・`turn_id` が付く。古いコミットの自由文や Git 作者の名義は返さない。
- `writer=all`（既定）・`daytime`・`night`・`owner` で絞れる。 `night` は参照の修正を含み、アバターの初期化を含めない。一覧は新しい順で、 `days` の日ごとの `items` に分かれる。各日の `changes` と `files`（重複を除いた変更パス数）はそのページ内でなく同じ絞り込みの一日全体の数。同じ日は次のページでも続きうる。
- `next` があれば、そのページの `head`、同じ絞り込みとともに `before` に渡す。 `next` が無いページで終わり、その一覧にない cursor は `400`。履歴は第一親の新しい側から、指定の**パス**が変わった変更を並べる。移動のコミットは両側のパスの履歴に出るが、移動前の別名は追わない。消えたパスの履歴も読める。比較の `changes` は `from` を除き `to` を含む間の変更数で、増減は 2 つの版の正味の差分。
- 差分の `kind: text` は連続した区間 `hunks` に分け、区間の頭に `old_start`・`new_start` を返す（存在しない側は 0 になりうる）。各行は `context`（両側の番号）、`added`（`new_line`）、`removed`（`old_line`）と、追加・削除の記号を含まない `text`。行番号は 1 始まり。区間の間には未表示の行がありうる。返すのは最大 2000 行とパッチ出力 1 MiB までで、途中で切れば `truncated: true`。 `image`・`binary`・`too_large` なら行を返さない。

### 検索

`q` は改行・NUL を含まない 1〜512 UTF-8 バイトの固定文字列。大文字・小文字、全角・半角を区別し、正規表現ではない。現在の版にある通常ファイルのみを対象にし、バイナリと `avatar/` は検索しない。 `files[]` に `path` と `lines[]: {line, text}` を Git の出力順で返す。上限は全体で `line_limit: 100` 行と 1 MiB。上限で結果を省いた場合には `truncated: true`。

## これから足すもの

- 作ったものの一覧の口と画面（[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)）。
- どの配置でも同じ形に保つ（[ADR-0026](adr/0026-move-natsumi-myao-and-aki-one-deployment-each-without-a-way-back.md)）。

## 承認

Sentinel の承認は個人のページでは扱わない。実装するときは、家でその住人との 1 対 1 の欄から答える（[ADR-0079](adr/0079-open-resident-pages-from-the-house.md)）。
