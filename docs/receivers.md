# receivers の仕様

receivers の設定、HTTP の口、プラグインの内側の契約、Alertmanager・GitHub・Slack のプラグインが出来事を作る形を決める。
方針は [ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md) と
[ADR-0023](adr/0023-receivers-plugins-in-the-repository-and-alertmanager-first.md)・
[ADR-0024](adr/0024-github-webhooks-pass-review-requests-and-dismissals-without-state.md)・
[ADR-0028](adr/0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)・
[ADR-0029](adr/0029-slack-events-inline-drawn-as-channels-and-threads.md) にある。ここにはその形を書く。
出来事の封筒と取り込み口は [events.md](events.md)、コンテナの UID・volume・待ち受けは [pod.md](pod.md) にある。

具体的なホスト名・token の値・配置ごとの名前は、配置のリポジトリの設定にだけ書く。ここの例はすべて架空である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 動かし方

- `receivers serve` で動く。image は引数なしでこれを動かす。`receivers version` は版を出す。
- 設定は 1 つの JSON のファイル。場所は環境変数 `PENELOPE_RECEIVERS_CONFIG` で渡す。既定は `/etc/penelope/receivers/config.json`。
- 鍵の値は設定のファイルに書かず、値を書いたファイルの場所を書く（`_file` で終わる欄）。
- 設定が読めない、または使えない値があれば、起動せずに終わる（終了コード 2）。標準エラーに、どの欄がなぜ使えないかを 1 行書く。
- 設定と鍵のファイルは起動のときに 1 度だけ読む。変えたら再起動する。
- 起動したら、標準エラーに待ち受けのアドレスと、有効化ごとの名前・プラグイン・`source` を、webhook と接続の種類に分けて 1 行書く（`receivers: listening on 0.0.0.0:8081; webhooks: fraction (alertmanager, source alertmanager); connections: slack (slack, source slack)`）。
- SIGTERM で、新しい要求を受けるのをやめ、処理中の要求（取り込み口へ送っているものを含む）を終えてから終わる。終える要求の応答には `Connection: close` を付け、つなぎ置きの接続を残さない。接続の種類のプラグインは、手元の出来事を取り込み口へ送り終えてから接続を閉じる。

## 設定

| 欄 | 既定 | 中身 |
| --- | --- | --- |
| `listen` | `0.0.0.0:8081` | HTTP の口の TCP の待ち受け（`host:port`、IPv6 は `[::]:8081`）。backend の `PENELOPE_LISTEN`（既定 `8080`）と同じ Pod で重ならないポートにする。ポートが `0` なら空いているものを使う（テストのため） |
| `intake` | `/run/penelope/intake/backend.sock` | 取り込み口の Unix socket。backend の `PENELOPE_INTAKE_SOCKET` と同じ場所 |
| `intake_timeout_seconds` | `10` | 取り込み口への 1 件の要求を待つ秒数。0 より大きい整数 |
| `plugins` | `[]` | プラグインの有効化の一覧（下の「プラグインの有効化」）。空なら、出来事を作らずに health だけを答える |

- 知らない欄が書かれていれば、起動しない（書き損じを黙って無視しない）。プラグインの `settings` の中も同じである。
- 起動しないときの 1 行は `receivers: <欄>: <理由>` の形である。欄は `plugins[0].settings.token_file` のように、どこにあるかを付けて書く。鍵のファイルが読めないときも、ファイルの場所と読めない理由だけを書き、中身は書かない。

### プラグインの有効化

1 件が、プラグイン 1 つを 1 つの名前と設定で動かすもの。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `name` | ○ | 有効化の名前。webhook のプラグインなら URL の `/v1/webhooks/<name>` になる。接続の種類ではログの `connection=<name>` になる。英小文字・数字・`-` で、1〜32 文字、`-` で始まらない。一覧の中で一意 |
| `plugin` | ○ | プラグインの名前（下の「プラグインの一覧」）。知らない名前なら起動しない |
| `source` | | 取り込み口に送る出来事の `source`。省けば `plugin` の名前。[events.md](events.md) の `source` の文字の制限を満たし、backend の中の受信元の名前（`ui`・`cron`・`a2a`・`self`・`control`・`heartbeat`）でないもの。一覧の中で一意 |
| `settings` | | プラグインごとの設定（各プラグインの節）。省けば `{}` |

- 1 つの配置に同じ送り手の種類が 2 つあるときは、同じ `plugin` を 2 つ有効にし、`name` と `source` を変える。`source` が重なる設定は起動しない。`id` は `source` の中だけで一意なので、送り手をまたいで ID が重なると、片方が重複として落ちるためである。

### 例

架空の配置。Alertmanager を、前の形から引き継いだ URL `/v1/webhooks/fraction` で受け、`source` を `alertmanager` にする。

| 欄 | 値 |
| --- | --- |
| `plugins[0].name` | `fraction` |
| `plugins[0].plugin` | `alertmanager` |
| `plugins[0].source` | 省く（`alertmanager` になる） |
| `plugins[0].settings.token_file` | `/run/secrets/penelope-receivers/alertmanager-token` |

`listen`・`intake`・`intake_timeout_seconds` は既定のまま省く。2 つ目の Alertmanager を足すなら、`name` を `lab`、`source` を `alertmanager-lab` のようにした有効化を並べる。

GitHub の webhook も受けるなら、前の形から引き継いだ URL `/v1/webhooks/github` の有効化を並べる。Slack を受けるなら、さらに `slack` の有効化を並べる（下の「Slack のプラグイン」の「設定」）。

| 欄 | 値 |
| --- | --- |
| `plugins[1].name` | `github` |
| `plugins[1].plugin` | `github` |
| `plugins[1].source` | 省く（`github` になる） |
| `plugins[1].settings.secret_file` | `/run/secrets/penelope-receivers/github-webhook-secret` |
| `plugins[1].settings.authors` | `["renovate[bot]", "example-bot[bot]"]` |
| `plugins[1].settings.reviewers` | `["example-operator"]` |

### プラグインの一覧

| `plugin` | 種類 | 節 |
| --- | --- | --- |
| `alertmanager` | webhook | 下の「Alertmanager のプラグイン」 |
| `github` | webhook | 下の「GitHub のプラグイン」 |
| `signal` | 接続 | 下の「Signal のプラグイン」 |
| `slack` | 接続 | 下の「Slack のプラグイン」 |

## HTTP の口

receivers は、`listen` の TCP で HTTP のサーバーを 1 つだけ持つ。Pod の外から呼ばれる口であり、sandbox からも loopback で届くが、扱いは外から届くのと同じである（[pod.md](pod.md) の「待ち受け」）。

| 要求 | 中身 |
| --- | --- |
| `GET /healthz` | `200`、body は `ok`。プロセスが要求を受けられることだけを表す。取り込み口に届くかは確かめない。`HEAD` も受ける。ほかのメソッドは `405`（`Allow: GET, HEAD`） |
| `POST /v1/webhooks/<name>` | webhook のプラグインの有効化 `<name>` が受ける。body の上限は 1 MiB |

| 応答 | 意味 |
| --- | --- |
| `200` | 受けた。作った出来事はすべて取り込み口が `202` で受けた（作った出来事が 0 件のときも同じ） |
| `400` | body が読めない、またはヘッダーと body がプラグインの形でない。送り直しても通らない |
| `401` | 送り手の確かめを通らない。出来事は作らない |
| `404` | `<name>` の webhook の有効化が無い。ほかの知らないパスも同じ |
| `405` | `/v1/webhooks/<name>` に POST 以外で来た。`Allow: POST` を付ける |
| `413` | body が上限より大きい |
| `503` | 取り込み口が 1 件でも `202` を返さなかった（つながらない・待ちが切れた・`202` 以外の応答）。送り手は同じ知らせを送り直す |

- webhook への応答は、どの番号も body を持たない。
- body の上限（`413`）は本体が、プラグインに渡す前に見る。`Content-Length` が上限を超えていれば読まずに断り、超えていなくても読んだ量が上限を超えたところで断る。
- 確かめ（`401`）は、body を読む（`400`）より先に行う。
- 出来事は 1 件ずつ順に取り込み口へ送り、最初に `202` を受けられなかったところで止めて `503` を返す。それまでに入った出来事は、送り直しのときに backend が重複として落とす。
- 取り込み口が `400`・`413` を返したときも `503` にする。receivers が作った封筒の誤りなので、標準エラーに出来事の `source`・`id` と応答を書く。
- 要求ごとに標準エラーへ 1 行書く: 有効化の名前、応答の番号、取り込み口が受けた出来事の数、捨てたものの数（Alertmanager なら捨てたアラート、GitHub なら照らして当たらなかった依頼と取り消し）。形は `receivers: webhook=<name> status=<番号> events=<数> dropped=<数>` で、有効化に当たらない要求（`404`）の名前は `-` である。`400` のときは、どの欄がなぜ外れたか（`reason="alerts[0]: fingerprint must be a non-empty string"` のように）を後ろに足す。body の中身と鍵は書かない。`/healthz` は書かない。
- 取り込み口に受けられなかったときは、その前にもう 1 行、出来事の `source/id` と理由（応答の番号と body の先頭、つながらない、待ちが切れた）を書く。

## プラグインの内側の契約

receivers の本体（以下、本体）とプラグインの境目。実装はこの境目に従う。

### 本体が持つもの

- 設定のファイルを読み、有効化ごとにプラグインへ `settings` を渡す。
- HTTP のサーバー、パスの振り分け、body の上限、`404`・`405`・`413` の応答、`/healthz`。
- 取り込み口への送信と、その結果からの `200`・`503` の応答。
- 出来事の `source`。プラグインは `source` を知らず、本体が有効化の `source` を付ける。
- 接続の種類のプラグインを、HTTP のサーバーと並べて起動し、SIGTERM で止める。

### プラグインが持つもの

- 名前（設定の `plugin` に書くもの）と種類（webhook か接続）。
- `settings` の確かめ: 起動のときに本体から `settings` を受け、知らない欄・使えない値・読めない鍵のファイルがあれば、理由を付けて断る。本体はそれを受けて起動しない。鍵のファイルを読むのはここである。

### webhook の種類

- 1 回の要求（ヘッダーと body のバイト列）を受けて、次のどちらかを返す。
  - 断る: 応答の番号（`400` か `401`）。出来事は作らない。`400` には、本体がログに書く理由を付ける。理由は欄の名前と外れ方だけで、body の中身を写さない。
  - 受ける: 出来事の一覧（0 件でもよい）と、捨てたものの数と、本体がログに書く行（Alertmanager の `truncatedAlerts` など。0 行でもよい）。出来事は封筒の `source` を除くすべての欄（`id`・`occurred_at`・`summary`・`stream`・`delivery`・`payload`）を持つ。
- 要求には、本体が受けた時刻を付けて渡す。プラグインは時計を読まない。
- プラグインは取り込み口にも網にも触れない。要求から封筒を作るだけなので、HTTP のサーバーも socket も無しでテストできる。

### 接続の種類

自分から外のサービスへ接続を張って出来事を受けるもの（[ADR-0028](adr/0028-slack-received-over-socket-mode-by-a-receivers-plugin.md) の Decision 項 1）。HTTP のサーバーの下に道を持たない。

- `settings` を確かめた後、本体が起動のときに 1 度だけ始める。そのとき本体は次の 3 つを渡す。
  - 送り出し: 出来事の一覧を受け、1 件ずつ順に取り込み口へ送り、すべてが `202` で受けられたら真、最初に受けられなかったところで止めて偽を返す。出来事は webhook と同じ欄を持ち、加えて取り込み口へ添付として送るファイル（名前・MIME の種類・バイト列）を持てる。ファイルがあれば、取り込み口へは `multipart/form-data` で送る（[events.md](events.md) の「取り込み口」）。
  - ログ: プラグインの書く 1 行。本体が `receivers: connection=<name> ` を前に付けて標準エラーに書く。
  - 時計。
- プラグインは、送り出しが真を返してから、外のサービスに受けたことを伝える。偽なら伝えず、外のサービスの送り直しに任せる（ADR-0023 の Decision 項 4）。
- 接続が切れても、プラグインが自分でつなぎ直す。本体は止めない。
- 本体が止めるとき、プラグインは新しい出来事を受けるのをやめ、手元の出来事を送り終えてから接続を閉じる。
- 取り込み口が受けなかった出来事は、本体が webhook と同じ形の 1 行を書く: `receivers: connection=<name> intake did not take <source>/<id>: <理由>`。

封筒の欄の型は `packages/contract` の `src/events.ts` の `Event` に従う。

## Alertmanager のプラグイン

Alertmanager の webhook（`webhook_configs`）の知らせを受ける。`plugin` は `alertmanager`、種類は webhook。

### 設定

| `settings` の欄 | 既定 | 中身 |
| --- | --- | --- |
| `token_file` | なし（必須） | Bearer の token を書いたファイル。前後の空白と改行を除いたものが token。読めない・空なら起動しない |
| `now_severities` | `["critical"]` | 鳴り始めを `now` にする `severity` のラベルの値の一覧。`[]` なら、すべて `batch` |
| `drop_labels` | `{"sender": "penelope"}` | 捨てるアラートの印。ラベルの名前から値への対応で、どれか 1 つが一致するアラートを捨てる。`{}` なら捨てない |

送り手の Alertmanager の側は、`http_config.authorization` で `type` を省き（`Bearer`）、`credentials_file` に同じ token を置く。`send_resolved: true` にすると、鳴り止みも届く。

### 確かめ

- `Authorization` が `Bearer <token>` で、`<token>` が設定の token と一致するものだけを通す。`Bearer` の大文字と小文字は問わない。
- 比べるのに要る時間が、どこまで一致したかで変わらない比べ方をする。届いた token と設定の token の SHA-256 を、長さの決まったバイト列どうしで比べるので、token の長さの違いでも時間が変わらない。
- ヘッダーが無い・形が違う・token が違う要求は、どれも同じ `401` で断る。

### body

- UTF-8 の JSON で、`alerts` が配列のもの。アラートはそれぞれ、`status`（`firing` か `resolved`）・`fingerprint`（空でない文字列）・`startsAt`（RFC 3339 の時刻）・`labels`（文字列から文字列への対応）を持つ。1 件でも外れれば、要求の全体を `400` で断る。
- `startsAt` を RFC 3339 の時刻に限るのは、`firing` の出来事の `occurred_at` になるためである。取り込み口は RFC 3339 でない `occurred_at` を `400` で断るので、受けてしまうと送り直しのたびに `503` になる。
- そのほかの欄（`version`・`groupKey`・`groupLabels` など）は確かめない。
- `truncatedAlerts` が 0 より大きければ、送り手が `max_alerts` でアラートを落としている。標準エラーにその数を書く。届いたアラートだけを出来事にする。

### 出来事の作り方

アラート 1 件ごとに、`drop_labels` に当たるものを捨て、残りを 1 件の出来事にする。

| 欄 | 作り方 |
| --- | --- |
| `id` | `<fingerprint>/<status>/<startsAt>`。`startsAt` は届いた文字列のまま |
| `occurred_at` | `firing` なら `startsAt`、`resolved` なら `endsAt`。`endsAt` が無い・RFC 3339 の時刻でない・`0001-01-01T00:00:00Z` なら、受けた時刻 |
| `stream` | `labels.alertname` を下の「`stream` の写し方」で写したもの。`alertname` が無いか、写して空になれば省く |
| `delivery` | `status` が `firing` で、`labels.severity` が `now_severities` にあれば `now`。ほかはすべて `batch`（`severity` のラベルが無いものも）。いつも明示する |
| `summary` | 下の「`summary` の形」 |
| `payload` | 届いたアラート 1 件の JSON をそのまま（欄を足しも削りもしない）に、要求の最上位の `externalURL` を `externalURL` の欄として足したもの。最上位に `externalURL` が無ければ足さない |

#### `stream` の写し方

1. `A`〜`Z` を `a`〜`z` にする。
2. 英小文字・数字・`.`・`_`・`-` のほかの文字（ほかの記号、空白、ASCII の外の文字）を、1 文字ずつ `_` にする。
3. 先頭の `.` を `_` にする。
4. 100 文字までに切る。

例: `KubePodCrashLooping` → `kubepodcrashlooping`、`Disk usage: /var` → `disk_usage___var`。

GitHub のプラグインも、同じ手順でリポジトリから `stream` を作る（下の「GitHub のプラグイン」）。

#### `summary` の形

- `[<状態> <severity>] <alertname>: <annotations.summary>`。`<状態>` は `FIRING` か `RESOLVED`。
- `severity` のラベルが無いか空なら `[<状態>]`。`alertname` が無いか空なら `fingerprint` を置く。`annotations.summary` が無い・空・文字列でないなら、`: ` から後を省く。
- 組み立てた 1 行の中の改行と制御文字（U+0000〜U+001F、U+007F〜U+009F）は、続くものをまとめて空白 1 つにする（`\r\n` も空白 1 つ）。そのうえで 200 文字（Unicode のコードポイント）までに切る。
- 例: `[FIRING critical] KubePodCrashLooping: Pod default/web-0 is crash looping.`

### 置き場所の例

`source` が `alertmanager` なら、上の例のアラートは `/sources/alertmanager/kubepodcrashlooping/<YYYY-MM-DD>.jsonl` に 1 行として足される（[events.md](events.md) の「`/sources`」）。

## GitHub のプラグイン

GitHub の webhook（GitHub App やリポジトリの webhook）の配送を受け、レビューの依頼とレビューの取り消しだけを出来事にする。`plugin` は `github`、種類は webhook。状態を持たず、1 回の配送だけから出来事を 0 件か 1 件作る。

### 設定

| `settings` の欄 | 既定 | 中身 |
| --- | --- | --- |
| `secret_file` | なし（必須） | webhook の秘密を書いたファイル。前後の空白と改行を除いたものが秘密。読めない・空なら起動しない |
| `authors` | なし（必須） | 扱う PR の作者のログインの一覧。1 つ以上。`renovate[bot]` のような App のログインも書ける |
| `reviewers` | なし（必須） | 依頼を受け、レビューを出す人のログインの一覧。1 つ以上 |

- `authors`・`reviewers` の要素は空でない文字列。空の一覧、空の文字列、大文字と小文字だけが違う同じログインの重なりがあれば、起動しない。要素の誤りは `plugins[1].settings.reviewers[1]` のように、何番目かを付けて書く。
- 照らすときは、大文字と小文字を区別しない。
- 送り手の GitHub の側は、Content type を `application/json` にし、Secret に同じ秘密を置き、Pull request と Pull request review のイベントを購読する（App なら Pull requests の read の権限が要る）。ほかのイベントを購読しても、読まずに `200` を返すだけである。

### 確かめ

- `X-Hub-Signature-256` が `sha256=<64 桁の 16 進>` の形で、その 16 進が、秘密を鍵にした body のバイト列の HMAC-SHA256 と一致するものだけを通す。16 進の大文字と小文字は問わない。
- 比べるのに要る時間が、どこまで一致したかで変わらない比べ方をする。16 進を 32 バイトに戻してから比べる。ヘッダーが無い・形が違うときも、32 バイトの 0 を同じように比べてから断るので、断り方で時間が変わらない。
- ヘッダーが無い・形が違う・署名が違う要求は、どれも同じ `401` で断る。`X-Hub-Signature`（SHA-1）は見ない。
- 確かめは、ヘッダーと body を読み分けるより先に行う（下の「読み分けの順」）。

### body

読む 2 つのイベントの body は、UTF-8 の JSON のオブジェクトで、次の欄を持つ。1 つでも外れれば `400` で断る。`pull_request.base.repo.full_name` をリポジトリとして使うのは、2 つのイベントのどちらにもあるためである。

| 欄 | 型 | 使うイベント |
| --- | --- | --- |
| `action` | 文字列 | 両方 |
| `pull_request.number` | 正の整数 | 両方 |
| `pull_request.title` | 文字列 | 両方 |
| `pull_request.html_url` | 文字列 | 両方 |
| `pull_request.user.login` | 空でない文字列 | 両方 |
| `pull_request.head.sha` | 空でない文字列 | 両方 |
| `pull_request.head.ref` | 文字列 | 両方 |
| `pull_request.base.ref` | 文字列 | 両方 |
| `pull_request.base.repo.full_name` | `<owner>/<name>` の形の文字列 | 両方 |
| `requested_reviewer.login` | 空でない文字列 | `pull_request` の `review_requested` で、`requested_reviewer` がオブジェクトのとき |
| `review.user.login` | 空でない文字列 | `pull_request_review` の `dismissed` |

- `action` が読む action でないときは、`action` のほかの欄を確かめない（下の「読み分けの順」）。
- `review_requested` で `requested_reviewer` が無いか `null` のもの（チームへの依頼で、`requested_team` を持つ）は、形が合っているものとして出来事を作らない。`requested_reviewer` がオブジェクトでも `null` でもなければ `400` で断る。
- そのほかの欄（`sender`・`installation`・`repository` など）は確かめない。

### 読み分けの順

| 順 | 見るもの | 外れたときの応答 |
| --- | --- | --- |
| 1 | 署名（上の「確かめ」） | `401` |
| 2 | `X-GitHub-Event` があり空でない | `400` |
| 3 | `X-GitHub-Event` が `pull_request` か `pull_request_review` | `200`、出来事 0 件（`ping` もここ） |
| 4 | body が JSON のオブジェクトで、`action` が文字列 | `400` |
| 5 | `action` が、`pull_request` なら `review_requested`、`pull_request_review` なら `dismissed` | `200`、出来事 0 件 |
| 6 | `X-GitHub-Delivery` があり空でない | `400` |
| 7 | 上の「body」の欄がそろっている | `400` |
| 8 | 依頼の相手（`requested_reviewer.login`）か、取り消されたレビューの人（`review.user.login`）が `reviewers` にあり、`pull_request.user.login` が `authors` にある | `200`、出来事 0 件（チームへの依頼もここ） |
| 9 | すべて通った | 出来事 1 件を取り込み口に送る（`200` か `503`） |

### 出来事の作り方

| 欄 | 作り方 |
| --- | --- |
| `id` | `X-GitHub-Delivery` の値そのまま |
| `occurred_at` | 受けた時刻 |
| `stream` | `pull_request.base.repo.full_name` の `/` を `.` に替え、上の「`stream` の写し方」で写したもの（`yuanying/natsumi` → `yuanying.natsumi`） |
| `delivery` | いつも `batch`。いつも明示する |
| `summary` | 下の「`summary` の形」 |
| `payload` | 下の表の欄だけを持つ JSON のオブジェクト |

`stream` は封筒の欄の名前で、`/sources/<source>/` の中の分け先である。GitHub では、リポジトリごとの置き場所になる。

| `payload` の欄 | 中身 |
| --- | --- |
| `event` | `X-GitHub-Event`（`pull_request` か `pull_request_review`） |
| `action` | `review_requested` か `dismissed` |
| `delivery` | `X-GitHub-Delivery` |
| `repository` | `pull_request.base.repo.full_name`（`<owner>/<name>`、届いたまま） |
| `number` | `pull_request.number` |
| `title` | `pull_request.title` |
| `url` | `pull_request.html_url` |
| `author` | `pull_request.user.login` |
| `head_sha` | `pull_request.head.sha` |
| `head_ref` | `pull_request.head.ref` |
| `base_ref` | `pull_request.base.ref` |
| `reviewer` | `review_requested` なら `requested_reviewer.login`、`dismissed` なら `review.user.login`。どちらも届いたまま |

- PR の本文、コメント、差分、レビューの本文は入れない。上の表にない欄は足さない。
- `payload` の題とブランチの名前は外の人が書いた文である。

#### `summary` の形

- `review_requested` なら `[review requested] <repository>#<number>: <title>`、`dismissed` なら `[review dismissed] <repository>#<number>: <title>`。
- 組み立てた 1 行の改行と制御文字の扱いと、200 文字（Unicode のコードポイント）までに切ることは、Alertmanager の「`summary` の形」と同じである。
- 例: `[review requested] yuanying/natsumi#12: Update dependency example to v1.2.3`

### 応答

- 応答の番号は上の「HTTP の口」と「読み分けの順」のとおりで、body を持たない。
- 出来事を作るのは 1 回の配送に 1 件までである。GitHub は 10 秒以内に 2xx を受けない配送を失敗とし、失敗した配送を自動では送り直さない（`503` も同じ）。送り直しは、人が Redeliver したときだけで、そのときの `X-GitHub-Delivery` は元と同じなので、backend が重複として落とす。
- 要求ごとの 1 行のログは「HTTP の口」のとおりである。「読み分けの順」の 8 で当たらなかったものは `events=0 dropped=1`、3 と 5 で読まなかったものは `events=0 dropped=0` になる。
- `400` の理由は次のどれかである。欄の理由は、外れた最初の欄の道筋（途中がオブジェクトでなければ、そこまで）と外れ方だけで、値を写さない。
  - `X-GitHub-Event is missing`・`X-GitHub-Delivery is missing`
  - `the body is not a JSON object`（UTF-8 でない、JSON でない、オブジェクトでない）
  - `action: must be a string`
  - `pull_request.base.repo: must be an object`・`pull_request.number: must be a positive integer`・`pull_request.base.repo.full_name: must be <owner>/<name>`・`requested_reviewer: must be an object or null` のような `<欄>: <外れ方>`

### 置き場所の例

`source` が `github` なら、上の例の依頼は `/sources/github/yuanying.natsumi/<YYYY-MM-DD>.jsonl` に 1 行として足される（[events.md](events.md) の「`/sources`」）。

### 未決

- 承認の後の push で ruleset の `dismiss_stale_reviews_on_push` が承認を取り消したときに、`pull_request_review` の `dismissed` が届くか。GitHub Docs に書かれていないので、実装の作業単位が、`dismiss_stale_reviews_on_push` を持つリポジトリで確かめて、この節に事実を書く。

## Slack のプラグイン

Slack の Socket Mode で、1 つ以上のワークスペースの発言・編集・削除・リアクション・ファイルを受ける。`plugin` は `slack`、種類は接続（[ADR-0028](adr/0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)）。状態を持たず、起きたこと 1 つを 1 件の出来事にする。今の姿（編集の後の本文、付いているリアクション）は読む側が組み立てる（下の「描き方と読み取りの CLI」）。

`payload` の型・描き方・`/sources` の読み方は、Slack のプラグインの package `packages/slack`（`@penelope/slack`）にあり、receivers のプラグイン・runner・読み取りの CLI が同じものを使う（[ADR-0029](adr/0029-slack-events-inline-drawn-as-channels-and-threads.md) の Decision 項 2）。Socket Mode と Web API の扱いは receivers の `src/plugins/slack/` にある。

### 設定

| `settings` の欄 | 既定 | 中身 |
| --- | --- | --- |
| `workspaces` | なし（必須） | 受けるワークスペースの一覧。1 つ以上（下の表） |
| `backfill_hours` | `24` | つなぎ直しのたびに取り直す長さ（時間）。0 以上の整数。`0` なら取り直さない |
| `max_file_bytes` | `20971520`（20 MiB） | 取ってくるファイル 1 つの大きさの上限。1〜62914560（60 MiB）の整数 |
| `file_types` | `["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]` | 取ってくるファイルの MIME の種類の一覧 |

| `workspaces[]` の欄 | 必須 | 中身 |
| --- | --- | --- |
| `name` | ○ | ワークスペースの短い名前。`stream` と `id` の頭になる。英小文字・数字・`-` で、1〜32 文字、`-` で始まらない。一覧の中で一意 |
| `app_token_file` | ○ | Slack App の app-level token（`xapp-` で始まる）を書いたファイル |
| `bot_token_file` | ○ | bot の token（`xoxb-` で始まる）を書いたファイル |
| `now_channels` | | どの発言も `now` にするチャンネルの名前（`#` は付けても付けなくてもよい）か ID の一覧。既定は `[]` |

- token のファイルは、前後の空白と改行を除いたものが token である。読めない・空・頭が違う（app-level token と bot の token の取り違え）ときは、起動しない。理由にはファイルの場所だけを書き、token は書かない。
- ワークスペースの欄に知らない欄があれば、起動しない（`plugins[2].settings.workspaces[0].colour: not a field of a workspace`）。

架空の例:

| 欄 | 値 |
| --- | --- |
| `plugins[2].name` | `slack` |
| `plugins[2].plugin` | `slack` |
| `plugins[2].settings.workspaces[0].name` | `work` |
| `plugins[2].settings.workspaces[0].app_token_file` | `/run/secrets/penelope-receivers/slack-work-app-token` |
| `plugins[2].settings.workspaces[0].bot_token_file` | `/run/secrets/penelope-receivers/slack-work-bot-token` |
| `plugins[2].settings.workspaces[0].now_channels` | `["ops"]` |

### Slack App の用意

ワークスペースごとに、Slack App を次のように用意する。配置のリポジトリが token を置く前に、本人が App の設定をこの表と照らす。

| 場所 | 設定 |
| --- | --- |
| Socket Mode | 有効にする。Request URL は要らない |
| App-Level Tokens | `connections:write` の token を作る。これが `app_token_file` |
| Event Subscriptions | 有効にし、Subscribe to bot events に `message.channels`・`message.groups`・`message.im`・`message.mpim`・`reaction_added`・`reaction_removed` を足す |
| OAuth & Permissions の Bot Token Scopes | `channels:history`・`groups:history`・`im:history`・`mpim:history`（発言と取り直し）、`channels:read`・`groups:read`・`im:read`・`mpim:read`（チャンネルの名前と一覧）、`users:read`（人の名前）、`reactions:read`（取り直した発言のリアクション）、`files:read`（ファイル） |
| App Home | DM を受けるなら、Messages Tab を有効にし、メッセージを送れるようにする |

- エージェントが投稿に使う scope は、Sentinel が持つ token の側の話で、受けるのには要らない。下の「投稿の CLI」には `chat:write`（投稿）、`chat:write.customize`（表情のアイコン）、`files:write`（画像）と、チャンネルを名前で探すための `channels:read`・`groups:read` が要る。同じ App の bot の token を両方で使うときは、両方の scope を持たせる（ADR-0028 の Consequences）。
- bot は、入っているチャンネルの出来事だけを受ける。受けたいチャンネルに bot を招く。
- `app_mention` は購読しなくてよい。メンションは `message.*` で届く。購読しても、読まずに受けたことだけを返す。
- 取り直しは `conversations.history` と `conversations.replies` を呼ぶ。Slack は 2025 年に、Marketplace に出していない配布の App のこの 2 つの上限を大きく下げた。自分のワークスペースにだけ入れる App として作る。

### 接続

- ワークスペースごとに接続を 1 本張る。最初に bot の token で `auth.test` を呼んで bot のユーザー・bot の ID・ワークスペースを知り、app-level token で `apps.connections.open` を呼んで得た URL へ WebSocket をつなぐ。
- Slack が `hello` を送ってきたら、つながったとしてログに書き、取り直しを始める（下の「つなぎ直しの取り直し」）。人とチャンネルの名前の覚えは、そのたびに捨てる（名前の変更を拾うため）。
- `disconnect`（`refresh_requested`・`warning` など）が来たら、その接続を閉じ、すぐに新しい接続を張る。
- 30 秒ごとに ping を送る。次の ping の時までに pong も何かの封筒も来なければ、その接続を切ってつなぎ直す。
- つなげない・`hello` の前に切れたときは、待ってからつなぎ直す。待ちは 1 秒から始め、続けて失敗するたびに倍にし、5 分を上限にする。`hello` を受けたら 1 秒に戻す。token が取り消されたときも、ログに書いてこの待ちでつなぎ直し続ける。
- 封筒は届いた順に 1 つずつ扱う。`events_api` の封筒は、作った出来事をすべて取り込み口が受けてから `envelope_id` を返す。受けなければ返さず、Slack の送り直しに任せる。出来事を作らなかった封筒（読まない出来事、別のワークスペースの出来事）にも返す。
- `events_api` でない封筒（`slash_commands`・`interactive` など）は、読まずに `envelope_id` を返す。
- Slack は 3 秒以内に返されない封筒を送り直す。ファイルを取るのに長くかかると同じ出来事が 2 度届くが、同じ `id` なので backend が落とす。
- 外向きの接続は Sentinel を通らない（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。receivers のコンテナから `slack.com` とそのファイルの置き場に届く必要がある。

### 出来事にするもの

| Slack の出来事 | 出来事 |
| --- | --- |
| `message`（subtype なし・`bot_message`・`file_share`・`me_message`・`thread_broadcast`） | 発言。チャンネル・スレッドの返信・DM・グループ DM。エージェント自身の発言も |
| `message` の `message_changed` | 編集。ただし本文とファイルが前と同じもの（リンクの展開や返信の数の変化）は捨てる |
| `message` の `message_deleted` | 削除 |
| `reaction_added`・`reaction_removed` | リアクションの付け外し。発言に付いたものだけ（ファイルへのものは捨てる） |
| ほか（`channel_join` などの subtype、ほかの種類の出来事） | 捨てる |

- 封筒の `payload.team_id` が、`auth.test` で知ったワークスペースと違う出来事は捨てる。

### 出来事の作り方

| 欄 | 作り方 |
| --- | --- |
| `id` | 発言は `<ワークスペース>/<チャンネルの ID>/<ts>`。取り直しで届いても同じになる。編集・削除・リアクションは `<ワークスペース>/<Slack の event_id>` |
| `occurred_at` | 発言は `ts` の時刻。ほかは封筒の `event_time`、無ければ受けた時刻 |
| `stream` | チャンネルは `<ワークスペース>.<チャンネルの名前>`、DM は `<ワークスペース>.dm.<相手のユーザー名>`。上の「`stream` の写し方」で写す（`work.dev`、`work.dm.alice`）。チャンネルの名前が分からなければ ID を使う |
| `delivery` | 下の「`delivery`」 |
| `summary` | 下の「`summary` の形」 |
| `payload` | 下の「`payload`」 |

- チャンネルの名前は `#` の無い名前、ユーザー名は Slack の `name`（表示名ではない）である。チャンネルの名前を変えると、その後の出来事は新しい `stream` に入る。チャンネルの ID は `payload` に残る。
- グループ DM（mpim）の `stream` は、Slack の付けた名前（`mpdm-alice--bob-1` など）から作る。

#### `delivery`

- 発言が `now` になるのは、エージェント自身の発言でなく、次のどれかに当たるとき: bot へのメンション（本文に `<@bot のユーザー ID>` がある）、DM（`im`）、`now_channels` のチャンネル。
- ほかの発言、編集・削除・リアクションは、すべて `batch`。いつも明示する。
- グループ DM はメンションのときだけ `now` である。
- 取り直しで届いた発言も、同じ決め方をする。backend に既にあれば重複として落ちるので、ターンには入らない。

#### `summary` の形

- 発言は `<ワークスペース> <場所> <話し手>: <本文>`。編集は `<ワークスペース> <場所> <話し手> edited: <本文>`、削除は `<ワークスペース> <場所>: a message was deleted`、リアクションは `<ワークスペース> <場所> <人> reacted :<名前>:`（外したら `took off`）。
- `<場所>` は `#<チャンネルの名前>`、DM は `DM with <相手の表示名>`、グループ DM は `group DM <名前>`。
- `<本文>` は Slack の記法を読める文にしたもの（`<@U…>` を `@<表示名>` に、リンクを `文字 (URL)` に）。改行と制御文字の扱いと、200 文字（Unicode のコードポイント）までに切ることは、Alertmanager の「`summary` の形」と同じである。
- 例: `work #dev Alice: the deploy is done @Bob`

#### `payload`

型は `packages/slack` の `src/payload.ts` が正である。どの出来事も次の欄を持つ。

| 欄 | 中身 |
| --- | --- |
| `type` | `message`・`message_changed`・`message_deleted`・`reaction_added`・`reaction_removed` |
| `workspace` | ワークスペースの名前（設定の `name`） |
| `channel` | `id`・`name`（`#` の無い名前、DM は相手の表示名）・`type`（`channel`・`group`（プライベートチャンネル）・`im`・`mpim`） |
| `ts` | 発言の `ts`。編集・削除・リアクションでは、その対象の発言の `ts` |
| `thread_ts` | スレッドの返信のときだけ、親の `ts`。親そのものには付けない。リアクションには付かない |

`message` と `message_changed` は、さらに次を持つ。

| 欄 | 中身 |
| --- | --- |
| `user` | 話し手。`id`（Slack のユーザー ID）と `name`（表示名、無ければ本名、無ければユーザー名、分からなければ ID）。ユーザーの無い bot の発言は `name` と `bot: true` だけ。bot のユーザーにも `bot: true` |
| `own` | エージェントの bot の発言なら `true` |
| `text` | Slack の本文そのまま（記法を含む） |
| `names` | 本文の記法が ID で指す人とチャンネルの名前（`{"U0123": "Bob"}`）。無ければ省く |
| `files` | 付いたファイル。1 件は `id`・`name`・`mimetype`・`size`・`attached`。無ければ省く |

`message` は、さらに次を持つ。

| 欄 | 中身 |
| --- | --- |
| `mention` | bot へのメンションなら `true` |
| `subtype` | Slack の subtype があるときだけ |
| `edited` | 受けたときに既に編集されていたら `true` |
| `reactions` | 取り直した発言だけ。そのときに付いていたリアクション。1 件は `name`・`users`（上の `user` と同じ形）・`count` |
| `fetched` | 取り直した発言なら `true` |

リアクションは `user`・`own`・`reaction`（絵文字の名前、`:` は無し）を持つ。削除はほかの欄を持たない。

- `payload` と `summary` の中身は外から来た文である（ADR-0028 の Decision 項 3）。

### ファイル

- 発言のファイルのうち、`mimetype` が `file_types` にあり、`size` が `max_file_bytes` 以下で、`url_private_download`（無ければ `url_private`）があるものを、bot の token で取ってくる。取れたものを出来事の添付として取り込み口へ送り、`payload` の `files` の `attached` を `true` にする。添付は `attached` が `true` のファイルの順に、`/sources` の行の `attachments` に並ぶ。
- 1 つの出来事の添付は、合わせて 60 MiB までにする（取り込み口の 64 MiB の内に収めるため）。超えるもの、上限を超えるもの、種類の違うもの、取れなかったもの（取ってみたら上限より大きかったものを含む）は、`attached` を `false` にして、あったことだけを残す。
- Slack が、取る権限の無いファイルに HTML のページを返したときは、取れなかったものとする。
- 編集では、ファイルを取り直さない。

### つなぎ直しの取り直し

- `hello` を受けるたびに（起動の後の最初の接続も）、bot の入っている会話（`users.conversations` のチャンネル・プライベートチャンネル・DM・グループ DM）を 1 つずつ、`backfill_hours` 前から後の発言を `conversations.history` で取る。返信を持つ発言で、最後の返信がその時刻より後のものは、`conversations.replies` で返信も取る。
- 取った発言は、ふつうの発言と同じ形の出来事にし（`fetched` と `reactions` が付く）、会話ごとにまとめて取り込み口へ送る。取り込み口が受けなければ、そこで取り直しをやめる（次のつなぎ直しでまた取り直す）。
- Slack が断った会話はログに書いて飛ばし、ほかの会話を続ける。
- 取り直しは 1 つずつ走る。走っている間に次の `hello` が来たら、終わってからもう一度走る。
- 取り直しのたびに、取り直す長さの中のファイルをもう一度取ってくる。
- 取り直せないもの: 切れていた間の編集・削除・リアクション（ADR-0028 の Decision 項 6）、親が取り直す長さより前にあるスレッドへの返信、取り直す長さより前の発言。

### ログ

標準エラーに次の形で書く。前に `receivers: connection=<name> workspace=<ワークスペース> ` が付く。本文・名前・token は書かない。

| 行 | いつ |
| --- | --- |
| `connected` | `hello` を受けた |
| `Slack asked for a new connection (<理由>)` | `disconnect` を受けた |
| `no answer to a ping; closing the connection` | ping に答えが無い |
| `cannot connect (<メソッド>: <Slack のコード>)`・`connecting again in <秒>s` | つなげない |
| `envelope=events_api events=<数> dropped=<数> taken=<true か false>` | 封筒 1 つごと |
| `filled in conversations=<数> events=<数> failed=<数>` | 取り直しの終わり。途中でやめたら後ろに `stopped` |
| `cannot name a person (…)`・`cannot name a channel (…)`・`cannot fetch a file (…)`・`cannot fill in a conversation (…)` | Web API の呼び出しが断られた。出来事は名前の代わりに ID で作る、ファイルはあったことだけを残す |

### 置き場所の例

`source` が `slack` なら、`work` の `#dev` の発言は `/sources/slack/work.dev/<YYYY-MM-DD>.jsonl` に、その添付は `/sources/slack/files/<seq>-<ファイルの名前>` に足される（[events.md](events.md) の「`/sources`」）。

### 描き方と読み取りの CLI

`/sources` の行は追記するだけなので、発言の今の姿は、行を `seq` の順に組み立てて作る。`packages/slack` の描き方が、それをチャンネル → スレッド → 発言の形の文にする（ADR-0029）。

- 1 つのチャンネルは、見出しの行（`work #dev (channel C0DEV, stream work.dev)`、DM は `work DM with Alice (…)`）と、発言の行の並び。発言は `- <月-日 時:分> <話し手> [<ts>]: <本文>` で、エージェント自身なら話し手に `(you)`、ほかの bot なら `(bot)` を付ける。本文は記法を読める文にし、続きの行は字下げする。編集された発言は `(edited)` を付けて今の本文、削除された発言は `(deleted)` だけを出す。
- 発言の下に、字下げして、リアクション（`reactions: :+1: Bob, Carol`）、ファイル（`file <名前>: <添付のパス>`、取らなかったものは `file <名前> (<種類>, <大きさ>): not fetched`）、スレッドの返信を並べる。
- 親を読めなかった返信は `- thread of [<ts>] (not read)` の下に、読めなかった発言へのリアクションは `- message [<ts>] (not read)` の下に並ぶ。
- ターンに載せる変化の描き方（変化だけを描き、返信の親とリアクションの付いた発言は `(earlier)` を付けて 60 文字までの 1 行にし、リアクションは `+ :名前: 人`・`- :名前: 人` の行で足し外しを出す。量の上限を超えたら古い変化を省き、`(<数> earlier changes left out; slackctl history <stream>)` を添える）も同じ package にある。ターンにどう入れるかは [events.md](events.md) の「ターンに入る形」の「Slack の出来事」にある。
- 時刻は CLI では `TZ` の時間帯（無ければ UTC）で出す。

Slack の出来事をターンに描いて載せるには、配置が、この有効化の `source` を backend の `PENELOPE_INLINE_SOURCES` と runner の `PENELOPE_SLACK_SOURCES` の両方に書く。runner は同じ image の中のこの package で描くので、描き方と CLI の版は揃う。

読み取りの CLI `slackctl` は sandbox の image に入る。

| 書き方 | 出すもの |
| --- | --- |
| `slackctl workspaces` | 見えるワークスペースと、そのチャンネルの数 |
| `slackctl channels` | `stream` ごとに、ワークスペースとチャンネルと、いちばん新しいファイルの日 |
| `slackctl history <stream> [--limit N] [--days N]` | その `stream` の新しい方の `N` 日分（既定 7）のファイルを読み、最後の `N` 件（既定 30、返信は数えない）の発言を今の姿で |
| `slackctl thread <stream> <ts>` | 発言 `<ts>` とその返信のすべてを今の姿で。親の日の前の日から後のファイルを読む |

- どれも `--sources <場所>`（既定 `/sources`）、`--source <名前>`（既定 `slack`。有効化の `source` を変えた配置で使う）、`--time-zone <時間帯>` を受ける。
- 無い `stream` や `thread` は終了コード 1、書き方の誤りは 2 で、標準エラーに理由と使い方を書く。

### 投稿の CLI

同じ `slackctl` で、エージェントとして Slack に投稿する（[ADR-0033](adr/0033-slack-posts-through-slackctl-with-the-token-stand-in.md)）。通信は Sentinel を通り、鍵はサロゲートのまま送る。curl で Web API を呼んでもよい。

| 書き方 | すること |
| --- | --- |
| `slackctl post --channel <チャンネル> [--workspace <名前>] [--thread <ts>] [--face <表情>] [--image <ファイル>]...` | 標準入力の本文を `chat.postMessage` で投稿し、続けて画像を共有する |
| `slackctl faces` | `--face` に書ける表情と、Slack に渡すアイコンの URL |

- 本文は標準入力を UTF-8 として読み、末尾の空白と改行を除いて、そのまま送る（複数行も Slack の記法もそのまま）。画像だけを送るときは標準入力を空にする（`</dev/null`）。本文も画像も無ければ書き方の誤りである。
- `--channel` はチャンネルの ID（`C…`・`G…`・`D…`）か名前（`#` は付けても付けなくてもよい）。名前は `users.conversations` で、bot の入っている公開・非公開のチャンネルから探す。DM は ID で書く（読み取りの見出しの `channel <ID>`）。
- `--thread` はスレッドの親の発言の `ts`。本文も画像もそのスレッドに入る。
- `--image` は何度でも書ける。画像は Slack の 3 段で送る: `files.getUploadURLExternal`（`filename` と `length`）→ 返った `upload_url` へ中身を POST（`application/octet-stream`、`Authorization` を付けない）→ 全部を 1 回の `files.completeUploadExternal` で、本文と同じチャンネル（とスレッド）に共有する。本文があれば、画像は本文の後の別の投稿になる。
- `--face` を書くと、表情の画像の URL を、本文の投稿と画像の共有の `icon_url` に入れる。URL は `PENELOPE_PUBLIC_URL` の `/api/agent`（ログインなし）が返す表情の道（[ui-api.md](ui-api.md) の「エージェント」、画像の拡張子で終わる）で、Slack はそれを外から取りにくる。表情の PNG（`png_icons`）があればその道、無ければ Web UI と同じ画像の道（`icons`）を使う。`PENELOPE_SLACK_ICON_BASE_URL` があるときは、その下の `<表情>.png` を使う（backend に Slack が届かない配置のため。表情の名前は backend から読む）。投稿の名前は変えない。

| 環境変数（sandbox） | 中身 |
| --- | --- |
| `SLACK_BOT_TOKEN` | `--workspace` を書かないときの bot の token のサロゲート |
| `SLACK_BOT_TOKEN_<名前>` | `--workspace <名前>` のときのサロゲート。`<名前>` はワークスペースの名前を大文字にし、`-` を `_` にしたもの（`--workspace home-two` なら `SLACK_BOT_TOKEN_HOME_TWO`）。ワークスペースの名前は上の「設定」の `workspaces[].name` と同じ形 |
| `PENELOPE_PUBLIC_URL` | オーナーが backend に届く公開の URL（backend の同じ名前の設定と同じ値）。`--face` と `faces` が使う |
| `PENELOPE_SLACK_ICON_BASE_URL` | 任意。Slack に渡すアイコンの URL の頭（例: `https://icons.example.com/iris`）。あれば `--face` と `faces` の URL は `<この値>/<表情>.png` になり、無ければ上の `PENELOPE_PUBLIC_URL` の道。表情ごとの PNG をそこに置いておく |

- 配置は、`slack.com` の登録に、各サロゲートを本物の bot の token に差し替える `bearer` の `credentials` を書く（[sentinel-config.md](sentinel-config.md)）。アップロード先（`files.slack.com`）にはサロゲートを送らない。
- 出力は、投稿した順に 1 行ずつ、タブで区切る。本文は `message <チャンネルの ID> <ts> <permalink>`（permalink は `chat.getPermalink` で取り、取れなければ省く）、画像は `file <ファイルの ID> <名前>`。
- 終了コードは、投稿し終えたら 0、Slack が断った・届かない・サロゲートの環境変数が無い・画像が読めない・表情やチャンネルが無いときは 1、書き方の誤りは 2。標準エラーに理由を書く（Slack が断ったときは `<メソッド>: <Slack のエラー>`）。
- 環境変数・画像・表情・チャンネルは、何かを投稿する前にすべて確かめる。本文を投稿した後に画像で失敗したときは、投稿した分を出力に残して 1 で終わる。

## Signal のプラグイン

Signal の 1 対 1 の会話で、許した相手の発言・ファイル・リアクションを受け、エージェントが返す道を持つ（[ADR-0040](adr/0040-signal-through-signal-cli-in-a-receivers-plugin-with-a-send-socket.md)）。`plugin` は `signal`、種類は接続。Signal には bot の API が無いので、配置がエージェントの番号で登録した [signal-cli](https://github.com/AsamK/signal-cli) を daemon として同じ Pod に置き、その JSON-RPC を Unix socket で使う。実装は `packages/receivers/src/plugins/signal.ts` にある。

### 設定

| `settings` の欄 | 既定 | 中身 |
| --- | --- | --- |
| `socket` | なし（必須） | signal-cli の JSON-RPC の Unix socket（`signal-cli daemon --socket <場所>`）。絶対パス |
| `account` | なし（必須） | エージェントの番号（E.164、`+81…`）。JSON-RPC の呼び出しごとに `account` として渡す（daemon が複数の番号を持つ形でも動く） |
| `senders` | なし（必須） | 受ける相手で、送ってよい相手。番号（E.164）か Signal の UUID の一覧。1 つ以上 |
| `send_socket` | なし | 送り口（下の「送り口」）を待ち受ける Unix socket。省けば送り口を持たない |
| `max_file_bytes` | `20971520`（20 MiB） | 取ってくるファイル 1 つの大きさの上限。1〜62914560（60 MiB）の整数 |
| `rpc_timeout_seconds` | `30` | JSON-RPC の 1 回の呼び出しを待つ秒数 |

- signal-cli の daemon は `--receive-mode on-connection` で動かす。receivers がつないでいる間だけ受け、最後の接続が閉じると受けるのをやめる。receivers との間が切れている間の発言は Signal のサーバーに残り、つなぎ直したときに受ける。取りこぼしうるのは、signal-cli が受けて `receive` の知らせを押し出した後に、取り込み口が受けなかった出来事である（下の「接続」）。
- signal-cli の socket は、signal-cli と receivers のコンテナだけが mount する volume に置く。sandbox は mount しない（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。signal-cli の文書は JSON-RPC の口に認証を書いておらず、届けば番号の操作（送信・グループの操作・端末の追加など）を呼べるためである。同じ理由で `--http`・`--tcp` では待ち受けない（loopback から sandbox が届く）。

### 接続

- `socket` へつなぎ、1 行 1 つの JSON-RPC を話す。daemon が受けた発言は `receive` の知らせ（`params.envelope`）で届く。
- 切れた・つなげないときは、待ってからつなぎ直す。待ちは Slack の接続と同じく 1 秒から倍にし、5 分を上限にする。つながったら 1 秒に戻す。
- signal-cli の `receive` の知らせには、受けたと返す手順が無く、文書は送り直す仕組みを書いていない。取り込み口が受けなかった出来事は、受けるまで同じ待ちで送り直す。30 分送り直しても受けなければ、ログに書いて捨てる（既読も返さない）。
- 止めている間に届いた知らせも、1 回は取り込み口へ送る。止めるときに送れていなければ、ログに書いて捨てる。
- 取り込み口が発言を受けたら、相手に既読（`sendReceipt`、`type: read`）を送る。signal-cli は既定では配達の確認しか返さないためである。

### 出来事にするもの

| envelope | 出来事 |
| --- | --- |
| `dataMessage` の本文かファイルのあるもの | 発言 |
| `dataMessage.reaction` | リアクションの付け外し |
| ほか（`groupInfo` のある発言、`senders` にない相手、既読・入力中・`syncMessage`、本文もファイルも無いもの） | 捨てる |

相手は `sourceNumber` か `sourceUuid` が `senders` にあるかで見る（`sourceUuid` が `null` で届くことがあるため両方を見る）。

| 欄 | 作り方 |
| --- | --- |
| `id` | `<相手の番号（無ければ UUID）>/<発言の timestamp>`。リアクションはリアクションの発言の timestamp |
| `occurred_at` | 発言の timestamp の時刻 |
| `stream` | `dm.<番号の + を除いたもの>`（無ければ UUID）を「`stream` の写し方」で写したもの |
| `delivery` | 発言は `now`、リアクションは `batch` |
| `summary` | `Signal <名前>: <本文>`（ファイルがあれば後ろに `(<数> file(s))`）、リアクションは `Signal <名前> reacted <絵文字>`（外したら `took off`）。`<名前>` は相手のプロフィールの名前、無ければ番号。改行と 200 文字の扱いは Alertmanager と同じ |

`payload`（型は `SignalPayload`）:

| 欄 | 中身 |
| --- | --- |
| `type` | `message` か `reaction` |
| `from` | `number`・`uuid`・`name`（あるものだけ） |
| `timestamp` | Signal の発言の時刻（ミリ秒）。リアクションと引用はこれで指す |
| `text` | 本文（あるときだけ） |
| `quote` | 引用した返事のとき、引用元の `timestamp` と `text` |
| `files` | 付いたファイル。1 件は `name`・`mimetype`・`size`・`attached` |
| `reaction` | `emoji`・`target_timestamp`・`removed` |

- 発言は `payload.text` を持つので、配置がこの有効化の `source` を backend の `PENELOPE_INLINE_SOURCES` に書けば、本文がそのままターンに載る（[events.md](events.md) の「`inline`」）。添付の画像も画像として載る。
- ファイルは `getAttachment` で取り、出来事の添付として送る。上限を超えるもの、合わせて 60 MiB を超えるもの、取れなかったものは `attached` を `false` にする。種類は問わない。

### 送り口

`send_socket` があれば、そこで HTTP を待ち受ける。sandbox は mount せず、Sentinel が登録の `upstream: unix://<send_socket>` で届ける（backend の sandbox 向けの口と同じ形。[sentinel-config.md](sentinel-config.md) の「上流」）。sandbox からの要求は Sentinel を通り、記録に残る。

| 要求 | 中身 |
| --- | --- |
| `POST /v1/send` | form（`multipart/form-data` か urlencoded）。`text`、`to`（省けば `senders` の最初）、`file`（何度でも）。上限 64 MiB |

| 応答 | 意味 |
| --- | --- |
| `200` | `{"timestamp": <送った発言の Signal の時刻>}` |
| `400` | form でない、本文もファイルも無い |
| `403` | `to` が `senders` に無い |
| `502` | signal-cli が断った、Signal が受けなかった（`results` に `SUCCESS` でないものがある） |
| `503` | signal-cli につながっていない |

- 本文は末尾の空白と改行を除いて `send` の `message` に、ファイルは `data:<種類>;filename=<名前>;base64,…` の形で `attachments` に入れる。
  - `<名前>` はパーセントエンコードする（`encodeURIComponent`）。signal-cli は data URI の引数の値を URL デコードするので、そのままだと `%` は壊れ、`+` は空白になる。
  - `<種類>` は form のファイルの `Content-Type` の `type/subtype`（`;` から後の引数は落とす）。それが無いか `application/octet-stream` なら、名前の拡張子（`png`・`jpg`・`jpeg`・`gif`・`webp`・`mp4`・`mov`・`m4a`・`ogg`・`pdf`）から決め、どれでもなければ `application/octet-stream` のまま。curl の `-F file=@x.webp` は WebP や MP4 を `application/octet-stream` で送り、そのまま渡すと Signal は画像や動画でなくファイルとして見せるためである。
- 応答の body は `{error}` の JSON。ログは `send status=<番号>` だけで、本文と宛先は書かない。
- 使い方は sandbox の image の skill `signal` にある。

### ログ

前に `receivers: connection=<name> ` が付く。本文・番号・名前は書かない。

| 行 | いつ |
| --- | --- |
| `connected`・`connection error (<code>)`・`connecting again in <秒>s` | つないだ・切れた |
| `envelope events=<数> dropped=<数>`（受けたら `taken=true`、止めるときに送れなければ `taken=false (stopping)`、30 分受けられずに捨てたら `dropped=1 taken=false (refused for 30 minutes, <回数> tries)`） | envelope 1 つごと |
| `cannot fetch a file (…)`・`cannot send a read receipt (…)` | JSON-RPC が断られた |
| `send status=<番号>` | 送り口の要求 1 つごと |

### 未決

- グループ、入力中の表示、エージェントからのリアクション、編集・削除の扱い。

## 後に足すプラグイン

ADR-0023・ADR-0024 が決めず、後の判断に回したもの。それぞれ、決めるときに ADR を書き、この文書に節を足す。

- GitHub のほかのイベント（issue、コメント、`pull_request_review` の `submitted` など）を読むこと。
- Slack: [ADR-0028](adr/0028-slack-received-over-socket-mode-by-a-receivers-plugin.md) で決め、上の「Slack のプラグイン」に書いた。ターンに inline で載せることは [ADR-0029](adr/0029-slack-events-inline-drawn-as-channels-and-threads.md) で決め、上の「描き方と読み取りの CLI」と [events.md](events.md) の「Slack の出来事」に書いた。
- 鳴り続けているアラートの知らせ（いまは鳴り始めと鳴り止みだけ）。
- エージェントが Alertmanager にアラートを足す道（`drop_labels` の印）と、返事の知らせ（[ADR-0027](adr/0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md) の Web Push）との関係。
