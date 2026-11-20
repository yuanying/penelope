# 出来事の仕様

エージェントに届く出来事の封筒、取り込み口、`/sources` の置き方、出来事がターンに入る形を決める。
方針は [ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md) と
[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md)・[ADR-0017](adr/0017-turn-input-as-json-lines-in-events.md) にある。ここにはその形を書く。
型は `packages/contract` の `src/events.ts`・`src/sandbox.ts`・`src/turn.ts` が正である。
receivers のプラグインが封筒を作る形は [receivers.md](receivers.md) にある。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 封筒

受信元が取り込み口へ送る 1 件の出来事。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `source` | ○ | 受信元の名前。`/sources` の最初のディレクトリにもなる。backend の中の受信元は `ui`・`cron`・`a2a`・`self`・`job`・`control`・`heartbeat` |
| `id` | ○ | 受信元が付ける。`source` と組で一意。重複を除くキー |
| `occurred_at` | ○ | 起きた時刻（RFC 3339） |
| `summary` | ○ | 1 行の要約。人とモデルが読む |
| `stream` | | `/sources/<source>/` の中の分け先（Slack のチャンネルなど） |
| `delivery` | | `now` か `batch`。省けば受信元の既定（下の「`delivery`」） |
| `payload` | ○ | 受信元の中身そのまま（任意の JSON）。backend は形を知らない |

backend は受けたときに、単調増加の整数 `seq` と、受けた時刻 `received_at` を付ける。順番は `seq` の順である。

`source` と `stream` は `/sources` のパスの一部になる。使えるのは英小文字・数字・`.`・`_`・`-` で、`.` で始まらないものだけである。外れた出来事は `400` で断る。`/` や `..` で `/sources` の外や別の受信元の場所を指せないようにするためである。受信元の名前が制限に外れうるもの（Alertmanager の `alertname` など）から `stream` を作るときは、受信元の側で使える文字に写してから送る（[receivers.md](receivers.md) の「`stream` の写し方」）。

### 配送の約束

- 少なくとも 1 回。受信元は、`202` を受け取れなければ同じ `id` で送り直す。
- `(source, id)` が既にあれば、受けたことにして何もしない。`/sources` にも書かない。

### `delivery`

- `now`: すぐにターンへ。ターンの最中なら割り込み（steer）、待っていれば新しいターン。起きている時間の外でも。
- `batch`: `/sources` にはすぐ書くが、ターンへはまとめて後で渡す。`now` の出来事が来たら、それと一緒に渡す。いつ渡すかは backend が決める（下の「いつ渡すか」）。
- **決めるのは受信元の側だけ**である。receivers のプラグインは自分の設定（例: Slack ならメンションと DM は `now`）に従って出来事ごとに付ける。backend はそれを上書きしない。
- 封筒で省いたときの既定は、receivers のプラグインなら `batch`。backend の中の受信元（`ui`・`cron`・`a2a`・`self`・`job`）は backend の設定で決め、既定はどれも `now`。`control` と `heartbeat` は常に `now`。

### `inline`

- 中身（`payload`）をそのままターンに載せる受信元。封筒の欄ではなく、backend の設定で受信元ごとに決める。
- 既定は `ui`（オーナーのメッセージ）・`job`（裏の仕事の終わり、[ADR-0030](adr/0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)）・`control`（制御の出来事）。サブエージェントの知らせ（`self`）は inline でない。
- Slack のプラグインの出来事を受ける配置は、その `source` も inline にする（[ADR-0029](adr/0029-slack-events-inline-drawn-as-channels-and-threads.md)）。runner がそれを描いてターンに載せる（下の「ターンに入る形」の「Slack の出来事」）。
- inline の出来事も、ほかと同じく `/sources` に書く。

### 制御の出来事

- `source` は `control`。runner が受けて手順を回し、エージェントのターンには入らない。
- 最初は夜の切り替えだけである。backend が夜の時刻に `payload` が `{kind: "nightly"}` の出来事を列に入れ、runner が振り返り → 照合係 → 整理係 → 新しいセッションを回す（[ADR-0044](adr/0044-check-memory-against-records-before-nightly-organization.md)）。終わったら runner が知らせる（[sandbox-api.md](sandbox-api.md) の「セッションの切り替えの知らせ」）。

### 予約の出来事

- エージェントの予約（[sandbox-api.md](sandbox-api.md) の「予約」）の時刻が来ると、backend が `source` が `cron` の出来事を列に入れる。
- `payload` は予約の ID（`schedule_id`）と理由（`reason`）。`summary` は理由。

### heartbeat の出来事

- 起きている時間に、本体の最後のターンの終わりから決めた時間がたつと、backend が `source` が `heartbeat` の出来事を 1 件入れる（[ADR-0031](adr/0031-a-heartbeat-event-after-quiet-minutes-in-awake-hours.md)）。いつ入れるか、入れないかは [backend.md](backend.md) の「heartbeat」。
- `id` は `heartbeat@<入れた時刻>`、`occurred_at` は入れた時刻、`stream` は無い。`delivery` はいつも `now` で、待っている `batch` の出来事を連れていく。
- `summary` は `no turn for <N> minutes`（N が 1 なら `minute`）。N をテスト用に秒で決めて分で割り切れないときは `no turn for <秒> seconds`。
- `payload` は `since`（数え始めた時刻。最後のターンの終わり、まだターンが無ければ backend が立ち上がった時刻）と `quiet_minutes`（N。テスト用の秒では端数になる）（型は `HeartbeatPayload`）。何をすべきかは書かない。
- inline ではない。ターンには要約と場所だけが入る。
- この出来事だけで始まり、ツールを 1 つも呼ばずに終わったターンでは、runner は畳む前の頼みを送らない。途中でほかの出来事が入ったターン、ほかの出来事と一緒に渡されたターンは、ほかのターンと同じく頼む（[ADR-0015](adr/0015-fold-ended-turns-before-they-are-sent.md)）。

### A2A の出来事

- ほかのエージェントが A2A で送ったメッセージ（新しい依頼と、聞き返しへの答え）は、1 つずつ `source` が `a2a` の出来事になる（[a2a.md](a2a.md)）。
- `stream` は送り手の名前（ServiceAccount の名前）、`id` は `<Task の ID>/<Task の中のメッセージの番号>`、`summary` は文の 1 行目（200 文字まで）。
- `payload` は `kind`（新しい依頼なら `request`、聞き返しへの答えなら `answer`）・`task_id`・`context_id`・`message_id`・`text`（型は `A2APayload`）。
- エージェントは、この出来事の `seq` を名指して Task に返す（[sandbox-api.md](sandbox-api.md) の「A2A の Task に返す」）。

### 裏の仕事の終わり

- 本体が裏で動かしたコマンド（[ADR-0030](adr/0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)）が終わると、runner が `source` が `job` の出来事を入れる（[sandbox-api.md](sandbox-api.md) の「裏の仕事の終わり」）。`stream` は無く、中身は `/sources/job/<日付>.jsonl` に入る。
- `id` は裏の仕事の ID、`summary` は終わり方とコマンドの 1 行目（`[exit 0] make test`・`[SIGKILL] …`・`[stopped] …`・`[timed out] …`・`[interrupted] …`）。
- `payload` は `JobEnd`。`text` の欄を持たないので、inline のときターンの `text` は `payload` を JSON にした文字列である（「ターンに入る形」）。終わり方・コマンド・時間・出力の末尾がまとめてターンに入る。

## 取り込み口

- Unix socket の上の HTTP。socket は backend と receivers だけが mount する volume に置く（[pod.md](pod.md)）。
- backend の中の受信元は、HTTP を通らず、同じ取り込みの処理を直接呼ぶ。

| 要求 | 中身 |
| --- | --- |
| `POST /v1/events` | body は封筒の JSON（`Content-Type: application/json`）。添付があるときは `multipart/form-data` で、封筒の JSON の部分と、ファイルの部分を並べる |

- multipart では、封筒は `event` の部分（文字の欄でも、JSON のファイルでもよい）、ファイルは `file` の部分を繰り返す。ファイルの名前は部分の filename である。
- 大きさの上限は、封筒とファイルを合わせた body の全体で 64 MiB。
- backend の中の受信元（`ui`・`cron`・`a2a`・`self`・`job`・`control`・`heartbeat`）の名前の出来事は、取り込み口では断る（`400`）。それらは取り込み口を通らない。receivers のプラグインが夜の切り替えなどを起こせないようにするためである。

| 応答 | 意味 |
| --- | --- |
| `202` | 受けた。重複も同じ。body は無い |
| `400` | 形が違う。body は `{error}`。送り直しても通らない |
| `413` | body が上限より大きい。送り直しても通らない |
| `5xx` | 受けていない。同じ `id` で送り直す。`/sources` に書けなかったときは `503` |

## `/sources`

- **書くのは backend だけ。** 追記するだけで、書き換えない。git にはしない。
- sandbox は読むだけ。receivers は mount しない。
- 置き場所:
  - 出来事 1 件を JSON の 1 行として、`/sources/<source>/<stream>/<YYYY-MM-DD>.jsonl` に追記する。`stream` が無ければ `/sources/<source>/<YYYY-MM-DD>.jsonl`。
  - 添付は `/sources/<source>/files/<seq>-<ファイルの名前>`。
- 1 行は、封筒の欄と backend が付けた欄を `payload` と並べたものである（型は `SourcesLine`）。

| 欄 | 中身 |
| --- | --- |
| `seq`・`received_at` | backend が付けたもの |
| `occurred_at`・`source`・`stream`・`id`・`summary` | 封筒のもの（`stream` は無ければ省く） |
| `attachments` | 添付のパスの一覧（無ければ省く） |
| `payload` | 封筒の `payload` そのまま |

- `occurred_at` は SQLite と `/sources` のどちらにも、受け取った表記のまま保存する。runner への配送時だけ変換する。
- ファイルの日付は、`received_at` を backend の設定の時間帯（[backend.md](backend.md) の `PENELOPE_TIME_ZONE`）で読んだ日である。
- 添付のファイルの名前は、送られた名前の最後の段から、英字・数字・`.`・`_`・`-` のほかを `_` に替え、先頭の `.` を落とし、100 文字までにしたもの。空になれば `file`。1 つの出来事の中で同じ名前が重なれば、拡張子の前に `-2`・`-3`… を付ける。`<seq>-` が前に付くので、出来事をまたいでは重ならない。
- 保存期間は backend の設定。日付のファイルごとに消す。消す仕組みはまだ無い（[backend.md](backend.md) の「状態」）。

### 例: Slack の記録

Slack のプラグインは、起きたことを 1 件ずつ出来事にする。下の表は、その `payload` が持つものである。発言・編集・削除・絵文字・スレッドの返信のどれも、起きた日のファイルに 1 行として足される。今の姿は書き換えずに、行を組み立てて作る。

| 起きたこと | `payload` が持つもの（例） |
| --- | --- |
| 発言 | `type: message`、`ts`、本文、送り手 |
| スレッドの返信 | `type: message`、`ts`、`thread_ts`（スレッドの親の `ts`）、本文 |
| 編集 | `type: message_changed`、元の発言の `ts`、新しい本文 |
| 削除 | `type: message_deleted`、元の発言の `ts` |
| 絵文字 | `type: reaction_added` か `reaction_removed`、付けた発言の `ts`、絵文字の名前 |

`payload` の形そのものは Slack のプラグインが決める（[receivers.md](receivers.md) の「Slack のプラグイン」の「`payload`」、型は `packages/slack` の `src/payload.ts`）。読むための CLI `slackctl`（チャンネルの最近の流れやスレッドを今の姿に組み立てて出す）はプラグインの package が持ち、sandbox の image に入る（同じく「描き方と読み取りの CLI」）。

## ターンに入る形

runner は sandbox 向けの口で出来事を受け取り（[sandbox-api.md](sandbox-api.md)）、一度に渡された分を 1 つの入力にする。入力は `<events>` の行と `</events>` の行で囲み、その間に 1 行 1 件の JSON を置いたものである（natsumi の ADR 0008 と同じ形）。1 行の型は `packages/contract` の `src/turn.ts` の `TurnLine` が正である。

- 行の順は、ひとつずつの出来事を `seq` の順に並べ、その後に `batch` のまとめを置く。
- 中身の文字（本文の改行など）は JSON の文字列の中で escape されるので、1 件が 2 行にまたがることはない。

### ひとつの出来事

| 欄 | 中身 |
| --- | --- |
| `agent` | その出来事を受けるエージェント。省けば `main`。今は `main` だけなので、いつも省く（サブエージェントのための余地） |
| `seq` | backend の順番。`reply` の `in_reply_to` はこれを取る |
| `source`・`stream` | 封筒のもの。`stream` が無ければ省く |
| `delivery` | `now` か `batch` |
| `occurred_at` | 配送時の値をそのまま載せる（[sandbox-api.md](sandbox-api.md) の「出来事を取る」） |
| `summary` | 封筒のもの |
| `text` | inline の出来事だけ。`payload` の `text`（文字列）。無ければ `payload` を JSON にした文字列 |
| `appended` | inline でない出来事だけ。中身を足した場所。`path` と `lines`（`[from, to]`、1 始まり・両端を含む） |
| `attachments` | 添付があるときだけ。1 件は `path`・`mime_type`・`size`（sandbox 向けの口の添付と同じ） |

- inline の出来事は中身（`text`）を持ち、`appended` を持たない。inline でない出来事は `appended` を持ち、`text` を持たない。中身は、エージェントが必要なときに sandbox の shell でそのファイルを読む。
- inline の出来事に付いた画像（`mime_type` が `image/png`・`image/jpeg`・`image/gif`・`image/webp` のもの）は、`attachments` に加えて、画像としてもターンに載せる。runner が `/sources` から読み、Pi の画像の入力として渡す。1 つの入力に 4 枚まで、添付の `size` が runner の設定の大きさ（既定 5 MiB）を超えるものと読めないものは載せず、`attachments` だけにする。
- inline でない出来事の画像は `attachments` だけである。エージェントが Pi の `read` で開く。

### `batch` のまとめ

一度に渡された `batch` の出来事（inline でないもの）は、受信元と `stream` ごとに 1 行にまとめる。

| 欄 | 中身 |
| --- | --- |
| `agent` | ひとつの出来事と同じ |
| `kind` | `batch`。ひとつの出来事の行は `kind` を持たない |
| `source`・`stream` | まとめた出来事のもの。`stream` が無ければ省く |
| `count` | まとめた件数 |
| `seqs` | まとめた出来事の `seq` の一覧（順に） |
| `summary` | まとめた出来事の `summary` を `seq` の順に改行でつないだもの |
| `appended` | 足された場所の一覧。ファイルごとに、接する行の範囲を 1 つにつないで並べる。1 件はひとつの出来事の `appended` と同じ形 |

- まとめた出来事の添付は、行には載せない。`/sources` の行の `attachments` にある。
- Slack の描き方で描く受信元のまとめは、さらに `text` を持つ（下の「Slack の出来事」）。ほかの受信元のまとめは `text` を持たない。

### Slack の出来事

Slack のプラグインの出来事は、runner が `packages/slack` の描き方で文にして載せる（[ADR-0029](adr/0029-slack-events-inline-drawn-as-channels-and-threads.md)）。一度に渡された分は、前に渡してから Slack で起きた変化である。描いた文の形は [receivers.md](receivers.md) の「描き方と読み取りの CLI」にある。

| runner の設定 | 既定 | 中身 |
| --- | --- | --- |
| `PENELOPE_SLACK_SOURCES` | なし | Slack の描き方で描く受信元（`,` で区切る）。有効化の `source` の名前を書く。無ければ何も描かない |
| `PENELOPE_SLACK_MAX_CHARS` | `6000` | 1 つの入力に載せる、描いた文の字数の上限。その入力の Slack の行の `text` を合わせた数 |

- 描くのは、その受信元の **inline の出来事だけ**である。backend の `PENELOPE_INLINE_SOURCES`（[backend.md](backend.md)）に無ければ、ほかの受信元と同じ形（要約と場所）で入る。
- `now` の出来事は、ひとつの出来事の行のままで、`text` が描いた文になる。変化の前の発言を 3 件まで、`(earlier)` の付いた 1 行で添える（スレッドの返信なら、同じスレッドの前の返信）。`appended` は持たず、`attachments` は持つ。
- `batch` の出来事は、受信元と `stream` ごとに 1 行のまとめになり、`text` に描いた文を持つ。前の発言は添えない（返信の親とリアクションの付いた発言だけを `(earlier)` で添える）。`count`・`seqs`・`summary`・`appended` は、省いた分も含めて、まとめた出来事すべてのものである。
- 同じ入力に `now` と `batch` が来たら、行はそれぞれの形で並ぶ。`batch` で描いた発言が、`now` の行に `(earlier)` で重ねて出ることがある。
- 描くために、runner は変化の `stream` の `/sources` のファイルを、いちばん早い変化を受けた日（UTC）の前の日のものから読む。それより前の親やリアクションの付いた発言は `(not read)` と描く。
- 時刻は runner の時間帯（`TZ`、無ければ UTC）で描く。
- 量の上限を超えたら、上限を行に分ける。上限を行の数で等分した字数に収まる行はそのまま、残りの字数を長い行で分ける。行の中では古い変化から省き、`(<数> earlier changes left out; slackctl history <stream>)` を添える（`source` が `slack` でなければ `--source <source>` が入る）。1 つの変化だけでも収まらないときは、終わりを切って `…` にする。
- 描けないとき（`payload` が描き方の知らない形、`stream` が無い、`/sources` のその `stream` の場所が読めない）は、その出来事を、ふつうの inline の出来事の行（`payload` の `text`、無ければ JSON）にする。`batch` でもまとめずに 1 件 1 行になる。runner のログに `slack: event <seq> of <source>/<stream> is not drawn: <理由>` を書く（本文は書かない）。描く途中で失敗したときは、その入力の描く出来事をどれも描かずに入れる（`now` はふつうの inline の行、`batch` は `text` の無いまとめ）。ログには `seq` の一覧と理由を書く。
- 添付の画像は、ほかの inline の出来事と同じく、画像としても載る（上の「ひとつの出来事」。`batch` の出来事の画像も、1 つの入力に 4 枚までのうちに入る）。

### 畳んだ後

- 終わったターンを畳むとき（[ADR-0015](adr/0015-fold-ended-turns-before-they-are-sent.md)）も、出来事の入力はそのまま残る。畳んだ後のターンにも、同じ `<events>` の形で出来事がある。
- Slack の描いた文も出来事の入力の一部なので、畳んだ後に残る。`slackctl` の出力はツールの出力なので残らない。

### いつ渡すか

- **いつ渡すかは backend が決め、渡す時が来た出来事だけを sandbox 向けの口で返す**（[sandbox-api.md](sandbox-api.md) の「出来事を取る」）。runner は時を数えない。
- `now`: backend はすぐに渡す。runner は、ターンの最中なら steer、待っていれば新しいターンにする。
- `batch`: backend は、受信元と `stream` をまたいで、まだ渡していない `batch` の最初の 1 件を受けると待ちを始める。待ちは、新しい `batch` の出来事が来るたびに N 分先まで延び、最初の 1 件から M 分で打ち切る。待ちが終わったら、それまでに溜まったものを一度に渡す。起きている時間の外に来たものは、朝まで渡さない。
  - 待ちの終わりが起きている時間の外に落ちたら、次に起きている時間が始まるときに渡す。
  - `now` の出来事を初めて渡すときは、待ちの途中でも、その時点で待っている `batch` の出来事をすべて一緒に、`seq` の順で渡す。起きている時間の外でも同じである。たとえば Slack の流れ（`seq` 10、`batch`）の後に自分へのメンション（`seq` 11、`now`）が来たら、10 と 11 を 1 回の poll で返す。ターンが、そこに至る流れと一緒にメンションを見られるようにするためである。ack が無くてもう一度渡す `now` の出来事は、`batch` を連れていかない。
  - N・M・起きている時間は backend の設定（[backend.md](backend.md)）。既定は N が 5 分、M が 30 分、起きている時間が 07:00〜23:00。
- runner は、一度に渡された `batch` の出来事を 1 つの入力にまとめる。ターンの最中に `batch` だけが渡されたときは steer にせず、そのターンの後に follow-up で入れる。`now` の出来事と一緒に渡されたときは、`now` と同じ 1 つの入力にして steer で入れる。
