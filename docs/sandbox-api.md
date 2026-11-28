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
- サブエージェントには返事・A2A の返事・眠り・気分・予約・裏の仕事の道具が無い。`agent` が `main` でない `POST /v1/replies`・`POST /v1/a2a/replies`・`POST /v1/sleep`・`POST /v1/mood`・`POST /v1/job-events`・予約の口（`GET`・`POST`・`DELETE`）は `400` で断る。取り違えを防ぐためで、守りではない。

## 口の一覧

| 口 | 中身 |
| --- | --- |
| `GET /v1/events?agent=&after=&wait=` | 出来事を取る（long-poll） |
| `GET /v1/status?agent=main` | 眠りの状態、眠気、気分を読む |
| `POST /v1/sleep` | 本体のターンの後に眠りを始める |
| `POST /v1/mood` | 本体の気分を置き換える |
| `PUT /v1/model-settings` | runner のモデル候補を知らせ、オーナーの設定を読む |
| `POST /v1/events/ack` | 済んだ出来事を知らせる |
| `POST /v1/self-events` | 自分宛ての出来事を入れる |
| `POST /v1/job-events` | 裏の仕事の終わりを入れる |
| `POST /v1/replies` | オーナーへの返事（画像を添えられる） |
| `POST /v1/a2a/replies` | A2A の Task に返す |
| `POST /v1/activity` | 途中経過 |
| `POST /v1/turns/end` | ターンの終わり |
| `POST /v1/memory/repairs` | 夜の移動に伴う記憶の参照の修正をコミット |
| `POST /v1/agents` | サブエージェントの状態（起こした・閉じた） |
| `GET /v1/schedules?agent=`・`POST /v1/schedules`・`DELETE /v1/schedules/<id>?agent=` | 予約 |
| `POST /v1/sessions/rotated` | セッションの切り替えの知らせ |

## 出来事を取る

- `after` より後の `seq` で、まだ済んでいない出来事を、`seq` の順に返す。無ければ `wait` 秒まで待ち、それでも無ければ空の一覧を返す。
- 返したものは「渡した」になる。渡したまま一定時間 ack の無いものは、次の poll でもう一度渡す。
- 返すのは、渡す時が来たものだけである。`batch` の待ちと眠りは backend が管理する（[events.md](events.md) の「いつ渡すか」）。runner は受け取った分をターンに入れるだけである。ターンに入る形（`<events>` の 1 行 1 件の JSON）は [events.md](events.md) の「ターンに入る形」にある。
- ack の無いままもう一度渡す出来事は、`seq` が `after` 以下でも返す。runner は再起動の後、`after` を省いて（0 として）取り直す。
- まだ一度も渡していない出来事も、`seq` が `after` 以下でも返す。`batch` の出来事は、後に来た `now` の出来事より後に渡ることがあり、そのとき `seq` は runner が受け取った最大の `seq` より小さい。
- 一定時間は backend の設定で、既定は 5 分（[backend.md](backend.md) の `PENELOPE_REDELIVER_MINUTES`）。ターンがそれより長く続くと、そのターンに入れたまま ack していない出来事も、もう一度渡る。
- `wait` の上限は 60 秒で、それより長い値は 60 秒として扱う。一度に返すのは 100 件まで。起きた直後は、待っている出来事がこの上限を超えていても、最初の応答に `wake` を入れる。
- 応答は `{events: [...]}`。1 件ごとに `seq`・`source`・`id`・`stream`・`occurred_at`・`received_at`・`summary`・`delivery`・足された場所（`appended`: `path` と `lines` の 1 始まり・両端を含む範囲）・添付（`attachments`）を持つ。inline の出来事だけが `inline: true` と `payload` を持つ。封筒に `answer_via` があれば、inline かどうかにかかわらず同じ値を返す。無ければ省く。
- `heartbeat` と `wake` は常に `inline: false` で、`payload` の代わりに `status` と、あれば `pending` と `plugin_notes` を渡す。どれも列に入れた時点の値で、以前の版で入れられた出来事には `status` や `plugin_notes` が無いことがある。runner はこれらを該当する出来事の行に直接載せる。backend が採る `pending` の欄は `a2a_tasks` と `failures`。`jobs` と `subagents` は runner 側の欄で、この応答には含まれない（[events.md](events.md) の「heartbeat と起きたときの `pending`」）。
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
- `running`・`waiting` になった時刻を `since`（RFC 3339）に記録する。`since` のない旧い `waiting` の記録を復元するときは、状態が変わった時刻そのものではなく、`agent.json` の最終更新時刻を `since` に使う。最終更新時刻は通常、状態が変わったときか、その後 backend が知らせを受け取り、runner が記録を更新したときの時刻である。時刻が読めなければ heartbeat の一覧に載せない。再起動で `running` から `waiting` に移すときは、その時点の時刻を記録する。
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

- コマンドは `bash -c` で、自分のプロセスのまとまり（process group）の長として、エージェントと同じユーザー・環境で走る。runner はその仕事の ID を `PENELOPE_JOB_ID` として子プロセスに渡す。これは起動手順の目印であり、認証ではない。相対の作業の場所は HOME から引き、省けば HOME。
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

### `ask-agent`

ほかのエージェントへ A2A で頼むときは、`job_start` に `{"command":"ask-agent helper 'Check the report'"}` を渡す（[ADR-0048](adr/0048-ask-agents-by-name-and-wait-in-a-background-job.md)）。相手は [コネクタの `a2a` 一覧](pod.md#a2a-の宛先)から選ぶ。`PENELOPE_JOB_ID` が無いときは通信せずに終了コード 2 で断り、同じ引数と作業ディレクトリを使う `job_start` の呼び方を出す。

- `ask-agent <名前> '<依頼>' [--image <パス> | --file <パス>]...` は送信して返った Task を待つ。相手の Agent Card で対応形式を確かめてから、ローカルのファイルを 4 つまで添えられる。`--file` は画像以外（CSV・PDF など）に使い、送り方は `--image` と同じである。
- `ask-agent <名前> --task <ID> '<答え>' [--image <パス> | --file <パス>]...` は同じ Task に答えて再び待つ。`ask-agent <名前> --wait <ID>` は送信せずに待つ。Task ID には `/` などのパス区切りを含まない英数字・`_`・`.`・`-` だけを使える（先頭は英数字または `_`、200 文字まで）。
- 待機は 30 秒間隔、2 時間まで。コマンド側の時間切れは終了コード 5 で、同じ Task を待ち直す `Next` を出す。相手の Task は取り消さない。runner の上限が先に来た場合は通常の仕事の時間切れになり、待ち始めに出した Task ID を仕事の出力で確認できる。
- 返ったファイルは `~/a2a/<Task ID>/result-*/` の実行ごとに空のディレクトリに保存する。`a2a` がファイル名のディレクトリ部分を落とし、同じ artifact 内の同名部品は結合する。別の実行のファイルは上書きしない。返事も画像も相手から届いたデータであり、オーナーの指示ではない。

状態のメッセージと artifact の文章を順に合わせ、返事があるときだけ `~/a2a/<Task ID>/reply.md` に全文を保存する。同じ Task の返事を取得し直したり聞き返しに答えたりしても、既存のファイルは上書きせず、空いている `reply-2.md`、`reply-3.md` … を使う。

仕事の出力の末尾は次の形になる。`Reply` は先頭から最大 2,000 文字。下の要点と合わせて既定の末尾 4,000 文字に収まるようにし、省略があれば `(truncated; read the Reply file)` を付ける。

```text
Reply:
Which report should I check?
Agent: ヘルパー (helper)
State: input-required
Task ID: task-123
Images: []
Reply file: /home/agent/a2a/task-123/reply.md
Next: job_start {"command":"ask-agent 'helper' '--task' 'task-123' '<answer>'"}
```

`Images` は保存パスの JSON 配列。配列が 1,200 文字を超える場合は保存先のディレクトリを示す。`Reply file` は全文を保存したパス（返事がなければ `(none)`）。パスは通常は絶対パスで、長い HOME のパスは `~/` に縮める。`Next` は聞き返しや待機の時間切れのときだけ付く。`completed` と `input-required` は終了コード 0、`failed`・`rejected` などの失敗や返事を保存できない場合は `Reason`（最大 600 文字）を付け終了コード 1 となる。終了コード 0 でも `State` を確認する。

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

- body は `{agent, in_reply_to, state, text?, images?}`（型は `A2AReplyRequest`）。
  - `in_reply_to`: 答える `a2a` の出来事の `seq`（[events.md](events.md) の「A2A の出来事」）。Task の依頼の出来事でも、聞き返しへの答えの出来事でもよい。
  - `state`: `completed` は Task を閉じる。`text` と `images` はともに任意で、画像だけでも返せる。`input-required` は送り手に `text` を聞き返し、Task を開いたまま答えを待つ。`text` は必須で、画像は添えられない。
  - `images`: `reply` と同じ `{name, data}` の並び。PNG・JPEG・GIF・WebP、復号後で 1 枚 5 MiB、4 枚まで。backend は中身の先頭のバイトで種類を確かめ、写しを `PENELOPE_ASSETS_DIR` に置き、Task と結び付ける（[backend.md](backend.md#作ったものの写し)）。合わない画像がある場合は `400`、保存できない場合は `500` で、返事も Task の状態変更も残さない。
- 応答は `200` と `{task_id, state}`（型は `A2AReplyResponse`）。送り手は `GetTask` で読みに来る（[a2a.md](a2a.md)）。
- `in_reply_to` が `a2a` の出来事の `seq` でなければ `404`、Task が閉じていれば（`completed`・`failed`・`rejected`）`409`、聞き返しに `text` が無ければ `400`。どれも Task は変わらない。
- `reply_to_agent` では `images` に sandbox のパスの並びを渡す。絶対パスまたは HOME からの相対パスを使う。runner が読み、backend は元のファイルに触れない。
- 返事はオーナーとの会話の履歴には入らない。

## 途中経過

- body は `{agent, activities: [...]}`。runner が Pi の出来事を購読し、**ブロックが閉じるごとに**送る。トークンごとには送らない。
- 1 件は `kind`・`at`（RFC 3339）・`turn_id` を持つ。
- `turn_id` は runner がターンごとに付ける UUID である。runner の 1 ターンは、Pi の 1 回の実行（入力を渡してから、Pi がそれ以上自分で続けなくなるまで）で、その間に steer と follow-up で入った出来事も含む。
- runner が[畳む前の頼み](events.md#畳む前の頼み)を送る場合、頼みとその答えは同じ `turn_id` のターンに入る。ターンの終わりの知らせは、その答えの後に送る。
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

- body は `{agent, turn_id, result?, reason?, seqs?, night?, context?}`（型は `TurnEndRequest`）。`turn_id` は前後に空白がない 1 行の文字列。`night` はコミットの印にもなる（下の「ターンの結果ときっかけ」）。`context` は [眠気の計算](backend.md#眠気) に使う。backend が `/memory` の作業ツリーの変わったものをコミットする合図である（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）。コミットの形は [backend.md](backend.md) の「`/memory` のコミット」にある。
- runner はこの要求の直前に、夜やサブエージェントのターンも含め、作業ツリーの共有権限をそろえる。変更か未修正があった場合はその件数だけを 1 行に残し、未修正があっても要求は送る（[Pod の仕様書](pod.md)、[ADR-0061](adr/0061-share-memory-worktree-access-before-turn-commits.md)）。
- backend はコミットを終えてから `204` で答える。コミットに失敗したら `500` で答える。backend のログには、Git の処理・分類した理由（権限拒否・インデックスへの追加失敗・インデックスのロックなど）と、その理由を示す診断の件数だけを残す。件数が不明なら `affected=unknown` とする。要求への応答は汎用のエラーのままで、ログにも応答にもパス・本文・Git の生の出力は載せない。本体の夜のターン（`night` あり）では backend がコミットの変更量も数える。数を取れなくても応答は変えず、runner に数は返さない。
- UI の流れでは、エージェントを `waiting` にする。
- runner は、ターンの `turn_end` の途中経過を送り終えてから、この口を呼ぶ。`turn_end` を送れなかったとき（途中経過は送り直さない）は、流れでは `waiting` になるが、記録から引く `state`（`GET /api/agents`）は次のターンの `turn_start` か `turn_end` まで `thinking` のままである。
- サブエージェントのターンの終わりにも、runner は `agent` をサブエージェントの名前にして送り、backend は同じくコミットする。サブエージェントが `/memory` に書いたものを、本体の次のターンを待たずに残すためである。本体のターンの途中の変更も一緒にコミットされる（[ADR-0022](adr/0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) の「サブエージェントの途中経過とターンの終わり」）。
- 途中経過の `turn_end` は UI と記録のため、この口はコミットのために、別に置く。
- 本体の通常のターンに限り、`context: {tokens, context_window}` を報告する。`tokens` は畳み込みを適用して送ったコンテキストについて、モデルが最後に返した使用量（キャッシュ分を含む入力と出力の合計）。`context_window` はそのモデルの上限である。使用量が無いときや、使用量を得た後で compaction してまだ新しい使用量が無いときは、`context` を省く。
- backend は本体の通常のターンで `tokens` が 0 以上、`context_window` が正の安全な整数であることを確かめる。形が違えば `400` を返す。欄が無ければコンテキストを不明として扱い、ターンの終了はそのまま受ける。夜やサブエージェントのターンではこの欄を使わない。

### 夜の移動に伴う記憶の参照の修正をコミット

- `POST /v1/memory/repairs` の body は `{agent, paths, moves, night?}`（型は `MemoryRepairRequest`）。`agent` は `main` のみ。`paths` は runner が参照を直した Markdown ファイルのパス、`moves` は `{from, to}` の一覧で、連続した移動の `to` は最後の行き先を指す。どちらも空にはしない。
- パスは `/memory` からの相対パスで、大文字・小文字を問わず `paths` は `.md` で終わる。絶対パス、空の成分、`.`、`..`、`.git`（大文字小文字の違いを含む）、バックスラッシュ、NUL は受けない。形が違えば `400`。
- `night: {seq, turn_id}` には、その夜の制御の出来事の正の `seq` と、移動を行った整理係のターンの ID を渡す。整理係の `POST /v1/turns/end` の値と同じものを使う。週の棚卸しでは移動した方のターンを指定する。旧 runner が `night` を省くと今までどおり修正をコミットするが、UI ではその夜に結び付けない。
- runner は整理係のターンの終わりに `204` を受け取ってから参照を書き換え、変更したパスだけをこの口で別コミットにする。backend はコミットの完了後に `204`（コミット不要の場合も同じ）、失敗時は `500` を返す。この口はターンの終了や活動の記録を更新しない。

## ターンの結果ときっかけ

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

## 日中のセッションに入る記憶

- セッションを開くとき、runner は `/memory` の `personality.md`、`always.md`、`handoff.md`、`PURPOSE.md` をこの順でシステムプロンプトに足す。無いファイルは省く。1 ファイルが `PENELOPE_PROMPT_FILE_MAX_BYTES` を超える場合は本文を入れず、パスとサイズを示す。

| runner の設定 | 既定 | 役目 |
| --- | ---: | --- |
| `PENELOPE_PROMPT_FILE_MAX_BYTES` | 65536 バイト | プロンプトに本文を入れる 1 ファイルの上限 |
| `PENELOPE_PROMPT_LAYER_TARGET_BYTES` | 16384 バイト | 毎回読む層の合計の目安。プロンプトへの採否やコミットの可否には使わない |
| `PENELOPE_NIGHT_CARRY_DAYS` | 7 日 | 未照合の日中のセッションを持ち越す日数（UTC、正の整数）。今回の日中のセッションは常に対象 |
| `PENELOPE_REVIEW_TOPIC_MAX_BYTES` | 100000 バイト | 週の棚卸しで本文まで見直すトピックの合計の目安（正の整数）。最優先の 1 ファイルが超えるときは単独で対象にする |

- `PURPOSE.md` は、配置ごとに何を知っているべきか、どの問いに答えられるべきかを書いた任意のファイルである。オーナーの同意を得て書く。知識は既存のトピックに書き、専用の階層は設けない。日中と夜の係に共通する記憶の説明では、変わりうる事実に時点と確認の根拠を添えることを伝える（[ADR-0049](adr/0049-grow-memory-around-an-instance-purpose.md)）。トピックは今わかっていることを残す場所で、何をいつ確かめたかの日ごとの記録は `diary/` に置く（[ADR-0059](adr/0059-keep-topics-current-and-review-large-topics-first.md)）。

## 眠りを求める

`POST /v1/sleep` の body は `{agent: "main", wake_at}`（`SleepRequest`）。`wake_at` は未来の RFC 3339 の時刻。形が違う場合、過去または現在の時刻、サブエージェントの名乗りは `400`。切り替えが済んでまだ寝ていれば `409`。

成功は `200` と `{wake_at, duration_seconds, clamped}`（`SleepResponse`）。`wake_at` は受け付けた時刻を配置の時間帯に直した RFC 3339 の値。`duration_seconds` は今回の要求からその時刻までの秒数（端数は切り上げ）。最初に眠りを求めた時刻からの最長時間に合わせて早めた場合、`clamped` は `true`。寝つく間にもう一度求めると、起きる時刻だけを置き直し、切り替えは増やさない。

runner は本体にだけ `sleep` ツールを渡す。ツールは受け付けた時刻と、そこまでの長さを返す。切り替えは今のターンを終えてから始まる。眠りの間の配送は [出来事を渡す条件](events.md#いつ渡すか) に従う。

## 気分を決める

`POST /v1/mood` の body は `{agent: "main", mood}`（`MoodRequest`）。sandbox の通常の認証が必要である。`mood` は Unicode コードポイントで最大 160 文字の 1 行のプレーンテキスト。前後の空白を除いて保存する。空白だけの文、改行、NUL、不正な Unicode、または本体以外の名乗りは `400`。失敗しても保存済みの気分は変わらない。

成功は `204`。runner は本体だけに `mood` ツールを渡す。呼び出すと、次のターンを待たずに保存済みの気分を置き換える。

## セッションの切り替えの知らせ

- 夜の切り替え（制御の出来事、[events.md](events.md) の「制御の出来事」）の手順を 1 回回し終えたら、runner が送る。body は `{agent, seq?, stages?, memory_reads?}`（型は `SessionRotatedRequest`）。`agent` は `main` だけで、ほかは `400`。
- 新しいセッションが動き出したという知らせで、backend はその時点までの未完了の眠りを切り替え済みにし、対応する制御の出来事を ack する。runner も成功した知らせの後で制御の出来事を ack する。知らせが失敗したら ack せず、渡し直されたときに送り直す。
- `seq` はその夜の制御の出来事の `seq`、`stages` は段ごとの結果 `{reflection, verifier, curator, session}` で、1 つの段は `{result, reason?, turn_id?}`（型は `NightTurnReport`。`session` は `turn_id` の無い `NightStage`）である（[ADR-0038](adr/0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)）。
  - `result` は `done`（済んだ）・`failed`（失敗した）・`skipped`（行われなかった）。`reason` は `failed` のときの理由の 1 行。
  - `reflection`、`verifier`、`curator` は対応するターンの結果を渡す。ターンを始められなかった場合や、runner の停止でターンを中断した場合も、その段は `failed` にする。`verifier` の無い旧 runner からの通知は、`verifier` を `skipped` として受ける。
  - `reflection`、`verifier`、`curator` はターンの終わりを知らせたときの `turn_id` を付ける。ターンに至らなければ省く。古い runner が省いても受け付ける。付けるときは空でない文字列とする。backend は同じ `seq` と段のターンに一致した場合だけ、そこで計測した記憶の変更量を段の記録に加える。
  - `session` は、新しいセッションを開いて動かし始めたら `done`。開けなかったら `failed`。
  - 古い未照合の記録を対象から外したときだけ、`stages.verifier.dropped_records` に件数（正の整数）を付ける。
  - 整理係の最初のターンに渡す毎回読む層のサイズが目安を超えたときだけ、`stages.curator.always_read_over_target` に `{total_bytes, target_bytes}` を付ける。どちらも正の整数で、合計が目安より大きい。いずれも注意事項であり、段の成否は変えない。
  - 新しいセッションに切り替えられなかったときも、各段を試みた結果の `stages` を送る。そのときは ack しないので、制御の出来事がもう一度渡り、手順を振り返りから回し直して、また送る。backend は同じ `seq` の後の知らせで記録を置き換える。
  - 同じ `seq` がもう一度渡って手順を回さずに知らせだけを送り直すときは、`stages` を省いて `{agent, seq}` を送ってよい。backend は前に受けた段の結果を残す。
  - `stages` は `seq` と一緒にだけ送る。`seq` の無い `stages`、形の違う `stages` は `400`。
  - どちらも無い知らせ（この欄の無い runner）は、新しいセッションに切り替えたが段の結果は分からない夜として記録される。
- いずれかの段が `failed` なら、その後の段が済んでいても、その夜を失敗として記録する。
- runner は、新しいセッションに切り替えたときに、その制御の出来事の `seq` をセッションの記録の場所に残す。同じ `seq` がもう一度渡されたら、手順は回さずに知らせと ack だけを送り直す。新しいセッションに切り替える前に止まったときは、もう一度渡された出来事で、振り返りからやり直す。

- runner は日中のセッションで振り返りを行い、照合係と整理係を新しい Pi セッションで動かす。照合係は 1 ターン、整理係は通常 1 ターン、制御の出来事に `review_date` があれば日次の整理に代えて中身、構成の順に 2 ターンを行う。棚卸しではターンごとに新しいセッションを開く。どちらかが失敗しても次のターンや段を試みる。記憶の変更は巻き戻さず、ターンの終わりの知らせでコミットする。
- 棚卸しも `stages.curator` は 1 件とする。両方済めば `done`、それ以外は `failed` で、異なる失敗理由が複数あれば `; ` でつなぐ。`turn_id` は構成のターン、ターンに至らなければ中身のターンの ID とする。この欄は旧版との互換性のために残す。棚卸しではさらに `stages.curator.review: {content, structure}` を付け、それぞれの `NightTurnReport` を送る。両方を試みた結果を持ち、ターンを開始できなかった方も `turn_id` の無い失敗として送る。
- 整理係のターンで `move` が成功したら、runner はターンのコミット後、記憶の Markdown リンクと `personality.md`・`always.md`・`handoff.md`・`PURPOSE.md`・`INDEX.md` のパス表記を直す（[ADR-0052](adr/0052-repair-memory-references-after-nightly-moves.md)）。現在の場所からたどれるリンク、URL、ページ内のリンク、対応が不明な参照はそのままにする。移動した Markdown 内の相対リンクは、必要なら元の場所を基準に解決し、移動後の場所からの相対パスに直す。リンク外では `/memory/`、`./`、または接頭辞なしのパス全体だけを置き換え、他のパスの一部に当たる文字列は変えない。
- 参照の修正と別コミットは、次の整理ターンの見取り図や夜の差分の基準を取る前に試みる。失敗は runner のログに残して夜を進め、新しいセッションには移動一覧を渡さない。
- 照合係には日中の未折り畳みの記録、セッション開始以降に更新されたサブエージェントの記録、`/sources` の場所と、セッションの開始から夜の切り替えの開始までの時刻を渡す。原文のファイル名は backend が出来事を受けた日付（backend の時間帯）なので、午前 4 時の切り替えや、夜を逃した後は複数の日付にまたがる。セッション中の出来事が指している原文や添付も読める。日次の整理係には照合後の変更一覧、記憶全体のバイト数と見取り図を渡す。振り返りの開始前と照合後に、毎回読む層のファイルのうち存在するもののバイト数を計り、各ファイルの大きさ・合計・目安をそれぞれ振り返りと整理係に伝える。合計が目安を超えていれば、整理係の最初のターンの入力の冒頭で、まず層を縮め、細部をトピックに移してリンクを残すよう伝える。
- 日次の整理と棚卸しの中身の見直しでは、トピックに溜まった日ごとの確認記録を `archive/` に要約し、トピックから外す。過ぎた予定や期限も、オーナーの言葉や記録で片が付いたと分かるものだけを同じように扱う。未確認の予定・期限、先の予定、日付の後も効く情報はトピックに残す（[ADR-0059](adr/0059-keep-topics-current-and-review-large-topics-first.md)）。
- 棚卸しの中身のターンには、全体の見取り図、本文の対象とするトピックのパス、予定日を含む直近 7 日分の `diary/YYYY-MM-DD.md` の一覧を渡す。トピックに数えるのは Markdown ファイルで、毎回読む層・`INDEX.md`・`diary/`・`archive/`・`goals/`・`skills/`・`agents/`・`extensions/` は除く。合計が予算内なら全トピック、超える場合は棚卸しの対象にまだ入っていないもの、次に最後に対象に入った日が古いものを優先する。同じ日（まだ対象に入っていないもの同士を含む）では大きい順、大きさも同じならパス順とし、残りの予算に収まらないファイルは飛ばす。ただし最優先の 1 ファイルが予算を超えるときは、そのファイルだけを対象にする。本文の範囲は読み書きを強制する制限ではない。
- 中身のターンが成功したら、編集の有無によらず、対象パスと予定日を `current.json` の `lastTopicReviews` に保存する。中身のターンが失敗した場合は対象の日付を進めない。存在しなくなったパスは落とし、整理係の `move` で動いたファイルの日付は移動先に引き継ぐ。この日付は、見取り図の「最後に夜の係が書いた日」や、棚卸しの両ターンの成功を要する整理の差分基準とは別に持つ。
- 中身のターンでは `archive/` の古い要約のまとめ先と元のファイルを計画し、新しい要約の行き先 `archive/YYYY-MM.md` とともに渡す。日記の週と archive の年月は `review_date` の現地日付で数える。四半期の最終月から 3 か月後の月（例: 7〜9 月分は 12 月）から月の要約を `archive/YYYY-Qn.md` に、翌年 10 月から前年の四半期と残っている月の要約を `archive/YYYY.md` にまとめる。年へのまとめを優先し、形式外のファイルや `diary/` は対象にしない。要約は整理係に任せ、計画はコミットの検査に使わない。
- 構成のターンには中身のターンの後に取り直した全体の見取り図と、`INDEX.md`、存在すれば `PURPOSE.md` の問いの節の場所を渡す。目的に沿って知識を探しやすい構成かを考え、統合・分割・移動・索引・リンクを見直す。`PURPOSE.md` が無い場合は現在の知識を探しやすくすることを目的とする。
- 照合に失敗したら、日中とサブエージェントの記録のパス、および原文を探すための時刻の範囲を `current.json` に残す。次の夜は未照合分も照合係に渡し、同じ読み取り専用の道具で読める。照合が成功すれば持ち越しを解消する。切り替えを試みた日の UTC 日付が設定の日数より古い持ち越し分は対象から外し、その件数を runner のログと活動の記録に残す。原本は削除しない。
- `PURPOSE.md` があれば、照合係と整理係にそのパスを知識の基準として伝える。あわせて、長く続く目標のファイルのパスを列挙し、`## なぜ` の節だけを今の重点の手がかりとする。`今の様子` や `goals/today.md` はこの手がかりに含めない。照合係は原本と照らしてその日の書き漏らしも拾い、整理係は必要な知識が見つかり、今の状態を答えられる構成にする。`PURPOSE.md` が無ければ目的に関する資料は追加しない（[ADR-0050](adr/0050-organize-memory-with-a-map-and-a-weekly-review.md)）。
- 記憶の書き方を示す `/memory/skills/memory/SKILL.md` があれば、夜の係に場所を伝える。知識の基準、目標、記憶の skill は自動で本文を取り込まず、夜の係が既存のファイル操作で読む。
- 変更一覧は、照合・整理それぞれの基準と段の開始前の記憶を比較し、追加・内容の変更・削除があったパスを渡す。基準は通常ファイルの相対パス・内容のハッシュ・バイト数で、`.git`、リンク、特殊ファイルは集計しない。照合が成功した夜の基準は、整理を試みた後の記憶とする。整理の成否によらず、前の夜の整理による変更を日中の変更と区別するためである。整理の基準は、整理が成功した直後の記憶とする。棚卸しでは 2 ターンとも成功した場合だけ進める。基準は新しいセッションを開く前に `current.json` に保存し、失敗した段の基準は据え置く。旧版の共有基準 `nightMemory` は両段の初期値として読み替える。基準が無い段にはそのことと現在のパス一覧を渡す（[ADR-0051](adr/0051-carry-unfinished-night-work-forward.md)）。
- 見取り図はディレクトリごとにまとめた 1 ファイル 1 行で、`.git` とシンボリックリンクを除く全ファイルを載せる。本文は入れない。Markdown の各見出しから次の見出しの手前までの行数、他のファイルからのリンク数、存在しないリンク先、たどれる記憶内のリンク先を示す。対象は記憶内の Markdown リンクと画像参照のファイル部分（アンカーの存在は調べない）。見出し名は最大 80 字に縮めるが、ファイルの件数は制限しない。
- 変更日は `.git` の現在の履歴から得るコミット日（UTC、改名前のパスはたどらない）。照合係・整理係の最終書き込みは `Night-stage` の印があるコミットから拾うので、印の導入より前の書き手は不明のままとする。履歴が得られなくても見取り図自体は渡す。
- 毎晩、振り返り前に日中の本体セッションの未折り畳みの記録を調べる。成功した `read` の対象、`grep`・`find` の出力、および `bash` のコマンドに現れる実在の記憶ファイル（絶対パス、`~/` または作業ディレクトリからの相対パス）を、1 回の呼び出しにつきパスごとに 1 回数える。`rg`・`grep`・`fd`・`find` から始まるシェルコマンドでは、出力から特定できる絶対パスも拾う。シェルの構文や展開は解釈しない。リダイレクトによる書き込みなども数えうるため、日中に触れられた目安であり、厳密な読み取り回数ではない。振り返りや夜の係の参照は含めない。
- 新しいセッションへの切り替え時に、セッション置き場の `current.json` に次のセッション・夜の `seq`・差分の基準とともに、参照された相対パスと参照日（UTC）を保存する。当日を含む直近 30 日分の参照日を残し、期間内に参照が無ければ最後の日だけを残す。検索語・コマンド・本文は集計には保存しない。整理係の見取り図には最終参照日と直近 30 日の参照回数を添える。
- 照合係・整理係は Pi の標準ツール一式や拡張、MCP、skill を読み込まず、専用のファイル操作だけを使う。記憶の読み書き（`.git` は対象外、`extensions/` は読み取りのみ）ができ、整理係はファイルの移動・削除もできる。日中のセッションとサブエージェントの記録、`/sources` は照合係だけが読み取る。ファイル名の `find`、文字列の `grep` も同じ範囲を検索し、セッションの置き場では渡された記録だけを対象にする。`read` は行と列で続きが読めるため、長い JSONL の行も末尾まで読める。JSONL に埋め込まれた画像データは `read` と `grep` の表示から省くが、画像と同じ行にあるテキストは保持する。この制限はツールの境界であり、同じ UID の別プロセスからの並行変更や、後から記憶を読む日中のセッションの動作までは隔離しない。

### 記憶の参照のスナップショット

- 日中の本体セッションから収集した `memoryReads` を、手順を実行した夜の `POST /v1/sessions/rotated` にオプションの `memory_reads` として付ける（型は `MemoryReadsSnapshot`）。新しいセッションが開けなかった夜でも、収集できたなら段の報告と一緒に送ってよい。段を回さずに `{agent, seq}` だけ再送するときと、収集できなかったときは省く。
- 形は `{day: "2026-11-23", files: [{path: "guide.md", dates: ["2026-11-22", "2026-11-22"]}]}`。 `day` は収集時に使った UTC の日付、 `files` はスナップショット全体で、参照がなければ空配列。 `path` は記憶からの相対パス（参照の修正をコミットする口と同じパスの決まり）で重複させない。 `dates` は参照 1 回につき UTC 日付を 1 つとし、同じ日の繰り返しを残す。当日を含む 30 日分を残し、その期間に参照がないパスは最後の日だけを残す。本文・検索語・コマンド・ツール出力は送らない。
- backend は `seq` と `stages` がある場合だけ受け付ける。 `day` と `dates` は実在する日付の `YYYY-MM-DD`、 `dates` は空でなく `day` より後の値を含めない。形が違えば `400` で報告全体を受け取らない。通常の sandbox API の body 上限に従う。
- 正しい報告は従来どおり `204`。backend が保持するのは最大の `seq` のスナップショット 1 組だけ。同じ `seq` の再送も加算せず置き換える。 `memory_reads` を省いた報告や後から届いた古い `seq` の報告は既存のスナップショットを消さない。未送信の配置は UI では件数不明になる。記録の保存に失敗しても夜の切り替えは断らない。

## 本体の状態

`GET /v1/status?agent=main` は、現在の状態を `200` と `AgentStatus` で返す。sandbox の通常の認証が必要である。本体の通常のターンの開始時に読み、読めない場合は状態を添えずターンを続ける。

| 欄 | 中身 |
| --- | --- |
| `sleep` | 起きていれば `{state: "awake"}`。寝つく間は `{state: "falling_asleep", wake_at}`、寝ていれば `{state: "asleep", wake_at}`。 `wake_at` は配置の時間帯での RFC 3339 の予定時刻 |
| `sleepiness` | backend が計算した眠気。0〜100 の整数 |
| `mood` | 本体が決めた現在の気分。初回の設定前は `null` |
| `awake_seconds` | 実際に起きた時刻からの秒数。眠りの間は増えない |
| `context` | 直近の本体の通常のターンのコンテキストを表す `{tokens, context_window}`。報告がなければ欄ごと省く |

計算と起点の決め方は [backend.md の「眠気」](backend.md#眠気)。

## モデルの設定

- `GET /v1/model-settings?agent=main` は保存設定だけを `200` と `{selection}` で返す。保存設定がなければ `selection` は `null`。sandbox の通常の認証が必要で、候補一覧・既定値・報告の期限・保存設定は変更しない。[記憶評価 CLI](memory-eval.md) はこの口で日中のモデル設定を読む。評価の問いや結果はこの API を通らない。
- `PUT /v1/model-settings` は `{agent: "main", models, default}`（候補と既定の型は [UI 向けの API の仕様](ui-api.md) の「設定」）。名前・ID・コンテキスト・思考の深さだけを送る。鍵や接続先は送らない。Pi の `ModelRuntime.getAvailable` が認証を確認した一覧を使う。
- backend は一覧をメモリに置き、最後の報告から 2 分で期限切れにする。応答は `200` と `{selection}`。sandbox からの要求はオーナーの設定を書き換えない。
- runner は起動後の poll と各ターンの前に報告し、各ターンの開始時点の設定をセッションに適用する。通信に失敗したらログに残し、最後に読めた設定を使う。まだ読めていなければ既定のままにする。
- モデルを替えるとき、新しいコンテキストから最大出力分を引いた大きさを既存の履歴の見積もりが超えるなら、切り替え前に Pi で compaction を試みる。失敗をログに残し、切り替えそのものは止めない。通常の自動 compaction は Pi に任せる。

### 終わったターンの畳み込み

- 畳み込みが有効な本体セッションでは、モデルに要求を送る直前に終わったターンの履歴を短くする。出来事と地の文は残し、思考は省く。セッションの記録と活動の記録は変えない。
- [ADR-0077](adr/0077-keep-folded-tool-calls-as-tool-messages.md) に従い、assistant メッセージの直後に、各呼び出しと同じ ID を持つツール結果を一つずつ続ける。結果がない呼び出しにはエラー扱いの定型結果を付ける。Pi が再送しない、エラーまたは中断で終わった assistant メッセージからは呼び出しも結果も送らない。
- `JSON.stringify` した引数が Unicode コードポイントで 200 文字以下なら、名前と引数は変更せず、結果を `(output folded)` に置き換える。200 文字を超えたら、元のツール名を示す履歴用の印に置き換える。この印は同じ呼び出し ID の `folded` で、引数は `{"tool":"<元のツール名>"}`、結果は `(call and output folded)` とする。引数を途中で切り詰めない。`folded` は履歴専用で、ツールの定義には加えない。
- `reply` と `reply_to_agent` は、元の結果がある場合は引数を切らず、短くした結果を残す。

### モデル要求の画像の上限

- 接続先が 1 回の要求で受け取る画像の上限は、Pi の `models.json` の `providers.<provider>.maxImagesPerRequest` に 0 以上の整数で書く。runner は起動時に読む。0 は画像を送らない、未指定は制限なし。不正な値は起動時にエラーになる。
- 各モデル要求の直前に、畳み込み後の文脈に載るユーザー発言・ツール結果などの画像を数える。上限を超えたら新しい画像を優先し、古い画像から `Image omitted from the model request.` で始まる文に置き換える。対応する添付や `read` のパスが分かる場合は添える。セッションの記録は書き換えない。
- 本体・サブエージェント・夜のターンで共通。接続先のエラーを受けて上限を変更したり、画像を減らしてその場で再試行したりはしない。

### 直前のモデル要求が失敗したとき

本体のセッションの最後のモデル応答がエラーなら、runner は同じセッションの次のターンの入力に `<runner_notes>` の JSON として `model_error` を添える。文は `The previous model request failed:` に続けてエラーの内容（最大 1,000 UTF-16 コード単位、省略の印を含む）を載せる。再起動後に同じ出来事が届き直した場合も、セッションの記録から付ける。配送と ack の扱いは変えない。

日中のセッションを使う夜の振り返りも同じ扱い。照合係・整理係・翌日のセッションは別々に開くので、前の段のエラーは引き継がず、段の失敗は従来どおり活動の記録に残す。

## 状態コード

成功で body の無いもの（ack・途中経過・ターンの終わり・記憶の参照の修正コミット・サブエージェントの状態・切り替えの知らせ）は `204`、形が違えば `400`、認証が通らなければ `401`、口の無い道は `404`、道はあるが method が違えば `405`、body が上限（16 MiB。返事は画像を運ぶので 64 MiB で、4 枚の 10 MiB の base64 が収まる。A2A の返事は 32 MiB）より大きければ `413`。backend が本物の token を設定されていなければ、すべての要求を `401` で断る。
