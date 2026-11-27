# 0013. 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す

- Date: 2026-11-14
- Status: Accepted（一部を [ADR-0055](0055-show-unfinished-work-in-heartbeats.md) と [ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え）

## Context

ADR-0002 で、出来事は小さな共通の封筒と受信元ごとに自由な中身からなり、取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいくと決めた。その中身がエージェントのターンにどう入るか、また過去の中身をエージェントがどう読むかは決めていなかった。

中身をそのままターンに載せると、困ることが 2 つある。

- Slack のチャンネルや監視の警報は量が多い。1 件ずつ全文をターンに載せると、文脈がすぐに埋まる。
- 過去の中身を読む道が要る。backend に問い合わせの口を作ると、どう探せるかを backend が先に決めることになる。エージェントは sandbox の shell で `rg` や `jq` を自由に使えるので（ADR-0011）、ファイルとして置けば探し方は任せられる。

natsumi では、Slack・外のエージェントの返事・監視の警報を `/sources` の下のファイルにし、変わったことを 1 種類の出来事 `sources_updated` で知らせている。ファイルを書くのは受信元ごとの処理で、受信元ごとにファイルの形が違う。差分はサーバーが `/sources` を git の作業ツリーとして持ち、専用のコマンド `sources-diff` で見せる。知らせるまでの待ちは、書き込みの速さから引いた指数分布の乱数である。Slack のリアクションは、元の発言の行の欄を書き換えて記録している。

このうち、ファイルとして置き、合図で知らせる形は penelope でも使える。一方、git と専用の差分の道具、受信元ごとのファイルの書き手、乱数の待ちは、backend とプロンプトに受信元ごとの事情を持ち込む。

オーナーは、すべての出来事の中身を `/sources` に置き、特別な出来事だけ中身をターンに入れ、知らせの名前（`sources_updated`）は無くして 1 つの仕組みに寄せたいとしている。また、出来事には、すぐ差し込むものと、遅れて渡すものの両方がある。

ここで使う言葉は次のとおりである。

- **`/sources`**: 出来事の中身を受信元ごとに置く、永続する場所。
- **inline の受信元**: 中身をそのままターンに載せる受信元。
- **制御の出来事**: runner が受けて手順を回し、エージェントのターンには入らない出来事。

## Decision

本 ADR は、ADR-0002 の決定（取り込み口 1 つ、封筒と自由な中身、配送の約束、runner が取りにいくこと）を変えない。ADR-0002 の上で、中身をどこに置き、ターンに何をいつ渡すかを決める。

### 中身は backend が `/sources` に追記する

- 取り込み口が受けたすべての出来事の中身を、backend が `/sources` の受信元ごとの場所に追記する。中身の形は知らずにそのまま書く（ADR-0002 の Decision 項 1（取り込み口は 1 つ、契約も 1 つ）の「backend は中身の形を知らない」を保つ）。
- `/sources` を書くのは backend だけである。受信元は封筒を取り込み口へ送るだけで、`/sources` を mount しない。sandbox は読むだけである。
- `/sources` は追記するだけで、書き換えない。日付で分け、古い分は日付ごとに消す。git にはしない。
- 編集・削除・リアクションのように前の中身を変える出来事も、起きたことの 1 件として追記する。今の姿は、読む側が行を組み立てて作る。
- 出来事についてきたファイル（添付）も、取り込み口が受けて `/sources` に置く。

### ターンには要約と場所だけを渡す

[ADR-0055 残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md) で、heartbeat の残っている仕事は、要約と場所に加えて直接載せる。通常の inline の設定は変えない。

- ターンに入るのは、出来事ごとの 1 行の要約と、中身を足した場所（ファイルと行の範囲）だけである。中身は、エージェントが必要なときに sandbox の shell で読む。
- 中身をそのままターンに載せるのは、inline の受信元の出来事だけである。どの受信元を inline にするかは backend の設定で決める。最初はオーナーのメッセージと制御の出来事だけとする。
- 知らせのための特別な出来事（`sources_updated` の類）は作らない。どの出来事も同じ仕組みで渡る。

### 渡す時は受信元の側が出来事ごとに決める

- 出来事は、すぐ渡す（`now`）か、まとめて後で渡す（`batch`）かを持つ。`now` は、ターンの最中なら割り込み、待っていればすぐにターンにし、起きている時間の外でも渡す。`batch` は、最初の 1 件から決めた時間だけ待ってまとめて渡し、起きている時間の外に来たものは朝まで渡さない。
  - 2026-11-27 追記: 起きている時間に結び付いた点は [ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え。起きている時間の設定はやめ、エージェントが起きていない間（寝つく間と寝ている間）は、`now` も `batch` も渡さずに溜め、起きたときに渡す。
- どちらにするかを決めるのは、受信元の側だけである。receivers のプラグインは自分の設定に従って出来事ごとに決め、backend はそれを上書きしない。backend の中の受信元（オーナーのメッセージ・予約・A2A・自分宛ての出来事）は backend の設定で決める。
- 待ちは決めた時間とし、乱数で引かない。

### 夜の切り替えは制御の出来事

- 夜の切り替え（ADR-0007）の合図は、backend が待ち行列に入れる制御の出来事とする。runner がそれを受けて切り替えを回す。

### 受信元のプラグインは読むための道具を持てる

- 受信元のプラグインは、受信の処理と、`/sources` の中身を読むための CLI を組で持てる。CLI は sandbox の image に入る。中身の読み方をプロンプトには書かない（ADR-0008）。

### 守る対象と、失敗したときの倒し方

- 守る対象は、受けた出来事の中身が落ちないことと、sandbox が `/sources` を書き換えられないことである。
- backend が中身を `/sources` に書けなかった出来事は、受けたことにしない。受信元は同じ ID で送り直す（ADR-0002 の Decision 項 3（配送の約束））。

### 本 ADR で決定しないこと

- `/sources` の置き場所の形（ディレクトリとファイルの名前）、封筒の欄、ターンに入る形、`batch` の待ちの長さ（委譲先: [出来事の仕様書](../events.md)）
- sandbox 向けの口の形（委譲先: [sandbox 向けの口の仕様書](../sandbox-api.md)）
- `/sources` の保存期間（委譲先: backend の設定）
- Slack のプラグインが書く行の形と、読むための CLI（委譲先: Slack のプラグインの文書）
- 夜の切り替えの途中で失敗したときの扱い（委譲先: [backend の仕様書「夜の切り替え」](../backend.md#夜の切り替え)。段ごとの扱いは [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) の Decision 項 1「夜の切り替えを 4 段にする」に従う）

## Consequences

- 受信元を足しても、backend とプロンプトは変わらない。中身はすべて同じ場所に同じ書き方で置かれ、知らせも同じ仕組みで渡る。
- 量の多い受信元でも、ターンに入るのは要約と場所だけなので、文脈が埋まりにくい。中身を読むかどうかはエージェントが決める。
- 過去の中身は、ファイルとして sandbox の道具で探せる。backend に問い合わせの口は要らない。
- 一方で、中身を読むには、エージェントが毎回ファイルを開くことになる。短い中身でも、inline でない受信元なら 1 手かかる。
- `/sources` は git ではないので、natsumi のような「前回見せた時点からの差分」は無い。代わりに、出来事ごとに足した行の範囲を渡す。
- 追記するだけなので、Slack の発言の今の姿を見るには、編集やリアクションの行を組み立てる手間がかかる。これを受信元のプラグインの CLI に任せる。
- receivers は `/sources` を書かないので、ファイルの形を受信元ごとに整えられない。中身の JSON は、封筒の欄と並べてそのまま 1 行に書く形で受け入れる。
- `/sources` が backend の書き込みに依存するので、backend の永続の場所が埋まると、出来事を受けられなくなる。

## Alternatives Considered

- **封筒をそのまま渡し、大きな中身と過去は sandbox 向けの口で backend に引かせる**: 問い合わせの形（どう探せるか）を backend が先に決めることになり、エージェントの探し方が狭まる。
- **receivers のプラグインも `/sources` に書く**: 受信元ごとに読みやすい形でファイルを書けるが、書き手が 2 つになり、receivers に `/sources` を mount することになる。
- **natsumi と同じく `/sources` を git にし、差分を専用の道具で見せる**: 前回からの差分を見せられるが、git の管理と専用の道具が backend と sandbox に増える。行の範囲を渡せば足りる。
- **backend の設定で受信元ごとに渡す時を上書きできるようにする**: 決める場所が受信元の側と backend の 2 つになる。

## Related ADRs

- Superseded by（一部）: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（Decision 項 3「渡す時は受信元の側が出来事ごとに決める」の、`now` は起きている時間の外でも渡し、`batch` は起きている時間の外では朝まで渡さない点。`delivery` を受信元の側が決めることは変えない）
- Superseded by（一部）: [ADR-0055 残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md)（Decision 項 2「ターンには要約と場所だけを渡す」に、heartbeat の残っている仕事だけの例外を加える）
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0007 セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える（切り替えの出来事と担当）
- Related: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md)（夜の段構成と段が失敗したときの扱い）
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0011 sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する
- Related: [ADR-0051 照合と整理の基準は別々に持ち、成功したときだけ進める](0051-carry-unfinished-night-work-forward.md)（失敗した段の入力は次の夜に持ち越す。出来事の処理や `/sources` の保存期間は変えない）。

## References

- natsumi の README「読みものの更新（sources_updated）」（https://github.com/yuanying/natsumi/blob/main/README.md 、2026-11-14 確認）: `/sources` を git の作業ツリーとして持ち、出来事に差分の本文を載せず `sources-diff` で見せる、待ちは指数分布から引く
- natsumi ADR 0050「読みものの更新を 1 種類のイベントで知らせ、差分は git で見せる」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0050-telling-of-source-updates-with-one-event.md 、2026-11-14 確認）
- natsumi ADR 0053「読みものの更新は、最初の変化で引いたランダムな待ちの後に知らせる」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0053-waiting-at-random-for-source-updates.md 、2026-11-14 確認）
- natsumi ADR 0043「Slack のリアクションをチャンネルのファイルに書き、なつみの投稿へのものを合図で知らせる」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0043-reactions-in-the-channel-files.md 、2026-11-14 確認）: Status の追記に、リアクションは JSON Lines の行の欄とする置き換えがある
