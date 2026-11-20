# UI 向けの API の仕様

Web UI が backend を呼ぶ API を決める。方針は [ADR-0009](adr/0009-web-ui-first-with-a-new-api-and-astryx.md) と
[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md) にある。型は `packages/contract` の `src/ui.ts` が正である。

**この文書は、画面の一覧と流れをオーナーと合意した後に直す。** ここにあるのは、backend を先に作るための最小の形である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 認証

- backend の GitHub OAuth のログインで作るセッションの cookie で確かめる（[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md)）。通すのはオーナーの GitHub アカウントだけ。
- cookie が無いか通らなければ `401`。失敗の応答の body は `{error}`。
- セッションの寿命と cookie の形は [backend.md](backend.md) の「オーナーのログイン」にある。

| 口 | 中身 |
| --- | --- |
| `GET /auth/github/start` | GitHub へ送る（`302`）。ログインが設定されていなければ `503`（`login-not-configured`） |
| `GET /auth/github/callback` | GitHub から戻る口。オーナーなら cookie を付けて `/` へ送る（`302`）。そうでなければ `{error}` で断る |
| `POST /auth/logout` | セッションを取り消し、cookie を消す（`204`） |

- callback の断りの `error` は、`invalid-state`・`login-expired`・`invalid-request`（`400`）、`github-denied`・`account-not-allowed`（`403`）、`github-exchange-failed`・`github-unavailable`（`502`）、`too-many-logins`（`429`）のどれか。
- 戻る先は `/` に決めてあり、要求の中身では変わらない。
- `GET /healthz` は認証なしで `200` を返す（配置の確かめのため）。
- `GET /api/agent` と `GET /api/agent/icons/<表情>` は認証なしで読める（「エージェント」）。ログインの画面とホーム画面のアイコンが、ログインの前にエージェントの名前とアイコンを出すためである。この 2 つにはそれ以外のものを載せない。
- `/a2a` と `/a2a/` の下は A2A の受け口で、ログインを使わず、受け口が自分で送り手を確かめる（[a2a.md](a2a.md)）。受け口が閉じていれば `404` で、Web UI のページにはならない。
- `/api/`・`/auth/`・`/a2a/` のほかの道は、Web UI の静的ファイルを配る場所である（「Web UI の配り方」）。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `POST /api/messages` | オーナーのメッセージを送る |
| `GET /api/history?before=` | 会話の履歴 |
| `GET /api/stream` | 返事・途中経過・状態の流れ（SSE） |
| `GET /api/agent`・`GET /api/agent/icons/<表情>[<拡張子>]` | エージェントの名前と表情のアイコン（認証なし） |
| `GET /api/agents` | 閉じていないサブエージェントの一覧 |
| `GET /api/assets/<id>` | 返事とオーナーのメッセージに添えられた画像の写し |
| `GET /api/push`・`POST /api/push/subscriptions`・`POST /api/push/subscriptions/delete` | 返事の知らせ（Web Push）の鍵と、購読の登録と解除 |
| `GET /api/schedules`・`DELETE /api/schedules/<id>` | エージェントの予約の一覧と取り消し |
| `GET /api/settings`・`PUT /api/settings` | モデルと思考の深さの設定 |
| `GET /api/record`・`GET /api/record/<種類>/<id>`・`GET /api/record/unseen`・`POST /api/record/seen` | 活動の記録（「活動の記録」） |
| `GET /api/approvals`・`POST /api/approvals/<id>` | 承認（後の波） |

## メッセージを送る

- body は `{text}`。添付があるときは `multipart/form-data` で、本文とファイルを並べる。
- backend は `source` が `ui` の出来事にして列に入れる（[events.md](events.md)）。`ui` は inline なので、本文はそのままターンに入る。添付は `/sources/ui/files/` に置かれる。
- 応答は `202` と `{id, images?, files?}`（型は `PostMessageResponse`）。`id` は出来事の `id`、`images` と `files` は履歴のその行と同じもの（「履歴」）。
- multipart では、本文は `text` の欄、ファイルは `file` の部分を繰り返す。大きさの上限は body の全体で 64 MiB。数の上限は置かない。
- 本文が空でファイルも無ければ `400`。
- 出来事の `summary` は本文の 1 行目（200 文字まで）。本文が空なら、ファイルの数。
- 添付のうち画像は、backend が写して行に結び付ける（[ADR-0034](adr/0034-images-the-owner-sends-copied-by-the-backend.md)、「画像」）。画像かどうかと 1 枚の大きさの上限は、返事の画像と同じ（PNG・JPEG・GIF・WebP を中身で見分け、10 MiB まで）。ほかのファイルは名前と大きさだけを残す。どちらもメッセージを断る理由にはしない。
- 写しを書けなければ `500`（`not sent: the images could not be kept`）で、出来事も行も残さない。

## 履歴

- 返事とオーナーのメッセージを、新しい順に返す。応答は `{entries, before?}`。`before` は次の（より古い）ページを取るための不透明な cursor で、最後のページには無い。
- 1 件は `kind`（`owner` か `agent`）・`id`・`at`・`text` を持つ。`agent` のものは、さらに `agent`（エージェントの ID）と `expression` を持つ。
- `agent` のものは、答えている出来事（返事の `in_reply_to`）を backend が知っていれば、`trigger` として、その出来事の `source` と `summary` を持つ。出来事の `payload` は載せない。UI はこれを、エージェントが何をきっかけに話したかの札にする。
- `agent` のものは、backend が返事を出したターンを知っていれば `turn_id` を持つ（[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)）。Web UI は返事の時刻のリンクで `GET /api/record/turns/<turn_id>` を開く（「活動の記録」）。
- `agent` のものは、画像を添えた返事なら `images` として、送られた順の画像の一覧を持つ（型は `ReplyImage`、「画像」）。画像の無い返事には欄が無い。
- `owner` のものは、添付があれば `images`（写した画像の一覧。型は `ReplyImage`、「画像」）と `files`（写さなかったファイルの `{name, size}` の一覧。型は `OwnerFile`）を、それぞれ送られた順に持つ。無い欄は載せない。[ADR-0034](adr/0034-images-the-owner-sends-copied-by-the-backend.md) より前に送られたメッセージは、どちらも持たない。

- 1 ページは 50 件。backend の渡していない `before` は `400`。
- 途中経過は履歴に含めない。途中経過は流れで送り、過去の途中経過は活動の記録で読む（「活動の記録」）。

## 流れ（SSE）

- `GET /api/stream` は Server-Sent Events。出来事の名前（SSE の `event`）と、JSON の `data` を送る。

| `event` | `data` |
| --- | --- |
| `reply` | 返事（履歴の `agent` の 1 件と同じ形） |
| `activity` | `{agent, activity}`。`activity` は sandbox 向けの口の途中経過の 1 件の写し（[sandbox-api.md](sandbox-api.md) の「途中経過」） |
| `state` | `{agent, state}`。`state` は `thinking`（ターンの最中）か `waiting`（出来事を待っている） |
| `agent` | `{agent, purpose, closed}`（型は `SubAgentStatus`）。サブエージェントを起こした・閉じた（「サブエージェント」） |
| `record` | `{unseen}`（型は `RecordUnseenResponse`）。まだ見ていない失敗の数が変わった（「活動の記録」） |

- 細かさは、sandbox 向けの口と同じくブロックが閉じるごと。トークンごとの流れが UI に要るなら、後で足す。

- SSE の `id` に連番を付ける。つなぎ直したときに `Last-Event-ID` があれば、その後のものから送り直す。backend が覚えているのは最近の 1000 件だけで、backend が再起動すると連番は 1 から数え直す。足りなければ UI が履歴を読み直す。
- Web UI は、最初につなぐときも、つなぎ直すときも `Last-Event-ID: 0` を付け、覚えている分をすべて受け取り直す。今の状態と今のターンの途中経過を、その中の最後の `state` と最後の `turn_start` から後で知るためである（状態だけを返す口は無い）。backend の再起動で連番が戻っても、これなら取りこぼさない。返事は `id` で履歴と重ねる。
- 25 秒ごとに SSE のコメントを送り、つながりを保つ。

未決:

- オーナー自身のメッセージを流れにも送るか（複数のタブで見ているとき）。今は送らない（`StreamEvent` にオーナーのメッセージの形が無い）。

## サブエージェント

サブエージェントは、本体が起こし、runner が回す別のセッションである（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)）。Web UI は見るだけで、サブエージェントを操作する口は無い。

- 流れの `activity` と `state` は、`agent` で本体（`main`）とサブエージェント（サブエージェントの名前）を見分ける。サブエージェントのものは右のパネルのそのサブエージェントの欄に出し、会話の時系列には出さない。
- 返事は本体だけが送るので、履歴と流れの `reply` の `agent` はいつも `main` である。
- `GET /api/agents` は `{agents: [...]}`（型は `SubAgentsResponse`、1 件は `SubAgent`）。1 件は `agent`（サブエージェントの名前）・`purpose`（起こしたときの目的）・`state`（`thinking` か `waiting`）・`started_at`（起こした時刻。backend が最初に `closed: false` を受けた時刻）・`state_since`（今の `state` になった時刻。まだターンの無いサブエージェントは `started_at` と同じ）を持つ。時刻は RFC 3339。並びは、backend がその名前を初めて受けた順。閉じたサブエージェントは載せない。サブエージェントは夜をまたいで残り、流れの覚えている 1000 件からは今のサブエージェントを組み立てられないため、この口を置く。
- 載るのは、runner がサブエージェントを起こしたと知らせた（sandbox 向けの口の `POST /v1/agents`）名前だけである。まだ知らせの無い名前の途中経過は流れには出るが、一覧には載らない。
- `state` と `state_since` は、そのサブエージェントの途中経過の記録の最後の `turn_start` か `turn_end` から引く。時刻はその途中経過の `at` で、backend が立ち上がり直しても変わらない（[sandbox-api.md](sandbox-api.md) の「途中経過」）。
- 流れの `state` は時刻を持たない。UI は受けた時刻を、その `state` になった時刻とする。
- 流れの `agent` は、サブエージェントを起こしたとき（`closed: false`）と閉じたとき（`closed: true`）に送る。UI は、閉じたサブエージェントの欄を消す。閉じたサブエージェントの途中経過は backend の記録に残るが、UI には出さない。
- UI は、最初につなぐときとつなぎ直すときに `GET /api/agents` を読み、その後は流れで直す。

## エージェント

- `GET /api/agent` は `{name, icons?}`。`name` は backend の設定のエージェントの名前（[backend.md](backend.md) の `PENELOPE_AGENT_NAME`、無ければアバターの名前）。`icons` は、エージェントのアバター（`/memory/avatar/`、[backend.md](backend.md) の「アバター」）に使える表情があるときだけあり、表情（expression）ごとの画像の道（`/api/agent/icons/<表情><拡張子>`。拡張子は画像のファイルの拡張子を小文字にしたもの。例 `/api/agent/icons/happy.png`）を持つ。`png_icons` は、アバターが表情の PNG を持つとき（`avatar.json` の `pngIcons`、[backend.md](backend.md) の「アバター」）だけあり、その表情ごとの PNG の道（`/api/agent/icons/<表情>.png`）を持つ。Slack への投稿のアイコン（[receivers.md](receivers.md) の「投稿の CLI」）は、URL が画像の拡張子で終わる形にするため、これらの道を使い、PNG があればそちらを使う。Slack が WebP のアイコンを受けるかを確かめていないためである。Web UI は `icons` の画像を使う。
- UI はエージェントの名前とアイコンをここから取る。コードと UI に決め打ちの名前を書かない（[ADR-0001](adr/0001-one-pod-with-pi-inside-the-sandbox.md)）。
- UI はアバターを表情ごとの画像で出す（[ADR-0016](adr/0016-show-the-avatar-and-expression-from-the-first-web-ui.md)）。表情が無いとき、アバターに無い表情のときは `neutral` の画像を出し、それも無ければ build に含めた汎用のアイコンを出す。
- `GET /api/agent/icons/<表情>` と `GET /api/agent/icons/<表情><拡張子>` は、その表情の画像を、拡張子の画像の型で返す。`GET /api/agent/icons/<表情>.png` は、その表情の PNG があればそれを返す。拡張子が画像のファイルのものと違う（PNG があるときの `.png` を除く）、無い表情、読めない画像は `404`。

## 知らせ

エージェントの返事（`reply`）は、すべてオーナーの購読に知らせる（[ADR-0027](adr/0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md)）。最初の種類は Web Push だけである。オーナー自身のメッセージ、途中経過、A2A の Task への返事は知らせない。

- `GET /api/push` は `{web_push?}`（型は `PushResponse`）。`web_push` は、配置が VAPID の鍵を渡しているとき（[backend.md](backend.md) の `PENELOPE_WEB_PUSH_VAPID_KEY_FILE`）だけあり、`public_key`（VAPID の公開鍵。非圧縮の P-256 を base64url で）を持つ。無ければ、Web UI は通知を使えないと示す。
- `POST /api/push/subscriptions` は購読を 1 つ登録する。body は `{kind: "web-push", endpoint, keys: {p256dh, auth}}`（型は `PushSubscriptionRequest`。ブラウザの `PushSubscription.toJSON()` に `kind` を足したもの）。応答は `204`。同じ `endpoint` をもう一度登録すると、鍵を置き換える。購読の数に上限は置かない。
  - `endpoint` は https の URL で 2048 文字まで、`p256dh` は P-256 の曲線上の非圧縮の点（65 バイト）、`auth` は 16 バイト。どれかが違えば `400`。
  - VAPID の鍵が無ければ `503`（`web-push-not-configured`）。
- `POST /api/push/subscriptions/delete` は body が `{endpoint}`（型は `PushUnsubscribeRequest`）で、その購読を消す。無くても `204`。
- 購読は配置の backend の SQLite にあり、ログインのセッションとは結び付けない。ログアウトしても購読は残る（止めるのは Web UI の「通知を止める」）。

### 知らせの中身

- Web Push の中身は JSON の 1 つ（型は `Notice`）で、購読の鍵で暗号化する（RFC 8291 の aes128gcm、1 レコード）。
  - `id`（返事の `id`）、`agent`（エージェントの名前。`GET /api/agent` の `name` と同じ）、`text`（返事の頭）、`expression`（返事にあれば）、`images`（返事に画像があるときの数、[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)）。
- `text` は返事の前後の空白を落とし、200 文字（Unicode の符号位置で数える）を超えれば切って `…` を付ける。JSON が平文の上限（3993 バイト）を超えるときは、収まるまで長さを半分にする。
- 送るときの `TTL` は 24 時間、`Urgency` は `high`。VAPID の token は push service の origin に向けて 12 時間有効で、`sub` は `PENELOPE_PUBLIC_URL` である。
- 送るのは 1 回だけで、redirect は追わない。`404`・`410` の購読は消す。ほかの失敗はログに残すだけで、送り直さない。ログには購読の番号と状態だけを書き、本文と `endpoint` は書かない。
- backend は push service へ自分で送り、Sentinel を通さない。

### service worker

- Web UI の build は `/sw.js` に service worker を置き、scope は `/` である。
- 知らせを受けると、題がエージェントの名前、本文が `text`（画像があれば次の行に「（画像 N 枚）」）、アイコンが `expression` の表情の画像（アバターに無ければ `neutral`、アバターが無ければ build の `icon.svg`）の通知を出す。表情の画像は `GET /api/agent` から引く。`tag` は返事の `id`。
- 開いている画面があり、その画面が前に出ていても、通知は出す（出さない push が続くと、ブラウザが購読を止めることがある）。そのときは音を鳴らさない。
- 通知を押すと、開いている画面があればそれを前に出し、無ければ会話（`/`）を開く。

### Web UI の切り替え

- 「通知を受ける」の切り替えは、PC は左のレールの下（ログアウトの隣、畳んでいるときはベルのアイコン）、スマートフォンはメニューの中（ログアウトの上）に小さく置く（[docs/design](design/README.md) の左の「場所」の並びの外に足すだけで、画面の割り当ては変えない）。
- 押すと、ブラウザに通知の許可を求め、`/sw.js` を登録し、`public_key` で購読して、`POST /api/push/subscriptions` で登録する。もう一度押すと（「通知を止める」）、ブラウザの購読を止め、`POST /api/push/subscriptions/delete` で消す。
- Web UI を開くたびに、ブラウザが購読を持っていれば登録し直す。購読の鍵が今の `public_key` と違えば、作り直してから登録する（鍵の替わった配置へは、前の購読では届かない）。
- 押せないときは、その訳を出す: 配置に鍵が無い、ブラウザが Web Push を持たない、オーナーがブラウザで通知を断った。

### iPhone で受けるには

iOS・iPadOS 16.4 から、ホーム画面に置いた Web アプリが Web Push を受けられる。Safari のタブのままでは受けられない。

1. Safari で配置の URL を開き、ログインする。
2. 共有ボタンから「ホーム画面に追加」を選ぶ。
3. ホーム画面のアイコンから開き、もう一度ログインする（ホーム画面の Web アプリは Safari と cookie を分けて持つ）。
4. メニューを開いて「通知を受ける」を押し、通知を許す。

止めるときは、メニューの「通知を止める」か、iPhone の「設定」の「通知」でそのアプリを止める。配置ごと（エージェントごと）に、この手順で購読する。

## Web UI の配り方

- `/api/`・`/auth/`・`/a2a/` のほかの道では、backend が `PENELOPE_WEB_DIR` にある Web UI の build（`packages/web` の `dist/`）を配る。`/` は `index.html` である。無いファイルは `404`。
- `/manifest.webmanifest` は backend がその場で作る。名前はエージェントの名前、アイコンはアバターの `neutral` の画像（無ければ build の `icon.svg`）である。ホーム画面に置いて開くため（PWA）。
- `assets/` の下のファイルは中身で名前が決まるので、長く cache させる。ほかは毎回確かめさせる。

## 設定

- `GET /api/settings` は `{selection, default, models}`（`SettingsResponse`）。`selection` は保存した `{model, thinking}`、`default` は runner が知らせた本体の既定の組。それぞれ無ければ `null`。
- `model` は `<provider>/<model>`。最初の `/` より後ろ全体がモデルの ID。候補の `models` は runner から届いた `{provider, id, name, context_window, thinking_levels}` の一覧。`context_window` はトークン数。一覧が届いていないか期限切れなら `models: []`、`default: null`。
- `PUT /api/settings` は `{model, thinking}` を配置の設定として保存し、`200` で `GET` と同じ形を返す。候補に無いモデルや、そのモデルが対応しない深さは `400`。いずれもオーナーのログインが必要で、sandbox や A2A の token は使えない。
- PC・スマートフォンとも「場所」の「設定」に置く。保存済みか既定かを示し、候補ごとに名前・provider/ID・コンテキストの大きさ・使える思考の深さを確認できる。保存すると本体・サブエージェント・夜の振り返りと整理係の次のターンから効く。今走っているターンは変わらない。

## 予約

ダッシュボードを少しずつ足す最初の 1 歩として、エージェントの予約（[sandbox-api.md](sandbox-api.md) の「予約」）を Web UI から見て取り消せるようにする。

- `GET /api/schedules` は `{schedules: [...]}`（型は `SchedulesResponse`、1 件は `ScheduleEntry`）。エージェントの `schedule_list`（`GET /v1/schedules?agent=main`）と同じ予約を、同じ順（作った順）で返す。予約を持つのは本体だけなので、`agent` は載せない。
- 1 件は `id`・`reason`・`cron` か `at` のどちらか一方（予約を作ったときの値のまま）・`next_at` を持つ。`next_at` は次に来る時刻（RFC 3339、UTC）で、backend が出来事にする時刻である。cron の予約は backend の設定の時間帯で数えた次の回、1 回の予約は `at` と同じ時刻になる。
- `DELETE /api/schedules/<id>` は予約を消す。エージェントの `schedule_remove`（`DELETE /v1/schedules/<id>`）と同じ結果になる。消したら `204`、その予約が無ければ `404`（`{error}`）。
- 消したことはエージェントには知らせない（出来事を入れない）。エージェントは `schedule_list` で知る。
- 予約を足す口は作らない。予約を足すのはエージェントである。

### Web UI の予約

- 左の「場所」の「出来事と予約」に置く。予約は時刻が来るとエージェントへの出来事（`cron`）になるためで、出来事の画面のほかの中身は後の波で足す。PC もスマートフォンも同じ中身で、幅は会話と同じく 720px までで中央に寄せる。スマートフォンでは、浮いたアバターの分だけ上を空ける。見た目は [docs/design](design/README.md) の 12 章。
- API は作った順で返すので、UI が `next_at` の順に並べ、日ごとに区切る（「今日 ・ 11月17日(火)」「明日 ・ …」か日付。年が違えば年も）。見出しの横に件数と次の 1 件（「7 件 ・ 次は 明日 6:00」）を出す。時刻と日付はブラウザの時間帯で書く。
- 1 件を 1 行にし、左端に次の時刻（時分）、理由、繰り返し、右端に「取り消す」のボタンを出す。理由は最初の「。」までを見出し、残りを 1 行の本文にし、行を押すと全文が開く（一度に 1 行）。無いときは「予約はありません」。
- 繰り返しは、cron の式（等幅）の前に言葉で書く。言葉にするのは毎日・毎週（曜日 1 つ）・毎月（日 1 つ）・毎年（月と日 1 つずつ）で、分と時が 1 つの数のときだけ（`0 6 * * *` は「毎日 6:00」、`0 18 * * 0` は「毎週 日曜 18:00」、`0 9 1 * *` は「毎月 1日 9:00」、`0 9 5 1 *` は「毎年 1月5日 9:00」）。ほかの式は式だけを出す。式は backend の時間帯で読まれるので、言葉は式の数をそのまま書く。1 回の予約は「1 回だけ」。
- 「取り消す」を押すと、取り消すかを確かめる（理由の見出し、繰り返しか 1 回だけか、エージェントには知らせないことを添える）。確かめてから `DELETE` を送り、その行を消す。`404` のときは（エージェントが自分で消したか、1 回の予約が来たあと）一覧を読み直す。ほかの失敗は知らせを出し、行は残す。
- 一覧はこの場所を開くたびに読む。流れでは直さない（予約の変化は流れに載らない）。

## 活動の記録

オーナーが、各エージェントがいつ・何をきっかけに・何をしたか、何かが失敗していないかを後から見る場所である（[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)、画面は [docs/design](design/README.md) の 14 章）。見るだけで、操作の口は無い。型は `packages/contract` の `src/ui.ts` の `Record…`、上限と期間は `src/record.ts`。

- 時刻はすべて RFC 3339 の UTC（`2026-11-14T10:00:00.000Z` の形）。
- 1 行の要約は 1 年、ターンの中の流れは 30 日で backend が消す（[backend.md](backend.md) の「活動の記録」）。

### 失敗

- **失敗** は、`result` が `failed` のターン、`result` が `failed` の夜、`failed_at` を持つ裏の仕事（0 以外の exit code で終わった `exited`、`timed-out`、`signaled`）である。止められたターン（`stopped`）、エージェントが止めた裏の仕事（`stopped`）、runner の立ち上がり直しで切れた裏の仕事（`interrupted`）は失敗でない。
- 夜の切り替えのターン（`night` を持つターン）は、その夜の行の中にあり、一覧のターンの行には出ない。失敗も夜の 1 つとして数える。夜の切り替えの知らせがまだ来ていない夜のターンは、ふつうのターンとして出る。
- 失敗の行は `failed_at`（backend がその失敗を知った時刻）を持つ。逃した夜も持つ。失敗でない行は持たない。
- **日ごとの数**（`turns`・`failures`）には逃した夜を数えない。**まだ見ていない失敗の数**（`unseen`）には数える。

### 一覧

`GET /api/record?day=&tz=&failed=&agent=&kind=` は 1 日分の行を返す（型は `RecordDayResponse`）。

| 引数 | 中身 |
| --- | --- |
| `day` | `YYYY-MM-DD`。省くと `tz` での今日 |
| `tz` | 日を区切る時間帯（IANA の名前、例 `Asia/Tokyo`）。省くと backend の `PENELOPE_TIME_ZONE`。Web UI はブラウザの時間帯を渡す（予約の一覧と同じく、日付はブラウザの時間帯で書くため） |
| `failed` | `1` で失敗の行と逃した夜だけ。`0` か省くと全部 |
| `agent` | `main` で本体の行（本体のターン・夜・逃した夜・裏の仕事）だけ。サブエージェントの名前で、その人のターンと閉じた行だけ |
| `kind` | `turn`・`night`（逃した夜も）・`job`・`sub_agent` のどれか |

- 形の違う `day`、知らない `tz`・`kind`、`0` と `1` でない `failed` は `400`。
- 応答は `{day, rows, turns, failures, before?, agents}`。
  - `rows` は行の並びで、`at` の新しい順。`at` は行の位置の時刻で、ターンと夜は始まり、逃した夜は予定の時刻、裏の仕事は終わり、閉じたサブエージェントは閉じた時刻である。
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
- 夜の `result` は、段のどれかが失敗なら `failed`、そうでなければ `done`、段の結果が知らされていなければ `unknown`。`stages` は `{reflection, verifier, curator, session}`（振り返り、照合係、整理係、新しいセッション） で、1 つの段は `{result, reason?}`。`result` は `done`・`failed`・`skipped`（行われなかった）・`unknown`。段の結果が知らされていない夜は、`session` が `done` で、ほかは `unknown` である。照合係を持たない旧 runner から段の結果が知らされた夜は、`verifier` が `skipped` になる。
- **逃した夜** は、記録が始まった後の予定の夜の時刻（backend の `PENELOPE_NIGHTLY_CRON`、今の設定で数える）のうち、次のどちらかのものである。夜の出来事が、その時刻から 1 分たっても列に無い（backend が止まっていた）。夜の出来事はあるが、次の夜の時刻までに切り替えの知らせが来なかった。`failed_at` はそれが決まった時刻（1 分後か、次の夜の時刻）。後から知らせが来れば、逃した夜ではなくなる。
- 閉じたサブエージェントの `turns` と `failed_turns` は、記録に残っているそのサブエージェントのターンと、うち失敗の数。

### 1 件

- `GET /api/record/turns/<id>` は `{turn, flow, expired, replies}`（型は `RecordTurnResponse`）。
  - `turn` は一覧の行と同じ形。
  - `flow` は、そのターンの途中経過を順に並べたもの（`turn_start` と `turn_end` は除く）。形は sandbox 向けの口の途中経過の 1 件と同じだが、`tool_result` だけは `output` の代わりに大きさ（`lines` 行・`bytes` バイト、UTF-8）を持つ（型は `RecordFlowItem`）。結果の本文は開いたときに下の口で読む。
  - `expired` は、30 日を過ぎて流れが消えたとき `true`（そのとき `flow` は空）。
  - `replies` は、そのターンで出した返事の `{id, at, text, history_before}`（型は `RecordReply`）の並び。`history_before` は `GET /api/history?before=` に渡すと、その返事から始まるページが返る値である。Web UI は「会話でこの返事を見る」で、会話を開いてそのページを読み、`id` の返事の位置へ移る。
- `GET /api/record/turns/<id>/results/<call_id>` は `{output}`（型は `RecordResultResponse`）。そのツールの結果の本文の全部（runner が切った 16,000 文字まで）。流れが消えたもの、無いものは `404`。
- `GET /api/record/nights/<id>` は `{night, turns}`（型は `RecordNightResponse`）。`turns` は `{reflection?, verifier?, curator?}` で、その段の最後のターン（一覧の `turn` の行と同じ形）。手順を回し直した夜は、最後に回したもの。
- `GET /api/record/sub-agents/<name>?before=` は `{sub_agent, turns, before?}`（型は `RecordSubAgentResponse`）。`sub_agent` は一覧の行と同じ形（閉じていなければ `closed_at` が無い）。`turns` はそのサブエージェントのターンの新しい順で、1 ページ 20 件。`before` は次のページの不透明な cursor で、最後のページには無い。backend の渡していない `before` は `400`。
- 無い `id`・名前は `404`。どの口も GET のほかの method は `405`。

### まだ見ていない失敗と「見た」

- backend は、オーナーが活動の記録の画面を開いた時刻を 1 つ覚える（配置のオーナーごと。ブラウザごとではない）。まだ一度も開いていなければ、記録が始まった時刻を使う。
- **まだ見ていない失敗の数** は、その時刻より後の `failed_at` を持つ失敗と逃した夜の数である。
- `GET /api/record/unseen` は `{unseen}`（型は `RecordUnseenResponse`）。Web UI は、最初につなぐときとつなぎ直すときにこれを読み、左のレールとメニューの札にする。
- 数が変わると、流れで `record`（`{unseen}`）を送る。backend は記録が失敗を受けたとき、オーナーが開いたとき、15 秒ごと（逃した夜は時がたつだけで決まるため）に数え直し、前に送った数と違えば送る。
- `POST /api/record/seen` は、今を開いた時刻として覚え、`{unseen, previous_seen_at}`（型は `RecordSeenResponse`）を返す。`unseen` は覚える前のまだ見ていない数、`previous_seen_at` は前に開いた時刻（初めてなら記録が始まった時刻）。Web UI は、活動の記録の画面を開いたときに 1 回送り、`unseen` が 1 以上なら「前に見たあとの失敗が n 件あります」を出し、`failed_at` が `previous_seen_at` より後の行に「新しい」の札を付ける。札は画面を離れるまで残す。

### Web UI の活動の記録

- 左の「場所」の「活動の記録」に置く。見た目は [docs/design](design/README.md) の 15 章。PC もスマートフォンも同じ中身で、幅は会話と同じく 720px までで中央に寄せる。
- 一覧と 1 件の画面はアドレスを持つ。backend は `/` のほかの道で Web UI を返さないので（「Web UI の配り方」）、アドレスは # の後ろに置く（`#/record`、`#/record/turns/<id>`、`#/record/nights/<id>`、`#/record/sub-agents/<名前>`）。ほかの場所も `#/talk` などのアドレスを持つ。
- 会話の返事は、`turn_id` を持てば、時刻をリンクにし、そのターンのアドレスへ移る。ターンの画面の「会話でこの返事を見る」は `#/talk?reply=<id>&before=<history_before>` に移り、会話がその返事を持っていなければ `GET /api/history?before=<history_before>` を読んで足し、その返事を画面に出す。そのページと今の会話のあいだのページは、上にスクロールすると読まれる。
- まだ見ていない失敗の数は、最初につなぐときとつなぎ直すときに `GET /api/record/unseen` を読み、その後は流れの `record` で直す。左のレールの「活動の記録」とスマートフォンのメニューのボタン（とメニューの中の「活動の記録」）に出す。活動の記録の場所にいるあいだは出さない。
- 活動の記録の場所を開くと `POST /api/record/seen` を 1 回送る。そこにいるあいだに数が 1 以上になったら（新しい失敗が来たら）、もう 1 回送り、返った `unseen` を知らせの件数に足す。「新しい」の札は、最初に送ったときの `previous_seen_at` より後の `failed_at` を持つ行に付ける。
- 一覧は、ブラウザの時間帯を `tz` に渡して今日を読み、下までスクロールしたら `before` の日を読む。行の無い日は出さない。流れがターンの始まりか終わり、サブエージェントを閉じたこと、`record` を送るたびに、今日をもう 1 回読んで置き換える。
- 畳みは 1 時間ごと（ブラウザの時間帯）で、失敗していないターンが 2 つ以上ある時間帯だけを畳む。畳んだ行はその時間の始まりの位置に置く。きっかけの種類ごとの数は、多い順に 3 つまでと「ほか n」。
- 1 件の画面のツールの結果は、開いたときに `GET /api/record/turns/<id>/results/<call_id>` を読む。`404` なら「この結果は残っていません。」を出す。閉じたサブエージェントのターンは、「残りの n 件を見る」で次のページを読む。

## 画像

返事に添えられた画像は、backend が返事を受けた時点で写したものである（[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)、[sandbox-api.md](sandbox-api.md) の「返事の画像」）。オーナーがメッセージに添えた画像も、backend がメッセージを受けた時点で同じように写す（[ADR-0034](adr/0034-images-the-owner-sends-copied-by-the-backend.md)）。

- 履歴（`agent` と `owner`）と流れの `reply` の `images` の 1 件は、`id`・`mime_type`（PNG・JPEG・GIF・WebP。中身の先頭の bytes から）・`size`（byte）・`name`（写した元のファイルの名前）を持つ。
- `GET /api/assets/<id>` は、その写しの中身を `mime_type` の型で返す。ログインしたオーナーのセッションだけが読める（ほかは `401`）。無い ID、読めない写しは `404`。GET のほかの method は `405`。
- 同じ ID の写しは変わらないので、`cache-control: private, max-age=31536000, immutable` を付ける。`x-content-type-options: nosniff` も付ける。
- Web UI は返事の文の下に縮小して並べ、押すと大きく見せる（[docs/design](design/README.md) の「返事の画像」）。オーナーの画像は吹き出しの上に並べる。送った直後はブラウザの持つファイルで出し、backend が受け付けたら応答の `images` の写しに替える。読み込み直した後と同じ見た目にするためである。
- 返事の知らせには画像を載せず、数だけを `images` に入れる（「知らせの中身」）。
- 写しの一覧の口はまだ無い。写しは返事と別の表に、種類・作った時刻・作ったエージェントとともに持つので（[backend.md](backend.md) の「作ったものの写し」）、作ったものの一覧の画面を作るときに `GET /api/assets` のような口を足せる。

## これから足すもの

- 作ったものの一覧の口と画面（[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)）。
- どの配置でも同じ形に保つ（[ADR-0026](adr/0026-move-natsumi-myao-and-aki-one-deployment-each-without-a-way-back.md)）。

## 承認（後の波）

形だけを置く。最初の版では作らない。

- `GET /api/approvals`: Sentinel の承認待ちの一覧。
- `POST /api/approvals/<id>`: 答える（「この 1 回」か「このホストをずっと」、または断る）。
- backend は Sentinel の管理口へ中継する（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。中身の形は、管理口の形とともに既定を ask に切り替えるときに決める。
