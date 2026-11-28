# 0027. 本人への返事はすべて Web Push で知らせ、購読は配置ごとに backend が持つ

- Date: 2026-11-16
- Status: Superseded by ADR-0079

## Context

penelope には、オーナーへの知らせの仕組みが無い。エージェントの返事（`reply`）は、Web UI を開いているときにだけ見える。natsumi のなつみは、iPhone のアプリへの APNs（natsumi ADR 0029）と、ブラウザへの Web Push（natsumi ADR 0070）で返事を知らせていた。なつみ・ミャオ・アキを penelope に移すと（ADR-0026）、iPhone のアプリは使えなくなる。

前提になる事実は次のとおりである。

- Web Push は、ブラウザが push service（ブラウザの作り手が運営する）に購読を作り、送り手はその購読の endpoint に HTTPS で POST する。中身は購読の公開鍵で暗号化し（RFC 8291）、push service は読めない。送り手は VAPID（RFC 8292）の鍵ペアで自分を名乗る。暗号化した中身は 4096 octets まで、平文は最大で 3993 octets である。
- iOS と iPadOS は 16.4 から、ホーム画面に置いた Web アプリ（PWA）で Web Push を受けられる。購読はユーザーの操作から求める。penelope の backend はすでに、ホーム画面に置くための manifest を配っている。
- Sentinel が向け直すのは sandbox の UID の外向きだけで、backend・Sentinel・receivers の外向きは向け直さない（ADR-0003、ADR-0014）。backend はすでに、自分で外へ通信している（GitHub OAuth、A2A の送り手を確かめるための API server と gated の鍵）。
- エージェントの返事は、sandbox から Sentinel を通って backend の sandbox 向けの口に届く（ADR-0002・ADR-0003）。返事の中身は、そこで Sentinel の記録に残る。
- オーナーは、全員をまとめて使う Mac・iPhone のアプリを後で作ると考えている（ADR-0026）。

## Decision

適用範囲は、エージェントの返事をオーナーに知らせることである。Sentinel の承認待ち（ADR-0005）の知らせは扱わない。

### 返事はすべて知らせる

- エージェントが `reply` で返したものは、すべて知らせる。`reply` に、知らせる・知らせないの印は付けない。知らせたいかどうかで返事を書き分けさせない。
- backend は、今そのブラウザが会話を開いているかを見分けない。開いている画面で通知を出すかは、ブラウザの側（service worker）が決める。
- オーナー自身のメッセージ、途中経過、A2A の Task への返事は知らせない。

### 購読は配置ごとに backend が持つ

- 購読は、配置ごとの backend が状態の一部として持つ（ADR-0002 の Decision 項 3（配送の約束）の SQLite）。購読を登録できるのは、オーナーのログインのセッションだけである（ADR-0010）。
- 1 人のオーナーが、PC のブラウザ・スマートフォンのホーム画面の PWA など、いくつでも購読を持てる。
- 購読の登録と解除は、UI 向けの API に足す。口の形はどの配置でも同じにする（ADR-0026 の Decision「Mac・iPhone のアプリは後で作り直し、UI 向けの API はどの配置でも同じ形に保つ」）。

### 送り先の種類を足せる形にする

- 送り先の購読は、種類を持つ形にする。最初の種類は Web Push だけである。後で作るアプリの通知（APNs など）は、種類を 1 つ足して同じ一覧に載せる。
- 知らせる中身（エージェントの名前、返事の本文を短くしたもの、表情、画像の数）は送り先の種類に依らず 1 つに決め、種類ごとの形に写す。

### 中身は暗号化して本文ごと送る

- Web Push の中身は、購読の鍵で暗号化して、返事の本文を短くしたものごと載せる。push service は中身を読めない。
- 本文は上限に収まるように切る。画像の付いた返事（ADR-0032）は、画像の数を添える。

### VAPID の鍵は配置が渡す

- VAPID の鍵ペアは、配置が backend にファイルで渡す（鍵の値は環境変数に置かない。docs/backend.md の「動かし方」）。backend は鍵を作らない。
- 鍵を変えると、それまでの購読はすべて使えなくなる。鍵は配置の Secret として長く保つ。

### backend から push service へは Sentinel を通さない

- Web Push の送信は backend が自分で行い、Sentinel を通さない。
- 理由は 3 つある。Sentinel が受け持つのは sandbox の外向きであり、backend の外向きではない（ADR-0003・ADR-0014）。知らせの中身を決めるのはエージェントではなく backend であり、その元の返事は sandbox から backend へ届くところで Sentinel の記録に残っている。push service の endpoint のホストはブラウザの作り手ごとに違い、Sentinel で開いて鍵を差し替える対象でもない。

### 守る対象と、失敗したときの倒し方

- 守る対象は、返事の中身と、購読（endpoint は、それだけで送り先になる）である。
- 購読を登録できるのはオーナーのセッションだけである。endpoint は https に限り、redirect は追わない。
- 中身は購読の鍵で暗号化する。backend のログには、購読の識別と結果の状態だけを書き、本文と endpoint は書かない。
- 送信は 1 回だけで、送り直さない。返事は会話の履歴に残っており、開けば読める。push service が購読を無いと答えたら（404・410）、その購読を消す。ほかの失敗はログに残すだけにする。
- 知らせに失敗しても、返事そのものは失敗にしない。返事を受けることと知らせることを分ける。
- VAPID の鍵が設定されていなければ、Web Push は無く、UI は使えないことを示す。設定されているのに読めない、形が違うときは、backend は起動しない。

### 本 ADR で決定しないこと

- 購読の登録と解除の口、VAPID の公開鍵を UI に渡す道、知らせの中身の欄、本文を切る長さ（委譲先: [UI 向けの API の仕様書](../ui-api.md)）
- VAPID の鍵のファイルを渡す設定の名前（委譲先: [backend の仕様書](../backend.md) の「設定」）
- service worker の動き（開いている画面での出し方、押したときに開く場所）と、購読を求める画面（委譲先: Web UI の実装の PR と `docs/design/`）
- アプリの通知（APNs など）の種類を足すこと（委譲先: Mac・iPhone のアプリを作り直すときの ADR）
- 承認待ちの知らせ（委譲先: ADR-0005 の「本 ADR で決定しないこと」）
- VAPID の鍵の値と置き場（委譲先: 配置のリポジトリ）

## Consequences

- iPhone のアプリが無くても、ホーム画面の PWA と PC のブラウザで返事の知らせを受けられる。アプリを作り直さずに 3 人を移せる。
- 返事に印を付けないので、エージェントは知らせを意識せずに返事を書ける。代わりに、返事が多いと知らせも多くなる。減らしたいときは、エージェントの返事の仕方（記憶）か、ブラウザの側の出し方で調える。
- 購読が配置ごとなので、4 人の知らせを受けるには、配置ごとに購読する。まとめのアプリができるまで、その手間を受け入れる。
- 送り先の種類を持つ形なので、後でアプリの通知を足すときに、知らせの中身と送る時を作り直さずに済む。
- backend に外向きの通信が 1 つ増え、それは Sentinel の記録に残らない。返事の中身は sandbox から backend へ届くところで記録に残るので、何を知らせたかは記録と会話の履歴から分かる。
- 本文を push service へ（暗号化して）送るので、push service は送った時刻と大きさを知る。中身は読めない。
- 送り直さないので、push service に届かなかった知らせは失われる。返事は履歴にある。

## Alternatives Considered

- **backend から push service への通信も Sentinel を通す**: backend の外向きを Sentinel に向け直す仕組みが新しく要り、push service のホストを開いて記録しても、中身は暗号化されているので読めない。元の返事はすでに記録に残る。
- **返事に知らせる・知らせないの印を付ける**: エージェントが知らせのために返事を書き分けることになり、印の付け忘れで大事な返事が届かない。
- **natsumi と同じく、つながっている端末には送らない**: backend が端末ごとのつながりを追うことになる。開いている画面で出すかはブラウザが自分で分かる。
- **VAPID の鍵を backend が初めての起動で作り、永続の場所に置く**: 永続の場所を作り直すと、黙って鍵が替わり、すべての購読が使えなくなる。配置が Secret として持つ方が、鍵の寿命が配置の管理の中に入る。

## Related ADRs

- Superseded by: [ADR-0079 会話する配置は家に住み、承認は家で答え、個人のページは家から開く](0079-open-resident-pages-from-the-house.md)。
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（backend の状態の SQLite）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（Sentinel が受け持つのは sandbox の外向き）
- Related: ADR-0005 承認待ちは Sentinel が持ち、オーナーは Web UI で答える（承認待ちの知らせは本 ADR の範囲外）
- Related: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Related: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける（「本 ADR で決定しないこと」の、オーナーへの知らせの仕組み）
- Related: ADR-0026 なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移し、記憶は履歴ごと写して、戻し道は持たない
- Related: ADR-0032 返事に sandbox の画像を添え、backend が写して Web UI で見せる
- Related（natsumi、このリポジトリの外）: ADR 0029「iPhone に通知を届ける」、ADR 0070「ブラウザにも Web Push で通知を届ける」

## References

- RFC 8030「Generic Event Delivery Using HTTP Push」（https://www.rfc-editor.org/rfc/rfc8030 、2026-11-16 確認）
- RFC 8291「Message Encryption for Web Push」の Section 4（https://www.rfc-editor.org/rfc/rfc8291 、2026-11-16 確認）: push service は 4096 octets を超える中身を受けなくてよく、平文は最大で 3993 octets
- RFC 8292「Voluntary Application Server Identification (VAPID) for Web Push」（https://www.rfc-editor.org/rfc/rfc8292 、2026-11-16 確認）
- WebKit Blog「Web Push for Web Apps on iOS and iPadOS」（https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ 、2026-11-16 確認）: iOS・iPadOS 16.4 から、ホーム画面に置いた Web アプリが、ユーザーの操作から Push API で購読できる
- [Pod の形の仕様書](../pod.md) の「網」（2026-11-16 確認）: ほかのコンテナの UID の通信は向け直さない
- [UI 向けの API の仕様書](../ui-api.md) の「Web UI の配り方」（2026-11-16 確認）: backend が `/manifest.webmanifest` を作る
- natsumi ADR 0070（https://github.com/yuanying/natsumi/blob/main/docs/adr/0070-web-push-to-the-browser.md 、2026-11-16 確認）: 暗号化して本文ごと送る、404・410 で購読を消す、1 回だけ送る、ログに本文と endpoint を出さない
