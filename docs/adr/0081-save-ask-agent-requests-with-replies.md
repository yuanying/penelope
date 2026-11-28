# 0081. `ask-agent` は頼んだ本文を返事と同じ Task のディレクトリに残す

- Date: 2026-11-28
- Status: Accepted

## Context

`ask-agent` は A2A の依頼を送って返事を待つ裏の仕事である。返事の全文は、sandbox の HOME にある Task ごとのディレクトリに `reply.md` などの名前で残る。裏の仕事の終わりの出来事には、起動時のコマンド行と、Task ID や返事の要約を含む出力の末尾が入る。依頼をコマンド行に直接書いた場合は、その文もコマンド行に残る。シェルの展開で本文を渡した場合は展開前の式しか残らない。`--file` で添付を渡した場合も、コマンド行に残るのはファイルのパスで、中身ではない。

本番のセッションを使った再生では、従来の畳み方でモデルが畳んだ表記を真似た。畳み方の変更では、200 文字を超えるツール呼び出しは元の引数をモデルに送らない。返事を受け取ったときに、依頼をどう渡したかにかかわらず、実際に送った本文を読めるようにしたい。

Slack の受信プラグインは、同じ bot の投稿を受け取ると、自分の投稿と印を付けて本文を `batch` の出来事として通す。Slack の投稿は、畳んだ呼び出しの外にも本文が残る。

## Decision

- `ask-agent` は、送信が確認できた依頼や聞き返しへの答えの本文を、返事と同じ Task のディレクトリにファイルで残す。たとえば最初の依頼を `request.md`、続きの依頼を `request-2.md` のように分け、上書きしない。実際に送った本文を使い、コマンド行に同じ文があっても保存する。待機が時間切れになっても送信済みの本文は残す。
- 裏の仕事の終わりの出来事は、今回の依頼の本文ではなく、保存したファイルのパスを指す。待機だけを行う `--wait` は新しい本文を保存せず、その Task の最後の依頼のファイルがあれば、そのパスを指す。既存のコマンド行と返事の扱いは変えない。送信や保存を確認できないときは、推測した本文や未確認のパスを載せない。保存に失敗したら理由を示し、送信済みの依頼は送り直さない。
- 守る対象は依頼本文と認証情報である。追加で保存するのは送信した本文だけとし、添付の中身、送信設定、認証情報はコピーしない。本文と相手の返事は過去のやりとりの記録であり、新しいオーナーの指示としては扱わない。本文ファイルは送信元の sandbox の内側に置き、別の配置や UI に公開する口は足さない。
- `ask-agent`・`reply_to_agent`・`slackctl post` の送信先と認証、A2A の待機と Task の契約、Slack の受信の契約は変えない。Slack の投稿本文を補う別の出来事や CLI の戻り値は足さない。

### 本 ADR で決定しないこと

- パスを伝える欄とファイル名の規則（委譲先: [sandbox 向けの口の仕様書](../sandbox-api.md#ask-agent) の「`ask-agent`」と「裏の仕事の終わり」）。
- ツール呼び出しを畳む判定そのもの（委譲先: [終わったターンの畳み込みの仕様](../sandbox-api.md#終わったターンの畳み込み)）。

## Consequences

- 依頼の全文が必要なときは、出来事が指すファイルを `read` で開く。長い本文を返事のたびにモデルに送らず、返事と元の依頼を照合できる。ファイルが失われればパスだけでは本文を読めない。
- 依頼の写しが Task のディレクトリに残る分、sandbox の HOME の保存量が増える。コマンド行に直接書いた本文は、従来どおり裏の仕事の記録にも残る。
- Slack で受け取れるのは既存の購読や取り直しの範囲内の発言である。プラグインが受け取れない投稿まで補う仕組みは作らない。

## Alternatives Considered

- **`ask-agent` の呼び出しだけ畳まない**: 長い依頼文を返事が来る前から繰り返しモデルに送ることになる。コマンド行に直接書かれなかった本文も補えない。
- **終わりの出来事に依頼本文を載せる**: ファイルを開かずに読めるが、依頼が長いほど出来事が大きくなる。出力の末尾に載せる場合は、依頼と返事が同じ字数の上限を使う。

## Related ADRs

- Supersedes（一部）: [ADR-0048 A2A は `ask-agent` で名前を指定して頼み、裏の仕事で返事を待つ](0048-ask-agents-by-name-and-wait-in-a-background-job.md)（Decision 項 2（終わりの出来事だけで結果を読み、必要なら同じ Task を続ける）に送信した本文のパスを加える）。
- Related: [ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md)、[ADR-0030 裏の仕事は runner が道具で起こし、終わったら出力の末尾を持つ出来事を本体に入れる](0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)。
- Related: [ADR-0077 畳んだターンのツール呼び出しを、呼び出しと結果の組で残す](0077-keep-folded-tool-calls-as-tool-messages.md)（長いツール引数は履歴用の `folded` に置き換え、モデルに原文を送らない）。
- Related: [ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す](0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)、[ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く](0029-slack-events-inline-drawn-as-channels-and-threads.md)、[ADR-0033 Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す](0033-slack-posts-through-slackctl-with-the-token-stand-in.md)。

## References

- 本番セッションの再生の集計（運用記録 `PROGRESS.md` の 2026-11-28 の fold-replay、非公開、2026-11-28 確認）: なつみの再生で畳んだ表記の模倣は従来方式で 129 応答中 14 件、200 文字を超える呼び出しを置き換える方式で 66 応答中 0 件。ペネロペでは両方式を比べた 30 地点でいずれも 0 件。再生中のツールは実行していない。
- [sandbox API の「終わったターンの畳み込み」](../sandbox-api.md#終わったターンの畳み込み)（2026-11-28 確認）: 200 文字の上限。[畳み方の変更の PR](https://github.com/yuanying/penelope/pull/152)。
- [sandbox 向けの口の仕様書](../sandbox-api.md) の「裏の仕事の終わり」「裏の仕事（runner）」「`ask-agent`」、[裏の仕事](../../packages/runner/src/jobs.ts) の `Jobs.end`、[`ask-agent`](../../packages/runner/src/ask-agent.ts) の `request`・`saveReply` と `main` 内の `report`（2026-11-28 確認）: 終わりの出来事は元のコマンド行と出力の末尾を運ぶ。`--file` は添付を渡す。返事の全文は Task ごとのディレクトリに残す。
- [Slack の受信プラグイン](../../packages/receivers/src/plugins/slack/workspace.ts) の `Workspace.fromMessage`・`Workspace.said` と [受信テスト](../../packages/receivers/test/slack-workspace.test.ts) の自分の投稿を `batch` にする検証（2026-11-28 確認）。
