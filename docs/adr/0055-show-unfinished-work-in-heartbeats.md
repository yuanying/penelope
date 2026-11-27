# 0055. 残っている仕事は heartbeat の出来事にだけ載せる

- Date: 2026-11-22
- Status: Accepted（一部を [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え）

## Context

さやかが A2A の依頼に返さず、送り手ごとの開いている Task の上限に達して、同じ送り手の新しい依頼が `rejected` になったとオーナーから報告があった。開いている Task は夜の切り替えでは閉じず、返事がなければ送り手の最後のメッセージから期限を過ぎて `failed` になるまで枠を使う。上限で断った依頼は送り手には見えるが、出来事にならないので受け手は気づかない。開いている Task の一覧を取る口は、A2A・Web UI・sandbox のいずれにもない。

heartbeat は、本体が起きている時間に、一定時間ターンがなかったことを伝える出来事である。オーナーの発言はターンの入力に全文が載るが、heartbeat は通常の非 inline の出来事と同じく、要約（`summary`）と `/sources` に足された場所（`appended`）だけが載る。ファイルを開くことに頼ると、モデルによっては追加の情報を見落とす。一方、普段のターンに残っている仕事を添えると、そのターンの用件以外にも注意を割かせてしまう。

## Decision

### 1. 本体への heartbeat の行に直接載せる

- 残っている仕事は仕組みが集める。エージェントが自分で一覧を見に行くための道具は新設しない。裏の仕事とサブエージェントの既存の道具は変えない。
- 本体のターンの `<events>` で、heartbeat の JSON の行にだけ残っている仕事を構造化して直接載せる。`summary` と `appended` は残し、出来事の中身全体を inline にするのではなく、残っている仕事だけを例外とする。モデルが `/sources` を開かなくても気づけるようにするためである。他の出来事の行とシステムプロンプトには載せない。
  - 2026-11-27 追記: 載せる先を heartbeat の行だけとする点は [ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え。エージェントが起きたことを知らせる出来事の行にも、同じ残っている仕事を載せる。
- 残っている仕事は事実として渡す。片付けの指示は書かず、何をするかはエージェントに任せる。heartbeat の発生条件、配送、畳む前の頼みの扱いは変えない。

### 2. 載せるのは 4 種類に絞る

1. **返事が済んでいない A2A の Task**: 送り手、経過時間、状態、`task_id`、返事に使える送り手の出来事の `seq`、元の出来事の要約（200 字まで）。エージェントの返事待ち（`working`）と、聞き返しに対する送り手の答え待ち（`input-required`）を区別する。どちらも枠を使うが、次に答える側は異なる。期限を過ぎた Task は載せない。
2. **走っている裏の仕事**: 操作に使う `job`、始めた時刻、コマンドの冒頭。
3. **開いたままのサブエージェント**: 操作に使う `name`、目的、状態（`running`・`waiting`）、その状態になった時刻。実行中のものと、何もせず長く待っていて閉じ忘れかもしれないものを見分けるためである。runner のサブエージェントの記録に状態が変わった時刻を残す。
4. **前の heartbeat より後に失敗したターンと裏の仕事**: 種類、時刻、ターンの短い失敗理由、または裏の仕事のコマンドの冒頭と終了コード（ある場合）。活動の記録の失敗判定を使い、中断や夜の切り替え自体の結果は並べない。

失敗は前の heartbeat より後のものだけ、他の 3 種類は片付くまで毎回載せる。種類ごとに最大 5 件とし、超えた分は件数だけを添える。元の依頼の本文や裏の仕事の出力は載せない。空の種類は省き、4 種類とも空ならこれまでと同じ heartbeat とする。

### 3. 次のものは載せない

- **近いうちの予約**: まだ実行時刻が来ていない予定は、残っている仕事とは別で、時刻が来れば通常の出来事として届く。
- **オーナーへの未返事**: オーナーの発言に個々の返事を求めるものではなく、未返事を heartbeat で数える対象にはしない。
- **上限で断った A2A の依頼**: 引き受けていないため、引き続き出来事にせず、送り手にだけ結果を返す。
- **記憶**: 目標や今日の予定など、何を記憶から読むかは仕組みがこの一覧で決めない。
- **Slack・GitHub の未返答**: backend は個々の出来事に返したかどうかを管理していない。出来事の受信だけを根拠に未返答とみなさない。

### 4. backend と runner はそれぞれが持つ状態から集める

- backend は、heartbeat を作るときに、自分が持つ A2A の Task と活動の記録から対象分だけを採り、その出来事と一緒に runner へ渡す。前の heartbeat は backend が入れた出来事を基準にする。活動の記録を読むための既存の UI の口や、A2A の送り手が読める範囲は広げない。
- runner は、heartbeat の行を組み立てるときに、自分が持つ裏の仕事とサブエージェントの状態を採り、backend から来た分と合わせて入力に載せる。それ以外の出来事にはこの処理をしない。
- 状態を持つ側で採れば、既にある出来事の配送だけで足りる。runner の状態を backend に複製したり、heartbeat を作る側が runner に問い合わせたりする必要がない。活動の記録から渡すのは本体への heartbeat 用の失敗の要約だけとする。情報を取得できない種類は載せず、通常の heartbeat の配送は止めない。

### 本 ADR で決定しないこと

- JSON の欄名、`summary` と超過件数の表記、上限内での並び順と、コマンドを短くする方法（委譲先: 実装と [出来事の仕様書「ターンに入る形」](../events.md#ターンに入る形)）
- 前の heartbeat がまだないときの失敗の集計範囲と、状態が変わった時刻を持たない既存のサブエージェントの扱い（委譲先: 実装と [backend の仕様書](../backend.md)・[sandbox 向けの口の仕様書](../sandbox-api.md)）

## Consequences

- エージェントは、追加の道具の呼び出しなしに、返事待ちの依頼や閉じ忘れの候補に気づける。処理や再試行を自動で行うわけではないので、放置がなくなることまでは保証しない。
- 忙しくて heartbeat が来ない間は、この一覧も届かない。上限に詰まってもすぐに知らせることより、普段のターンの用件を増やさないことを優先する。
- 一覧はターンの文脈を使い、片付くまでは同じ仕事が繰り返し載る。件数の上限と短い要約で量を抑える代わりに、上限を超えた項目は個別には見えない。
- backend は出来事を入れる時点、runner は入力を組み立てる時点の状態を採る。両者を同じ時点にそろえるための同期はしない。その後に仕事が進み、載った状態が操作時点では変わっていることもある。

## Alternatives Considered

- **一覧の道具か `/sources` への参照だけを渡す**: 必要なら読めるが、モデルが道具を呼ばなかったりファイルを開かなかったりすると、知らせたい仕事に気づけない。
- **普段のターンにも添える、または仕事ごとに専用の出来事で起こす**: 早く見える一方、そのターンの用件を増やしたり、追加のターンを発生させたりする。heartbeat が来ない間は一覧を出さない方を選ぶ。
- **backend が 4 種類すべてを集める**: 発生時点の一覧を一か所に置けるが、runner の状態の通知か問い合わせが増え、通知なら backend に状態の写しを持たせて更新の遅れも扱うことになる。

## Related ADRs

- Superseded by（一部）: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（Decision 項 1「本体への heartbeat の行に直接載せる」の、載せる先を heartbeat の行だけとする点）
- Supersedes（一部）: [ADR-0031 起きている時間に何もない時間が続いたら、backend が heartbeat の出来事を入れる](0031-a-heartbeat-event-after-quiet-minutes-in-awake-hours.md)（Decision 項 2「何をするかはエージェントに任せる」の、無活動の事実だけを持つ点）
- Supersedes（一部）: [ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す](0013-event-contents-in-sources-and-summaries-in-turns.md)（Decision 項 2「ターンには要約と場所だけを渡す」に heartbeat の残っている仕事だけの例外を加える。通常の inline の設定と `/sources` の追記は変えない）
- Supersedes（一部）: [ADR-0022 サブエージェントは runner が非同期に回し、本体とだけツールと自分宛ての出来事でやりとりする](0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md)（Decision 項 4「サブエージェントの寿命は、本体が閉じるまで」の、ターン入力には一覧を差し込まない点。寿命と既存の一覧の道具は変えない）
- Related: [ADR-0017 ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする](0017-turn-input-as-json-lines-in-events.md)（行の形式と型で契約を持つ点は変えない）
- Related: [ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる](0008-prompts-state-facts-and-leave-the-how.md)（残っている仕事は事実として渡す）
- Related: [ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md)（上限、期限、返事の宛先は変えず、送り手への催促はしない）
- Related: [ADR-0030 裏の仕事は runner が道具で起こし、終わったら出力の末尾を持つ出来事を本体に入れる](0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md)（起動と終了の知らせは変えない）
- Related: [ADR-0038 活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる](0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md)（失敗の定義と記録。記録の閲覧の口は変えない）
- Related: [ADR-0024 GitHub の webhook は状態を持たずに受け、レビューの依頼と取り消しの 2 つだけを出来事にする](0024-github-webhooks-pass-review-requests-and-dismissals-without-state.md)（受信時に返答を追跡しない）
- Related: [ADR-0029 Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く](0029-slack-events-inline-drawn-as-channels-and-threads.md)（既存の入力の形は変えない）

## References

以下のコードと仕様は 2026-11-22 確認。

- オーナーからの一次報告（2026-11-22）: さやかが A2A に返さず、送り手ごとの上限で新しい依頼が拒否された。本番の DB は確認していない。
- [A2A の受け口の仕様書](../a2a.md) の「新しい依頼」「期限」「状態」と、[`inbox.ts`](../../packages/backend/src/a2a/inbox.ts) の `Inbox.open`・`Inbox.expire`・`Inbox.reply`: 上限、期限、出来事の `seq` による返事。既定は [`config.ts`](../../packages/backend/src/config.ts) の A2A の設定（`PENELOPE_A2A_MAX_OPEN_TASKS`・`PENELOPE_A2A_DEADLINE_HOURS`）で上限 3 件、期限 24 時間。
- [`endpoint.ts`](../../packages/backend/src/a2a/endpoint.ts) の `listTasks`（`UnsupportedOperation`）、[UI 向けの API の仕様書](../ui-api.md)・[sandbox 向けの口の仕様書](../sandbox-api.md): 開いている Task の一覧の口はない。
- [`heartbeat.ts`](../../packages/backend/src/heartbeat.ts) の `Heartbeat.tick`、[`queue.ts`](../../packages/backend/src/queue.ts) の `delivered`: backend は無活動の知らせを作り、非 inline の出来事では payload を runner に配送しない。
- [`prompts.ts`](../../packages/runner/src/prompts.ts) の `systemPrompt`、[`runner.ts`](../../packages/runner/src/runner.ts) の `Runner.input`、[`turn-input.ts`](../../packages/runner/src/turn-input.ts) の `formatEvents` と [出来事の仕様書「ターンに入る形」](../events.md#ターンに入る形): runner が `<events>` の行を組み立てる。
- [`jobs.ts`](../../packages/runner/src/jobs.ts) の `Jobs.list` と [`subagents.ts`](../../packages/runner/src/subagents.ts) の `SubAgents.list`・`SubAgentRecord`: runner が稼働中の裏の仕事と開いているサブエージェントを持つ。サブエージェントの記録には状態が変わった時刻がない。
- [`record.ts`](../../packages/backend/src/record.ts) の `ActivityRecord.turnEnded`・`ActivityRecord.jobEnded`: backend がターンの結果と裏の仕事の終了を記録する。
