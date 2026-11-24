# 0060. 答えるときは出来事の口を使い、ターンの文だけで終わったら一度だけ知らせる

- Date: 2026-11-24
- Status: Accepted

## Context

オーナーの Web UI からの発言に、エージェントが `reply` を呼ばず、ターンの最後の文だけで答える例が目立つとオーナーから報告があった。ターンの文は活動の記録には残るが、Web UI の会話や Slack、送り手の A2A Task には返事として届かない。システムプロンプトは、ターンの文が届かないことと Web UI・A2A の返す道具を説明しているが、出来事の受信元と答える口を結び付けていない。runner も、文だけで終わったことをエージェントに知らせずにターンを閉じる。

オーナーの発言でも外からの依頼でも、答えるかどうかはエージェントに任せたい。忘れて送らなかった場合に気づく機会は作るが、答えないという選択を上書きしたり、ターンの文をシステムが代わりに送ったりはしない。

## Decision

### 1. 答える口は出来事の受信元で決まる

本体のシステムプロンプトに、ターンの文は返事としてどこにも届かないこと、答えるなら出来事が来た口を使うこと、答えないことも選べることを英語で示す。受信元と口の対応だけを示し、投稿手順や、どんなときに答えるべきかは書かない。

| 出来事の受信元 | 答える口 | 答えないとき |
|---|---|---|
| オーナーの Web UI の発言（`ui`） | `reply` | 何も送らない |
| Slack（配置で指定した受信元） | `slackctl post`。同じワークスペースの同じチャンネル（DM を含む）に返し、スレッド内の発言にはそのスレッドで返す | 何も送らない |
| A2A（`a2a`） | 出来事の `seq` を指定して `reply_to_agent` | 本文も画像も付けずに `reply_to_agent` の `completed` で Task を閉じる |
| その他（裏の仕事の終了、予約、自分宛て、heartbeat など） | その出来事自体には答える相手がいない | — |

A2A で答えないことを選んだエージェントは、上のとおり Task を明示的に閉じる。何も呼ばずに終えた場合は runner が代わりに閉じることはなく、開いた Task は期限で `failed` になるまで heartbeat の残っている仕事の対象となる。本文なしでの完了、期限、聞き返しは既存の Task の契約を使う。

これは受信した出来事に答える場合の決定であり、裏の仕事の結果を元の依頼に返すことや、オーナーへの自発的な連絡を妨げない。`reply` の API、Slack の投稿の権限や鍵、A2A の送り手と Task の対応は変えない。受信元が不明なときは宛先を推測しない。Slack の受信元の設定が無ければ、その名前を推測して表や念押しに足さない。

### 2. 本体の出来事のターンで、一度だけ念を押す

次をすべて満たしたとき、runner はターンを閉じる前に知らせる。夜の振り返り・照合・整理と、サブエージェントのターンは対象外とする。

- ターンに、答える口がある受信元（`ui`、配置で Slack として設定した `source`、`a2a`）の出来事が入った。途中の steer や follow-up で実際に渡った出来事も含める。Slack の判定には、描画に使う受信元の設定を共用する。
- 出来事の入力とその続きの処理が `done` で終わり、そのターンの最後のアシスタントメッセージに空白だけではない文がある。途中の文、思考、ツール出力、前のターンの文は代わりに数えない。失敗・中断や、runner の停止中は知らせない。
- そのターンに、次に定める送信の試みが一つもない。

送信の試みとみなすのは、`reply`・`reply_to_agent` の呼び出し（本文なしの完了を含む）、および `bash`・`job_start` のコマンドに `slackctl post` が現れたことだけとする。実際の到達、ツールの成否、宛先と各 `seq` の対応は確かめない。試みが一つでもあれば、ほかに答えていない出来事が混じっていても念を押さない。失敗した呼び出しや投稿を含むコマンドの誤検出による促し損ねを受け入れ、重複した送信を促す危険を減らす。`ask-agent` での別の依頼、サブエージェントとのやりとり、予約、自分宛ての出来事、投稿を含まない裏の仕事は数えない。`curl` や別のスクリプトを使った投稿までは追跡しないので、送信済みでも知らせが出る場合がある。

### 3. 同じターンに runner の知らせとして足す

知らせは、受信した出来事やオーナーの発言ではなく、同じ Pi セッションで本体に渡す runner 由来の続きの入力とする。対象の出来事の `seq` と `source`、runner がこのターンに送信の試みを見ていないこと、ターンの文は返事として届いていないこと、答えないならそのまま終えてよいことを英語で伝える。出来事の本文やターンの文は転載しない。知らせを受けた続きでも通常の道具を使える。runner は自動送信・自動再送をせず、外に作用する道具は既存の権限と失敗時の扱いに従う。

知らせはターンの終了・記憶のコミット・出来事の ack より前に入れ、活動上も元のターンの一部とする。念押しの間に届く新しい出来事は次のターンに回す。畳む前に保持する文を聞く処理とは別とし、その聞き取りで初めて出た文を根拠にはしない。知らせは一つのターンに最大一回とし、その続きも何も出さず正常に終われば、答えないと決めたものとして再度は促さない。続きが失敗・中断した場合は通常のターンの結果として扱い、新たに促さない。

知らせは Pi のセッション記録と runner のログで追えるようにする。活動の記録には専用の項目や別ターンを足さず、続きで出た文・道具の呼び出し・ターンの結果は既存の記録に残す。

### 本 ADR で決定しないこと

- `reply` を sandbox の CLI・コネクタに移して Web UI を Slack と同じ構成にすること（委譲先: Web UI の返事の口を見直すときの新しい ADR。既存の契約は [sandbox 向けの口の仕様書「返事」](../sandbox-api.md#返事)）
- プロンプトと知らせの正確な文面、Pi に足すメッセージの型、コマンド文字列の照合方法（委譲先: runner の実装。既存の入口は `packages/runner/src/prompts.ts` の `systemPrompt` と `packages/runner/src/runner.ts` の `turnOf`）

## Consequences

- エージェントは返事の出し先と、答えない選択を同じ場所で知る。文だけで終わった場合にも、外へ返すかどうかを見直す機会が一度ある。
- 念押しが入るターンではモデルへの処理が増え、終了や次の出来事の処理が遅くなる。届いたことの保証や、出来事ごとの未返信の検出は得られない。
- A2A で本文なしの完了を選べば、送り手には完了が見え、Task の枠が空く。道具を呼ぶこと自体を忘れた Task には、既存の期限と heartbeat が引き続き効く。

## Alternatives Considered

- **ターンの文を返事として自動で送る**: 答えない選択を奪い、複数の出来事が入ったときに文の宛先を取り違えうる。
- **宛先ごとに配達を追い、未返信を促す**: Web UI、Slack、A2A で配達の意味が異なり、裏の仕事はターンが終わってから投稿することもある。忘れた可能性に気づくためだけに配達状態を持たない。

## Related ADRs

- Related: [ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる](0008-prompts-state-facts-and-leave-the-how.md)（「出来事がどう届き、どう返すか」に、答える口の対応を具体化する。出来事ごとの手順や扱いは足さない）
- Related: [ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す](0013-event-contents-in-sources-and-summaries-in-turns.md)（出来事の取り込み・配送や `/sources` の形は変えず、念押しを別の出来事にはしない）
- Related: [ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md)（畳む前の聞き取りと念押しは別）
- Related: [ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md)（Decision 項 4（エージェントは出来事の `seq` を名指して Task に返す）の本文なしの完了を、不回答の選択に使う。Decision 項 3（上限と期限で、Task が開いたまま積もらないようにする）の、開いた Task に backend が催促しない方針は変えない。同じターン内の念押しは Task の状態を見て起こす催促ではない）
- Related: [ADR-0022 サブエージェントは runner が非同期に回し、本体とだけツールと自分宛ての出来事でやりとりする](0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)（サブエージェントは念押しの対象外で、本体とのやりとりも送信の試みに数えない）
- Related: [ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す](0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)（Decision 項 2（1 つの有効化で複数のワークスペースを受ける）のとおり、Slack の `source` は有効化ごとに決まる）
- Related: [ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く](0029-slack-events-inline-drawn-as-channels-and-threads.md)（Decision 項 2（描き方は Slack のプラグインの package に置き、runner と CLI が同じコードを使う）と同じ配置の設定で Slack の受信元を識別する）
- Related: [ADR-0030 裏の仕事は runner が道具で起こし、終わったら出力の末尾を持つ出来事を本体に入れる](0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)（仕事の起動と終了の契約は変えない。念押しでは投稿を含む起動だけを数える）
- Related: [ADR-0032 返事に sandbox の画像を添え、backend が写して Web UI で見せる](0032-images-attached-to-a-reply-copied-by-the-backend.md)（`reply` は引き続き Web UI の口であり、画像添付も変えない）
- Related: [ADR-0033 Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す](0033-slack-posts-through-slackctl-with-the-token-stand-in.md)（既存の `slackctl post` を Slack の答える口とし、他の投稿方法を禁じない）
- Related: [ADR-0038 活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる](0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)（記録の契約は変えない）
- Related: [ADR-0055 残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md)（開いた Task は引き続き heartbeat に載る対象）

## References

- `packages/runner/src/prompts.ts` の `systemPrompt` と `slackSection`、`packages/runner/src/tools.ts` の `backendTools`（2026-11-24 確認）: ターンの文は届かない旨、Slack の受信元、`reply`・`reply_to_agent` の契約。
- `packages/runner/src/runner.ts` の `deliver`・`turnOf`・`ask` と `packages/runner/src/activities.ts` の `TurnRecorder`（2026-11-24 確認）: 出来事の続き、同じセッションへの畳む前の聞き取り、ターンの終了と ack、文と道具の活動記録。
- `packages/backend/src/a2a/inbox.ts` の `reply`・`expire`・`heartbeatTasks` と [sandbox 向けの口の仕様書「A2A の Task に返す」](../sandbox-api.md#a2a-の-task-に返す)（2026-11-24 確認）: 本文・画像なしでの完了、期限、開いた Task の参照。
- [receivers の仕様書「投稿の CLI」](../receivers.md#投稿の-cli)（2026-11-24 確認）: `slackctl post` はワークスペース、チャンネル、スレッドを指定できる。
