# UI 向けの API の仕様

Web UI と iPhone アプリが backend を呼ぶ API を決める。方針は [ADR-0009](adr/0009-web-ui-first-with-a-new-api-and-astryx.md) と
[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md) にある。型は `packages/contract` の `src/ui.ts` が正である。

**この文書は、画面の一覧と流れをオーナーと合意した後に直す。** ここにあるのは、backend を先に作るための最小の形である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 認証

- Web UI は GitHub OAuth で作るセッションの cookie を、iPhone は `Authorization: Bearer <token>` を使う（[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md)・[ADR-0064](adr/0064-backend-issued-bearer-tokens-for-iphone.md)）。どちらも同じ GitHub OAuth App でオーナーの GitHub アカウントだけを通す。
- 認証が必要な `/api/…` では `Authorization` があれば Bearer だけを確かめる。形式違い、不明、期限切れ、失効済みの token は `401`。`Authorization` がないときは cookie を確かめ、無いか通らなければ `401`。失敗の応答の body は `{error}`。
- セッションの寿命、cookie と端末の資格の保存は [backend.md](backend.md) の「オーナーのログイン」にある。

| 口 | 中身 |
| --- | --- |
| `GET /auth/github/start` | GitHub へ送る（`302`）。ログインが設定されていなければ `503`（`login-not-configured`） |
| `GET /auth/github/callback` | GitHub から戻る共通の口。オーナーなら Web の要求には cookie を付けて `/` へ、iPhone の要求には code を付けてアプリへ送る（`302`）。そうでなければ `{error}` で断る |
| `POST /auth/logout` | セッションを取り消し、cookie を消す（`204`） |
| `GET /auth/app/start` | iPhone の PKCE challenge を受け、GitHub へ送る（`302`） |
| `POST /auth/app/token` | code と verifier を端末の token に引き換える（`200`） |

- ログインの断りの `error` は、`invalid-state`・`login-expired`・`invalid-request`（`400`）、`github-denied`・`account-not-allowed`（`403`）、`too-many-logins`（`429`）、`github-exchange-failed`・`github-unavailable`（`502`）、`login-not-configured`（`503`）。
- 戻る先は Web の場合は `/`、iPhone の場合は `penelope://auth` に固定する。URL で戻り先を指定する欄は無い。
- `GET /healthz` は認証なしで `200` を返す（配置の確かめのため）。
- `GET /api/agent` と `GET /api/agent/icons/<表情>` は認証なしで読める（「エージェント」）。ログインの画面とホーム画面のアイコンが、ログインの前にエージェントの名前とアイコンを出すためである。この 2 つにはそれ以外のものを載せない。
- `/.well-known/agent-card.json`、`/a2a`、`/a2a/` の下は A2A の道で、オーナーのログインは使わない。JSON-RPC の呼び出しは受け口が送り手を確かめる（[a2a.md](a2a.md)）。受け口が閉じていれば `404` で、Web UI のページにはならない。

### iPhone のログインと端末の失効

1. アプリは端末で PKCE の verifier を要求ごとに新しく生成する（43〜128 文字、`A–Z a–z 0–9 - . _ ~`。例: 32 バイトの乱数を padding なしの base64url にする）。UTF-8 の verifier の SHA-256 を padding なしの base64url にして challenge とする。
2. `ASWebAuthenticationSession` で配置の `GET /auth/app/start?code_challenge=<challenge>&code_challenge_method=S256` を開く。backend は既存の GitHub callback を使ってオーナーを確かめ、`penelope://auth?code=<code>` に戻す（Web の cookie は発行しない）。アプリの PKCE は backend と GitHub の間の PKCE とは別である。
3. 開始したのと同じ配置に JSON `{code, code_verifier, device_name}`（`AppTokenRequest`）を `POST /auth/app/token` で送る。端末名は前後の空白を取り、1〜100 Unicode 文字（制御文字なし）。成功は `200` と `{token, expires_at}`（`AppTokenResponse`）。時刻は RFC 3339（UTC）。code は発行から 5 分間で、正しい verifier で一度だけ引き換えられる。token は発行から 365 日間で、使っても延びない。
4. token を Keychain に保存し、発行元の HTTPS の UI 向け API にだけ Bearer として送る。URL に入れたり、別の配置や Safari に渡したりしない。失効・期限切れの後はログインし直す。

- このログインの 2 つの口は、`PENELOPE_PUBLIC_URL` が HTTPS でなければ `503`（`app-login-requires-https`）。challenge の形式や方式が違うと開始は `400`（`invalid-code-challenge`）。引き換えでは不正な body は `400`、不明・期限切れ・使用済みの code や verifier の不一致は `400`（`invalid-grant`）。失敗時に cookie に切り替えない。
- Web の設定は cookie で `GET /api/app/devices` を読み、有効な端末だけを発行の新しい順で受ける（`AppDevicesResponse`: `{devices: [{id, name, created_at, expires_at}]}`、`id` は UUID）。`DELETE /api/app/devices/<id>` はその端末を失効させる（既になくても `204`）。どちらも Bearer では `403`。
- アプリで配置を外す前は Bearer で `DELETE /api/app/devices/current` を送る。その token だけを失効させて `204` を返す。cookie だけでは `403`。サーバー側で失効したことを確認できなければ、端末内の資格は消した上で、Web の設定から失効できることを知らせる。
- Bearer で開いた会話と要約の SSE は、イベントや keepalive を送る前に token を確かめ、失効・期限切れなどで無効なら送らずに閉じる。Web のログアウトと端末の失効は互いに影響しない。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `POST /api/messages` | オーナーのメッセージを送る |
| `GET /api/history?before=` | 会話の履歴 |
| `POST /api/history/read` | 会話を指定したメッセージまで既読にする |
| `GET /api/stream` | 返事・途中経過・状態の流れ（SSE） |
| `GET /api/summary/stream` | 配置の要約の流れ（SSE） |
| `GET /api/agent`・`GET /api/agent/icons/<表情>[<拡張子>]` | エージェントの名前と表情のアイコン（認証なし） |
| `GET /api/agents` | 閉じていないサブエージェントの一覧 |
| `GET /api/status` | 眠りの状態、眠気、気分 |
| `GET /api/assets/<id>` | 返事とオーナーのメッセージに添えられた画像の写し |
| `GET /api/push`・`POST /api/push/subscriptions`・`POST /api/push/subscriptions/delete` | 返事の知らせ（Web Push）の鍵と、購読の登録と解除 |
| `GET /api/schedules`・`DELETE /api/schedules/<id>` | エージェントの予約の一覧と取り消し |
| `GET /api/settings`・`PUT /api/settings` | モデルと思考の深さの設定 |
| `GET /api/app/devices`・`DELETE /api/app/devices/<id>` | iPhone の端末の一覧と失効（Web の cookie） |
| `DELETE /api/app/devices/current` | 呼び出した iPhone の端末の失効（Bearer） |
| `PUT /api/app/push`・`DELETE /api/app/push` | 呼び出した iPhone の APNs 登録・解除（Bearer） |
| `GET /api/record`・`GET /api/record/<種類>/<id>`・`GET /api/record/unseen`・`POST /api/record/seen` | 活動の記録（「活動の記録」） |
| `GET /api/memory` および `/api/memory/…` | コミット済みの記憶の閲覧（「記憶」） |
| `POST /api/memory/save` | 既存の記憶ファイル 1 つの保存（「保存と復元」） |
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

### 会話の既読

- `POST /api/history/read` の JSON は `{"through": "<履歴の id>"}`（型は `ReadHistoryRequest`）。オーナーの発言でもエージェントの返事でもよい。指定した行まで（その行も含む）に保存された返事を既読にし、`204` を返す。不正な body は `400`、存在しない ID は `404`。
- 既読は配置のオーナーで 1 つ。古い位置を伝え直しても戻らず、指定した行の後に届いた返事は未読のまま。時刻が同じ発言も、backend に保存された順で区別する。履歴を読むだけでは既読にならない。
- Web は会話が開いていてタブが見えているときに、表示した会話の位置を伝える。活動の記録の「見た」は別で、会話の既読で失敗の数は消えない。

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
- Web UI は、最初につなぐときも、つなぎ直すときも `Last-Event-ID: 0` を付け、覚えている分をすべて受け取り直す。今の状態と今のターンの途中経過を、その中の最後の `state` と最後の `turn_start` から後で知るためである（下の要約の流れに途中経過は含まれない）。backend の再起動で連番が戻っても、これなら取りこぼさない。返事は `id` で履歴と重ねる。
- 25 秒ごとに SSE のコメントを送り、つながりを保つ。

未決:

- オーナー自身のメッセージを流れにも送るか（複数のタブで見ているとき）。今は送らない（`StreamEvent` にオーナーのメッセージの形が無い）。

## 要約の流れ（SSE）

`GET /api/summary/stream` は [ADR-0066](adr/0066-agent-summary-stream-and-shared-unread.md) の配置一覧向けの SSE。会話の一部を含むので、他の非公開 UI API と同じくオーナーの認証が必要。接続直後に現在の要約を 1 件送り、その後は欄が変わったときだけ要約全体を送る。イベント名は `summary`、JSON の `data` は `AgentSummary`。

| 欄 | 中身 |
| --- | --- |
| `state` | 本体の状態（下記） |
| `last_message` | 最後に保存された発言の `{kind, at, text}`。発言が無いときは `null`。履歴と同じく `kind` は `owner` または `agent`、`at` は RFC 3339。本文が無い発言の `text` は空文字 |
| `unread` | オーナーがまだ読んでいない返事の数。オーナーの発言は数えない |
| `unseen_failures` | `GET /api/record/unseen` の `unseen` と同じ数（「まだ見ていない失敗と『見た』」） |

- `state` は `{kind: "waiting"}`（出来事を待つ）、`{kind: "thinking"}`（ターン中）、`{kind: "tool", tool: "..."}`（ターン中で、結果がまだ届いていない最後のツール）。ツールの表示は名前と、分かる場合はコマンド・パターン・パスなどの先頭だけ。
- `{kind: "approval", pending: 1}` は「止まって承認を待っている」状態と承認の件数を表す予約形。現行 backend は待機・思考・ツール使用の 3 状態だけを配信する。承認待ちの配信は Sentinel の承認機能の実装後に行う。
- 発言とツールの表示には先頭の 1 行を使い、200 文字を超えたら `…` を付けて切る。思考の本文やツールの結果、添付は送らない。
- 要約に SSE の `id` は付けず、`Last-Event-ID` は使わない。再接続では途中の変化を再生せず、その時点の要約から始める。接続中は 25 秒ごとにコメントを送る。

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

エージェントの返事（`reply`）は、すべてオーナーの購読に知らせる（[ADR-0027](adr/0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md)）。送り先は Web Push と iPhone アプリの APNs（[ADR-0065](adr/0065-encrypted-reply-notifications-over-apns.md)）。オーナー自身のメッセージ、途中経過、A2A の Task への返事、失敗や承認待ちは知らせない。

### Web Push の購読

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

### ホーム画面に追加した Web アプリで受けるには

iOS・iPadOS 16.4 から、ホーム画面に置いた Web アプリが Web Push を受けられる。Safari のタブのままでは受けられない。

1. Safari で配置の URL を開き、ログインする。
2. 共有ボタンから「ホーム画面に追加」を選ぶ。
3. ホーム画面のアイコンから開き、もう一度ログインする（ホーム画面の Web アプリは Safari と cookie を分けて持つ）。
4. メニューを開いて「通知を受ける」を押し、通知を許す。

止めるときは、メニューの「通知を止める」か、iPhone の「設定」の「通知」でそのアプリを止める。配置ごと（エージェントごと）に、この手順で購読する。

### iPhone アプリの APNs 登録

- `PUT /api/app/push` は `{token, environment, public_key}`（型は `ApnsRegistrationRequest`）。`token` は APNs の device token を 16 進で表した文字列（1〜256 バイト、小文字に正規化）、`environment` は `sandbox` または `production`（TestFlight は `production`）、`public_key` は P-256 の曲線上の非圧縮 X9.63 公開鍵（65 バイト、詰め物付きの標準 base64）。不正な登録には `400`（`invalid-apns-registration`）。
- `PUT` は呼び出した端末の登録を置き換える。アプリの再インストールなどで別の端末資格から同じ environment・token を登録したときは新しい方を使う。`DELETE /api/app/push` はその端末の通知登録だけを消し、Bearer token は失効させない。どちらも成功時は `204`（解除は登録が無くても `204`）。
- HTTPS の配置で、有効なアプリ用 Bearer token に限る。Web の cookie だけなら `403`、認証できなければ `401`。APNs の送信設定が無くても登録・解除はできる。アプリから配置を外すときは `DELETE /api/app/devices/current` で端末の資格ごと消す。

### APNs の中身

- `ApnsReplyPayload` は `{aps, messageId, kind: "reply", e}`。`messageId` は返事の履歴の `id`、`aps` は `mutable-content: 1`、`sound: "default"` と `alert: {title, body}` を持つ。題はエージェントの名前、本文は固定の「返事があります」。復号できなければこの汎用通知のまま表示する。
- `e` は natsumi ADR 0029 と同じ `{v: 1, epk, nonce, ct}`。`epk` は送信ごとの一時 P-256 公開鍵（非圧縮 X9.63）。ECDH の共有秘密から HKDF-SHA256（salt は `epk ‖ 端末公開鍵` の生バイト、info は ASCII の `natsumi-push-v1`、出力は 32 バイト）で AES-256-GCM の鍵を導く。AAD は `messageId` の UTF-8、`nonce` は 12 バイトの乱数、`ct` は暗号文に 16 バイトの認証タグを連結したもの。`epk`・`nonce`・`ct` は詰め物付きの標準 base64。
- 平文（型は `ApnsReplyPreview`）は `{text, expression?, images?, url}`。Web Push と同じ返事の冒頭・表情・画像数を使い、通知から会話を開くための配置の HTTPS URL も暗号化の内側に置く。natsumi の `position` やバッジは送らず、未読は backend の要約の流れで共有する。APNs 全体の上限（4096 バイト）に収まらないときは `text` をさらに短くし、それでも収まらなければ送らない。

## Web UI の配り方

- API・ログイン・ヘルスチェック・A2A の道以外では、backend が `PENELOPE_WEB_DIR` にある Web UI の build（`packages/web` の `dist/`）を配る。`/` は `index.html` である。無いファイルは `404`。
- `/manifest.webmanifest` は backend がその場で作る。名前はエージェントの名前、アイコンはアバターの `neutral` の画像（無ければ build の `icon.svg`）である。ホーム画面に置いて開くため（PWA）。
- `assets/` の下のファイルは中身で名前が決まるので、長く cache させる。ほかは毎回確かめさせる。

## 本体の状態

`GET /api/status` は、オーナーの cookie または iPhone の Bearer token で認証する。現在の眠りの状態、眠気と元の事実、気分を `200` と [`AgentStatus`](sandbox-api.md#本体の状態) で返す。キャッシュはしない。

`mood` は本体が決めたプレーンテキストで、未設定なら `null`。返事の `expression` とは別の欄である。

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
- 失敗の行は `failed_at`（backend が失敗とした時刻）を持つ。眠れなかった眠りも日ごとの `failures` とまだ見ていない失敗の `unseen` に数える。

### 一覧

`GET /api/record?day=&tz=&failed=&agent=&kind=` は 1 日分の行を返す（型は `RecordDayResponse`）。

| 引数 | 中身 |
| --- | --- |
| `day` | `YYYY-MM-DD`。省くと `tz` での今日 |
| `tz` | 日を区切る時間帯（IANA の名前、例 `Asia/Tokyo`）。省くと backend の `PENELOPE_TIME_ZONE`。Web UI はブラウザの時間帯を渡す（予約の一覧と同じく、日付はブラウザの時間帯で書くため） |
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

- `GET /api/record/turns/<id>` は `{turn, flow, expired, replies}`（型は `RecordTurnResponse`）。
  - `turn` は一覧の行と同じ形。
  - `flow` は、そのターンの途中経過を順に並べたもの（`turn_start` と `turn_end` は除く）。形は sandbox 向けの口の途中経過の 1 件と同じだが、`tool_result` だけは `output` の代わりに大きさ（`lines` 行・`bytes` バイト、UTF-8）を持つ（型は `RecordFlowItem`）。結果の本文は開いたときに下の口で読む。
  - `expired` は、30 日を過ぎて流れが消えたとき `true`（そのとき `flow` は空）。
  - `replies` は、そのターンで出した返事の `{id, at, text, history_before}`（型は `RecordReply`）の並び。`history_before` は `GET /api/history?before=` に渡すと、その返事から始まるページが返る値である。Web UI は「会話でこの返事を見る」で、会話を開いてそのページを読み、`id` の返事の位置へ移る。
- `GET /api/record/turns/<id>/results/<call_id>` は `{output}`（型は `RecordResultResponse`）。そのツールの結果の本文の全部（runner が切った 16,000 文字まで）。流れが消えたもの、無いものは `404`。
- `GET /api/record/nights/<id>` は `{night, turns}`（型は `RecordNightResponse`）。`turns` は `{reflection?, verifier?, curator?, content?, structure?}`（一覧の `turn` の行と同じ形）。通常はその段の最後のターン、棚卸しでは `content`・`structure` に報告された各ターンを返し、`curator` は旧 UI 向けにうち最後のものを返す。
- `GET /api/record/sub-agents/<name>?before=` は `{sub_agent, turns, before?}`（型は `RecordSubAgentResponse`）。`sub_agent` は一覧の行と同じ形（閉じていなければ `closed_at` が無い）。`turns` はそのサブエージェントのターンの新しい順で、1 ページ 20 件。`before` は次のページの不透明な cursor で、最後のページには無い。backend の渡していない `before` は `400`。
- 記憶の変更が辿れるときだけ、ターンの詳細に `memory_change`（`MemoryChange`）を、夜の詳細に `memory_changes`（`MemoryChange[]`、コミット順）を加える。後者は参照の修正を含む。リンク先は `GET /api/memory/changes/<id>`（下の「記憶」）。
- 無い `id`・名前は `404`。どの口も GET のほかの method は `405`。

### まだ見ていない失敗と「見た」

- backend は、オーナーが活動の記録の画面を開いた時刻を 1 つ覚える（配置のオーナーごと。ブラウザごとではない）。まだ一度も開いていなければ、記録が始まった時刻を使う。
- **まだ見ていない失敗の数** は、その時刻より後の `failed_at` を持つ失敗の数である。
- `GET /api/record/unseen` は `{unseen}`（型は `RecordUnseenResponse`）。Web UI は、最初につなぐときとつなぎ直すときにこれを読み、左のレールとメニューの札にする。
- 数が変わると、流れで `record`（`{unseen}`）を送る。backend は記録が失敗を受けたとき、オーナーが開いたとき、15 秒ごと（切り替えの知らせが来ないまま期限が過ぎる場合があるため）に数え直し、前に送った数と違えば送る。
- `POST /api/record/seen` は、今を開いた時刻として覚え、`{unseen, previous_seen_at}`（型は `RecordSeenResponse`）を返す。`unseen` は覚える前のまだ見ていない数、`previous_seen_at` は前に開いた時刻（初めてなら記録が始まった時刻）。Web UI は、活動の記録の画面を開いたときに 1 回送り、`unseen` が 1 以上なら「前に見たあとの失敗が n 件あります」を出し、`failed_at` が `previous_seen_at` より後の行に「新しい」の札を付ける。札は画面を離れるまで残す。

### Web UI の活動の記録

- 左の「場所」の「活動の記録」に置く。見た目は [docs/design](design/README.md) の 15 章。PC もスマートフォンも同じ中身で、幅は会話と同じく 720px までで中央に寄せる。
- 一覧と 1 件の画面はアドレスを持つ。backend は `/` のほかの道で Web UI を返さないので（「Web UI の配り方」）、アドレスは # の後ろに置く（`#/record`、`#/record/turns/<id>`、`#/record/nights/<id>`、`#/record/sub-agents/<名前>`）。ほかの場所も `#/talk` などのアドレスを持つ。
- 会話の返事は、`turn_id` を持てば、時刻をリンクにし、そのターンのアドレスへ移る。ターンの画面の「会話でこの返事を見る」は `#/talk?reply=<id>&before=<history_before>` に移り、会話がその返事を持っていなければ `GET /api/history?before=<history_before>` を読んで足し、その返事を画面に出す。そのページと今の会話のあいだのページは、上にスクロールすると読まれる。
- まだ見ていない失敗の数は、最初につなぐときとつなぎ直すときに `GET /api/record/unseen` を読み、その後は流れの `record` で直す。左のレールの「活動の記録」とスマートフォンのメニューのボタン（とメニューの中の「活動の記録」）に出す。活動の記録の場所にいるあいだは出さない。
- 活動の記録の場所を開くと `POST /api/record/seen` を 1 回送る。そこにいるあいだに数が 1 以上になったら（新しい失敗が来たら）、もう 1 回送り、返った `unseen` を知らせの件数に足す。「新しい」の札は、最初に送ったときの `previous_seen_at` より後の `failed_at` を持つ行に付ける。
- 一覧は、ブラウザの時間帯を `tz` に渡して今日を読み、下までスクロールしたら `before` の日を読む。行の無い日は出さない。流れがターンの始まりか終わり、サブエージェントを閉じたこと、`record` を送るたびに、今日をもう 1 回読んで置き換える。
- 夜の一覧行と 1 件の画面では、段の結果の横に記憶の変更量を出す。変更が 0 なら「記憶の変更なし」、計測されていなければ「記憶の変更は不明」、振り返りで `handoff_changed` が `false` なら「引き継ぎ未更新」と出す。行われなかった段と新しいセッションには変更量を出さない。毎回読む層の超過と照合対象外の件数は、夜の行と 1 件の画面に注意事項として出す。棚卸しでは一覧でも「棚卸し」と示し、詳細では整理係の下に中身・構成それぞれの成否、理由、変更量とターンへのリンク（ターンがあるとき）を出す。整理係全体の変更量を別に表示しない。
- 畳みは 1 時間ごと（ブラウザの時間帯）で、失敗していないターンが 2 つ以上ある時間帯だけを畳む。畳んだ行はその時間の始まりの位置に置く。きっかけの種類ごとの数は、多い順に 3 つまでと「ほか n」。
- 1 件の画面のツールの結果は、開いたときに `GET /api/record/turns/<id>/results/<call_id>` を読む。`404` なら「この結果は残っていません。」を出す。閉じたサブエージェントのターンは、「残りの n 件を見る」で次のページを読む。

## 画像

返事に添えられた画像は、backend が返事を受けた時点で写したものである（[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)、[sandbox-api.md](sandbox-api.md) の「返事の画像」）。オーナーがメッセージに添えた画像も、backend がメッセージを受けた時点で同じように写す（[ADR-0034](adr/0034-images-the-owner-sends-copied-by-the-backend.md)）。

- 履歴（`agent` と `owner`）と流れの `reply` の `images` の 1 件は、`id`・`mime_type`（PNG・JPEG・GIF・WebP。中身の先頭の bytes から）・`size`（byte）・`name`（写した元のファイルの名前）を持つ。
- `GET /api/assets/<id>` は、その写しの中身を `mime_type` の型で返す。オーナーの cookie または Bearer で読める（ほかは `401`）。無い ID、読めない写しは `404`。GET のほかの method は `405`。
- 同じ ID の写しは変わらないので、`cache-control: private, max-age=31536000, immutable` を付ける。`x-content-type-options: nosniff` も付ける。
- Web UI は返事の文の下に縮小して並べ、押すと大きく見せる（[docs/design](design/README.md) の「返事の画像」）。オーナーの画像は吹き出しの上に並べる。送った直後はブラウザの持つファイルで出し、backend が受け付けたら応答の `images` の写しに替える。読み込み直した後と同じ見た目にするためである。
- 返事の知らせには画像を載せず、数だけを `images` に入れる（「知らせの中身」）。
- 写しの一覧の口はまだ無い。写しは返事と別の表に、種類・作った時刻・作ったエージェントとともに持つので（[backend.md](backend.md) の「作ったものの写し」）、作ったものの一覧の画面を作るときに `GET /api/assets` のような口を足せる。

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

## 承認（後の波）

形だけを置く。最初の版では作らない。

- `GET /api/approvals`: Sentinel の承認待ちの一覧。
- `POST /api/approvals/<id>`: 答える（「この 1 回」か「このホストをずっと」、または断る）。
- backend は Sentinel の管理口へ中継する（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。中身の形は、管理口の形とともに既定を ask に切り替えるときに決める。
