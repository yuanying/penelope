# 端から端までの確かめ（e2e）

[docs/pod.md](../docs/pod.md) の Pod の 4 つのコンテナ（Sentinel・backend・sandbox・receivers）を Docker Compose で 1 つの網の名前空間に並べ、
Pod の外を偽物にして、オーナーのログインから夜の切り替えまでを通す。

```sh
make e2e
```

`make images` で image を作り、`node --test` で `test/e2e.test.ts` を動かす。Docker（Compose v2）と Node が要る。`make test` からは呼ばない。

- `PENELOPE_E2E_KEEP=1` を付けると、終わった後もコンテナを残し、全部のログを出す。失敗したときはいつもログを出す。
- 鍵と証明書は走らせるたびに `e2e/.run/` に作り直す（git には入れない）。

### 同じマシンで並べて走らせる

worktree ごとに Compose の project 名と image の版を分ける。

```sh
COMPOSE_PROJECT_NAME=penelope-e2e-<ブランチ名> VERSION=<ブランチ名> make e2e
```

- `COMPOSE_PROJECT_NAME` が、コンテナ・volume と、テストが作る image（`<project 名>-outside`・`<project 名>-init`）の名前を分ける。既定は `penelope-e2e`。
- `VERSION` が、`make images` の作るリポジトリの image（`penelope-<target>:<VERSION>`）の版を分ける。既定は `git describe` で、同じコミットの worktree どうしは重なる。
- 鍵と証明書の `e2e/.run/` は worktree ごとにあるので重ならない。網は Docker の既定の bridge を共有するが、アドレスは Docker がコンテナごとに付ける。

## 並べ方

| サービス | 役目 |
| --- | --- |
| `pod` | 網の名前空間の持ち主。Pod の pause コンテナに当たる |
| `init` | `NET_ADMIN` を持つ init container。sandbox の UID（1000）の TCP と名前解決を、IPv4 と IPv6 とも Sentinel へ向け直す。loopback はそのまま（`init/redirect.sh`）。Pod と同じく root のファイルシステムは読み取り専用 |
| `volumes` | volume の持ち主を決め、sandbox の HOME に Pi の設定（`config/models.json`）を置く。Pod の `fsGroup` と配置の役目に当たる |
| `sentinel`・`backend`・`sandbox`・`receivers` | リポジトリの image そのまま。`network_mode: service:pod` で名前空間を共有する |
| `outside` | Pod の外の偽物（下の「偽物」） |

- volume と mount は pod.md の表のとおり。`/memory/.git` は別の volume で、sandbox には読み取りで重ねる。取り込み口と管理口の socket は sandbox に mount しない。
- sandbox に置くのはサロゲートと Sentinel の CA の公開の証明書だけである。本物の鍵（モデルの鍵、backend の token、OAuth の client secret、Web Push の VAPID の鍵）は Sentinel・backend・偽物にだけ mount する。
- receivers は image のまま `serve` で動き、Alertmanager のプラグインを `/v1/webhooks/fraction` で、GitHub のプラグインを `/v1/webhooks/github` で、Slack のプラグインをワークスペース `work` で有効にする（`config/receivers.json`）。Alertmanager の token と GitHub の webhook の秘密は走らせるたびに作る `alertmanager-token` と `github-webhook-secret` で、receivers にだけ mount する。Slack の app-level token と bot の token（`slack-app-token`・`slack-bot-token`）は、receivers と偽物にだけ mount する。テストは同じコンテナで小さな送り手（`sender/send.ts`）も動かし、自分で作った封筒で取り込み口の socket を叩く。

## 偽物

`outside` のコンテナ 1 つが、Pod の外を受け持つ（`outside/`）。

- 名前解決: テストの名前（`model.example.com`・`backend.example.com`・`plain.example.net`・`github.com`・`api.github.com`・`kubernetes.example.com`・`auth.example.com`・`a.apps.example.com`・`push.example.com`・`slack.com`・`wss-primary.slack.com`・`files.slack.com`）を自分のアドレスで答え、ほかは無いと答える。Pod のすべてのコンテナの `resolv.conf` はこれを指す（クラスタの DNS に当たる）。テストはマシンの外に出ない。
- モデル: Pi の `openai-completions` が話す chat completions の偽物。テストの印（`E2E-TURN-1` など）を見て、決まった返事と道具の呼び出し（`write`・`bash`・`reply`）を返す。受けた入力をすべて覚え、`Authorization` が本物の鍵だったか（Sentinel が差し替えたか）を記録する。
- GitHub の OAuth と API: token の交換（client secret と PKCE を確かめる）と `/user`。
- 素通しの宛先: `plain.example.net`（HTTPS と平文の HTTP）。
- アプリ（`a.apps.example.com`）: Sentinel のワイルドカードの登録（`*.apps.example.com`）に当たる名前。届いた `Authorization` が本物の鍵だったかを返す。
- ブラウザの push service（`push.example.com`）: `/send/` の下への Web Push を受けて、暗号化された中身のまま覚える。`/send/gone-` の下は、終わった購読として `410` で答える。
- クラスタの API server の TokenReview（`kubernetes.example.com`）: backend 自身の ServiceAccount の token（`kube-token`）で尋ねられたときだけ答える。A2A の送り手の token（`sender-token`、`system:serviceaccount:e2e:claude`）と、allow-list に無い ServiceAccount の token（`stranger-token`）を知っている。
- gated（`auth.example.com`）: assertion に署名する鍵の JWKS を配り、テストが頼むと、その鍵で assertion に署名する（gated が token を落として assertion に置き換えた呼び出しの代わり）。
- Slack（`outside/slack.ts`）: `slack.com/api/` の Web API（`auth.test`・`apps.connections.open`・`users.conversations`・`conversations.history` など）、`wss-primary.slack.com/link/` の Socket Mode（WebSocket。`hello` を送り、`envelope_id` の ack を覚える）、`files.slack.com` のファイル。投稿の口（`chat.postMessage`・`chat.getPermalink`・`files.getUploadURLExternal`・`files.completeUploadExternal`）と、画像のアップロード先（`files.slack.com/upload/v1/`、受けた中身と token の有無を覚える）も持つ。app-level token と bot の token を、呼び出しごとに確かめる。テストは制御の口から、`conversations.history` の答え・送る封筒・`disconnect` を与える。
- 制御の口: テストが偽物の受けたものを読む。outside のコンテナの loopback だけで待ち受ける。

テストは backend の UI 向けの API と偽物の制御の口を、`outside` のコンテナの中から呼ぶ（`outside/client.ts`）。receivers の webhook も同じく `outside` から、Alertmanager と GitHub の代わりに呼ぶ。オーナーのブラウザが Pod の外にいるのと同じ形で、テストを動かすマシンにポートを公開しない。

## Pod とのずれ

- **Slack の宛先**: receivers の Slack の宛先も設定で変えられない。GitHub と同じく、偽物の名前解決が Slack の名前を偽物に向け、receivers にだけ偽物の CA を `NODE_EXTRA_CA_CERTS` で信頼させる。
- **GitHub の宛先**: backend の GitHub の宛先は設定で変えられない（`github.com` と `api.github.com` に決めてある）。テストのために設定を足さず、偽物の名前解決がこの 2 つの名前を偽物に向け、backend にだけ偽物の CA を `NODE_EXTRA_CA_CERTS` で信頼させる。backend の UID の外向きは向け直されないので、本番と同じ宛先のまま偽物に届く。sandbox も同じ名前解決を見るのが Pod とのずれである（このテストでは sandbox は GitHub を使わない）。
- **push service**: 購読の `endpoint` はテストが決める（`https://push.example.com/send/…`）。backend は GitHub と同じく偽物の CA を信頼して、偽の push service に自分で送る。Sentinel は通らない。
- **網**: `pod` と `outside` は Docker の既定の bridge に置き、アドレスは Docker が付ける。テストは `outside` を立ててから `resolv.conf` を書き、`pod` を立ててから backend の公開の URL を決め、残りを立てる。ユーザー定義の網は使わない（コンテナどうしが届かないマシンがあった）。IPv6 の向け直しの規則は入れるが、網は IPv4 だけである。
- **volume の持ち主**: Pod は `fsGroup` で共有の volume を 1 つのグループに置く。ここでは `volumes` のコンテナが持ち主を UID ごとに決める。
- **ServiceAccount の token と kubeconfig**: クラスタが無いので、どのコンテナにも無い。backend の TokenReview のための token は、偽の API server が知っている値（`kube-token`）を mount し、API server の名前と CA は設定で偽物に向ける。
- **gated**: 前段の gated は置かない。送り手の呼び出しは backend に直に届き、gated の assertion の呼び出しは、テストが偽の gated に署名させた assertion を自分で付ける。
- **`batch` の待ち**: 既定の 5 分のまま待たない。`batch` の出来事は、後から入れた `now` が連れていく。待ちが明けて渡ることは backend の単体テストが見る。
- **heartbeat**: 既定では切ってある。そのシナリオだけ、backend を作り直してテスト用の `PENELOPE_HEARTBEAT_SECONDS` で N を 5 秒にする。次の夜の切り替えのシナリオで作り直すときに切れる。2 つめの heartbeat が 1 つめのターンの終わりから数え直すことは、backend の単体テストが見る。
- **夜の切り替え**: モデルの偽物はオーナーのテスト用メッセージで `sleep` を呼ぶ。4 段の結果と、眠りの間に送ったメッセージが `wake` とともに新しいセッションに届くことを確かめる。

## 通すシナリオ

`test/e2e.test.ts` が、1 つの Pod で順に通す。

1. GitHub の OAuth でログインする。backend が Web UI の build（ページ、script、styles）を配り、エージェントの名前（`/api/agent` と manifest）と、選んだアバターの表情の画像が設定から来る。メッセージを送る。sandbox の runner がターンを回し、返事が履歴と流れ（SSE）に届く。途中経過（`turn_start`・`tool_call`・`tool_result`・`message`・`turn_end`）と状態（`thinking`・`waiting`）が流れに乗る。モデルにはサロゲートではなく本物の鍵が届く。
2. ターンの終わりに `/memory` がコミットされる（`Turn <turn_id>` と `Agent: main`）。sandbox は `/memory/.git` に書けず、履歴は読める。
3. 2 つめのターンのモデルへの入力で、1 つめのターンが畳まれている（出来事・地の文・`reply` は残り、ほかの呼び出しは 1 行、道具の出力は無い）。
4. オーナーが 2 つのブラウザの購読を登録し（`GET /api/push` の公開鍵は配置の VAPID の鍵のもの）、返事が Web Push で偽の push service に届く。中身はブラウザの鍵で開け、エージェントの名前と返事の本文を持ち、VAPID の token は配置の鍵で push service の origin に署名されている。`410` と答えた購読は消え、次の返事は届いた方にだけ行く。backend のログに `endpoint` と本文は無く、Sentinel の記録に push service は無い。
5. 偽のモデルが sandbox の HOME に PNG と、画像でないファイルを書き、画像でないファイルを添えた `reply` は文ごと断られて、理由がその呼び出しの結果に返る。PNG を添えた返事は、履歴と流れに画像の一覧（種類・大きさ・名前）を持ち、その画像はオーナーのセッションでだけ `GET /api/assets/<id>` から取れる。backend の写しは sandbox のファイルと同じ中身で、sandbox からは見えない。
6. sandbox の外向きが Sentinel を通り、記録に残る。素通し（`plain.example.net`）、開く宛先（モデルと backend と、ワイルドカードの登録に当たるアプリ）、名前解決、登録の無いホストへのサロゲート・リンクローカル・受け口へ直に届いた通信を断る。sandbox の loopback は向け直されず、記録にも残らない。
7. sandbox に本物の鍵が無い。取り込み口の socket が見えない。backend の UI 向けの口に loopback で届いても、ログインを求められる。
8. receivers から取り込み口へ出来事を入れ、`/sources` に追記される。重複は受けたことになり、`control` は断られる。`batch` は待ち、後から来た `now` が待っている `batch` を連れて 1 つのターンに届く。
9. Alertmanager の形の POST を Pod の外から receivers の webhook に送る。token が違えば `401` で断られる。`critical` の鳴り始めは `/sources/alertmanager/kubepodcrashlooping/` に追記され、`now` として 1 つのターンに入る。同じ POST の送り直しは重複として落ち、印のラベル（`sender="penelope"`）のアラートは出来事にならない。
10. GitHub の形の配送（`pull_request` の `review_requested`）を Pod の外から receivers の webhook に送る。署名が違えば `401` で断られ、`ping` と `authors` に無い作者の PR は出来事にならない。署名の合う依頼は `/sources/github/example-org.example-repo/` に `batch` として追記され、同じ `X-GitHub-Delivery` の送り直しは重複として落ちる。PR の本文は残らない。後から来た `now` が、その `batch` を連れて 1 つのターンに届く。
11. receivers の Slack のプラグインが Socket Mode でつなぐ（app-level token で `apps.connections.open`、bot の token で `auth.test`）。Slack が求めたつなぎ直しの後に、離れていた間の発言が取り直されて `/sources/slack/work.dev/` に入る。画像の付いたメンションの封筒は、取り込み口が受けてから ack され、画像が bot の token で取られて添付になる。Slack の送り直しは重複として落ちる。メンションは `now` として、取り直した発言を連れて 1 つのターンに入る。backend は `slack` を inline にし、runner は `PENELOPE_SLACK_SOURCES` で描くので、メンションの行は取り直した発言を `(earlier)` で添えた文を、取り直した発言の `batch` のまとめはその発言を描いた文を、`text` に持つ。メンションは inline なので、その画像は画像としても入力に入る（台本のモデルは画像を受けないので、Pi が入力の後ろにそう書き添える）。sandbox の `slackctl history work.dev` が、そのチャンネルを今の姿で描く。
12. sandbox の `slackctl post` が、本文（日本語の複数行）を `#dev` のスレッドに、表情 `happy` のアイコンと画像 1 枚を添えて投稿する。チャンネルは名前から `users.conversations` で ID になり、`chat.postMessage` と `files.completeUploadExternal` には Sentinel が差し替えた本物の bot の token が届き、本文はそのまま、画像の共有も同じスレッドと同じアイコンである。画像のアップロード先（`files.slack.com/upload/`）には token が付かない。アイコンの URL は backend の公開の URL の `/api/agent/icons/happy.webp` で、Pod の外から取れる。`slackctl faces` が同じ URL を出す。
13. ほかのエージェントが A2A で頼む。token なしで Agent Card が読める。allow-list に無い ServiceAccount は、TokenReview でも gated の assertion でも断られる。送り手が ServiceAccount の token で頼み（TokenReview）、ターンが `reply_to_agent` で聞き返し、送り手が gated の assertion で答え、ターンが閉じた答えを送り手が `GetTask` で読む。依頼と答えは `/sources/a2a/claude/` に追記され、API server には backend 自身の token で尋ねている。
14. 本体がサブエージェントを起こす（`subagent_start`）。サブエージェントは自分のシステムプロンプトと作業の場所で、本体の道具（`reply`・`reply_to_agent`・`self_event`・`subagent_*`）を持たずに走り、`/memory` に書いて問いで止まる。その地の文が `self` の出来事として本体に届き（`/sources/self/<名前>/`）、本体が続きを送り（`subagent_send`）、同じセッションで続いたサブエージェントの結果を受けて閉じる（`subagent_close`）。サブエージェントの書いたものは、そのターンの終わりに `Agent: <名前>` でコミットされる。UI の流れには起こした・閉じたことと途中経過が乗り、閉じたサブエージェントは `/api/agents` に載らない。
15. 本体が裏の仕事を起こす（`job_start`）。道具は仕事の ID と出力のファイルを返し、コマンドの出力は返さない。コマンドが終わると、終わり方・コマンド・出力の末尾が inline の `job` の出来事として新しいターンに入り（`/sources/job/`）、出力の全文は `~/jobs/<ID>/output.log` にある。`ask-agent` は同じ道具で起動し、Sentinel 越しにテストの相手へ画像付きで頼む。Task の返事と保存した画像のパスが終わりの出来事に入る。
16. heartbeat を 5 秒で入れた backend に作り直すと、何もないまま 5 秒たって heartbeat の出来事だけで 1 つのターンが始まる（`delivery` は `now`、中身は `/sources/heartbeat/` にある）。偽のモデルは地の文もツールも無しで終え、畳む前の頼みは送られない。
17. 夜の制御の出来事で、振り返り → 整理係 → 新しいセッションが回り、`handoff.md` と整理係の変えたものがコミットされる。新しいセッションのシステムプロンプトに `handoff.md` が入り、前の日の会話は無い。次の切り替えの後も、ターンは回り続ける。
