# 0056. 記憶の画面はコミット済みの版を読み、活動の記録と行き来できるようにする

- Date: 2026-11-23
- Status: Accepted（一部を [ADR-0057](0057-edit-existing-memory-in-the-backend.md)・[ADR-0058](0058-read-memory-history-on-demand.md) で置き換え）

## Context

backend はターンの終わりに `/memory` をコミットする。活動の記録は夜の段の変更量を持つが、オーナーはそこからファイルや差分を開けず、どの記述がいつ変わったかも画面で分からない。記憶の作業ツリーは日中も夜の段の途中も書き換わる。本文を作業ツリーから読むと、履歴が示す版と一致しない。runner は日中のセッションで触れられたパスと日付を夜ごとに集めるが、その記録は runner の状態にしかない。

## Decision

- 記憶の画面のために、backend が Git の HEAD で確定した版を読む。ファイル一覧・本文・検索と、第一親の履歴にある変更を提供する。要求の途中で HEAD が進んでも、選んだ版の木と履歴から答える。作業ツリーは読まず、この口から記憶や履歴にも書かない。
- 記憶には私的な本文や履歴があるので、既存のオーナー認証をすべての閲覧に適用する。認証が設定されていない、または失敗した要求には渡さない。通常ファイルだけを扱い、外部差分処理やパスの解釈によって記憶の外を読まない。取得に失敗したとき Git の出力をログやエラーに載せない。活動の記録自体は、記憶を読めなくても引き続き読める。
- 書き手はコミットメッセージの印から決める。本体の夜のターンには、振り返りも含めて段と制御の出来事の番号を印に残す。参照の修正は仕組みの別の変更とし、夜を特定できるときは同じ夜の印を付ける。活動の記録はきっかけ、棚卸しの中身と構成の区別、それぞれの画面へのリンクを補う。古い振り返りでも一致するターンが分かれば使うが、時刻や自由文で古い書き手を推定しない。アバターの初期の写しは仕組みの変更、明示的に設定した Git 作者の一致はオーナーとし、特定できない古い履歴（Natsumi 形式を含む）は「分からない」にする。
- 検索は版にある本文の固定文字列で、大文字小文字と全角半角を区別する。結果に上限を置き、結果を省いたときは伝える。履歴の一覧と変更の見出しには量を載せるが、差分の本文はファイルごとに求められたときだけ返す。変更の索引と差分統計の読み方は [ADR-0058](0058-read-memory-history-on-demand.md) で置き換える。ファイルの履歴はパス単位とし、移動より前の別名は追わない。
- runner は、夜の段の既存の報告に、その夜に集めた参照のスナップショットを任意で添える。集計と段の報告は同じ夜の手順で作られ、同じ制御の出来事の番号で再送を見分けられるので、別の報告の口は置かない。backend が runner のセッションから再集計することもしない。同じ夜の再送で加算しない。backend が持つのは最新の組のパスと日付だけで、本文や検索語は受け取らない。未送信と参照 0 回を区別する。毎回読む層の目安を超えた夜は、整理に入る前の計測ではなく夜の終わりの版から示す。

### 本 ADR で決定しないこと

- コミットの印の機械可読な書式、各口のパス・型・上限、保持する表の形（委譲先: References の backend・UI・sandbox の仕様書）。
- 記憶の編集・衝突解消・復元（委譲先: ADR-0057）。

## Consequences

- オーナーは表示されている本文と変更を同じ確定版として調べられる。活動の記録と相互にたどれるが、未コミットの書きかけや、印・記録のない来歴は分からない。参照の数も最後の夜の収集までで、ファイルの有用性の判定には使わない。
- 夜の変更を開いても畳んだファイルの差分までは作らない。変更一覧の初回読み取りと索引の費用は ADR-0058 の Consequences を参照。
- 参照の集計と夜の最終版のために SQLite のスキーマが進む。スキーマを古い版に戻す機構は作らない。旧 runner からの通知は従来どおり受ける。

## Related ADRs

- Superseded by（一部）: [ADR-0057 オーナーによる記憶の編集と復元は、backend が 1 ファイルずつ確定する](0057-edit-existing-memory-in-the-backend.md)。閲覧の口は引き続き読み取り専用とし、別に保存の口を置く。
- Superseded by（一部）: [ADR-0058 記憶の差分統計は必要な変更だけを計算し、Git の保守は backend が行う](0058-read-memory-history-on-demand.md)。全履歴の差分統計の索引をやめ、最終変更のためのパスの索引だけを保持する。

- Related: [ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md)
- Related: [ADR-0036 アバターは記憶の中で育て、最初の 1 回だけ backend が選んだアバターを写す](0036-the-avatar-grown-in-memory-copied-once-by-the-backend.md)
- Related: [ADR-0038 活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる](0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)
- Related: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md)
- Related: [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md)
- Related: [ADR-0050 夜は記憶の見取り図を渡し、棚卸しで中身と構成を分けて見直す](0050-organize-memory-with-a-map-and-a-weekly-review.md)
- Related: [ADR-0052 夜の係が移動した記憶への参照は runner が直す](0052-repair-memory-references-after-nightly-moves.md)

## References

以下は 2026-11-23 に確認。

- [`memory.ts`](../../packages/backend/src/memory.ts) の `Memory.commit`・`Memory.committedChange`、[backend の「`/memory` のコミット」](../backend.md#memory-のコミット): ターン後の確定と書き手の印。
- [`record.ts`](../../packages/backend/src/record.ts) の `ActivityRecord.nightReported`・`ActivityRecord.stagesKept`: 夜の段の報告とコミットの変更量。
- [`memory-reads.ts`](../../packages/runner/src/memory-reads.ts) の `memoryReads`、[`runner.ts`](../../packages/runner/src/runner.ts) の `Runner.nightly`: 日中の参照の集計と夜の切り替え。
- [UI API の「記憶」](../ui-api.md#記憶)、[sandbox API の「記憶の参照のスナップショット」](../sandbox-api.md#記憶の参照のスナップショット)、[backend の「コミット済みの記憶の閲覧」](../backend.md#コミット済みの記憶の閲覧): 各口、上限、保持とマイグレーション。
