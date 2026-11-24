# 0060. 答える口は出来事が持ち、送信を試みなければ一度だけ知らせる

- Date: 2026-11-24
- Status: Accepted

## Context

オーナーの Web UI からの発言に、エージェントが `reply` を呼ばず、ターンの最後の文だけで答える例が目立つとオーナーから報告があった。ターンの文は活動の記録には残るが、会話には返事として届かない。システムプロンプトは Web UI と A2A に返す道具を説明しているが、どの出来事にどの口で返せるかは示していない。runner も文だけで終わったことを知らせない。

同じ Slack の受信元から、自分宛ての DM だけでなく、チャンネルの発言・編集・リアクションも届く。受信元の名前だけでは、送信を忘れたかもしれない出来事と、読むだけでよい出来事を分けられない。Slack のプラグインは、どの発言をすぐ渡すかをすでに出来事ごとに決めている。答える口も、その出来事を作る側が知っている。どの口を使うかを知らせても、答えるかどうかはエージェントに任せる。

## Decision

### 1. 出来事を作る側が答える口を付ける

共通の封筒に任意の `answer_via` を加える。値は道具の名前を表す `{"tool":"…"}` か、シェルのコマンドの先頭を表す `{"command":"…"}` のどちらか一つである。どちらも空でない文字列を取り、宛先・引数・本文は入れない。`delivery` とは別の欄であり、`now` だからといって答える口があるとは限らない。

| 出来事を作る側 | `answer_via` を付ける出来事 | 値 |
|---|---|---|
| backend | オーナーの Web UI の発言（`ui`） | `{"tool":"reply"}` |
| backend | A2A の依頼と聞き返しへの答え（`a2a`） | `{"tool":"reply_to_agent"}` |
| Slack のプラグイン | 自分自身の投稿を除き、bot へのメンション・DM・配置で `now` にするチャンネルの発言。取り直しも含め、発言を `now` にする既存の判定を共用する | `{"command":"slackctl post"}` |

それ以外の Slack の出来事、裏の仕事の終了、予約、自分宛て、Alertmanager などには付けない。受信元を足す作者は、返事が想定される出来事に欄を付けるだけでよい。runner の受信元一覧やプロンプトの対応表は更新しない。付け忘れた場合はヒントと念押しがないだけで、出来事は従来どおり届く。

### 2. 封筒からターンの行まで値を保つ

backend は JSON と添付付きの取り込みのどちらでも `answer_via` を封筒の欄として受ける。形が不正なら封筒の不正として取り込みを断る。正しければ、backend が中で作った出来事も含め、既存の出来事の保存（待ち行列と `/sources`）と runner への配送でその値を保つ。無い欄は補わず、既存の記録にも足さない。重複の扱いは変えない。

runner は inline かどうかにかかわらず、該当する出来事の JSON の行に `answer_via` をそのまま載せる。欄がある出来事は `batch` で届いても個別の行にし、まとめの中で `seq` と答える口の対応を失わないようにする。これはターンでの表示だけの例外で、`delivery` の待ち方は変えない。Slack の描画に失敗しても欄は落とさない。

本体のシステムプロンプトには、ターンの文は返事として届かないこと、`answer_via` がある出来事に答えるなら示された口を使うこと、答えないことも選べることだけを返事の一般則として英語で書く。受信元別の使い方はプロンプトに並べない。Slack では同じワークスペース・チャンネル（DM を含む）に返し、スレッド内の発言にはそのスレッドで返す。A2A で答えないと決めたときは、エージェントが出来事の `seq` を指定し、本文・画像なしの `completed` で Task を閉じる。runner は代わりに閉じない。開いた Task は期限で `failed` になるまで heartbeat に載る対象のままである。

`answer_via` は信頼した backend の受信処理や配置で有効にしたプラグインが付けるヒントである。外から届いた本文や `payload` 内の同名の欄を、封筒の値としてそのまま採らない。ヒントは宛先や権限を与えず、runner がこの値を実行することもない。宛先を確かめられなければ推測して送らない。外への送信と Task の更新には、既存の権限・失敗時の扱いを使う。

### 3. どの口も試みていなければ、同じターンで一度だけ念を押す

対象は本体の日中の出来事のターンだけとする。サブエージェントと夜の振り返り・照合・整理には適用しない。次をすべて満たしたときに知らせる。

- `answer_via` のある出来事をターンに渡した。途中の steer と follow-up で実際に渡したものも含む。
- 出来事の処理が `done` で終わり、そのターンの最後のアシスタントメッセージに空白だけではない文がある。途中の文、思考、ツール出力、前のターンの文は数えない。失敗・中断や runner の停止中は知らせない。
- そのターンで、該当する `answer_via` のどの口も試みていない。

`tool` は実際に呼び出した道具の名前、`command` は `bash` または `job_start` に渡したコマンドにそのコマンドの先頭が現れたことで照らし合わせる。行頭からだけでなく、パイプなどに続く呼び出しも対象とする。道具の成否、実際の到達、宛先と `seq` の対応は調べない。一つでも試みがあればターン全体で知らせない。失敗した呼び出しやコマンドの誤検出で促し損ねることを受け入れ、重複送信を促す危険を減らす。欄に対応しない `ask-agent`・予約・サブエージェントとのやりとりなどは数えない。別のスクリプトや `curl` で送ったときは、送信済みでも知らせが出る場合がある。

知らせはオーナーからの発言や新しい出来事ではなく、同じ Pi セッションの runner 由来の続きの入力とする。対象の `seq`・`source`、送信の試みが見当たらないこと、ターンの文は返事として届いていないこと、この続きでは送るかそのまま終えるかだけでよいことを英語で伝える。出来事やターンの本文は転載しない。続きの道具は制限せず、自動送信や自動再送もしない。

ターンの終了・記憶のコミット・出来事の ack より前に知らせ、新たに届く出来事は次のターンに回す。畳む前の聞き取りとは別であり、その聞き取りで初めて出た文を根拠にしない。続きも何も出さず正常に終われば、答えないと決めたものとして再度は促さない。続きが失敗・中断した場合も、通常のターンの結果として扱い、新たに促さない。

### 4. 念押しの結果は runner のログで数える

念押しごとに runner のログを一行残す。対象の `seq`・`source` の組、続きで該当する口を試みたか、続きで道具を呼んだ回数、続きの終わり方を記録する。本文と道具の引数は記録しない。backend の活動の記録には専用の欄や別ターンを足さず、続きで出た文・道具の呼び出し・ターンの結果を既存の形式で記録する。

### 本 ADR で決定しないこと

- `reply` を sandbox の CLI・コネクタに移すこと（委譲先: Web UI の返事の口を見直すときの新しい ADR。既存の契約は [sandbox 向けの口の仕様書「返事」](../sandbox-api.md#返事)）
- 封筒・取り込み・保存・ターンの行の契約の詳細（委譲先: [出来事の仕様](../events.md) の「封筒」「取り込み口」「`/sources`」「ターンに入る形」、[sandbox 向けの口の仕様「出来事を取る」](../sandbox-api.md#出来事を取る)）
- プラグイン作者向けの契約と Slack の付与条件の詳細（委譲先: [receivers の仕様](../receivers.md) の「プラグインの内側の契約」「Slack のプラグイン」）。実装の変更では、返信を想定する Slack の発言と読むだけの出来事が取り込み口に異なる封筒で渡ることを receivers の契約テストで確かめる。
- コマンドの照合方法、Pi に足すメッセージの型、知らせの文面、ログの書式（委譲先: `packages/runner/src/runner.ts` の `turnOf` と `packages/runner/src/prompts.ts` の `systemPrompt` を含む runner の実装）

## Consequences

- 出来事を足しても runner に受信元ごとの対応を足さなくてよい。Slack の自分宛てでない通常の発言など、口が付かない出来事だけでは念押ししない。
- 封筒・保存・配送に共通の欄が増える一方、backend がプラグインの `payload` の形を知る必要はない。
- 念押ししたターンではモデルへの呼び出しが増え、次の出来事が待つ。ログで続きの有無と結果を数えられるが、配達の保証や出来事ごとの未返信の検出はしない。

## Alternatives Considered

- **runner が受信元ごとの一覧を持つ**: 受信元を足すたびに runner の更新が要り、同じ Slack の受信元でも返事を想定する発言とそれ以外を分けられない。
- **ターンの文を自動送信する**: 答えない選択を奪い、出来事が混じったときに宛先を取り違えうる。

## Related ADRs

- Related: [ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる](0008-prompts-state-facts-and-leave-the-how.md)（出来事ごとの手順は足さず、答える口の欄の意味を知らせる）
- Related: [ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す](0013-event-contents-in-sources-and-summaries-in-turns.md)（`payload` の扱いは変えず、共通の封筒の欄を加える。念押しは新しい出来事にしない）
- Related: [ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md)（畳む前の聞き取りと念押しは別）
- Related: [ADR-0017 ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする](0017-turn-input-as-json-lines-in-events.md)（個別の行の契約に欄を足す）
- Related: [ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md)（Decision 項 4（エージェントは出来事の `seq` を名指して Task に返す）の本文なしの完了を使う。念押しは、Decision 項 3（上限と期限で、Task が開いたまま積もらないようにする）で採らなかった、開いた Task に対する backend の催促ではない）
- Related: [ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す](0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)（Decision 項 4（`delivery`）の Slack の発言の判定を共用する）
- Related: [ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く](0029-slack-events-inline-drawn-as-channels-and-threads.md)（`answer_via` の無い Slack の `batch` の描き方は変えない）
- Related: [ADR-0030 裏の仕事は runner が道具で起こし、終わったら出力の末尾を持つ出来事を本体に入れる](0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)（仕事の契約は変えず、送信の試みには欄に対応する起動だけを数える）
- Related: [ADR-0032 返事に sandbox の画像を添え、backend が写して Web UI で見せる](0032-images-attached-to-a-reply-copied-by-the-backend.md)（`reply` の道具と画像添付は変えない）
- Related: [ADR-0033 Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す](0033-slack-posts-through-slackctl-with-the-token-stand-in.md)（既存の投稿の口と権限を使う）
- Related: [ADR-0038 活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる](0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)（活動の記録の契約は変えない）
- Related: [ADR-0055 残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md)（開いた Task が heartbeat に載る条件は変えない）

## References

- `packages/runner/src/prompts.ts` の `systemPrompt`、`packages/runner/src/tools.ts` の `backendTools`（2026-11-24 確認）: 返事が届く口の説明と道具の契約。
- `packages/backend/src/queue.ts` の `Queue`、[出来事の仕様](../events.md) の「封筒」「取り込み口」「`/sources`」、[sandbox 向けの口の仕様](../sandbox-api.md) の「出来事を取る」（2026-11-24 確認）: 共通の封筒から保存・配送までの既存の契約。
- `packages/receivers/src/plugins/slack/workspace.ts` の `Workspace` と [receivers の仕様](../receivers.md) の「Slack のプラグイン」の「`delivery`」「投稿の CLI」（2026-11-24 確認）: 発言の配送の判定、取り直し、投稿で選べる宛先。
- `packages/runner/src/turn-input.ts` の `turnLines`、`packages/runner/src/runner.ts` の `deliver`・`turnOf`・`ask` と `packages/runner/src/activities.ts` の `TurnRecorder`（2026-11-24 確認）: ターンの行、続きの入力、畳む前の聞き取り、終了と活動記録。
- `packages/backend/src/a2a/inbox.ts` の `reply`・`expire`・`heartbeatTasks`（2026-11-24 確認）: 本文・画像なしでの完了、期限、開いた Task の参照。
