# 0061. ターンのコミット前に runner が記憶の共有権限をそろえる

- Date: 2026-11-25
- Status: Accepted

## Context

`/memory` の作業ツリーは sandbox と backend が別々のユーザーで使う。backend は共有グループを通じて sandbox が書いたファイルを読み、ターンの終わりに全体を Git に追加してコミットする。履歴を守るため、sandbox は `.git` に書けない。

外部エージェントから届いた返事を HOME から記憶にコピーしたとき、コピーされたファイルが持ち主にしか読めないまま残った。共有グループに属していても backend は読めず、記憶の中の 1 つのファイルで作業ツリー全体のコミットが止まった。backend のログにはコミットが失敗したことだけが出て、ファイルの読み取りと Git のロックのどちらが原因か区別できなかった。

## Decision

### 1. 作業ツリーの共有権限は sandbox 側でそろえる

- runner は、backend にターンのコミットを頼む直前に、`/memory` の作業ツリーで sandbox ユーザーが所有する項目に共有グループのアクセスを補う。本体・夜の各ターン・サブエージェントのいずれも、同じ作業ツリーをコミットするので対象とする。
- 変更するのはファイルの共有グループでの読み書きと、ディレクトリでの読み書き・通過に必要な権限だけとする。他のグループに属する項目、`.git`、作業ツリーの外は対象外とし、リンクを介して権限を広げない。HOME の返事や検索結果は従来どおり持ち主だけが読める。
- そろえられない項目はそのままにし、runner は変更と未修正の件数だけをログに残す。そろえられなかったことだけでコミットの依頼を止めない。内容の検査・変更の取り消しは行わず、コミットは引き続き backend が行う。

### 2. backend はコミットの失敗理由を種類と件数で知らせる

- ターンのコミットが失敗したときは、Git の失敗の種類と、分かる範囲で対象件数を backend のログに残す。判別できない理由や件数は不明とする。記憶のパス・本文・Git の生の出力はログにも応答にも載せない。
- 失敗時の応答は引き続き汎用のエラーとする。runner は既にこのエラーをログに残すので、エージェントの次の入力への通知やターンの結果の変更は加えない。読めないファイルを除外して残りを部分コミットすることもしない。

### 本 ADR で決定しないこと

- 共有グループの指定と volume の持ち主（委譲先: References の Pod の仕様書と Kubernetes の配置）。
- 権限の補い方と失敗理由の分類（委譲先: References の Pod と sandbox API の仕様書）。

## Consequences

- 持ち主だけが読めるファイルを記憶にコピーしても、それだけでターン末のコミットが止まることはなくなる。失敗が残ったときも、記憶をログに載せずに切り分けられる。
- ターンごとに作業ツリーを走査する。ほかの書き手を止める処理は加えないため、走査とコミットの間に権限が変わった場合や、runner が直せない項目がある場合は、コミットが失敗することがある。

## Alternatives Considered

- **HOME の出力を最初から共有グループに開く**: 記憶に写すと決めていない資料まで共有するうえ、ほかのコマンドで作ったファイルには効かない。
- **backend が権限をそろえる**: 別ユーザーのファイルの権限を変えるために追加の権限が要る。持ち主である sandbox ユーザーで直せるので与えない。

## Related ADRs

- Related: [ADR-0006](0006-memory-kept-compatible-without-checks-committed-outside.md) の Decision 項 2（検査をやめる）と項 3（コミットは sandbox の外で backend がする）。内容の検査は復活させず、作業ツリーの権限だけをそろえる。
- Related: [ADR-0022](0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) の Decision 項 9（サブエージェントの途中経過とターンの終わり）。本体と同じ作業ツリーをコミットする。
- Related: [ADR-0044](0044-check-memory-against-records-before-nightly-organization.md) の Decision 項 1（夜の切り替えを 4 段にする）。セッションの開始だけを行う段ではターンのコミットは発生しない。
- Related: [ADR-0058](0058-read-memory-history-on-demand.md)（Git の保守と `.git` の扱いは変えない）。

## References

以下は 2026-11-25 に確認。

- [`ask-agent.ts` の `saveReply`](../../packages/runner/src/ask-agent.ts) と [`x-search.ts` の `save`](../../packages/runner/src/x-search.ts): HOME の出力は持ち主だけに開く。
- 変更前の [`memory.ts` の `Memory.commitNow`](https://github.com/yuanying/penelope/blob/77dea13f9b235a2ad014c517f6c803f6cea83dcf/packages/backend/src/memory.ts) と [`sandbox-api.ts` の `sandboxHandler`（ターンの終わり）](https://github.com/yuanying/penelope/blob/77dea13f9b235a2ad014c517f6c803f6cea83dcf/packages/backend/src/sandbox-api.ts): Git は作業ツリー全体を追加し、失敗の詳細はログに出さない。
- [`sandbox-api.test.ts` の「the end of a turn」](../../packages/backend/test/sandbox-api.test.ts): 読めない一時ファイルを Git に追加すると失敗することを、記憶の実データを使わずに確認できる。
- [Pod の「volume」](../pod.md#volume) と [sandbox API の「ターンの終わり」](../sandbox-api.md#ターンの終わり)。
