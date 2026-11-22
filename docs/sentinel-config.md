# Sentinel の設定と記録の仕様

Sentinel の設定の形と、通信の記録の形を決める。方針は
[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)・[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)・[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)・[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)・[ADR-0020](adr/0020-connectors-with-a-usage-document-listed-in-the-prompt.md)・[ADR-0025](adr/0025-wildcard-host-registrations-for-one-left-most-label.md) にある。
Go の型は Sentinel の実装が持ち、この文書に合わせる。

具体的なホスト名・鍵の置き場所・サロゲートの値は、配置のリポジトリの設定にだけ書く。ここの例はすべて架空である。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## 設定

設定は 1 つの YAML のファイル。

| 欄 | 中身 |
| --- | --- |
| `default` | 開くと決めていないホストの扱い。`passthrough`（素通しで記録だけ）・`ask`（オーナーに聞く）・`deny`。最初は `passthrough`。省けば `passthrough` |
| `hosts` | 開くホストの登録の一覧（下の「ホストの登録」） |
| `allow` | 既定が `ask` のときに素通しでよいホストの一覧（後の波）。最初の版は空 |
| `listen.proxy` | 向け直しの受け口（TCP）のアドレスとポートの一覧。IPv4 と IPv6 を別に書く（例: `0.0.0.0:15001`・`[::]:15001`）。IPv6 のアドレスは IPv6 だけを受ける |
| `listen.dns` | 名前解決の向け直しの受け口のアドレスとポートの一覧。UDP と TCP の両方で受ける |
| `resolver` | 名前解決の上流のアドレスとポート。省けば Sentinel の `/etc/resolv.conf` の最初の `nameserver` の 53 番 |
| `ca.cert`・`ca.key` | Sentinel の CA の証明書と秘密鍵の PEM のファイル（Secret を mount する） |

- 最初の版の Sentinel は承認を持たない。`default: ask` か、空でない `allow` が書かれていれば、起動しない（動いている最中の読み直しなら、前の設定のまま）。
- 知らない欄が書かれていれば、起動しない（書き損じを黙って無視しない）。
- 設定のファイルは 10 秒ごとに読み直し、中身が変わっていれば新しい設定にする。`SIGHUP` を受けたときもすぐに読み直す。新しい設定は、それより後に届いた通信から使う。
- 読み直した設定が読めないか、`listen`・`resolver`・`ca` が変わっていれば、前の設定のまま動き続け、標準エラーにそう書く。これらを変えるには再起動する。

### ホストの登録

1 件が、開いて（TLS を終端して）鍵を差し替えるホスト 1 つ。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `name` | ○ | ホストの名前、またはワイルドカード（`*.example.com`。下の「ワイルドカード」）。SNI で照らす |
| `port` | | 既定 443 |
| `upstream` | | 上流の宛先。省けば `name` を名前解決した先へ `port` の TLS で送る（下の「上流」） |
| `upstream_ca` | | 上流の証明書を確かめる CA のファイル。省けばシステムの CA |
| `credentials` | | 鍵の差し替えの一覧（下の「鍵の差し替え」） |
| `connector` | | コネクタのプラグインの名前。省けばプラグイン無し |
| `connector_config` | | コネクタごとの設定。形はコネクタが決める |

- 名前は大文字と小文字を区別せず、末尾の `.` を除いて照らす。同じ名前とポートを 2 つの登録に書けば、起動しない。
- 特定のホストを特別扱いするコードは書かない。クラスタの API server も、backend も、登録の 1 件である。

### ワイルドカード

- `name` の左端のラベルを `*` にした登録（`*.example.com`）は、`*` の位置のちょうど 1 つのラベルに当たる。`a.example.com` に当たり、`example.com` と `a.b.example.com` には当たらない（TLS の証明書のワイルドカードと同じ）。
- `*` は左端のラベルの全体にだけ、1 つだけ書ける。`*` の後ろには 2 つ以上のラベルが要る。`a*.example.com`・`a.*.example.com`・`*.*.example.com`・`*.com` を書けば、起動しない。YAML では `"*.example.com"` と引用符で囲む（`*` で始まる値は YAML の別名になる）。
- 名前とポートに、完全な名前の登録とワイルドカードの登録の両方が当たるときは、完全な名前の登録を使う。
- SNI に `*` を含む通信は、どの登録にも当たらない。
- 開いた通信では、SNI の名前を「開いた名前」とする。`Host` の照らし（下の「鍵の差し替え」）、sandbox 側の証明書（SNI の名前で発行する）、記録の `host` は、どれも開いた名前を使う。
- ワイルドカードの登録の `credentials` は、当たるすべての名前で使う。完全な名前の登録が勝った名前では、ワイルドカードの `credentials` は引き継がない。勝った登録にサロゲートと置き場所が無ければ、断る（`surrogate-out-of-place`）。

### 上流

- `upstream` は上流の宛先を URL で書く汎用の欄である。特定のホストのための欄ではない。ワイルドカードの登録に書けば、当たるすべての名前をその宛先へ送る。
  - 省いたワイルドカードの登録は、開いた名前を Sentinel が名前解決した先へ、`port` の TLS で送り、上流の証明書を開いた名前で確かめる。
  - `https://<ホスト>:<ポート>`: その宛先へ TLS で送る。上流の証明書は `upstream_ca`（省けばシステムの CA）で確かめる。
  - `http://<ホスト>:<ポート>`: その宛先へ TLS でなく送る。
  - `unix://<socket のパス>`: その Unix socket へ、TLS でない HTTP で送る（例: `unix:///run/penelope/backend/sandbox.sock`）。
- sandbox からの通信は、どの場合も sandbox との間では Sentinel の CA の証明書で TLS を終端する。
- backend の sandbox 向けの口は、この欄で backend の Unix socket を指して登録する（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。

### コネクタのプラグイン

- コネクタ（ホストの登録と使い方の文書の組。下の「コネクタの文書」）のうち、Sentinel に差し込むのがプラグインである。プラグインは、1 つのホストに特化した判定や処理を差し込む（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。判定、そのホストに特有の鍵の扱い（body に鍵を含める要求や署名など、差し替えでは扱えないもの。[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)）、記録を詳しくすることを受け持つ。
- **最初の版の Sentinel はプラグインを 1 つも持たない。** `connector` が書かれた登録があれば、「知らないプラグイン」として起動しない（黙って無視しない）。動いている最中の読み直しなら、前の設定のまま動き続ける（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md) の Decision「守る対象と、失敗したときの倒し方」）。

未決:

- プラグインの差し込み口（Go の interface）の形。最初のプラグインを作るときに決める。

### 鍵の差し替え

`credentials` の 1 件が、要求の 1 か所のサロゲートを本物の鍵に差し替える。

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `place` | ○ | 置き場所。`bearer`（`Authorization` の Bearer と token）・`basic`（`Authorization` の Basic のパスワードの部分）・`header`（名前を決めたヘッダ） |
| `header` | `place` が `header` のとき | ヘッダの名前（例: `x-api-key`） |
| `surrogate` | ○ | sandbox に置くサロゲートの値 |
| `source` | ○ | 鍵の出どころ。最初は `{file: <パス>}` だけ |

- 鍵のファイルは使うたびに読み直す（kubelet が作り直す ServiceAccount の token を指せるようにするため）。前後の空白と改行は除く。空のファイルは読めないものとして扱う。
- 鍵の出どころから鍵が読めないときは、その要求を上流へ送らずに断る（`503`）。
- query の置き場所は後から足す。
- `bearer` は `Authorization` の scheme が `Bearer` か `token`（大文字小文字を問わない）で、その後ろの値がサロゲートと一致するものを差し替える。scheme は書かれたまま残す。
- `basic` は Basic のユーザー名を残し、パスワードの部分だけを差し替える。
- `header` はヘッダの値の全体（前後の空白を除く）がサロゲートと一致するものを差し替える。
- サロゲートは 16 バイト以上の、空白を含まない表示可能な ASCII とする。接頭辞は求めない。
- 同じサロゲートを複数の登録に書けるのは `source` が同じときだけである。`source.file` のパスは設定に書いた文字列で照らし、ファイルの中身は比べない。異なる `source` を書けば起動せず、動作中の読み直しなら前の設定のまま動く（[ADR-0054](adr/0054-share-surrogates-only-for-the-same-key-source.md)）。
- サロゲートを共有しても、差し替えるのは、その要求に当たったホストの登録の `place` だけである。ほかの登録の置き場所は使わない。
- 登録したホストへの要求にサロゲートが無いとき（オーナーが自分の鍵を入れて呼んだときなど）は、そのまま送る。
- 登録したホストへの要求の `Host` が開いた名前（とポート）と違うときは、断る（`403`）。完全な名前の登録では、開いた名前は登録の `name` である。

例（架空の値）:

```yaml
listen:
  proxy: ["0.0.0.0:15001", "[::]:15001"]
  dns: ["0.0.0.0:15053", "[::]:15053"]
ca:
  cert: /run/secrets/example/sentinel-ca/tls.crt
  key: /run/secrets/example/sentinel-ca/tls.key
default: passthrough
hosts:
  - name: api.example.com
    credentials:
      - place: bearer
        surrogate: surrogate-example-0001
        source: { file: /run/secrets/example/token }
  - name: backend.example.com
    upstream: unix:///run/penelope/backend/sandbox.sock
    credentials:
      - place: bearer
        surrogate: surrogate-example-0003
        source: { file: /run/secrets/example/backend-token }
  - name: kubernetes.default.svc
    upstream_ca: /run/secrets/example/ca.crt
    credentials:
      - place: bearer
        surrogate: surrogate-example-0002
        source: { file: /run/secrets/example/sa-token }
  - name: "*.apps.example.com"
    credentials:
      - place: bearer
        surrogate: surrogate-example-0004
        source: { file: /run/secrets/example/apps-token }
allow: []
```

未決:

- 管理口の socket の欄（承認を足すときに決める）。

### 開くか、素通しか

- TLS の ClientHello の SNI とポートが登録の 1 件に当たれば（完全な名前で一致するか、ワイルドカードに当たれば）開く。一致しなければ、TLS を Sentinel の側から 1 バイトも返さずに、ClientHello から元の宛先へ素通しする。
- TLS でない通信のうち、最初の行が HTTP/1 の要求の行であるものは平文の HTTP として読み、要求ごとに元の宛先へ送る（下の「登録の無いホストへのサロゲート」）。
- それ以外の通信と、1 秒のうちに何も送らない通信（相手から先に話す手順のもの）は、読まずに素通しする。
- 開いた通信は、sandbox との間で HTTP/1.1 だけを話し、上流へも HTTP/1.1 で送る。Upgrade（WebSocket・SPDY）はそのまま中継し、応答は届いたぶんから順に返す。
- Sentinel が自分で返す応答には `Penelope-Sentinel` ヘッダ（`deny` か `error`）を付ける。上流の応答に同じ名前のヘッダがあれば取り除く。

## コネクタの文書

コネクタは、ホストの登録（1 つ以上）と、その使い方の文書 1 つの組である（[ADR-0020](adr/0020-connectors-with-a-usage-document-listed-in-the-prompt.md)）。文書は配置が Sentinel の設定の隣に持ち、sandbox に読み取りで置く。runner はその一覧をエージェントのシステムプロンプトに出す。

- 置き場所: sandbox の 1 つのディレクトリ。runner には環境変数 `PENELOPE_CONNECTORS_DIR` で伝える。配置の既定は `/etc/penelope/connectors/`。設定が無ければ、runner はコネクタを読まない。
- ファイル: コネクタごとに `<名前>.md` を 1 つ、ディレクトリの直下に置く。`.` で始まる名前、`.md` でないもの、ディレクトリは読まない。リンクは辿る（ConfigMap の mount の形）。
- 先頭の front matter（YAML）:

| 欄 | 必須 | 中身 |
| --- | --- | --- |
| `name` | ○ | コネクタの名前。ファイルの名前の `.md` の前と同じにする |
| `description` | ○ | 何に使うかの 1〜2 文。一覧にそのまま載る |
| `hosts` | ○ | 使うホストの登録の `name` の一覧（1 つ以上）。ワイルドカードの登録は `*.example.com` のまま書く。一覧にそのまま載る |

- 本文は自由な Markdown である。サロゲートを持つ環境変数や設定ファイル、使う道具（`gh`・`kubectl`・`vmctl`・`curl` の例）、注意を書く。鍵の値とサロゲートの値は書かない。
- runner は、新しいセッションを始めるたびにディレクトリを読み、名前の順に、名前・説明・ホスト・ファイルの場所をシステムプロンプトの「Connectors」の節に出す。本文は出さない。
- ディレクトリが無い、または読めるファイルが 1 つも無ければ、節そのものを出さない。
- front matter が無い・YAML として読めない・必須の欄が欠ける・`name` がファイルの名前と違うファイルは一覧から外し、runner の標準エラーに `connector left out: <パス> <理由>` と 1 行書く。ほかのファイルは一覧に載せる。
- 登録と文書の対応（文書の `hosts` が設定の `hosts` にあり、鍵を差し替える登録がどれかの文書の `hosts` にあること）は、配置のリポジトリが確かめる。Sentinel も runner も確かめない。

例（架空の値）:

```markdown
---
name: github
description: GitHub の API、git の HTTPS、リリースのファイル送信。gh と git で使う。
hosts:
  - api.github.com
  - github.com
  - uploads.github.com
---

`GH_TOKEN` にサロゲートがある。この例では同じ鍵の出どころを使い、
`api.github.com` と `uploads.github.com` では Bearer、`github.com` では Basic に登録する。
```

## 登録の無いホストへのサロゲート

- サロゲートが、登録の無いホスト、または登録に無い置き場所で出ていくときは、その要求を断り、記録に残す（[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md) の「本 ADR で決定しないこと」で委ねられた点）。
- Sentinel が見えるのは、開いた（TLS を終端した）通信と、平文の HTTP の中身だけである。素通しの TLS の中のサロゲートは見えないままとし、見つけるために開くことはしない。出ていくのはサロゲートであり、本物の鍵ではないためである。
- 探すのは、ヘッダの名前と値（Basic は解いた中身も）、path、query で、それぞれ書かれたままと、escape を解いたものを見る。body は見ない。
- 断るときは、`403` と `Penelope-Sentinel: deny` と、理由を書いた短い本文を返す。

## Sentinel が断る通信

- リンクローカル（169.254.0.0/16、fe80::/10）への通信。sandbox の UID のものは iptables で Sentinel へ向け直されてくるので、Sentinel が断り、記録に残す（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。
- 向け直しの受け口へ直に届いた通信（向け直される前の宛先が受け口そのもの）。sandbox の loopback は止めないので、sandbox から受け口へ直につなげるためである。向け直される前の宛先が分からない通信も、直に届いたものとして断る。
- 登録の無いホストへのサロゲート（上の節）と、鍵の出どころから鍵が読めない要求。
- 既定が `deny` のときの、登録の無いホストへの通信。TLS と平文でない通信は閉じ、平文の HTTP には `403` を返す。

記録の `reason` には、次の値を書く。

| `reason` | 断ったもの |
| --- | --- |
| `link-local` | リンクローカルへの通信 |
| `direct` | 受け口へ直に届いた通信 |
| `not-registered` | 既定が `deny` のときの、登録の無いホストへの通信 |
| `host-mismatch` | `Host` が開いた名前と違う要求 |
| `surrogate-out-of-place` | 登録の無いホスト、または登録に無い置き場所のサロゲート |
| `key-unavailable` | 鍵の出どころから鍵が読めない要求 |
| `tls-handshake-failed` | 開くと決めた通信の TLS の握手の失敗 |

## 記録

- 1 つの通信を 1 行の JSON にする。素通しの通信も、開いた通信も、止めた通信も残す。
  - 読まずに素通しした通信は、通信が終わったときに 1 行。
  - 開いた通信と平文の HTTP は、要求ごとに 1 行。
  - 名前解決は、問い合わせごとに 1 行。
- 鍵の値は記録に出さない。サロゲートも出さない（`path` の中のサロゲートは `[surrogate]` に置き換える）。query は記録しない。
- 記録は Sentinel の標準出力に書く。保存期間と見方は、クラスタのログの集め方に任せる。Sentinel 自身の不具合は標準エラーに書く。

| 欄 | 中身 |
| --- | --- |
| `time` | 通信の始まり（RFC 3339） |
| `kind` | `tcp`（読まずに素通しした、または読む前に断った通信）・`http`（読んだ要求）・`dns`（名前解決） |
| `uid` | 送り手の UID。Pod の網の名前空間の `/proc/net` から引く。分からなければ書かない |
| `agent` | エージェントの ID。分かるときだけ（[sandbox-api.md](sandbox-api.md) の「`agent` の欄」。同じ UID なので、要求の中身から分かるときに限る）。最初の版は書かない |
| `host` | 宛先の名前（SNI か `Host`、名前解決の要求なら問い合わせた名前）。ワイルドカードの登録で開いた通信も、登録の `name` ではなく開いた名前 |
| `addr`・`port` | 宛先のアドレスとポート（名前解決なら、上流の resolver のもの） |
| `action` | `passthrough`・`open`・`deny`（後の波で `ask`） |
| `reason` | `deny` のときの理由（上の「Sentinel が断る通信」） |
| `method`・`path`・`status` | 開いたとき、または平文の HTTP のときだけ |
| `qtype` | 名前解決の型（`A`・`AAAA` など） |
| `bytes_in`・`bytes_out` | 量。`bytes_in` は上流から sandbox へ、`bytes_out` は sandbox から上流へ |
| `duration_ms` | 時間 |
| `error` | 断ってはいないが通らなかったときの理由（上流につながらないなど） |

未決:

- 管理口の API の形と、承認待ちの期限（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)。既定を ask に切り替えるときに決める）。
