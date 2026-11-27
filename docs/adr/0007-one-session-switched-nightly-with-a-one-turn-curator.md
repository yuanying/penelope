# 0007. セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える

- Date: 2026-11-14
- Status: Accepted（一部を [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) と [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え）

## Context

エージェントのセッションは 1 本だけで、毎日クリアし、記憶を育てていく。これは natsumi から変えない。

natsumi では、夜に次の順で切り替える。

1. エージェント自身がその日を振り返り、引き継ぎと日記を書く。
2. 人格を持たない記憶の整理係が、記憶を組み直す。整理係は「出来事から知識へ」「古い記憶を `archive/` へ移す」「構成と節の組み直し」「索引」の 4 つの工程に分かれ、工程ごとに新しいセッションを作り、1 ターンで終える。
3. 引き継ぎを入れた新しいセッションで翌日を始める。

工程に分けたのには 2 つの理由があった。1 つは、検査に当たった変更を工程ごとに全部か無しかで捨てるためである。もう 1 つは、1 つの工程に集中させるためである。

penelope では、記憶の検査をやめる（ADR-0006）。Pi は sandbox の中で runner が回す（ADR-0001）。

## Decision

夜の段の構成と照合・整理の分担は [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) で置き換えた。棚卸しの夜の整理係は [ADR-0050 夜は記憶の見取り図を渡し、棚卸しで中身と構成を分けて見直す](0050-organize-memory-with-a-map-and-a-weekly-review.md) に従う。本体のセッションを 1 本にすること、backend と runner の分担、日中の compaction は変えない。

### 3 段は残す

- 夜の切り替えは、振り返り → 整理係 → 新しいセッション の 3 段とする。
- 夜の時刻と、切り替えの出来事を出すのは backend である。セッションを回すのは runner である。
  - 2026-11-27 追記: 夜の時刻を backend が設定で持つ点は [ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え。切り替えは、エージェントが眠りを求めたときに始まる。backend が切り替えの出来事を出し、runner が回す分担は変えない。

### 整理係は 1 つのセッションの 1 ターン

- 整理係は人格を持たず、エージェントと同じ sandbox で動く。
- 整理係は、1 つのセッションの 1 ターンで記憶の整理を終える。natsumi の 4 つの工程には分けない。
- 整理係のプロンプトは、記憶の形と目的だけを伝え、やり方は任せる（ADR-0008）。
- ファイルの持ち主の決まり（このファイルは整理係だけが書く、など）は置かない（ADR-0006）。

### 文脈があふれたら compaction、足りなければ分け直す

- 記憶が大きくなって 1 ターンの文脈があふれたら、Pi の compaction で続ける。compaction の設定は Pi の既定を使う。
- 1 ターンで足りなくなったときは、そのときに工程に分け直す。分け直す条件は、決めておかない。

### 本 ADR で決定しないこと

- 夜の時刻（委譲先: [backend の設定](../backend.md)）
- 振り返りと整理係のプロンプトの文面（委譲先: プロンプトのファイル。ADR-0008 の方針に従う）
- 整理係のターンが失敗したときの扱い（委譲先: [backend の仕様書](../backend.md)）
- 日中のセッションの compaction の設定（委譲先: backend の設定。最初は Pi の既定）

## Consequences

- 夜の仕組みが単純になる。工程ごとのセッション、工程ごとの入力の組み立て、工程ごとの検査とやり直しが要らない。
- 整理係はエージェントと同じ sandbox で同じ道具を使えるので、整理のための特別な道具が要らない。
- 一方で、1 ターンにすべてを任せるので、整理の質はモデルの強さに依存する。集中のために工程を分けていた効果は失われる。
- compaction が起きると、ターンの前半の細部はモデルから見えなくなる。整理が雑になれば、工程に分け直す。

## Alternatives Considered

- **natsumi の 4 つの工程をそのまま写す**: 工程に分けた理由のうち、検査で全部か無しかを決めることは、検査をやめたので消えた。集中のための分割は、強いモデルでは要らない見込みである。

## Related ADRs

- Superseded by（一部）: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（Decision 項 1「3 段は残す」の、夜の時刻を backend が設定で持つ点。本体 1 セッション、backend が切り替えの出来事を出し runner が回す分担、日中の compaction は維持）
- Superseded by（一部）: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md)（Decision 項 1「3 段は残す」、項 2「整理係は 1 つのセッションの 1 ターン」、項 3「文脈があふれたら compaction、足りなければ分け直す」のうち、夜の段取りと照合・整理を 1 ターンにまとめる判断。本体 1 セッション、backend と runner の分担、日中の compaction は維持）
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない（compaction の手前に畳み込みを足す）
- Related（natsumi、このリポジトリの外）: ADR 0009「長期記憶と、夜の session の切り替え」、ADR 0055「記憶の組み直しは、人格を持たない整理係が夜に行う」、ADR 0068「整理係は人間の記憶のように、工程を分けて古い記憶を要約し、出来事を知識にする」
- Related: [ADR-0050 夜は記憶の見取り図を渡し、棚卸しで中身と構成を分けて見直す](0050-organize-memory-with-a-map-and-a-weekly-review.md)（棚卸しの夜だけ整理係を 2 ターンに分ける。本体のセッションは 1 本のまま）。

## References

- natsumi の README の夜の整理の節（https://github.com/yuanying/natsumi/blob/main/README.md 、2026-11-14 確認）: 一晩は「出来事から知識へ」→「古い記憶を `archive/` へ移す」→「構成と節の組み直し」→「索引」の工程に分かれ、工程ごとに新しい session を作り、1 ターンで終える
- natsumi ADR 0068（https://github.com/yuanying/natsumi/blob/main/docs/adr/0068-a-curator-that-remembers-like-a-person.md 、2026-11-14 確認）: 検査に当たった係の変更を捨てる単位を工程ごとにする
- Pi Coding Agent の文書 `docs/rpc.md`（https://github.com/earendil-works/pi 、npm の `@earendil-works/pi-coding-agent` 1.5.2 に同梱のもの、2026-11-14 確認）: 1 回の実行の後にも compaction・steer・follow-up が続きうる
