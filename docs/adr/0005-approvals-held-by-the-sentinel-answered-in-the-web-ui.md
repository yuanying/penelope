# 0005. 承認待ちは Sentinel が持ち、オーナーは Web UI で答える

- Date: 2026-11-14
- Status: Accepted（一部を [ADR-0079](0079-open-resident-pages-from-the-house.md) で置き換え）

## Context

Sentinel の既定の扱いは、最初は素通しで、使うホストが分かってきたら ask に切り替える（ADR-0003）。ask は「オーナーに聞いてから通す」扱いであり、聞いて答えを受け取る仕組みが要る。

聞く道を会話の中に置くと、承認の答えがエージェントの入力を通ることになる。エージェントが乗っ取られていれば、答えを偽れる。Muse は、承認待ちを Sentinel が作って実行を止め、承認のダイアログを会話ではなくクライアントの UI に出し、答えを Sentinel に直接戻している。

natsumi では、関所が承認待ちを持ち、server のダッシュボードに窓口を置いて、答えが出たことを出来事で知らせている。

## Decision

### 承認待ちの持ち主と答える場所

- ask の通信に当たったら、Sentinel が承認待ちを作り、その通信には「承認待ち」の印つきの応答を返す。
- 承認待ちは Sentinel が持つ。backend は、同じ Pod の中の Sentinel の管理口から承認待ちを読み、Web UI に出す。
- オーナーの答えは、Web UI から backend を経て Sentinel へ戻る。答えはエージェントの会話を通らない。
- 答えが出たことは、出来事としてエージェントに知らせる（ADR-0002）。エージェントは知らせを受けてから、同じ通信をやり直す。
- 新しい承認待ちができたことは、オーナーに Web Push か Slack で知らせる。

### 許しの範囲

- 最初に選べる範囲は、「この 1 回」と「このホストをずっと」の 2 つとする。

### 守る対象と、失敗したときの倒し方

- 守る対象は、ask の扱いのホストへの通信が、オーナーの答え無しに通らないことである。
- 答えの無い承認待ちは、通さない側に倒す。Sentinel が止まって承認待ちが失われたときも、許していないものとして扱う。
- Sentinel の管理口は、同じ Pod の backend からだけ届くようにする。sandbox の UID からは届かない（ADR-0003 の Decision「私用のアドレスも素通し、loopback とリンクローカルは止める」）。
  - 2026-11-14 追記: 届かなくする仕組みは、ADR-0014 で、管理口を Unix socket だけで待ち受け、その socket を sandbox に mount しない形に置き換えた。

### 本 ADR で決定しないこと

- 管理口の API の形（委譲先: Sentinel の仕様書。実装の作業単位で `docs/` に置く）
- 承認待ちの期限と、期限が来たときの扱いの細部（委譲先: Sentinel の仕様書）
- 許しをどこに永続させるか（委譲先: 既定を ask に切り替えるときの ADR）
- 「この 1 回」「このホストをずっと」のほかの範囲（期限つき、セッションの間など）（委譲先: 既定を ask に切り替えるときの ADR）
- Web Push と Slack のどちらで知らせるか（委譲先: 実装の作業単位の PR）
- 承認の画面の見た目（委譲先: ADR-0009 の画面の合意）

## Consequences

- 承認の答えはエージェントの入力を通らないので、エージェントが答えを偽ることはできない。
- 承認待ちの状態が Sentinel の 1 か所にあるので、通信の判定と許しが食い違わない。
- 一方で、オーナーが Web UI を見ていなければ、ask の通信はずっと通らない。知らせ（Web Push か Slack）が届くことに頼る。
- 承認待ちの応答を受けたエージェントは、答えの知らせを待ってからやり直す必要がある。通信が止まって待つのではなく、応答が返ってくるので、ターンは止まらない。

## Alternatives Considered

- **承認を会話の中で聞く**: 答えがエージェントの入力を通る。
- **承認待ちを backend が持つ**: Sentinel が判定のたびに backend へ問い合わせることになり、判定と許しの状態が 2 か所に分かれる。

## Related ADRs

- Superseded by（一部）: [ADR-0079 会話する配置は家に住み、承認は家で答え、個人のページは家から開く](0079-open-resident-pages-from-the-house.md)（Decision 項 1（承認待ちの持ち主と答える場所）のうち、配置ごとの Web UI で答える点と、新しい承認待ちを Web Push か Slack で知らせる点。Sentinel は引き続き承認待ちと許可の判定を持つ）。
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（答えの知らせ）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する（既定の扱いの ask）
- Related: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る（承認の API と画面）
- Related: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける（管理口の待ち受け）
- Related（natsumi、このリポジトリの外）: ADR 0096「関所が本人に聞くものの窓口をダッシュボードに置き、答えは /sources で知らせる」

## References

- Meta AI Research「How We Built Safety Into Muse」（https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse 、2026-11-14 確認）: ask では Sentinel が承認待ちを作り、実行が止まる。ダイアログは会話ではなくクライアントの UI に出て、答えは Sentinel に戻る。範囲は一度・セッション・タスク・期限つき・恒久
- natsumi ADR 0096（https://github.com/yuanying/natsumi/blob/main/docs/adr/0096-sentinel-approvals-on-the-dashboard.md 、2026-11-14 確認）
