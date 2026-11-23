# ADR

penelope の設計の判断の記録です。1 つの ADR に 1 つの判断を書きます。

| 番号 | タイトル | Status |
| --- | --- | --- |
| 0001 | [1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす](0001-one-pod-with-pi-inside-the-sandbox.md) | Accepted |
| 0002 | [出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく](0002-one-intake-and-a-runner-that-pulls-events.md) | Accepted（一部を ADR-0014 で置き換え） |
| 0003 | [sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する](0003-all-egress-through-the-sentinel-passthrough-by-default.md) | Accepted（一部を ADR-0014 で置き換え） |
| 0004 | [本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする](0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md) | Accepted（一部を ADR-0021 で置き換え） |
| 0005 | [承認待ちは Sentinel が持ち、オーナーは Web UI で答える](0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md) | Accepted |
| 0006 | [記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md) | Accepted（一部を ADR-0049 で置き換え） |
| 0007 | [セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える](0007-one-session-switched-nightly-with-a-one-turn-curator.md) | Accepted（一部を ADR-0044 で置き換え） |
| 0008 | [プロンプトは事実と環境だけを伝え、やり方は任せる](0008-prompts-state-facts-and-leave-the-how.md) | Accepted（一部を ADR-0045 と ADR-0049 で置き換え） |
| 0009 | [最初の UI は Web だけにし、新しい API と Astryx で作る](0009-web-ui-first-with-a-new-api-and-astryx.md) | Accepted（一部を ADR-0016 で置き換え） |
| 0010 | [人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる](0010-github-oauth-for-people-tokenreview-for-a2a.md) | Accepted（一部を ADR-0018 で置き換え） |
| 0011 | [sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する](0011-a-full-dev-image-and-a-generic-user-home.md) | Accepted |
| 0012 | [なつみベースのペネロペからは、並べて立ち上げてから切り替え、戻せる形を保つ](0012-move-penelope-side-by-side-and-keep-a-way-back.md) | Accepted |
| 0013 | [出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す](0013-event-contents-in-sources-and-summaries-in-turns.md) | Accepted（一部を [ADR-0055](0055-show-unfinished-work-in-heartbeats.md) で置き換え） |
| 0014 | [sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける](0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md) | Accepted |
| 0015 | [終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない](0015-fold-ended-turns-before-they-are-sent.md) | Accepted（一部を ADR-0031 で置き換え） |
| 0016 | [最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる](0016-show-the-avatar-and-expression-from-the-first-web-ui.md) | Accepted |
| 0017 | [ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする](0017-turn-input-as-json-lines-in-events.md) | Accepted |
| 0018 | [A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md) | Accepted（一部を ADR-0047 で置き換え） |
| 0019 | [ssh は別のコンテナの ssh-agent の socket で行い、鍵は sandbox に見せない](0019-ssh-through-an-agent-socket-keys-kept-out-of-the-sandbox.md) | Superseded by ADR-0021 |
| 0020 | [コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す](0020-connectors-with-a-usage-document-listed-in-the-prompt.md) | Accepted（一部を ADR-0035 で置き換え） |
| 0021 | [自分で作った VM への ssh の鍵は、エージェントが自分で HOME に作る](0021-her-own-ssh-key-in-home-for-the-vms-she-makes.md) | Accepted |
| 0022 | [サブエージェントは runner が非同期に回し、本体とだけツールと自分宛ての出来事でやりとりする](0022-sub-agents-run-by-the-runner-and-talk-only-to-the-main-agent.md) | Accepted（一部を [ADR-0055](0055-show-unfinished-work-in-heartbeats.md) で置き換え） |
| 0023 | [receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける](0023-receivers-plugins-in-the-repository-and-alertmanager-first.md) | Accepted |
| 0024 | [GitHub の webhook は状態を持たずに受け、レビューの依頼と取り消しの 2 つだけを出来事にする](0024-github-webhooks-pass-review-requests-and-dismissals-without-state.md) | Accepted |
| 0025 | [Sentinel のホストの登録に、左端の 1 ラベルだけのワイルドカードを書ける](0025-wildcard-host-registrations-for-one-left-most-label.md) | Accepted（一部を [ADR-0054](0054-share-surrogates-only-for-the-same-key-source.md) で置き換え） |
| 0026 | [なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移し、記憶は履歴ごと写して、戻し道は持たない](0026-move-natsumi-myao-and-aki-one-deployment-each-without-a-way-back.md) | Accepted |
| 0027 | [本人への返事はすべて Web Push で知らせ、購読は配置ごとに backend が持つ](0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md) | Accepted |
| 0028 | [Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す](0028-slack-received-over-socket-mode-by-a-receivers-plugin.md) | Accepted |
| 0029 | [Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く](0029-slack-events-inline-drawn-as-channels-and-threads.md) | Accepted |
| 0030 | [裏の仕事は runner が道具で起こし、終わったら出力の末尾を持つ出来事を本体に入れる](0030-background-jobs-run-by-the-runner-and-their-end-as-an-event.md) | Accepted |
| 0031 | [起きている時間に何もない時間が続いたら、backend が heartbeat の出来事を入れる](0031-a-heartbeat-event-after-quiet-minutes-in-awake-hours.md) | Accepted（一部を [ADR-0055](0055-show-unfinished-work-in-heartbeats.md) で置き換え） |
| 0032 | [返事に sandbox の画像を添え、backend が写して Web UI で見せる](0032-images-attached-to-a-reply-copied-by-the-backend.md) | Accepted |
| 0033 | [Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す](0033-slack-posts-through-slackctl-with-the-token-stand-in.md) | Accepted |
| 0034 | [オーナーが送った画像も backend が写し、会話の履歴の行に結び付ける](0034-images-the-owner-sends-copied-by-the-backend.md) | Accepted |
| 0035 | [道具の使い方とどの配置にも同じ skill は sandbox の image に skill として入れ、オーナー・記憶の後に並べる](0035-tool-usage-and-shared-skills-as-image-skills.md) | Accepted（一部を ADR-0042 で置き換え） |
| 0036 | [アバターは記憶の中で育て、最初の 1 回だけ backend が選んだアバターを写す](0036-the-avatar-grown-in-memory-copied-once-by-the-backend.md) | Accepted |
| 0037 | [main への push ごとに image を `main` の tag で出し、脆弱性対応の係の PR がマージされたらすぐにパッチ版を出す](0037-a-main-image-to-scan-and-a-vulnerability-fix-released-at-once.md) | Accepted |
| 0038 | [活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる](0038-the-activity-record-kept-as-one-line-summaries-by-the-backend.md) | Accepted（一部を ADR-0044 で置き換え） |
| 0039 | [Pi 拡張はオーナーの置き場と記憶から本人のセッションだけに読み込む](0039-load-owner-and-memory-extensions-in-the-main-session.md) | Accepted |
| 0042 | [配置が一覧に載せる image の skill を選ぶ](0042-select-image-skills-per-deployment.md) | Accepted |
| 0043 | [モデルと思考の深さはオーナーが設定画面で選ぶ](0043-the-owner-picks-the-model-and-thinking-level-in-the-web-ui.md) | Accepted（一部を ADR-0044 で置き換え） |
| 0044 | [夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md) | Accepted（一部を ADR-0050 と ADR-0051 で置き換え） |
| 0045 | [夜のプロンプトは目的を伝え、印の付いたモデルだけに手順を足す](0045-tell-nightly-roles-their-goals-and-add-guidance-by-model.md) | Accepted |
| 0046 | [モデル要求では接続先の上限に合わせて古い画像を省き、失敗を次のターンに伝える](0046-budget-images-before-model-requests.md) | Accepted |
| 0047 | [A2A のメッセージで画像を受け、Task の成果として返す](0047-exchange-images-over-a2a.md) | Accepted |
| 0048 | [A2A は `ask-agent` で名前を指定して頼み、裏の仕事で返事を待つ](0048-ask-agents-by-name-and-wait-in-a-background-job.md) | Accepted |
| 0049 | [配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md) | Accepted |
| 0050 | [夜は記憶の見取り図を渡し、棚卸しで中身と構成を分けて見直す](0050-organize-memory-with-a-map-and-a-weekly-review.md) | Accepted |
| 0051 | [照合と整理の基準は別々に持ち、成功したときだけ進める](0051-carry-unfinished-night-work-forward.md) | Accepted |
| 0052 | [夜の係が移動した記憶への参照は runner が直す](0052-repair-memory-references-after-nightly-moves.md) | Accepted |
| 0053 | [目的に沿った問いで記憶を評価する CLI を持つ](0053-evaluate-memory-with-purpose-questions.md) | Accepted |
| 0054 | [同じ出どころの鍵に限り、複数の登録でサロゲートを共有できる](0054-share-surrogates-only-for-the-same-key-source.md) | Accepted |
| 0055 | [残っている仕事は heartbeat の出来事にだけ載せる](0055-show-unfinished-work-in-heartbeats.md) | Accepted |
| 0056 | [記憶の画面はコミット済みの版を読み、活動の記録と行き来できるようにする](0056-read-committed-memory.md) | Accepted（一部を ADR-0057 で置き換え） |
| 0057 | [オーナーによる記憶の編集と復元は、backend が 1 ファイルずつ確定する](0057-edit-existing-memory-in-the-backend.md) | Accepted |
