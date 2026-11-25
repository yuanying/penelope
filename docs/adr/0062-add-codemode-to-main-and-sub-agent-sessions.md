# 0062. 本体とサブエージェントに Pi の codemode を加える

- Date: 2026-11-25
- Status: Accepted

## Context

natsumi からの移行では、作業環境を Pi の基本ツールと CLI で扱えるようにし、natsumi の codemode は引き継がなかった。penelope の runner は Pi の SDK でセッションを開くため、CLI に組み込まれている codemode も自動では読み込まれない。複数のツールを使った作業では、シェルだけで完結する場合を除き、モデルが各ツールの結果を受け取って次の操作を組み立てる。

Pi の codemode は、JavaScript でツールを並行に呼んだり、結果を次の呼び出しに渡したりできる道具である。大きな結果はスクリプト内で絞ることができ、モデルが受け取るのはスクリプトの出力である。外部のツールをつなぐ MCP を導入するときにも、同じ呼び出し方を使える。

## Decision

### 既存の道具に加える

- codemode を引き継がない判断を改め、Pi 同梱の codemode を `on` で、本体（夜の振り返りを含む）とサブエージェントに加える。従来の道具は引き続きモデルから直接呼べる。配置ごとの入り切りは設けない。
- `reply` と `reply_to_agent` はモデルからの直接呼び出しに限る。スクリプト内の呼び出しは独立した呼び出しと結果としてセッションの記録に残らないため、返事を畳み込み後の文脈に残す仕組みを維持するには直接呼び出しが要る。
- 照合係・整理係と記憶評価は引き続き専用のファイル操作だけを使う。オーナーの置き場や記憶から拡張を読むのは引き続き本体だけで、その読み直しで codemode は外れない。

### 通信と認証の境界は変えない

- スクリプトは QuickJS の中で動き、ファイルやネットワークに直接アクセスしない。セッションが許す道具と Pi の `models` を使う。新しい宛先や認証は設定せず、外向きの通信は引き続き Sentinel を通る。
- `models` による分類・画像生成は、Pi のカタログで解決したモデルをセッションの既存の認証で呼び出す。スクリプトから資格情報を取得したり、資格情報を付ける宛先を指定したりはできない。モデルが無い、認証が使えない、または Sentinel が通信を通さないときは、その呼び出しは成立しない。別の認証や経路を追加して補わない。本物の鍵の保管と差し替えは引き続き Sentinel が担う。

### 本 ADR で決定しないこと

- MCP の接続・認証・ツールの公開方法と `tool_search` の導入（委譲先: 本リポジトリで MCP を導入するときの設計）。現時点ではどちらも加えない。
- 既存の道具を隠して codemode 経由に限る `only` の採否（委譲先: 本リポジトリで道具の公開方法を見直す際の設計）。

## Consequences

- 結果を絞り込んでからモデルに返せるため、長いツール出力をすべて文脈に積む必要がなくなる。一方で、モデルに渡す道具の定義は増え、スクリプト内の個々の結果はセッションの記録から後で読めない。
- 呼び出しをまとめてもトランザクションにはならない。スクリプトが途中で失敗しても、実行済みの道具の作用は取り消されない。
- 分類・画像生成に対応した認証がある場合、スクリプトからのモデル呼び出しも、その提供元の利用枠を消費しうる。

## Related ADRs

- Related: [ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす](0001-one-pod-with-pi-inside-the-sandbox.md) の Decision「Pi ごと sandbox の中で動かす」。基本ツールは置き換えない。
- Related: [ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する](0003-all-egress-through-the-sentinel-passthrough-by-default.md) の Decision「sandbox の外向きは 1 本の道」。通信経路は変えない。
- Related: [ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする](0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md) の Decision「鍵は Sentinel が持つ」。鍵の管理を変えない。
- Related: [ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md) の Decision 項 1（終わったターンを、送る直前に畳む）。畳んだ後も返事を残す。
- Related: [ADR-0020 コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す](0020-connectors-with-a-usage-document-listed-in-the-prompt.md)。CLI やコネクタの文書は置き換えない。
- Related: [ADR-0022 サブエージェントは runner が非同期に回し、本体とだけツールと自分宛ての出来事でやりとりする](0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) の Decision「サブエージェントは本体とだけ話す」。本体専用の道具はサブエージェントに渡さない。
- Related: [ADR-0039 Pi 拡張はオーナーの置き場と記憶から本人のセッションだけに読み込む](0039-load-owner-and-memory-extensions-in-the-main-session.md)。対象は Pi 同梱の拡張だけで、ディスク上の拡張を読む範囲は変えない。
- Related: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) の Decision 項 4（照合係と整理係にはファイル操作だけを渡す）、および [ADR-0053 目的に沿った問いで記憶を評価する CLI を持つ](0053-evaluate-memory-with-purpose-questions.md)。制限されたセッションには加えない。

## References

- [natsumi ADR 0066「Pi の Codemode で、作業環境の生の出力を文脈に入れずに済ませる」](https://github.com/yuanying/natsumi/blob/main/docs/adr/0066-codemode-to-keep-raw-output-out-of-the-context.md)（2026-11-25 確認）: natsumi での採用理由と記録の扱い。
- Pi SDK `docs/sdk.md`「Codemode and MCP」、`docs/codemode.md`「Scripts」「Call tools」「Models」、`dist/extensions/codemode/execute.js` の `runModelCall`、`dist/core/nested-tool-calls.js` の `NestedToolCallRunner`（`@earendil-works/pi-coding-agent` 1.5.2、2026-11-25 確認）: SDK での読み込み、実行境界、認証、セッションの記録。
- [runner のセッション作成](../../packages/runner/src/pi.ts) の `openSession`、[起動処理](../../packages/runner/src/main.ts) の `serve`、[畳み込み](../../packages/runner/src/fold.ts) の `KEPT_TOOLS`（2026-11-25 確認）: セッションごとの道具、モデルの認証とカタログ、残す返事ツール。
