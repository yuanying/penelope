# backend の仕様

backend の設定、オーナーのログインのセッション、`/memory` のコミット、夜の切り替えでの backend の役目を決める。
ADR が「backend の仕様書」「backend の設定」に委ねた点はここに書く。
口の形は [events.md](events.md)（取り込み口）・[sandbox-api.md](sandbox-api.md)（sandbox 向けの口）・[ui-api.md](ui-api.md)（UI 向けの API）・[a2a.md](a2a.md)（A2A の受け口）にある。

## 動かし方

- `backend serve` で動く。image は引数なしでこれを動かす。`backend version` は版を出す。
- 設定は環境変数で渡す。鍵の値は環境変数に置かず、値を書いたファイルの場所を渡す（`_FILE` で終わる変数）。
- 設定に使えない値があれば、起動せずに終わる（終了コード 2）。
- SIGTERM で、待ち受けを閉じ、つながっている long-poll と流れを切ってから終わる。

## 設定

| 変数 | 既定 | 中身 |
| --- | --- | --- |
| `PENELOPE_DATABASE` | `/var/lib/penelope/backend.sqlite` | SQLite のファイル（永続） |
| `PENELOPE_ASSETS_DIR` | `PENELOPE_DATABASE` と同じディレクトリの `assets`（既定では `/var/lib/penelope/assets`） | エージェントが作ったものの写しの置き場（永続、下の「作ったものの写し」） |
| `PENELOPE_SOURCES_DIR` | `/sources` | `/sources` の場所。sandbox から見える場所と同じにする |
| `PENELOPE_MEMORY_DIR` | `/memory` | `/memory` の作業ツリー |
| `PENELOPE_INTAKE_SOCKET` | `/run/penelope/intake/backend.sock` | 取り込み口の Unix socket |
| `PENELOPE_SANDBOX_SOCKET` | `/run/penelope/sandbox/backend.sock` | sandbox 向けの口の Unix socket |
| `PENELOPE_LISTEN` | `0.0.0.0:8080` | UI 向けの API の TCP の待ち受け（`host:port`、IPv6 は `[::]:8080`） |
| `PENELOPE_PUBLIC_URL` | なし | オーナーが backend に届く URL（例: `https://penelope.example.com`）。OAuth の callback はこの下の `/auth/github/callback` |
| `PENELOPE_SANDBOX_TOKEN_FILE` | なし | sandbox 向けの口の本物の token。無ければ、sandbox 向けの口はすべて `401` |
| `PENELOPE_GITHUB_CLIENT_ID` | なし | OAuth App の client ID |
| `PENELOPE_GITHUB_CLIENT_SECRET_FILE` | なし | OAuth App の client secret |
| `PENELOPE_OWNER_GITHUB_ID` | なし | オーナーの GitHub の数値の user ID |
| `PENELOPE_TIME_ZONE` | `TZ`、それも無ければ `UTC` | 時間帯。`/sources` の日付、起きている時間、cron の式に使う |
| `PENELOPE_AWAKE_HOURS` | `07:00-23:00` | 起きている時間（`HH:MM-HH:MM`、始まりを含み終わりを含まない。日をまたいでよい。始まりと終わりが同じならいつも起きている） |
| `PENELOPE_NIGHTLY_CRON` | `0 4 * * *` | 夜の切り替えの時刻（5 欄の cron の式）。テスト用に、先頭に秒の欄を足した 6 欄も受ける（例: `*/20 * * * * *`） |
| `PENELOPE_BATCH_QUIET_MINUTES` | `5` | `batch` の N（最後の 1 件から待つ分） |
| `PENELOPE_BATCH_MAX_MINUTES` | `30` | `batch` の M（最初の 1 件から待つ最長の分） |
| `PENELOPE_REDELIVER_MINUTES` | `5` | 渡して ack の無い出来事をもう一度渡すまでの分 |
| `PENELOPE_HEARTBEAT_MINUTES` | なし | heartbeat の N（本体の最後のターンの終わりから待つ分）。無ければ heartbeat は無い（下の「heartbeat」） |
| `PENELOPE_HEARTBEAT_SECONDS` | なし | テスト用。heartbeat の N を秒で決める。`PENELOPE_HEARTBEAT_MINUTES` と一緒には置けない |
| `PENELOPE_DELIVERY_UI`・`_CRON`・`_A2A`・`_SELF`・`_JOB` | `now` | backend の中の受信元の `delivery` の既定 |
| `PENELOPE_INLINE_SOURCES` | `ui,job` | inline の受信元（`,` で区切る）。`control` は書かなくても常に inline。書くと既定を置き換えるので、裏の仕事の終わりを inline のままにするなら `job` も書く。Slack のプラグインの出来事を描いて載せる配置は、その `source` も書く（[events.md](events.md) の「Slack の出来事」） |
| `PENELOPE_GIT_AUTHOR_NAME` | `penelope-backend` | `/memory` のコミットの作者の名前 |
| `PENELOPE_GIT_AUTHOR_EMAIL` | `backend@penelope.invalid` | 同じくメールアドレス |
| `PENELOPE_AVATAR` | なし | UI に出すアバターの名前。`PENELOPE_AVATARS_DIR` の下の、この名前のディレクトリを読む（[ui-api.md](ui-api.md) の「エージェント」）。image に入っているのは `penelope`・`natsumi`・`myao`・`aki` |
| `PENELOPE_AVATARS_DIR` | `/app/avatars` | アバターの置き場所。image にはリポジトリの `assets/avatars/` が入っている。sandbox も同じ名前の 2 つの設定で、同じアバターの姿の素材を読む（[pod.md](pod.md) の「姿の素材」） |
| `PENELOPE_AGENT_NAME` | アバターの名前、それも無ければ `Agent` | UI に出すエージェントの名前。アバターの `avatar.json` の名前より優先する |
| `PENELOPE_WEB_DIR` | `/app/web` | Web UI の build の場所。image ではここに入っている |
| `PENELOPE_A2A_SENDERS` | なし | A2A の送り手の allow-list。ServiceAccount を `<名前空間>/<名前>` で `,` で区切る。無ければ A2A の受け口は閉じる |
| `PENELOPE_A2A_AUTH` | なし | 送り手の確かめ方。`gated-assertion`・`tokenreview` のどちらか、または両方を `,` で区切る |
| `PENELOPE_A2A_DESCRIPTION` | 空 | Agent Card の説明 |
| `PENELOPE_A2A_DEADLINE_HOURS` | `24` | 開いている Task が、送り手の最後のメッセージから `failed` になるまでの時間 |
| `PENELOPE_A2A_MAX_OPEN_TASKS` | `3` | 送り手ごとの開いている Task の上限 |
| `PENELOPE_A2A_GATED_ISSUER` | なし | `gated-assertion`: gated の発行元（`iss`） |
| `PENELOPE_A2A_GATED_JWKS_URL` | なし | `gated-assertion`: gated の鍵の JWKS の URL |
| `PENELOPE_A2A_AUDIENCES` | なし | `tokenreview`: 送り手の token に求める audience（`,` で区切る） |
| `PENELOPE_KUBERNETES_URL` | `https://<KUBERNETES_SERVICE_HOST>:<KUBERNETES_SERVICE_PORT>` | `tokenreview`: API server の URL |
| `PENELOPE_KUBERNETES_TOKEN_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | `tokenreview`: backend 自身の ServiceAccount の token。尋ねるたびに読み直す |
| `PENELOPE_WEB_PUSH_VAPID_KEY_FILE` | なし | Web Push の VAPID の秘密鍵（P-256、PEM）。無ければ Web Push は無い（[ui-api.md](ui-api.md) の「知らせ」） |
| `PENELOPE_KUBERNETES_CA_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | `tokenreview`: API server の証明書を確かめる CA |

- GitHub のログインは、`PENELOPE_GITHUB_CLIENT_ID`・`PENELOPE_GITHUB_CLIENT_SECRET_FILE`・`PENELOPE_OWNER_GITHUB_ID` の 3 つと `PENELOPE_PUBLIC_URL` が揃ったときだけ動く。3 つのどれも無ければ、ログインは無く、誰も入れない（[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md)）。一部だけあるときは、設定の誤りとして起動しない。
- 数は分の整数で、0 より大きいもの。
- A2A の受け口は、`PENELOPE_A2A_SENDERS` があるときだけ開く（[ADR-0018](adr/0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md)）。そのときは `PENELOPE_PUBLIC_URL`（Agent Card の URL と、`gated-assertion` の `aud` に使う）と `PENELOPE_A2A_AUTH` が要り、選んだ確かめ方に要るものがすべて要る。`gated-assertion` には発行元と JWKS の URL、`tokenreview` には audience と API server と、読める token のファイルと CA のファイル。欠けていれば起動しない。
- `tokenreview` に audience を必ず求めるのは、API server 自身の audience では、その ServiceAccount で動くどの Pod にも mount されている token が通ってしまうためである。
- `PENELOPE_A2A_SENDERS` が無ければ、ほかの `PENELOPE_A2A_*` は読まない。
- Web Push は `PENELOPE_WEB_PUSH_VAPID_KEY_FILE` があるときだけ動く（[ADR-0027](adr/0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md)）。そのときは `PENELOPE_PUBLIC_URL` が要る（VAPID の token の `sub`。Apple の push service に届くには https にする）。鍵が読めない、PEM の秘密鍵でない、P-256 でないときは起動しない。backend は鍵を作らない。
- VAPID の鍵は配置の Secret として長く保つ。鍵を替えると、それまでの購読には届かなくなる（Web UI は、次に開いたときに購読を作り直す）。作るには `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out vapid.pem`。
- アバターのディレクトリは `avatar.json` を持つ。`avatar.json` は、名前（`name`）と、表情ごとのアイコンの画像の場所（`icons`、ディレクトリからの相対の場所）を持つ。画像の拡張子は `.png`・`.jpg`・`.jpeg`・`.gif`・`.webp`・`.svg` のどれかで、ディレクトリの外は指せない。表情ごとの PNG の場所（`pngIcons`、拡張子は `.png`）も持てる。Slack の投稿のアイコンに使う（[ui-api.md](ui-api.md) の「エージェント」）。読めないとき、形が違うときは起動しない。
- `batch` の待ちは、N・M のほか、`now` の出来事を初めて渡すときにも終わる。そのとき待っている `batch` の出来事は、起きている時間の外でも、`now` の出来事と一緒に渡す（[events.md](events.md) の「いつ渡すか」）。

## 状態

- 状態は `PENELOPE_DATABASE` の SQLite の 1 つのファイルに置く（[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)）。待ち行列、会話の履歴、途中経過の記録、予約、セッションの切り替えの記録、ログインのセッション、A2A の Task、サブエージェントごとに runner が最後に知らせたもの（目的と閉じたか）、知らせの購読である。
- エージェントごとの今の状態（`thinking` か `waiting`）とその状態になった時刻は別に残さず、途中経過の記録の最後の `turn_start` か `turn_end` から引く（[sandbox-api.md](sandbox-api.md) の「途中経過」）。
- schema は migration の列で進める。版は `PRAGMA user_version` で、その数の migration が当たっている。migration は足すだけで、書き換えない。backend より新しい版のファイルは開かずに止まる。版 2 は A2A の Task、版 3 はサブエージェント（`sub_agents`）と、途中経過の記録から最後の `turn_start`・`turn_end` を引く索引、版 4 は知らせの購読（`push_subscriptions`。`endpoint` ごとに 1 行、種類と、その種類の鍵の JSON）、版 5 は作ったものの写し（`assets`）、版 6 はオーナーの画像の写し（`assets` を作り直して `agent` を空でもよくし、`reply_id` を `message_id` にした。履歴の `files`）である。
- 出来事・会話の履歴・途中経過・A2A の Task は消さない。いつまで残すかは、量が問題になったときに決める。
- `/sources` の保存期間による削除はまだ無い。

## 作ったものの写し

[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md) の「写しの置き場所」をここで決める。今あるのは返事の画像と、オーナーがメッセージに添えた画像（[ADR-0034](adr/0034-images-the-owner-sends-copied-by-the-backend.md)）である。

- 写しは `PENELOPE_ASSETS_DIR` の下の 1 つのファイル `<ID>.<拡張子>`（`png`・`jpg`・`gif`・`webp`）で、ID は UUID である。`/sources` とも `/memory` とも分ける。既定では SQLite と同じ永続の場所にあり、backend だけが mount する（[pod.md](pod.md) の「volume」）。
- ファイルは `<ID>.<拡張子>.part` に書いてから名前を変える。書きかけの写しは置き場の名前で見えない。
- SQLite の `assets` に 1 つの写しが 1 行で、ID・種類（`kind`、今は `image`）・MIME・大きさ・元のファイルの名前・置き場のファイルの名前・作ったエージェント（オーナーの画像は空）・作った時刻・結び付いた履歴の行（返事かオーナーのメッセージ。`message_id`）と、その行の中の順を持つ。行の順が作った順である。後で履歴の行に結び付かない写しを足せるよう、`message_id` は空でもよい。
- 返事の行と写しの行は 1 つの transaction で残す。オーナーのメッセージは、出来事の列への追加・履歴の行・写しの行を 1 つの transaction で残す。どちらも、写しのファイルを先に書き、transaction が失敗したら書いた写しのファイルを消す。
- オーナーのメッセージの、写さなかったファイルの名前と大きさは、履歴の行の `files` に JSON で持つ。
- 写しは消さない。会話の履歴と同じく、いつまで残すかは量が問題になったときに決める。

## オーナーのログイン

[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md) の「ログインのセッションの寿命と cookie の扱い」をここで決める。

- natsumi のブラウザのログインの形を写す。ログインの試みごとに 1 回限りの `state` と backend 自身の PKCE の verifier を作り、GitHub の答えのアカウントを数値の user ID でオーナーと照らす。GitHub の access token は user ID を読むのに 1 回使うだけで、残さない。
- ログインの試みはメモリにだけ置く。寿命は 10 分。backend が再起動すると、途中のログインはやり直しになる。
- セッションの token は 256 bit の乱数で、SQLite には SHA-256 だけを残す。
- セッションは最後に使ってから 30 日で終わる。使うたびに終わりを延ばす（前に延ばしてから 1 時間以内なら書かない）。
- cookie は `penelope_session` の 1 つで、`Path=/`・`HttpOnly`・`SameSite=Strict`。`PENELOPE_PUBLIC_URL` が https なら `Secure` も付ける。セッションを延ばすたびに cookie も付け直す。
- 使うたびに、セッションの GitHub の user ID が今の設定のオーナーと同じかを確かめる。設定のオーナーを変えると、前のセッションは通らなくなる。
- ログアウトはセッションを取り消し、cookie を消す。

## `/memory` のコミット

[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md) の「コミットの作者とメッセージの形」をここで決める。

- ターンの終わり（`POST /v1/turns/end`）ごとに、作業ツリーの変わったものをすべて（足したもの・変えたもの・消したもの）、検査せずにそのままコミットする。変わったものが無ければコミットしない。
- 作者とコミッターは `PENELOPE_GIT_AUTHOR_NAME` と `PENELOPE_GIT_AUTHOR_EMAIL`。
- メッセージは、1 行目が `Turn <turn_id>`、本文が `Agent: <agent>`。サブエージェントのターンの終わりでは `<agent>` はサブエージェントの名前で、本体のターンの途中の変更も一緒に入る（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)）。
- ターンの終わりに `.git/HEAD` が無ければ（`.git` が無い、または Pod が別に mount した空の `.git`）、変わったものを見る前に `git init` で `main` を枝にしてリポジトリを作る。変わったものが無くても作る。`HEAD` があれば、そのリポジトリと今の枝をそのまま使う。
- git は backend の git の設定を読まない。hook も署名も使わない。作業ツリーの持ち主は sandbox のユーザーなので、その場所を `safe.directory` として渡す。
- コミットは 1 つずつ順に行う。
- コミットに失敗したら、ターンの終わりに `500` で答える。変わったものは作業ツリーに残り、次のターンの終わりにコミットされる。

## 夜の切り替え

[ADR-0007](adr/0007-one-session-switched-nightly-with-a-one-turn-curator.md) と [sandbox-api.md](sandbox-api.md) の「セッションの切り替えの知らせ」の、backend の役目を決める。

- `PENELOPE_NIGHTLY_CRON` の時刻に、`source` が `control`、`id` が `nightly@<時刻>`、`payload` が `{kind: "nightly"}` の出来事を列に入れる。backend が止まっていて時刻を過ぎたものは、後から入れない。次の夜を待つ。
- 時刻は 15 秒ごとに確かめる。テスト用の秒の欄で夜どうしの間が 1 分より短いときは、1 秒ごとに確かめる。
- backend は切り替えの段を数えない。制御の出来事も、ほかの出来事と同じく、ack が無ければ `PENELOPE_REDELIVER_MINUTES` の後にもう一度渡すだけである。
- 切り替えの知らせ（`POST /v1/sessions/rotated`）は記録に残す。
- 切り替えの途中で runner が止まったときにどこからやり直すか、整理係のターンが失敗したときにどうするかは、runner が決める。

## heartbeat

[ADR-0031](adr/0031-a-heartbeat-event-after-quiet-minutes-in-awake-hours.md) の、backend が何もない時間に入れる出来事の細部を決める。形は [events.md](events.md) の「heartbeat の出来事」。

- `PENELOPE_HEARTBEAT_MINUTES`（テストでは `PENELOPE_HEARTBEAT_SECONDS`）があるときだけ動く。既定は無し（切ってある）。
- backend は 15 秒ごとに確かめ、次のすべてが揃えば heartbeat の出来事を 1 件入れる。遅れは最大で 15 秒である。N が 1 分より短いとき（テストだけ）は 1 秒ごとに確かめる。
  - 今が起きている時間（`PENELOPE_AWAKE_HOURS`）の中である。
  - 本体（`main`）が待っている。途中経過の記録の最後が `turn_end` か、まだ記録が無い（「状態」）。
  - その `turn_end` の時刻から N 分以上たっている。まだターンが無ければ、backend が立ち上がった時刻から数える。
  - 渡す時が来ていて ack の無い出来事が 1 つも無い。渡す前のもの、渡してターンがまだ終わっていないものの両方を含む。`batch` で待っている途中のものは数えない。
- 最後の条件で、次のときには入れない。
  - 前の heartbeat を runner がまだ取っていない、またはそのターンが終わっていない。heartbeat は積み重ならない。
  - オーナーのメッセージなど、ターンを始める出来事が渡るのを待っている。
  - 夜の切り替えの間。制御の出来事は、新しいセッションが始まってから ack されるので、振り返りと整理係のターンの合い間にも入らない。
- サブエージェントのターンは数えない。本体の記録だけを見る。
- heartbeat のターンが終わると、その `turn_end` からまた数える。何もない時間が続けば、N 分ごとに入る。
- 起きている時間の外で N 分を過ぎたときは、次に起きている時間が始まった最初の確かめで入る。夜の切り替えのターンの終わりから数えるので、N が夜の切り替えから朝までより短ければ、朝いちばんに入る。
- `/sources` に書けずに入れられなかったときは、次の 15 秒で入れ直す。

## 予約

- 予約は SQLite に置き、次に来る時刻を持つ。backend は 15 秒ごとに、時刻の来た予約を出来事にする。
- 出来事の `id` は `<予約の ID>@<時刻>`、`occurred_at` は予約の時刻である。
- cron の予約は、出来事にしたら次の時刻に進める。backend が止まっていて何回分かを過ぎたときも、出来事は 1 つだけにする。1 回の予約は、出来事にしたら消す。
- `/sources` に書けずに出来事にできなかった予約は、そのまま残し、次の 15 秒で入れ直す。
