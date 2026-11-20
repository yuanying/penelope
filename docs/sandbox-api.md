# sandbox 向けの口の仕様

sandbox の中の runner と道具が backend を呼ぶ口を決める。方針は
[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)・[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)・[ADR-0007](adr/0007-one-session-switched-nightly-with-a-one-turn-curator.md)・[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md)・[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)・[ADR-0030](adr/0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)・[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md) にある。
型は `packages/contract` の `src/sandbox.ts` が正である。サブエージェントの名前の形を確かめる関数は `src/agents.ts` にあり、runner と backend が同じものを使う。出来事の封筒と `/sources` は [events.md](events.md) にある。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 道と認証

- sandbox からは、backend の内部の名前（例: `https://backend.example.com`。実際の名前は配置のリポジトリの設定）の HTTPS で呼ぶ。ほかの外向きと同じく Sentinel を通る（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。Sentinel はこの名前の登録の上流として、backend が sandbox 向けの口を待ち受ける Unix socket につなぐ。backend はこの口を TCP では待ち受けない（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)、[pod.md](pod.md)）。
- 要求は `Authorization: Bearer <サロゲート>` を持つ。Sentinel がそのサロゲートを backend の本物の token に差し替える（[sentinel-config.md](sentinel-config.md)）。backend は本物の token だけを受け、ほかは `401` で断る。
- 要求と応答の body は JSON。失敗の応答の body は `{error}`。

### `agent` の欄

- **すべての要求が、呼んでいるエージェントの ID を `agent` に持つ。** POST は body の欄、GET と DELETE は query の `agent`。
- 本体は `main`。サブエージェントは、本体が `subagent_start` で付けた名前である。
- サブエージェントの名前は、英小文字・数字・`-` からなり、英小文字か数字で始まる 63 文字までのもので、`main` ではない。`/sources/self/<名前>/` と、作業の場所の既定 `~/agents/<名前>/` にそのまま使うためである。runner は、形の違う名前と、閉じたサブエージェントも含めて前のサブエージェントと重なる名前を断る。
- 形は contract の `SUB_AGENT_NAME`（正規表現）と `isSubAgentName` が決める。backend は、どの口でも、`agent` が `main` でもこの形の名前でもなければ `400` で断る。
- 同じ UID で動くエージェントを、backend と UI が見分けるための欄である。確かめはしない（sandbox の中の名乗り）。

- サブエージェントは出来事を取らない。本体からサブエージェントへの頼みは runner の中で直接渡り、backend はサブエージェントの列を持たない（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)）。`agent` が `main` でない `GET /v1/events` は `400` で断る。
- サブエージェントには返事・A2A の返事・予約・裏の仕事の道具が無い。`agent` が `main` でない `POST /v1/replies`・`POST /v1/a2a/replies`・`POST /v1/job-events`・予約の口（`GET`・`POST`・`DELETE`）は `400` で断る。取り違えを防ぐためで、守りではない。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `GET /v1/events?agent=&after=&wait=` | 出来事を取る（long-poll） |
| `PUT /v1/model-settings` | runner のモデル候補を知らせ、オーナーの設定を読む |
| `POST /v1/events/ack` | 済んだ出来事を知らせる |
| `POST /v1/self-events` | 自分宛ての出来事を入れる |
| `POST /v1/job-events` | 裏の仕事の終わりを入れる |
| `POST /v1/replies` | オーナーへの返事（画像を添えられる） |
| `POST /v1/a2a/replies` | A2A の Task に返す |
| `POST /v1/activity` | 途中経過 |
| `POST /v1/turns/end` | ターンの終わり |
| `POST /v1/agents` | サブエージェントの状態（起こした・閉じた） |
| `GET /v1/schedules?agent=`・`POST /v1/schedules`・`DELETE /v1/schedules/<id>?agent=` | 予約 |
| `POST /v1/sessions/rotated` | セッションの切り替えの知らせ |

## 出来事を取る

- `after` より後の `seq` で、まだ済んでいない出来事を、`seq` の順に返す。無ければ `wait` 秒まで待ち、それでも無ければ空の一覧を返す。
- 返したものは「渡した」になる。渡したまま一定時間 ack の無いものは、次の poll でもう一度渡す。
- 返すのは、渡す時が来たものだけである。`batch` の待ちと起きている時間は backend が数える（[events.md](events.md) の「いつ渡すか」）。runner は受け取った分をターンに入れるだけである。ターンに入る形（`<events>` の 1 行 1 件の JSON）は [events.md](events.md) の「ターンに入る形」にある。
- ack の無いままもう一度渡す出来事は、`seq` が `after` 以下でも返す。runner は再起動の後、`after` を省いて（0 として）取り直す。
- まだ一度も渡していない出来事も、`seq` が `after` 以下でも返す。`batch` の出来事は、後に来た `now` の出来事より後に渡ることがあり、そのとき `seq` は runner が受け取った最大の `seq` より小さい。
- 一定時間は backend の設定で、既定は 5 分（[backend.md](backend.md) の `PENELOPE_REDELIVER_MINUTES`）。ターンがそれより長く続くと、そのターンに入れたまま ack していない出来事も、もう一度渡る。
- `wait` の上限は 60 秒で、それより長い値は 60 秒として扱う。一度に返すのは 100 件まで。
- 応答は `{events: [...]}`。1 件ごとに `seq`・`source`・`id`・`stream`・`occurred_at`・`received_at`・`summary`・`delivery`・足された場所（`appended`: `path` と `lines` の 1 始まり・両端を含む範囲）・添付（`attachments`）を持つ。inline の出来事だけが `inline: true` と `payload` を持つ。
- `occurred_at` は全受信元について、同じ瞬間を backend の `PENELOPE_TIME_ZONE`（[backend.md](backend.md) の「設定」）で表した RFC 3339 で返す。UTC オフセット（UTC なら `+00:00`）は発生時点のものを使う。たとえば `Asia/Tokyo` では `2026-11-18T23:00:00Z` は `2026-11-19T08:00:00+09:00` になる。変換できない保存済みの値はそのまま返す。SQLite と `/sources` に保存した値や `received_at` は変えない。
- `attachments` の 1 件は、`/sources` に置いた場所（`path`）、MIME（`mime_type`）、大きさ（`size`、byte）を持つ。添付が無ければ欄ごと省く。`/sources` の行の `attachments` は、場所だけの一覧のままである（[events.md](events.md)）。
- `mime_type` は、PNG・JPEG・GIF・WebP なら中身の先頭の bytes から決める。ほかは送り手が付けた Content-Type で、それも無いか形が違えば `application/octet-stream`。送り手が画像の型を付けても、中身がその画像でなければ `application/octet-stream` にする。画像だと言われたものが画像であるようにするためである。
- runner はターンの最中も取り続ける。`now` の出来事をターンの途中に steer で入れるためである。
- runner は、扱っている最中か扱い済みの `seq` がもう一度渡されたら捨てる。重複は `after` ではなく `seq` で見る。ターンが失敗して ack しなかった出来事だけは、もう一度渡されたら取り直す。

## 済んだ出来事を知らせる

- body は `{agent, seqs}`。runner は、出来事をターンに入れ、そのターンが終わってから ack する。制御の出来事は、手順が終わってから ack する。
- 知らない `seq`・既に済んだ `seq` は無視する。

## 自分宛ての出来事

- body は `{agent, id, summary, payload}`。backend は `source` が `self` の出来事として列に入れる（取り込み口と同じ処理）。`delivery` は backend の設定（既定 `now`）。
- サブエージェントが終わったことの知らせや、自分の作業の区切りに使う。取り込み口は Unix socket で sandbox から見えないため、この口を置く。
- `id` は呼び手が付ける。同じ `id` は重複として落ちる。
- `agent` が `main` でなければ、backend はその名前を出来事の `stream` にする。中身は `/sources/self/<名前>/<日付>.jsonl` に入る。`main` なら `stream` は無い。
- 応答は `202` で、body は無い（取り込み口と同じ）。

### サブエージェントの知らせ

サブエージェントが止まるたびに、runner が `agent` をサブエージェントの名前にして送る（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) の「サブエージェントから本体へは、自分宛ての出来事」）。

- `id` は `<サブエージェントの名前>/<番号>`。番号は、そのサブエージェントが止まった回を 1 から数えたもので、runner がサブエージェントの記録に残す。送り直すときは同じ `id` を使う。
- `payload` は `{reason, purpose, text}`（型は `SubAgentNotice`）。
  - `reason`: `stopped`（最後の地の文を返して止まった。結果か問いかは `text` が言う）、`failed`（実行が失敗した。`text` は失敗の中身）、`interrupted`（runner が止まって、走っていた実行が切れた。`text` は空）。
  - `purpose`: 起こしたときの目的。
  - `text`: 最後の地の文の全文。地の文が無ければ空。
- `summary` は `text` の 1 行目（200 文字まで）。`text` が空なら `reason`。
- どの理由でも、知らせの後のサブエージェントは止まって待っている状態で、`subagent_send` で続きを送れる。

### サブエージェントの記録（runner）

runner は、サブエージェントごとに `<Pi のディレクトリ>/sessions/agents/<名前>/` を作り（`PENELOPE_SUB_AGENTS` で場所を変えられる）、そこに記録 `agent.json` とセッションの記録のファイルを置く（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) の「サブエージェントの寿命は、本体が閉じるまで」）。HOME の下なので永続する。

- `agent.json` は、名前・目的・作業の場所・役割（選んだときだけ）・セッションの記録のファイル・状態（`running`・`waiting`・`closed`）・止まった回の数・走っている実行のターンの `turn_id`・backend がまだ受けていない知らせの並びを持つ。
- 閉じても、ディレクトリと作業の場所は消さない。名前が前のサブエージェントと重なるかは、このディレクトリがあるかで決める。
- 止まったら、知らせを記録に足してから送る。backend が受けたら（`202`）記録から外す。受けなければ同じ `id` で送り直す（1 秒から倍にして 30 秒まで間を空ける）。runner が止まって送れなかった知らせは、次に立ち上がったときに記録から送る。
- runner が立ち上がったら、閉じていないサブエージェントのすべてについて状態を送る（「サブエージェントの状態」）。記録で走っていたものは、止まった回を 1 つ進めて止まって待っている状態にし、切れたターンの `turn_end` の途中経過とターンの終わりを送ってから、`interrupted` の知らせを送る。セッションは、次に続きを送られたときに記録のファイルから開き直す。
- サブエージェントのシステムプロンプトは、セッションを開くたびに作る。役割のファイルは、起こすときと、立ち上がり直した後に初めて続きを送るときに読む。

### サブエージェントを扱うツール（runner）

本体のセッションにだけ渡す。引数と説明の文は `packages/runner/src/tools.ts` が正である。断るときは、理由の文をツールのエラーとして返す。

| ツール | 断るとき |
| --- | --- |
| `subagent_start` | 名前の形が違う。閉じたものも含めて前のサブエージェントと名前が重なる。作業の場所が無いか、ディレクトリでない。役割の名前がファイルの名前でない（`/` や `..` を含むなど）。役割のファイル `/memory/agents/<役割>.md` が無い・読めない・front matter に `name` と `description` が無い・上限（`PENELOPE_PROMPT_FILE_MAX_BYTES`）より大きい |
| `subagent_send` | その名前のサブエージェントがいない・閉じている・走っている |
| `subagent_close` | その名前のサブエージェントがいない・閉じている |

- `subagent_start` は、作業の場所を省けば `~/agents/<名前>/` を作る。相対の作業の場所は HOME から引く。`default.md` が無い・読めないときは、固定の文だけで起こし、そのことを結果の文に添える。
- `subagent_start` と `subagent_send` は、実行を始めたところで返る。
- `subagent_list` は、閉じていないサブエージェントの `name`・`state`（`running` か `waiting`）・`purpose`・`cwd` の JSON の配列を返す。
- `subagent_close` は、走っていれば実行を取り消してから閉じる。取り消した実行の知らせは送らない（ターンの終わりは送る）。

## 裏の仕事の終わり

本体が裏で動かしたコマンドが終わるたびに、runner が送る（[ADR-0030](adr/0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)）。

- body は `{agent, id, summary, payload}`（型は `JobEventRequest`）。backend は `source` が `job` の出来事として列に入れる。`stream` は無い。`delivery` は backend の設定（既定 `now`）、inline も backend の設定で、既定では inline である（[events.md](events.md) の「裏の仕事の終わり」）。
- 受信元を `self` と分けるのは、inline を受信元ごとに選ぶためである。サブエージェントの知らせは要約と場所のまま、裏の仕事の終わりは中身ごとターンに入る。
- `agent` は `main` だけ。ほかは `400`。`id`（空でない文字列）・`summary`（文字列）・`payload` が無ければ `400`。
- `id` は裏の仕事の ID。1 つの仕事の終わりは 1 件なので、送り直しても同じ `id` で、重複として落ちる。応答は `202` で、body は無い。
- backend は、出来事のほかに、活動の記録の 1 行（[ui-api.md](ui-api.md) の「活動の記録」）を残す。`payload` が下の表の形でなければ記録には残さないが、出来事としては受ける。
- `payload` は次の欄を持つ（型は `JobEnd`）。

| 欄 | 中身 |
| --- | --- |
| `job` | 裏の仕事の ID |
| `command`・`cwd` | コマンドと作業の場所 |
| `end` | 終わり方。`exited`（自分で終わった）・`signaled`（runner の送ったのでないシグナルで終わった）・`stopped`（`job_stop` で止めた）・`timed-out`（長さの上限で止めた）・`interrupted`（runner が立ち上がり直したときに走っていた） |
| `exit_code` | 終わりの code。プロセスが code で終わったときだけ |
| `signal` | 終わらせたシグナルの名前（`SIGTERM` など）。`signaled` のとき、`stopped`・`timed-out` では runner が最後に送ったシグナル |
| `started_at`・`ended_at` | 始まりと終わり（RFC 3339）。`interrupted` の `ended_at` は、runner が切れたのを見つけた時刻 |
| `seconds` | 始まりから終わりまでの秒（整数） |
| `output`・`output_bytes` | 出力のファイルの場所と大きさ（byte） |
| `tail`・`tail_truncated` | 出力の末尾（上限の字数まで）と、出力がそれより長いか |

### 裏の仕事（runner）

runner は、本体のセッションにだけ、裏の仕事を扱う 3 つのツールを渡す。サブエージェントには渡さない。引数と説明の文は `packages/runner/src/tools.ts` が正である。断るときは、理由の文をツールのエラーとして返す。

| ツール | 中身 | 断るとき |
| --- | --- | --- |
| `job_start` | `command`、任意の `cwd`・`timeout_seconds` を取る。コマンドが走り出したら、ID・コマンド・作業の場所・始まり・長さの上限・出力のファイルの JSON を返す | 作業の場所が無いか、ディレクトリでない。`timeout_seconds` が 1 から上限の秒の整数でない。走っている数が上限に達している（走っている仕事の一覧を添える） |
| `job_list` | 引数を取らない。走っている仕事の、`job_start` が返すのと同じ形の JSON の配列を返す | なし |
| `job_stop` | `id` を取る。仕事のプロセスのまとまりに `SIGTERM` を送り、終わらなければ 5 秒後に `SIGKILL` を送る。終わってから返る。終わりの出来事は `stopped` で送る | その ID の仕事が走っていない |

- コマンドは `bash -c` で、自分のプロセスのまとまり（process group）の長として、エージェントと同じユーザー・同じ環境で走る。相対の作業の場所は HOME から引き、省けば HOME。
- 仕事ごとに `~/jobs/<ID>/` を作り（`PENELOPE_JOBS` で場所を変えられる）、標準出力と標準エラー出力を 1 つのファイル `output.log` に書き、記録を `job.json` に置く。HOME の下なので永続する。ID は 8 桁の 16 進数である。
- `job.json` は、ID・コマンド・作業の場所・プロセスのまとまりの長の pid・始まり・長さの上限と、backend がまだ受けていない終わり（`pending`）か、受けた印（`done`）を持つ。消さない。
- 終わったら、終わりを記録に足してから送る。backend が受けたら（`202`）記録で受けた印にする。受けなければ同じ `id` で送り直す（1 秒から倍にして 30 秒まで間を空ける）。
- 長さの上限に達したら、`job_stop` と同じくプロセスのまとまりを止め、`timed-out` で知らせる。コマンドの長が自分で終わっても、そのまとまりに残った子は止めない。
- 夜の切り替えは裏の仕事に触らない。終わりの出来事は、そのとき走っている本体のセッションに届く。
- runner が止まるときは、走っている仕事のまとまりを `SIGKILL` で止め、知らせは送らない。記録は走っているままにする。runner が立ち上がったら、走っているままの記録のまとまりに `SIGKILL` を送り（残っていれば）、`interrupted` の終わりを送る。送れていない終わりも送る。pid が別のまとまりに使い回されていれば、それを止めてしまう。sandbox の中のプロセスはエージェントのものだけなので、受け入れる。

| 設定（runner の環境変数） | 既定 | 中身 |
| --- | --- | --- |
| `PENELOPE_JOBS` | `$HOME/jobs` | 裏の仕事の記録と出力の置き場所 |
| `PENELOPE_JOBS_MAX` | `5` | 同時に走る数の上限 |
| `PENELOPE_JOB_MAX_SECONDS` | `86400`（24 時間） | 1 つの仕事の長さの上限。`timeout_seconds` を省いたときの長さ |
| `PENELOPE_JOB_TAIL_CHARS` | `4000` | 終わりの出来事の `tail` の字数の上限 |

## サブエージェントの状態

- body は `{agent, purpose, closed}`（型は `SubAgentStatus`）。runner が、サブエージェントを起こしたとき（`closed: false`）、閉じたとき（`closed: true`）、runner が立ち上がったときに閉じていないサブエージェントのすべてについて送る。
- backend は、サブエージェントごとに最後に受けたものを残す（永続、SQLite の `sub_agents`）。同じ名前を受け直したら、目的と `closed` を置き換える。UI に閉じていないサブエージェントを出すためである（[ui-api.md](ui-api.md) の「サブエージェント」）。受けるたびに UI の流れへ `agent` を送る。
- 走っているか待っているか（UI の `state`）は、サブエージェントの途中経過とターンの終わりから決める（「途中経過」）。
- この口をまだ受けていない名前の途中経過とターンの終わりも、ほかと同じく受けて、記録・流れ・コミットに回す。`GET /api/agents` には載せない。後でこの口を受けたら、それまでの途中経過から決めた `state` で載る。
- `agent` が `main` か形の違う名前、`purpose` が文字列でない、`closed` が真偽値でなければ `400`。応答は `204`。

## 返事

- body は `{agent, text, expression?, in_reply_to?, turn_id?, images?}`。
  - `turn_id`: 返事を出したターンの ID（「途中経過」の `turn_id`）。backend は返事をそのターンに結び付け、活動の記録と会話の行き来に使う（[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)）。無ければ、backend はそのとき本体の進んでいるターン（記録に始まりがあって終わりの無いもの）に結び付け、それも無ければ結び付けない。空の文字列は `400`。
  - `expression`: 表情。Web UI はアバターをこの表情の絵で出す（[ADR-0016](adr/0016-show-the-avatar-and-expression-from-the-first-web-ui.md)）。
  - `in_reply_to`: 答えている出来事の `seq`。ターンの `<events>` の行の `seq` である（`batch` のまとめなら `seqs` の 1 つ）。
  - `images`: 返事に添える画像の並び（[ADR-0032](adr/0032-images-attached-to-a-reply-copied-by-the-backend.md)）。1 件は `{name, data}`（型は `ReplyImageUpload`）で、`name` はファイルの名前（ディレクトリを除く、1〜255 文字）、`data` はファイルの中身の base64（padding 付き）。
- 応答は `201` と `{id}`。backend は会話の履歴に残し、UI の流れへ送る（[ui-api.md](ui-api.md)）。

### 返事の画像

- 上限は contract の `src/images.ts` が正で、runner と backend が同じものを使う。1 回 4 枚（`REPLY_IMAGES_MAX`）、1 枚 10 MiB（`REPLY_IMAGE_MAX_BYTES`、10,485,760 バイト）、種類は PNG・JPEG・GIF・WebP（`REPLY_IMAGE_TYPES`）。
- 種類は中身の先頭の bytes で決める（取り込み口の添付と同じ見分け方、[events.md](events.md)）。名前の拡張子と送り手の言い分は見ない。
- 1 枚でも合わなければ、文も含めて何も残さず `400` で断る。`error` は `not sent: ` に続けて、何番目のどのファイルが、なぜ合わないかを言う（枚数が多い、名前が無い、base64 でない、大きすぎる、PNG・JPEG・GIF・WebP でない）。
- backend は確かめに通った画像を写しの置き場に書いてから、返事と写しの記録を 1 つの transaction で残す（[backend.md](backend.md) の「作ったものの写し」）。書けなければ、書きかけを消し、返事も残さずに `500`（`not sent: the images could not be kept`）で答える。
- 画像の無い返事、`images` が空の返事は、履歴と流れに `images` の欄を持たない。

### `reply` のツール（runner）

- `images` に、sandbox の中の画像のファイルの場所を並べて渡す。相対の場所は HOME から引く。引数と説明の文は `packages/runner/src/tools.ts` が正である。
- runner はファイルを読んで base64 にし、`name` をファイルの名前にして送る。backend は sandbox のファイルを読まない。
- runner は、枚数が上限より多い、ファイルが無い・読めない・普通のファイルでない、大きさが上限より大きい（読む前に `stat` で見る）ときは、送らずにツールのエラーにする。種類は確かめず、backend に任せる。backend の断りは、その `error` をそのままツールのエラーにする。どちらも `Not sent` / `not sent` で始まり、返事は届いていない。
- 畳んだターンにも `reply` の呼び出しは丸ごと残る（[ADR-0015](adr/0015-fold-ended-turns-before-they-are-sent.md)）。残るのはファイルの場所だけで、画像の中身はモデルへの入力に入らない。

## A2A の Task に返す

- body は `{agent, in_reply_to, state, text?}`（型は `A2AReplyRequest`）。
  - `in_reply_to`: 答える `a2a` の出来事の `seq`（[events.md](events.md) の「A2A の出来事」）。Task の依頼の出来事でも、聞き返しへの答えの出来事でもよい。
  - `state`: `completed` は Task を閉じる。`text` は任意で、あれば送り手への答えになる。`input-required` は送り手に `text` を聞き返し、Task を開いたまま答えを待つ。`text` は必須。
- 応答は `200` と `{task_id, state}`（型は `A2AReplyResponse`）。送り手は `GetTask` で読みに来る（[a2a.md](a2a.md)）。
- `in_reply_to` が `a2a` の出来事の `seq` でなければ `404`、Task が閉じていれば（`completed`・`failed`・`rejected`）`409`、聞き返しに `text` が無ければ `400`。どれも Task は変わらない。
- 返事はオーナーとの会話の履歴には入らない。

## 途中経過

- body は `{agent, activities: [...]}`。runner が Pi の出来事を購読し、**ブロックが閉じるごとに**送る。トークンごとには送らない。
- 1 件は `kind`・`at`（RFC 3339）・`turn_id` を持つ。
- `turn_id` は runner がターンごとに付ける UUID である。runner の 1 ターンは、Pi の 1 回の実行（入力を渡してから、Pi がそれ以上自分で続けなくなるまで）で、その間に steer と follow-up で入った出来事も含む。
- 地の文の無いまま終わったターンで、畳む前に runner が送る頼みと、その答え（[ADR-0015](adr/0015-fold-ended-turns-before-they-are-sent.md)）も、同じ `turn_id` のターンに入る。ターンの終わりの知らせは、その答えの後に送る。
- `tool_result` の `output` は、結果の文字の部分を改行でつないだものである。画像などの文字でない部分は `[image/png]` のように種類だけを書く。16,000 文字を超えた分は送らず、`[N more characters]` と数だけを添える。
- 送れなかった途中経過は送り直さない。記録と UI の写しだけのためである。

| `kind` | ほかの欄 |
| --- | --- |
| `turn_start` | なし |
| `thinking` | `text`（考えたこと） |
| `tool_call` | `call_id`・`name`・`arguments`（任意の JSON） |
| `tool_result` | `call_id`・`is_error`・`output`（文字列） |
| `message` | `text`（返答の区切り） |
| `turn_end` | なし |

- backend は 1 件ずつ記録に残し、UI の流れへ送る。`turn_start` でエージェントを `thinking`、`turn_end` で `waiting` にする。
- エージェントの今の `state` とその時刻は、記録に残したそのエージェントの最後の `turn_start`（`thinking`）か `turn_end`（`waiting`）と、その `at` である。別には残さないので、backend が立ち上がり直しても同じものが引ける。どちらもまだ無いエージェントは `waiting` である。
- サブエージェントの途中経過は、`agent` をサブエージェントの名前にして同じ形で送る。サブエージェントのターンは、サブエージェントの 1 回の実行（頼みか続きを受けてから止まるまで）である。runner が立ち上がり直して中断したサブエージェントを戻すときは、切れたターンの `turn_end` を送る。
- 1 件でも形が違えば、要求の全体を `400` で断り、何も残さない。

## ターンの終わり

- body は `{agent, turn_id, result?, reason?, seqs?, night?}`（型は `TurnEndRequest`）。`turn_id` のほかは活動の記録のための欄である（下の「ターンの結果ときっかけ」）。backend が `/memory` の作業ツリーの変わったものをコミットする合図である（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）。コミットの形は [backend.md](backend.md) の「`/memory` のコミット」にある。
- backend はコミットを終えてから `204` で答える。コミットに失敗したら `500` で答える。
- UI の流れでは、エージェントを `waiting` にする。
- runner は、ターンの `turn_end` の途中経過を送り終えてから、この口を呼ぶ。`turn_end` を送れなかったとき（途中経過は送り直さない）は、流れでは `waiting` になるが、記録から引く `state`（`GET /api/agents`）は次のターンの `turn_start` か `turn_end` まで `thinking` のままである。
- サブエージェントのターンの終わりにも、runner は `agent` をサブエージェントの名前にして送り、backend は同じくコミットする。サブエージェントが `/memory` に書いたものを、本体の次のターンを待たずに残すためである。本体のターンの途中の変更も一緒にコミットされる（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) の「サブエージェントの途中経過とターンの終わり」）。
- 途中経過の `turn_end` は UI と記録のため、この口はコミットのために、別に置く。

### ターンの結果ときっかけ

[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md) の活動の記録のために、runner はターンの終わりに次の欄を足す。どれも省いてよく、省いた要求も今までどおり受けてコミットする。形が違えば `400` で、コミットもしない。

| 欄 | 中身 |
| --- | --- |
| `result` | `done`（ふつうに終わった）・`failed`（失敗した）・`stopped`（runner が中断した）のどれか。省くと、記録ではそのターンの結果は「分からない」（`unknown`） |
| `reason` | 文字列。`failed` のときの理由の 1 行。`stopped` にも付けてよい。backend は 1 行目だけを、`RECORD_REASON_MAX`（500 文字）まで残す |
| `seqs` | 整数の並び。そのターンに渡した出来事の `seq` を、渡した順に、すべて（最初の入力も、steer と follow-up で途中に入ったものも）。backend は自分の列から `source`・`stream`・`summary` を引いて残す（先頭の `RECORD_TRIGGERS_MAX`（20）件と、全部の数）。知らない `seq` は落とす。夜の切り替えのターン、サブエージェントのターンは省く |
| `night` | `{seq, stage}`。夜の切り替えのターンだけ。`seq` はその夜の制御の出来事の `seq`、`stage` は `reflection`（振り返り）、`verifier`（照合係）、`curator`（整理係）のいずれか |

- `failed` は、ターンの実行が失敗で終わったもの（Pi の実行が例外を投げた、モデルの要求が失敗で終わったなど）である。理由の 1 行は、オーナーが記録の一覧で読む。
- `stopped` は、runner が自分で切ったもの: runner が止まるために中断した、走っているサブエージェントを `subagent_close` で閉じた、runner が立ち上がり直して切れたターンを終わらせた（サブエージェント）。失敗には数えない。
- どの場合を `failed` と `stopped` に分けるかの細部は runner が決める。迷うものは `failed` にする（失敗に気づけることを先にする）。
- 本体のターンが Pod ごと落ちて終わりを送れなかったときは送り直さない。backend は、同じエージェントの次のターンの `turn_start` を受けたとき、終わりの無い前のターンを `stopped` にする。
- 記録に残せなかったとき（backend の中の誤り）も、ターンの終わりは断らない。

## 予約

- 予約は、cron の式か 1 回の時刻（RFC 3339）のどちらか一方と、理由（`reason`）を持つ。
- `POST /v1/schedules` の body は `{agent, reason, cron}` か `{agent, reason, at}`。応答は予約（`{id, agent, reason, cron か at}`）。
- `GET /v1/schedules?agent=` は `{schedules: [...]}`。`DELETE /v1/schedules/<id>` で消す。
- 時刻が来たら、backend が `source` が `cron` の出来事を列に入れる（[events.md](events.md) の「予約の出来事」）。1 回の予約は、出来事にしたら消える。

- cron の式は 5 欄（分・時・日・月・曜日）で、backend の設定の時間帯で読む。式か時刻が読めなければ `400`。
- 作ったら `201`、消したら `204`、消す予約が無ければ `404`。

## セッションの切り替えの知らせ

- 夜の切り替え（制御の出来事、[events.md](events.md) の「制御の出来事」）の手順を 1 回回し終えたら、runner が送る。body は `{agent, seq?, stages?}`（型は `SessionRotatedRequest`）。`agent` は `main` だけで、ほかは `400`。
- 新しいセッションが動き出したら、そのあと runner は、制御の出来事を ack する。
- `seq` はその夜の制御の出来事の `seq`、`stages` は段ごとの結果 `{reflection, verifier, curator, session}` で、1 つの段は `{result, reason?}`（型は `NightStage`）である（[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)）。
  - `result` は `done`（済んだ）・`failed`（失敗した）・`skipped`（行われなかった）。`reason` は `failed` のときの理由の 1 行。
  - `reflection`、`verifier`、`curator` は対応するターンの結果を渡す。ターンを始められなかった場合や、runner の停止でターンを中断した場合も、その段は `failed` にする。`verifier` の無い旧 runner からの通知は、`verifier` を `skipped` として受ける。
  - `session` は、新しいセッションを開いて動かし始めたら `done`。開けなかったら `failed`。
  - 新しいセッションに切り替えられなかったときも、各段を試みた結果の `stages` を送る。そのときは ack しないので、制御の出来事がもう一度渡り、手順を振り返りから回し直して、また送る。backend は同じ `seq` の後の知らせで記録を置き換える。
  - 同じ `seq` がもう一度渡って手順を回さずに知らせだけを送り直すときは、`stages` を省いて `{agent, seq}` を送ってよい。backend は前に受けた段の結果を残す。
  - `stages` は `seq` と一緒にだけ送る。`seq` の無い `stages`、形の違う `stages` は `400`。
  - どちらも無い知らせ（この欄の無い runner）は、新しいセッションに切り替えたが段の結果は分からない夜として記録される。
- いずれかの段が `failed` なら、その後の段が済んでいても、その夜を失敗として記録する。
- runner は、新しいセッションに切り替えたときに、その制御の出来事の `seq` をセッションの記録の場所に残す。同じ `seq` がもう一度渡されたら、手順は回さずに知らせと ack だけを送り直す。新しいセッションに切り替える前に止まったときは、もう一度渡された出来事で、振り返りからやり直す。

- runner は日中のセッションで振り返りを行い、照合係と整理係をそれぞれ別の新しい Pi セッションで 1 ターンずつ動かす。各段が失敗しても後の段を試みる。記憶の変更は巻き戻さず、ターンの終わりの知らせでコミットする。
- 照合係には日中の未折り畳みの記録、セッション開始以降に更新されたサブエージェントの記録、`/sources` の場所と、セッションの開始から夜の切り替えの開始までの時刻を渡す。原文のファイル名は backend が出来事を受けた日付（backend の時間帯）なので、午前 4 時の切り替えや、夜を逃した後は複数の日付にまたがる。セッション中の出来事が指している原文や添付も読める。整理係には照合後の変更一覧、毎回読む 3 ファイルと記憶全体のバイト数を渡す。
- 変更一覧は、前回の切り替えで整理を試みた後の記憶と比較する。runner が通常ファイルの相対パス・内容のハッシュ・バイト数を記録し、新セッションの指し先と一緒に `current.json` に保存する。照合前、整理前に採り直し、追加・内容の変更・削除があったパスを渡す。`.git`、リンク、特殊ファイルは集計しない。初回、旧版からの切り替え、または前回の集計に失敗したときは、比較元が無いことと現在のパス一覧を渡す。
- 照合係・整理係は Pi の標準ツール一式や拡張、MCP、skill を読み込まず、専用のファイル操作だけを使う。記憶の読み書き（`.git` は対象外、`extensions/` は読み取りのみ）ができ、整理係はファイルの移動・削除もできる。日中のセッションとサブエージェントの記録、`/sources` は照合係だけが読み取る。ファイル名の `find`、文字列の `grep` も同じ範囲を検索し、セッションの置き場では渡された記録だけを対象にする。`read` は行と列で続きが読めるため、長い JSONL の行も末尾まで読める。JSONL に埋め込まれた画像データは `read` と `grep` の表示から省くが、画像と同じ行にあるテキストは保持する。この制限はツールの境界であり、同じ UID の別プロセスからの並行変更や、後から記憶を読む日中のセッションの動作までは隔離しない。

## モデルの設定

- `PUT /v1/model-settings` は `{agent: "main", models, default}`（候補と既定の型は [UI 向けの API の仕様](ui-api.md) の「設定」）。名前・ID・コンテキスト・思考の深さだけを送る。鍵や接続先は送らない。Pi の `ModelRuntime.getAvailable` が認証を確認した一覧を使う。
- backend は一覧をメモリに置き、最後の報告から 2 分で期限切れにする。応答は `200` と `{selection}`。sandbox からの要求はオーナーの設定を書き換えない。
- runner は起動後の poll と各ターンの前に報告し、各ターンの開始時点の設定をセッションに適用する。通信に失敗したらログに残し、最後に読めた設定を使う。まだ読めていなければ既定のままにする。
- モデルを替えるとき、新しいコンテキストから最大出力分を引いた大きさを既存の履歴の見積もりが超えるなら、切り替え前に Pi で compaction を試みる。失敗をログに残し、切り替えそのものは止めない。通常の自動 compaction は Pi に任せる。

## 状態コード

成功で body の無いもの（ack・途中経過・ターンの終わり・サブエージェントの状態・切り替えの知らせ）は `204`、形が違えば `400`、認証が通らなければ `401`、口の無い道は `404`、道はあるが method が違えば `405`、body が上限（16 MiB。返事は画像を運ぶので 64 MiB で、4 枚の 10 MiB の base64 が収まる）より大きければ `413`。backend が本物の token を設定されていなければ、すべての要求を `401` で断る。
