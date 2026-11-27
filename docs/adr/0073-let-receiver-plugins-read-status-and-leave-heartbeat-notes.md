# 0073. receivers のプラグインは本体の status を読み、heartbeat に載せる様子を預けられる

- Date: 2026-11-27
- Status: Accepted

## Context

receivers のプラグインと backend の間の道は、一方向である。プラグインは、正規化した出来事を取り込み口へ送る。backend からプラグインへ渡るものは無い。接続の種類のプラグインが本体から受け取るのは、出来事の送り出し、ログ、時計の 3 つだけである。

家（[ADR-0074](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)）を receivers のプラグインとして差し込むには、この道では 2 つのことができない。

- 家は、住人の眠気、気分、寝ているかを見せる。その正は backend にあり（[ADR-0068](0068-sleepiness-as-one-value-with-its-facts.md)）、プラグインはそれを読めない。
- オーナーは、heartbeat に家の様子（自分の居場所、誰がどこにいるか）を載せ、エージェントが自分から部屋を移るきっかけにすると決めた。プラグインは heartbeat に何も足せない。

オーナーは、どちらも家に特化させず、差し込める形にすると決めた。家を使わない配置の heartbeat には、何も出ない。

heartbeat の行に載る残っている仕事は、状態を持つ側が採っている。backend は自分の分を出来事に付け、runner は行を組み立てるときに自分の分を足す。receivers が持つ様子には、この形を使えない。backend は receivers を呼ばず、runner は receivers に届かないためである。

## Decision

適用範囲は、backend と receivers の間の道である。出来事の取り込み（ADR-0002 の Decision 項 1（取り込み口は 1 つ、契約も 1 つ））と、プラグインの載せ方（ADR-0023 の Decision 項 1（プラグインはリポジトリの中に持ち、配置の設定で有効にする））は変えない。道は、取り込み口と同じく backend と receivers だけが見える Unix socket に置く。

### 1. プラグインは、本体の status を読める

- backend は、receivers に status（眠気と元の事実、気分、眠りの状態と起きる時刻）を読ませる口を持つ。今の status と、その変化が伝わる。
- 渡すのは状態そのものである。プラグインは、つなぎ直したら今の status を読み直せば追いつく。
- backend は、どのプラグインが何のために読むかを知らない。

### 2. プラグインは、heartbeat に載せる様子を預けられる

- プラグインは、heartbeat に載せたい今の様子を backend に預けられる。backend が持つのは、受信元ごとに最新の 1 件だけである。
- 中身は受信元ごとに自由で、backend は形を知らない（ADR-0002 の Decision 項 1 と同じ）。大きさには上限を置く。
- プラグインは、様子が古くなったら取り下げる（外のサービスとの接続が切れたときなど）。
- backend は、heartbeat の出来事と「起きた」出来事（[ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) の Decision 項 4（起きるのは、起きる時刻だけ））を入れるときに、預かっている様子を受信元の名前ごとに付ける。runner はそれを、その出来事の行に直接載せる。
- 預かっている様子が無ければ、行は今までと同じである。普段のターンの行には載せない。
- 残っている仕事の欄（ADR-0055 の Decision 項 2（載せるのは 4 種類に絞る））とは別の欄にする。backend と runner が採る残っている仕事は変えない。

### 守る対象と、失敗したときの倒し方

- 守る対象は、status（気分の文を含む）と、heartbeat の行である。
- 2 つの口に届くのは、socket が見えるコンテナだけである。sandbox には socket を見せない。共有の token は使わない（ADR-0002 の Decision 項 2（基本の受信元は backend の中、それ以外は receivers）と同じ守り方）。
- status を読めるのは、配置が設定で有効にしたプラグインである。プラグインが status を外のサービスへ送るかどうかは、そのプラグインの決定に書く。
- 預かった様子には、外から来た文（ほかのエージェントの気分など）が入りうる。行の中では受信元の名前の下に置き、backend と runner が採った欄と混ぜない。
- backend が様子を預かれないとき、付けられないときは、様子を載せずに heartbeat を渡す。heartbeat の配送は止めない。

### 本 ADR で決定しないこと

- 2 つの口の形、様子の大きさの上限、backend が立ち上がり直したときの預かりの扱い（委譲先: [出来事の仕様書](../events.md) の「取り込み口」と [receivers の仕様書](../receivers.md) の「プラグインの内側の契約」）
- heartbeat の行に載せる欄の名前（委譲先: [出来事の仕様書](../events.md) の「ターンに入る形」と `packages/contract` の `src/turn.ts`）
- 家のプラグインが何を預け、status をどこへ送るか（委譲先: [ADR-0074](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)）

## Consequences

- 家のように、エージェントの様子を外に見せ、外の様子を heartbeat で知らせる受信元を、backend と runner を変えずに足せる。backend は家を知らないままである。
- 使わない配置では、status を読む者も、様子を預ける者もいない。heartbeat は変わらない。
- 一方で、backend と receivers の間の道が双方向になる。receivers は、出来事を送るだけの部品ではなくなる。
- backend は、受信元ごとに様子の写しを 1 件持つ。プラグインが取り下げ損ねると、古い様子が heartbeat に載る。
- 気分の文を含む status が receivers に渡る。receivers の外向きは Sentinel を通らないので、プラグインが status を外へ送っても Sentinel の記録には残らない。

## Alternatives Considered

- **runner が、heartbeat の行を組み立てるときに CLI で外のサービスに尋ねる**: 状態を持つ側で採る形には合うが、行を組み立てる間に外への通信を待つことになる。受信元ごとの尋ね方も runner が知ることになる。
- **backend が外のサービスへ status を直接送る**: backend が家の場所と確かめ方を知ることになる。
- **様子を普通の出来事として送る**: `now` ならそのたびにターンが始まり、`batch` なら変化のたびに行が文脈に積もる。要るのは今の様子の 1 件だけである。

## Related ADRs

- Related: [ADR-0068 眠気は backend が 1 つの値にし、元の事実と並べてターンの始まりと heartbeat に渡す](0068-sleepiness-as-one-value-with-its-facts.md)（status）
- Related: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（「起きた」出来事）
- Related: [ADR-0070 気分は `mood` で自分で決め、次に変えるまで続く](0070-a-mood-she-sets-that-lasts.md)
- Related: [ADR-0074 家は居場所と会話を持つ 1 つのサーバーにし、receivers のプラグインと CLI で差し込む](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)（最初に使うプラグイン）
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（取り込み口と socket の守り方）
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける
- Related: ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す（接続の種類のプラグイン、receivers の外向きは Sentinel を通らない）
- Related: ADR-0031 起きている時間に何もない時間が続いたら、backend が heartbeat の出来事を入れる
- Related: [ADR-0055 残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md)（残っている仕事の欄は変えない）

## References

- `packages/receivers/src/plugin.ts` の `ConnectionIO`（2026-11-27 確認）: 接続の種類のプラグインが本体から受け取るのは、出来事の送り出し、ログ、時計である
- [receivers の仕様書](../receivers.md) の「プラグインの内側の契約」（2026-11-27 確認）: プラグインは取り込み口へ出来事を送るだけで、backend から受け取るものは無い
- [ADR-0055 残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md) の Decision 項 4（backend と runner はそれぞれが持つ状態から集める）（2026-11-27 確認）
- [Pod の形の仕様書](../pod.md) の「volume」（2026-11-27 確認）: 取り込み口の socket は backend と receivers だけが mount する
