# 0081. `ask-agent` の終わりの出来事には頼んだ本文も載せる

- Date: 2026-11-28
- Status: Accepted

## Context

`ask-agent` は A2A の依頼を送って返事を待つ裏の仕事である。終わりの出来事には、相手・Task の状態と ID・返事と画像の場所を含む出力の末尾が入るが、頼んだ本文は入らない。本番のセッションを使った再生では、従来の畳み方でモデルが畳んだ表記を真似た。畳み方の変更では、200 文字を超えるツール呼び出しは元の引数をモデルに送らない。長い依頼では起動時に渡した本文が畳まれるため、返事と元の問いを同じ出来事から読めるようにしたい。

Slack は別の道をすでに持つ。投稿した workspace のイベントが届くと、同じ bot の発言も受信プラグインが自分の投稿と印を付けて本文を `batch` の出来事として通す。別の受信イベントを作らなくても、畳んだ呼び出しの外に本文が残る。

## Decision

- `ask-agent` が依頼または聞き返しへの答えを送った裏の仕事の終わりの出来事には、返事や Task ID とともに、今回送った本文を含める。後から `--wait` で待機するだけの仕事は、新しい送信本文を持たない。待機の時間切れなどで返事が無くても、送信済みならその本文を残す。
- 本文はコマンド行全体や標準出力からの推測ではなく、その仕事で A2A のメッセージとして送った文を使う。既存の出来事の大きさを超えない範囲で原文を載せる。収まらないときは省略を明示し、sandbox 内にある全文を指す。本文の追加で返事が押し出されないようにする。送信設定、認証情報、画像の中身は追加しない。
- 本文と相手の返事は過去のやりとりの記録であり、新しいオーナーの指示としては扱わない。出来事を別の配置や UI に公開する口を足さない。誰に何を送ったか確認できないときは、推測して載せない。
- `ask-agent`・`reply_to_agent`・`slackctl post` の送信先と認証、A2A の待機と Task の契約、Slack の受信の契約は変えない。Slack の投稿本文を補う別の出来事や CLI の戻り値は足さない。

### 本 ADR で決定しないこと

- 終わりの出来事の欄、字数の配分、全文の置き場（委譲先: [sandbox 向けの口の仕様書](../sandbox-api.md) の「裏の仕事の終わり」）。
- ツール呼び出しを畳む判定そのもの（委譲先: [終わったターンの畳み込みの仕様](../sandbox-api.md#終わったターンの畳み込み)）。

## Consequences

- 受け取った返事を何の依頼に対するものか、その出来事から判断できる。以前のツール呼び出しを省く方針は変わらない。
- 出来事に載せる文が増え、依頼文が送信元のセッションにもう一度残る。長い依頼は全文の場所を開く必要がある。
- Slack で受け取れるのは既存の購読や取り直しの範囲内の発言である。プラグインが受け取れない投稿まで補う仕組みは作らない。

## Alternatives Considered

- **`ask-agent` の呼び出しだけ畳まない**: 長い依頼文を返事が来る前から何度もモデルに送り、長いツール引数を省く方針に例外ができる。
- **本文を出力の末尾に単純に足す**: 本文と返事の長さによって、どちらかが末尾の上限で落ちる。

## Related ADRs

- Supersedes（一部）: [ADR-0048 A2A は `ask-agent` で名前を指定して頼み、裏の仕事で返事を待つ](0048-ask-agents-by-name-and-wait-in-a-background-job.md)（Decision 項 2（終わりの出来事だけで結果を読み、必要なら同じ Task を続ける）の、出来事に含める内容）。
- Related: [ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md)、[ADR-0030 裏の仕事は runner が道具で起こし、終わったら出力の末尾を持つ出来事を本体に入れる](0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)。
- Related: [ADR-0077 畳んだターンのツール呼び出しを、呼び出しと結果の組で残す](0077-keep-folded-tool-calls-as-tool-messages.md)（長いツール引数は履歴用の `folded` に置き換え、元の本文は残さない）。
- Related: [ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す](0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)、[ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く](0029-slack-events-inline-drawn-as-channels-and-threads.md)、[ADR-0033 Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す](0033-slack-posts-through-slackctl-with-the-token-stand-in.md)。

## References

- 本番のセッションを用いた fold-replay の集計（運用記録、2026-11-28 確認）: なつみの再生で畳んだ表記の模倣は従来方式で 129 応答中 14 件、200 文字を超える呼び出しを置き換える方式で 66 応答中 0 件。ペネロペでは両方式を比べた 30 地点でいずれも 0 件。再生中のツールは実行していない。
- [sandbox API の「終わったターンの畳み込み」](../sandbox-api.md#終わったターンの畳み込み)（2026-11-28 確認）: 200 文字の上限。[この変更の PR](https://github.com/yuanying/penelope/pull/152)。
- [`ask-agent`](../../packages/runner/src/ask-agent.ts) の `request` と `main` 内の `report`、[裏の仕事](../../packages/runner/src/jobs.ts) の `Jobs.finished`（2026-11-28 確認）。
- [Slack の受信プラグイン](../../packages/receivers/src/plugins/slack/workspace.ts) の `Workspace.fromMessage`・`Workspace.said` と [受信テスト](../../packages/receivers/test/slack-workspace.test.ts) の自分の投稿を `batch` にする検証（2026-11-28 確認）。
