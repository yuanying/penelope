# 0070. 気分は `mood` で自分で決め、次に変えるまで続く

- Date: 2026-11-27
- Status: Accepted

## Context

エージェントの様子として画面に出るのは、返事ごとの表情（expression）だけである。表情は 9 種の語から返事のたびに選び、Web UI はその絵を一定の時間見せて neutral に戻す。考えている最中は thinking になる。返事と返事の間に続く心持ちを示すものは無い。

オーナーは、エージェントの status として、眠気と寝ているに並べて「気分」を求めた。気分は、オーナーの画面と、同じ家にいるほかの住人（[ADR-0074](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)）から見える。

## Decision

適用範囲は本体のセッションである。表情の語、絵、neutral に戻る決まり（ADR-0016 の Decision）は変えない。

- エージェントは、ツール `mood` で自分の気分を決める。`mood` は backend に直接届き、本体のセッションだけに渡す。エージェントの本質につながるものはツールにする（[ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) の Decision 項 1（寝るのはエージェントが決める））。
- 気分は短い自由な文である。決まった語から選ばない。長さには上限を置く。
- 気分は、次に `mood` で変えるまで続く。眠りをまたいでも続く。backend が永続に持つ。
- 気分は status の一部である（[ADR-0068](0068-sleepiness-as-one-value-with-its-facts.md)）。ターンの始まりの知らせ、heartbeat、Web UI とアプリ、receivers のプラグインが読む status に出る。metrics には出さない。
- backend は、気分から何も決めない。表情、眠気、眠りの状態のどれとも結び付けない。表情の `sleepy` は、今までどおり返事の顔である。
- システムプロンプトには、気分が何で、どこから見えるかを事実として書く（ADR-0069 の Decision 項 8（システムプロンプトには、自分の様子がどう働くかを事実として書く））。どんな気分にすべきかは書かない。
- 気分はエージェントが書いた自由な文である。ほかのエージェントに見せる側は、外から来た文として扱う。

### 本 ADR で決定しないこと

- 気分の長さの上限、`mood` の引数と結果の形（委譲先: [sandbox 向けの口の仕様書](../sandbox-api.md)。気分を実装する作業単位で足す）
- 画面での見せ方（委譲先: [UI 向けの API の仕様書](../ui-api.md) と [docs/design](../design/README.md)）
- システムプロンプトの文面（委譲先: プロンプトのファイル `packages/runner/src/prompts.ts`）

## Consequences

- 一瞬の表情と、続く心持ちが分かれる。オーナーとほかの住人は、返事が無い間もエージェントの様子を知れる。
- 気分は眠りをまたぐが、新しいセッションは、その気分を決めた経緯を覚えていない。ターンの始まりの知らせで今の気分を見るだけである。変えなければ、古い気分が出続ける。
- 自由な文が、ほかのエージェントの入力に入る道が 1 つ増える。仕組みが置くのは長さの上限だけで、取り違えないことはモデルの判断に頼る。

## Alternatives Considered

- **表情を長く続かせる**: 表情は返事に添える顔で、絵に縛られた 9 種の語である。続く心持ちを自由に言えない。
- **決まった語から選ぶ**: 画面は作りやすいが、語の一覧をコードが持つことになる。
- **記憶のファイルに書く**: backend と家が読む口が要り、sandbox が書いたファイルを status の正にすることになる。

## Related ADRs

- Related: [ADR-0068 眠気は backend が 1 つの値にし、元の事実と並べてターンの始まりと heartbeat に渡す](0068-sleepiness-as-one-value-with-its-facts.md)（status と、渡す先）
- Related: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（本質につながるものはツール）
- Related: [ADR-0073 receivers のプラグインは本体の status を読み、heartbeat に載せる様子を預けられる](0073-let-receiver-plugins-read-status-and-leave-heartbeat-notes.md)
- Related: [ADR-0074 家は居場所と会話を持つ 1 つのサーバーにし、receivers のプラグインと CLI で差し込む](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)（気分が見える場所）
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0016 最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる（表情は変えない）

## References

- [ADR-0016 最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる](0016-show-the-avatar-and-expression-from-the-first-web-ui.md) の Decision（2026-11-27 確認）: 表情の 9 種の語、ターンの最中は thinking、一定の時間で neutral に戻す
- [sandbox 向けの口の仕様書](../sandbox-api.md) の「返事」（2026-11-27 確認）: 表情は返事の欄である
