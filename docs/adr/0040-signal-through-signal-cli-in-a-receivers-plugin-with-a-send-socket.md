# 0040. Signal は receivers のプラグインが signal-cli の JSON-RPC で受け、送り口は Sentinel から Unix socket で届ける

- Date: 2026-11-18
- Status: Accepted

## Context

natsumi では、オーナーが Signal でエージェントと話していた。penelope に移した配置でも、Signal の 1 対 1 の会話で話せるようにしたい。

確かめた事実は次のとおりである（References）。

- Signal には bot の API が無い。エージェントの番号を [signal-cli](https://github.com/AsamK/signal-cli) で登録し、その daemon を通して受けて送るのが、natsumi でも使ってきた形である。
- signal-cli の daemon は JSON-RPC を Unix socket・TCP（既定 `localhost:7583`）・HTTP（既定 `localhost:8080`）で待ち受け、複数のクライアントの要求を受ける。文書は、この口に認証の仕組みを書いていない。届けば、送信・グループの操作・端末の追加（`addDevice`）なども呼べる。
- `--receive-mode` は、受け始める時を `on-start`・`on-connection`・`manual` から選ぶ。自動で受ける形では、受けた発言は `receive` の知らせとしてクライアントへ押し出され、クライアントから受けたと返す手順は無い。文書は「取りこぼさないためには `manual` で自動の受信を止められる」と書いている。押し出した知らせを送り直す仕組みは書かれていない。
- signal-cli は既定で配達の確認を返す。既読は `--send-read-receipts` を付けたときか、`sendReceipt` で返す。
- receivers には、外へ接続を張る種類のプラグインがある（ADR-0028 の Decision 項 1）。
- Pod の中の口は Unix socket だけで待ち受ける。sandbox の loopback は sandbox に任せるので、TCP で待ち受けた口には sandbox が届く（ADR-0014）。Sentinel は、登録したホストの上流に `unix://` を書ける（backend の sandbox 向けの口と同じ形）。

## Decision

本 ADR は、receivers に Signal のプラグインを足し、エージェントが Signal に送る道を、そのプラグインが持つ送り口にする。取り込み口・封筒・配送の約束（ADR-0002・ADR-0013）と、外へ接続を張る種類のプラグインの決まり（ADR-0028 の Decision 項 1）は変えない。

### 1. signal-cli は同じ Pod に置き、Unix socket だけで話す

- 配置が signal-cli の daemon を同じ Pod のコンテナとして置く。receivers の Signal のプラグインは、その JSON-RPC の Unix socket につなぐ。
- signal-cli の socket は、signal-cli と receivers のコンテナだけが mount する volume に置く。sandbox は mount しない。signal-cli は TCP・HTTP では待ち受けない。

### 2. 受けるもの

- 設定に書いた相手（`senders`）との 1 対 1 の会話の、発言・ファイル・リアクションを出来事にする。ほかの相手とグループは捨てる。
- 発言は `now`、リアクションは `batch` にする。発言は `payload.text` を持ち、配置が inline にすれば本文がそのままターンに載る。
- 取り込み口が受けなかった出来事は、signal-cli が知らせを送り直さないので、プラグインが受けるまで送り直す。ただし 30 分で諦めてログに残す（送り直しで後の発言をいつまでも止めないため）。取り込み口が受けたら、相手に既読を返す。

### 3. 送り口はプラグインが持ち、Sentinel から届ける

- プラグインは、設定の Unix socket で HTTP の送り口（`POST /v1/send`）を待ち受ける。sandbox は mount しない。Sentinel が登録のホストの上流 `unix://` で届ける。
- 送り口が送るのは `senders` の相手だけである。それ以外の宛先は断る。
- エージェントの送信は、ほかの外向きと同じく Sentinel を通り、記録に残る（ADR-0003）。使い方は image の skill `signal` に書く（ADR-0035）。

### 守る対象と、失敗したときの倒し方

- 守る対象は、エージェントの番号（signal-cli が持つ鍵）と、エージェントの出来事の入口である。
- sandbox が signal-cli の JSON-RPC に直接届く道を作らない。sandbox ができるのは、送り口で `senders` に送ることだけである。
- signal-cli につながらないときは、ログに残してつなぎ直し続ける。ほかの有効化の受け口は止めない。送り口は `503` を返す。
- 設定が誤っているとき（socket・番号・`senders` が無いなど）は、receivers は起動しない（ADR-0023 の Decision 項 1）。
- ログに本文・番号・名前を書かない。

### 本 ADR で決定しないこと

- 設定の欄の名前と既定、`payload` の欄、`id` と `stream` の組み立て、送り口の form の欄と応答（委譲先: [receivers の仕様書](../receivers.md) の「Signal のプラグイン」）
- グループ、入力中の表示、エージェントからのリアクション、編集・削除の扱い（委譲先: それぞれを足す作業単位）
- 送る中身を判定すること（委譲先: ADR-0028 の「本 ADR で決定しないこと」に挙げた、投稿を判定するコネクタ）
- signal-cli のコンテナ、番号の登録、volume の置き方（委譲先: 配置のリポジトリ）

## Consequences

- 公開の URL を持たずに Signal で話せる。
- エージェントの番号でできることのうち、sandbox に開くのは `senders` への送信だけになる。
- 送り口が receivers の中にあるので、receivers が初めて sandbox から（Sentinel を通って）呼ばれる口を持つ。
- signal-cli は押し出した知らせを送り直さないので、取り込み口への送り直しは receivers が持つ分だけである。取り込み口が 30 分受けなかった出来事と、receivers が止まるときに取り込み口が受けなかった出来事は失われる。`on-connection` の signal-cli は receivers がつないでいない間は受けないので、その間の発言は Signal のサーバーに残り、失われない。
- signal-cli の版上げと、番号の登録の保ち方は配置の仕事になる。

## Alternatives Considered

- **sandbox から signal-cli の JSON-RPC を直接呼ぶ**: 確かめの無い口を sandbox に開くことになり、番号でできることの全部をエージェントに渡す。
- **送り口を backend に置く**: backend は Signal を知らない。受けるのと送るのを 1 つのプラグインに閉じれば、Signal に固有のものはプラグインにだけある（AGENTS.md の「1 つのサービスに固有のものはプラグイン」）。
- **signal-cli の HTTP（`--http`）で待ち受け、Sentinel から届ける**: loopback で待ち受けるので sandbox からも届く（ADR-0014）。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（送信の記録）
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す（添付）
- Related: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける
- Related: ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す（外へ接続を張る種類のプラグイン、つなぎ直しの待ち）
- Related: ADR-0035 道具の使い方とどの配置にも同じ skill は sandbox の image に skill として入れ、オーナー・記憶の後に並べる

## References

- signal-cli の `signal-cli(1)`（https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc 、2026-11-18 確認）: `daemon` の `--socket`・`--tcp`・`--http` と既定の待ち受け、`--receive-mode`（on-start・on-connection・manual、受け始める時）、`--send-read-receipts`（既定の配達の確認に加えて既読を返す）、`addDevice`・`send`・`sendReceipt`・`getAttachment`
- signal-cli の `signal-cli-jsonrpc(5)`（https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc 、2026-11-18 確認）: 1 行 1 つの JSON-RPC、`receive` の知らせ、「取りこぼさないためには `--receive-mode=manual`」
