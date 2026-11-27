# natsumi からの移行の手引き

Kubernetes で動いている natsumi（[yuanying/natsumi](https://github.com/yuanying/natsumi)）のインスタンス 1 人を、penelope の配置 1 つに移す手順である。方針は [ADR-0026](adr/0026-move-natsumi-myao-and-aki-one-deployment-each-without-a-way-back.md) にある。記憶は git の履歴ごと写し、書き手は常に 1 つにし、並べて確かめる期間も戻し道も持たない。問題が起きたら、natsumi に戻すのではなく penelope の側を直す。

- 対象の版は **v0.9.1 以降**。v0.9.0 の backend が記憶に写したアバターは、配置によってはエージェントが上書きできない（見本の README の冒頭）。アバターは新しい配置の最初の起動で 1 回だけ写されるので、最初から v0.9.1 以降で立てる。新しい配置は [deploy/kubernetes/](../deploy/kubernetes/README.md) の見本から作る。この手引きの名前（StatefulSet `penelope`、PVC `penelope`・`penelope-memory` など）は、見本の「名前」の節のものである。
- 写すときに使う作業用の Pod と道具は [deploy/kubernetes/migrate/](../deploy/kubernetes/migrate/) にある。
- **記憶・作業の場所・HOME・予約の中身は読まない。** 鍵や個人の情報が入っている。この手引きのコマンドは、数・大きさ・持ち主と権限・`git fsck` の終了コード・コミットの数だけを出す。`cat`・`grep`・`git log`・`git show`・ファイルの名前を並べる `ls -R` や `find`・`rsync -v`・SQLite の行の表示は使わない。

## 何が移り、何が移らないか

### 移るもの

| もの | natsumi | penelope |
| --- | --- | --- |
| 記憶 | data directory の `memory/`（作業ツリーと `.git`） | `/memory`。形は互換で（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）、中身を書き換えずに git の履歴ごと写す。性格（`personality.md`）・`always.md`・日記・引き継ぎも記憶の中なので一緒に移る |
| 作業の場所 | data directory の `work/`（作業環境の `/work`） | `~/work`（`/home/agent/work`） |
| 予約 | `.natsumi/state.sqlite` の `self_checks` の pending（`schedule_self_check`） | backend の予約（[sandbox-api.md](sandbox-api.md) の「予約」）。道具 `move-schedules.mjs` で写す |

### 移らないもの・変わるもの

| もの | penelope では |
| --- | --- |
| Mac・iPhone のアプリと APNs | 無い。話し口は Web UI で、知らせは Web Push（[ADR-0027](adr/0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md)）。iPhone ではホーム画面に置いた Web UI で受ける。購読は移らないので、移った後にオーナーが Web UI で知らせを許し直す |
| natsumi の会話の履歴・Pi のセッション・チャットに添えたファイル | 写さない。penelope は形が違う。覚えておくべきことは記憶にある |
| `sources/`（Slack のチャンネルのファイル、A2A の返事など） | 写さない。penelope の `/sources` は新しく始まる（[events.md](events.md)） |
| `home/`（`/home/natsumi`。シェルの設定・道具のキャッシュ） | 写さない。penelope の HOME は `/home/agent` で、道具は image に入っている |
| 宛先の許し（natsumi の関所の allow-list） | 無い。penelope の Sentinel は既定が素通しで、記録だけを取る（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。natsumi の許しの一覧は、後で絞るときの材料として配置のリポジトリに残しておくとよい |
| 郵便ポスト（記憶の `postbox/` の定期便） | 仕組みは無い。予約と `a2a send` に替える。ファイルは記憶ごと移るので、移った後にエージェントに予約へ移してもらう（下の「後で」） |
| モデルの経路を手で切り替える仕組み（natsumi ADR 0046） | 無い。モデルは配置の設定で 1 つ選ぶ |
| 夜の整理係の工程・睡眠薬・ダッシュボード・設定の画面 | 夜の切り替えの照合係と整理係（[ADR-0044](adr/0044-check-memory-against-records-before-nightly-organization.md)）。設定は配置の ConfigMap で変える |
| ポッポさん（Slack への投稿の判定と承認） | 無い。エージェントが `slackctl post` で直接投稿する（[ADR-0033](adr/0033-slack-posts-through-slackctl-with-the-token-stand-in.md)） |
| 宣言したツール・鍵を付ける中継（natsumi ADR 0075・0085） | 無い。sandbox は開発の道具を一通り持ち、鍵は Sentinel がサロゲートと差し替える（[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)） |
| A2A の待っている依頼と、受け口の Task | 移らない。受け口の URL（`/a2a/`）は同じ形だが、Task と context は新しく始まる |
| natsumi のサーバーが読んでいた、記憶の外の置き場（`/manual/agents`・`/manual/avatar`・設定で指した `appearance.yaml` など） | 読まない。頼める相手は配置のコネクタの文書、姿は記憶の `/memory/avatar/` にある（下の「アバター」） |
| natsumi にしか無い仕組みの記憶のファイル（`postbox/` など） | 記憶ごと写し、消さない。片付けるかはエージェントに任せる（ADR-0026） |

### パスの移り変わり

エージェントは、記憶に古いパスを書いているかもしれない。移った後の最初のメッセージで伝える（手順の 10）。

| natsumi | penelope |
| --- | --- |
| `/memory` | `/memory`（同じ） |
| `/work/…` | `~/work/…`（`/home/agent/work/…`）。sdctl の出力の既定 `/work/images` は `~/work/images`（見本の `SDCTL_OUTPUT_DIR`） |
| `/home/natsumi/…` | `~/…`（`/home/agent/…`）。中身は移らない |
| `/manual/agents/` | 無い。頼める相手はシステムプロンプトに並ぶコネクタの文書にある |
| `/manual/avatar/`（`images.md`・`sdctl-params.yaml`） | `/memory/avatar/`（`appearance.yaml`・`sdctl-params.yaml`）と skill `self-portrait` |
| `/sources/…`・`/sources.git` | `/sources/…`。形が違い、古いものは移らない |

## 設定の写し方

natsumi の config（JSON）の項目と、それを書く penelope の配置の場所。場所は [deploy/kubernetes/example/](../deploy/kubernetes/example/) のファイルである。

| natsumi の config | penelope の配置 |
| --- | --- |
| `publicOrigin` | `backend.env` と `sandbox/env` の `PENELOPE_PUBLIC_URL`、`ingress.yaml` のホスト |
| `listen`（`tls`・`behindProxy` を含む） | 無い。backend は `8080` で平文で待ち、TLS は Ingress が終える |
| `github.clientId`・`clientSecretFile`・`allowedUserId` | `backend.env` の `PENELOPE_GITHUB_CLIENT_ID`・`PENELOPE_OWNER_GITHUB_ID`、Secret `penelope-backend` の `github-client-secret`。callback の道は同じ `/auth/github/callback` なので、公開の URL を変えなければ同じ OAuth App を使える |
| `loop.timeZone` | `backend.env` の `PENELOPE_TIME_ZONE` と `sandbox/env` の `TZ` |
| `loop.awakeHours`・`loop.nightlyRotationAt` | 移さない。本体は `sleep` で自分で眠り、時刻を決めて起きる（[ADR-0069](adr/0069-sleep-by-her-own-call-until-a-wake-time.md)） |
| `loop.pingIntervalMinutes` | `PENELOPE_HEARTBEAT_MINUTES`（本体が起きていて、静かな時間が続いたら出来事を入れる。[ADR-0031](adr/0031-a-heartbeat-event-after-quiet-minutes-in-awake-hours.md)） |
| `loop` のほか・`curator` | 無い |
| `pi.routes`・`defaultRoute` | `sandbox/env` の `PENELOPE_MODEL`（`<provider>/<model>`）、`sandbox/models.json`、`sentinel/sentinel.yaml` のモデルの API のホストと Secret `penelope-sentinel` の鍵（下の「モデル」） |
| `avatar` | `backend.env` の `PENELOPE_AVATAR` と、自分のアバターなら `PENELOPE_AVATARS_DIR`（下の「アバター」） |
| `avatarBaseUrl` | `sandbox/env` の `PENELOPE_SLACK_ICON_BASE_URL`（Slack が backend に届かないときだけ。[receivers.md](receivers.md) の「投稿の CLI」） |
| `inbox.card.name` | `backend.env` の `PENELOPE_AGENT_NAME` と `sandbox/env` の `PENELOPE_NAME`（同じ名前にする） |
| `inbox`（受け口） | `backend.env` の `PENELOPE_A2A_*`（下の「A2A」） |
| `a2a.agents`・`a2a.tokenFile` | `connectors/agents.md`、`sentinel/sentinel.yaml`、`sandbox/surrogates.env`、`patches/statefulset.yaml` の projected token（下の「A2A」） |
| `slack.workspaces` | `receivers/config.json`、Secret `penelope-receivers`・`penelope-sentinel`、`sentinel/sentinel.yaml` の `slack.com`、`connectors/slack.md`（下の「Slack」） |
| `slack.judge` など投稿の判定 | 無い |
| `webhooks` | `receivers/config.json` の Alertmanager・GitHub のプラグイン（[receivers.md](receivers.md)）と、Ingress の `/v1/webhooks/` |
| `skills` | ConfigMap `penelope-skills`（`skills/skills.list`。見本の README の「skill」） |
| `tools`・中継 | 無い |
| `postbox` | 無い |
| `apns` | 無い。Web Push は `PENELOPE_WEB_PUSH_VAPID_KEY_FILE` と Secret `penelope-backend` の `web-push-vapid-key` |
| `sentinel`（関所の承認待ち） | 無い |
| sdctl（作業環境の `/etc/sdctl/config.yaml` と中継） | `sandbox/surrogates.env` の `SDCTL_URL`・`SDCTL_TOKEN`、`sentinel/sentinel.yaml`、`connectors/sd-webui.md`（下の「sd-webui」） |

鍵の値は natsumi の Secret から写す。どのキーに入れるかは見本の README の「Secret の作り方」にある。

### モデル

- Pi の provider とモデルを `PENELOPE_MODEL` と `sandbox/models.json` に書く。OpenAI 互換の API なら、`models.json` の `providers` に `baseUrl` と `api` を持つ provider を足せる（Pi の `models.json` の形）。
- 1 回の要求で受け付ける画像の枚数が決まっている接続先には、その provider に `maxImagesPerRequest` を足す（例: `providers.sakura.maxImagesPerRequest` を `3` にする）。runner は送る文脈だけを古い画像から減らす。書かなければ枚数を制限しない。値の例は [Kubernetes 配置の手引き](../deploy/kubernetes/README.md#モデルの設定) を参照。
- 鍵は `models.json` の `apiKey` にサロゲートを書き、`sentinel.yaml` でその API のホストを登録して本物に差し替える。sandbox に本物の鍵は置かない（ADR-0004）。natsumi の `openai` の経路で使っていた ChatGPT のサインイン（`pi.authPath` の `auth.json`）は、本物の資格を sandbox に置くことになるので写さない。鍵を付ける中継を自分で立てているなら、その中継のホストを登録する。
- natsumi の `compactionThreshold` などの上限は写さない。

### Slack

- **同じ Slack App を使える。** natsumi も penelope の receivers も Socket Mode でつなぐ（[ADR-0028](adr/0028-slack-received-over-socket-mode-by-a-receivers-plugin.md)）。app-level token（`xapp-`）を `receivers/config.json` の `app_token_file`、bot token（`xoxb-`）を `bot_token_file` と Sentinel の `slack.com` の鍵の両方に入れる。
- natsumi と penelope を同じ App で同時につながない。Socket Mode は出来事を接続の間で分けて届けるので、どちらにも一部が届かない。手順どおり natsumi を止めてから入れる。
- natsumi の App の scope とイベントで、受けることと投稿することは足りる。グループ DM も受けるなら、`mpim:history`・`mpim:read` とイベント `message.mpim` を足して入れ直す（[receivers.md](receivers.md) の「Slack App の用意」）。
- ワークスペースの名前は natsumi の `slack.workspaces` の名前と同じにする。エージェントが記憶で使ってきた呼び名のままになる。
- bot を招いたチャンネルは App の側にあるので、招き直しは要らない。

### A2A

- **頼む側**: natsumi の `a2a.agents` の相手ごとに、ホストを `sentinel.yaml` に登録し、サロゲートを `sandbox/surrogates.env` に、`connectors/agents.md` の frontmatter の `a2a` に `name`・`label`・`url`（ホストのルート、例: `https://helper.agents.example.com/`）・`token`（サロゲートの環境変数名）を書く（[Pod の形](pod.md#a2a-の宛先)）。`job_start` で `ask-agent <name> '<依頼>'` を起こすと、送信と待機が同じ仕事で行われる。token は natsumi と同じく ServiceAccount の projected token にし、audience は相手が求めるもの（natsumi の配置が付けていたもの）にする（見本の README の「A2A」）。
- **身元が変わる。** 新しい配置の ServiceAccount は `penelope` で、相手に見えるのは `system:serviceaccount:<名前空間>:penelope` になる。相手の allow-list にこれを足す。natsumi の ServiceAccount の名前のまま続けたいなら、overlay の patch で StatefulSet の `serviceAccountName` をその名前にする。
- **受ける側**: natsumi の `inbox` は `PENELOPE_A2A_SENDERS`（送り手の ServiceAccount を `<名前空間>/<名前>` で）と `PENELOPE_A2A_AUTH` に替わる（[a2a.md](a2a.md)、[backend.md](backend.md)）。確かめ方は gated の assertion（`gatedSubject` の送り手、`inbox.gated` の `issuer`・`jwksUrl`）か TokenReview である。**natsumi の `tokenFile`（送り手と分け合う決まった token）の送り手は、penelope では受けられない。** その送り手は、自分の ServiceAccount の token で呼ぶか、gated を通して呼ぶ形に変える。
- JSON-RPC の呼び出し口は natsumi と同じ `/a2a/`。Agent Card はホストのルートの `/.well-known/agent-card.json` で読める。名前は `PENELOPE_AGENT_NAME`、説明は `PENELOPE_A2A_DESCRIPTION` である。
- natsumi の返事の push の受け口（`a2a.pushUrl`）は無い。エージェントは Task を裏の仕事で待つ（image の skill `a2a`）。

### sd-webui

- natsumi の作業環境は、Pod の中の中継（loopback の口）越しに sd-webui を呼び、token は中継が付けていた。penelope では sandbox が sd-webui の本当の URL を `SDCTL_URL` で呼び、`SDCTL_TOKEN` のサロゲートを Sentinel が本物に差し替える。
- 中継が持っていた token を Secret `penelope-sentinel` の `sd-webui-token` に入れ、`sentinel.yaml` に sd-webui のホストを登録する。置き場所は sd-webui の認証の形に合わせる。Bearer の token なら `place: bearer`、Basic 認証のパスワードなら `place: basic`（[sentinel-config.md](sentinel-config.md)）。
- 描画の既定は `/memory/avatar/sdctl-params.yaml` になる（下の「アバター」）。natsumi の config の `avatar.sdctlParams` で別のファイルを指していたなら、そのファイルをアバターのディレクトリに入れる。

## アバター

penelope のアバターは記憶の `/memory/avatar/` にあり、エージェントが育てる（[ADR-0036](adr/0036-the-avatar-grown-in-memory-copied-once-by-the-backend.md)、見本の README の「アバター」）。natsumi の記憶には `avatar/` が無いので、**新しい配置の最初の起動で 1 回だけ**、backend が選んだアバターを記憶に写してコミットする。写した後に置き場や `PENELOPE_AVATAR` を替えても、写し直されない。

- **natsumi の組み込みのアバター**（config の `avatar.id`）のうち、`natsumi`・`myao`・`aki`・`penelope` は penelope の image にも入っている。`PENELOPE_AVATAR` にその名前を書くだけでよい。`iori`・`nanashi` は入っていないので、natsumi のリポジトリの `assets/avatars/<名前>/` を自分のアバターとして置く。
- **自分のアバター**（config の `avatar.directory`）は、そのディレクトリを `<名前>/` として置き場に入れ、backend に読み取りで mount して `PENELOPE_AVATARS_DIR` で指し、`PENELOPE_AVATAR` をその名前にする（置き方は見本の README の「アバター」）。

natsumi と penelope でアバターのディレクトリの形が違うところ:

| こと | natsumi | penelope |
| --- | --- | --- |
| Slack の投稿のアイコン | `slack/<表情>.png` を名前で探す | `avatar.json` の `pngIcons` に表情ごとの場所を書く。natsumi のディレクトリを写すときに足す（`"pngIcons": {"neutral": "slack/neutral.png", …}`） |
| 名前 | `avatar.json` の `name` | `PENELOPE_AGENT_NAME` が優先し、無ければ `avatar.json` の `name` |
| 表情のアイコン | `avatar.json` の `icons` | 同じ |
| スプライトシート・`pet.json`・`atlas`・`animations`・`expressions` | 使う | 読まない。置いたままでよい（`avatar.json` の知らない項目は残す） |
| 姿・描画の既定 | アバターの `appearance.yaml`・`sdctl-params.yaml`、または config の `avatar.appearance`・`avatar.sdctlParams` が指すファイル | アバターのディレクトリの `appearance.yaml`・`sdctl-params.yaml` だけ。config で別のファイルを指していたなら、そのファイルをこの名前で入れる |
| 性格の初期値 | アバターの `personality.md` か config の `avatar.personality` | 使わない。記憶の `personality.md` がそのまま移る |

写った後は、sandbox の `avatar check` で確かめられる（手順の 9）。

## 置き換える値

`deploy/kubernetes/migrate/` を配置のリポジトリに写し、次の値を自分のものにする。作業用の Pod は 1 回きりで、新しい配置の overlay からは参照しない。

| 場所 | 値 | 置き換えるもの |
| --- | --- | --- |
| `kustomization.yaml` | `namespace: penelope` | natsumi の PVC がある名前空間。Pod は自分の名前空間の PVC しか mount できないので、**新しい配置も同じ名前空間に置く** |
| `kustomization.yaml` | `newTag` | 新しい配置と同じ版（v0.9.1 以降） |
| `pod.yaml` | `claimName: natsumi-data` | natsumi の data directory がある PVC の名前 |
| `pod.yaml` | `subPath: data` | その PVC の中の data directory の場所（natsumi の `--data-dir`）。PVC の一番上なら `subPath` の行を消す |

data directory は、natsumi が `memory/`・`work/`・`home/`・`.natsumi/` を作る場所である（natsumi の README の「サーバーの起動」）。natsumi の Pod の server のコンテナで `--data-dir` に渡している場所と、その volume の mount を見て決める。

別の名前空間に置きたいときは、natsumi の名前空間で natsumi の PVC だけを、新しい名前空間で新しい PVC だけを mount する Pod を 1 つずつ立て、`kubectl exec … tar -cf -` と `kubectl exec -i … tar -xf -` をつないで写す。持ち主と権限は写した後に `copy.sh` と同じく付け直す。この手引きはその形を扱わない。

## 手順

以下の `<名前空間>` は natsumi と新しい配置の名前空間、`<overlay>` は新しい配置の overlay、`<migrate>` は写した `deploy/kubernetes/migrate/` である。

```sh
ns=<名前空間>
# natsumi の Pod と server のコンテナ、data directory の、そのコンテナから見た場所
n="kubectl -n $ns exec <natsumi の Pod> -c <server のコンテナ> --"
d=/data
```

### 0. 前もって

1. 新しい配置の overlay を作る（[deploy/kubernetes/](../deploy/kubernetes/README.md) と上の「設定の写し方」）。`kubectl kustomize <overlay>` で組めることを確かめる。まだ入れない。
2. Secret（`penelope-sentinel-ca`・`penelope-sentinel`・`penelope-backend`・`penelope-receivers`）を作る（見本の README の「Secret の作り方」）。
3. natsumi を GitOps（Argo CD の auto sync など）で入れているなら、止めた natsumi が戻されないよう、手順の 3 より前に同期を止める方法を決めておく。
4. 日取り: natsumi の夜の切り替えと backup の前後を避け、移した後にすぐオーナーが話して確かめられる時間にする。
5. 移す前の日の話を記憶に入れておきたいなら、natsumi に睡眠薬を飲ませる（natsumi の README の「睡眠薬で寝かせる」）か、夜の切り替えの後の朝に移す。写すのは記憶だけで、会話の履歴は写さないためである。

### 1. 写す前の数を控える

中身は出さず、数と大きさだけを控える。写した後に照らす。

```sh
$n git -C $d/memory rev-list --count HEAD
$n sh -c "git -C $d/memory status --porcelain | wc -l"
$n node --no-warnings -e '
  const db = new (require("node:sqlite").DatabaseSync)(process.argv[1], { readOnly: true });
  const q = (w) => db.prepare(`SELECT count(*) AS n FROM self_checks WHERE state = ? AND ${w}`).get("pending").n;
  console.log("pending repeating:", q("cron IS NOT NULL"), "one-off:", q("cron IS NULL"))' $d/.natsumi/state.sqlite
$n sh -c "find $d/memory/postbox -name '*.md' 2>/dev/null | wc -l"
$n du -sk $d/memory $d/work $d/.natsumi/state.sqlite
```

- コミットの数、未コミットの数、pending の予約の数（繰り返しと 1 回）、郵便ポストの定期便の数、大きさ（KiB）の順に出る。
- 記憶と作業の場所の大きさが、新しい PVC（見本では `penelope-memory` 5Gi、`penelope` 20Gi）に収まることを見る。収まらなければ overlay の patch で大きくする。
- 予約を書き出すときに SQLite を作業用の Pod の一時の場所へ写すので、その大きさのぶんノードに空きがあること。

### 2. natsumi の backup を取る

natsumi の配置の backup（CronJob など）を手で 1 回動かし、終わるのを待つ。backup の仕組みが無ければ、PVC の VolumeSnapshot を取る。戻し道は持たないが、写しに失敗したときに元が残っているようにする。

### 3. natsumi を止める

記憶の書き手を 1 つにするため、natsumi を止めてから写す。

```sh
kubectl -n $ns scale statefulset <natsumi の StatefulSet> --replicas=0
kubectl -n $ns wait --for=delete pod/<natsumi の Pod> --timeout=15m
```

- natsumi は話している最中のターンが終わるのを待ってから止まる（既定で最大 10 分）。
- natsumi の backup の CronJob があれば止める（`kubectl -n $ns patch cronjob <名前> -p '{"spec":{"suspend":true}}'`）。
- 新しい配置で同じホストを使うなら、natsumi の Ingress を消す。同じホストの Ingress を 2 つ並べないためである。証明書の Secret は、新しい Ingress で使うなら消さない。

### 4. 新しい PVC だけを入れる

StatefulSet を先に入れると、空の記憶でセッションが始まる。2 つの PVC だけを先に作る（`yq` は mikefarah の v4）。

```sh
kubectl kustomize <overlay> \
  | yq 'select(.kind == "PersistentVolumeClaim" and (.metadata.name == "penelope" or .metadata.name == "penelope-memory"))' \
  | kubectl apply -f -
```

### 5. 写す

作業用の Pod（`<migrate>`）が natsumi の PVC を読むだけでつかみ、新しい 2 つの PVC へ写す。

```sh
kubectl apply -k <migrate>
kubectl -n $ns wait --for=condition=Ready pod/penelope-migrate --timeout=5m
m="kubectl -n $ns exec penelope-migrate -c migrate --"
```

1. 記憶と作業の場所を写す。`copy.sh` は、`/memory` の作業ツリーと `.git` を履歴ごと、`/work` を `~/work` に写し、持ち主と権限を新しい Pod の UID と group に付け直す（見本の README の「volume と持ち主」）。写す先が空でなければ何もせずに止まる。

   ```sh
   $m sh /migrate/copy.sh
   ```

   最後に `1000:2000 2770 …/memory`・`1001:2000 2770 …/memory/.git`・`1000:1000 700 …/home`・`1000:1000 <元の権限> …/home/work` の 4 行が出る。

2. 照らす。

   ```sh
   $m sh /migrate/check.sh
   ```

   - `memory entries`・`memory bytes`・`commits`・`uncommitted`・`work entries`・`work bytes` の各行で、natsumi の側と写しの 2 つの数が同じであること。
   - `commits` は 1 で控えた数以上である（止めるときに終わったターンがコミットしていれば増える）。
   - `fsck of the copy: 0`。
   - `memory avatar/: none`。`there` なら記憶に `avatar/` があり、backend はアバターを写さない（そのディレクトリをアバターとして読む）。
   - `uncommitted` は 0 でなくてよい。新しい backend が最初のターンの終わりにコミットする。

3. 予約を書き出す。`move-schedules.mjs` は SQLite を WAL ごと一時の場所に写してから読み、元には書かない。理由は出さず、数だけを出す。

   ```sh
   $m node --no-warnings /migrate/move-schedules.mjs export /old/.natsumi/state.sqlite /new/state/home/.natsumi-schedules.json
   $m chown 1000:1000 /new/state/home/.natsumi-schedules.json
   ```

   `pending: N (repeating: R, one-off: O, one-off past due: P)` の 1 行が出る。`R` と `O` が 1 で数えた数と同じであること。`P` は、時刻が過ぎた 1 回の予約の数で、8 でどう扱うかを決める。

4. 作業用の Pod を消す。つかんだままだと、新しい Pod が別のノードで起動できない。

   ```sh
   kubectl delete -k <migrate>
   ```

写さないもの: `home/`、`sources/`・`sources.git/`、`agents/`、`.natsumi/` の予約のほか（会話の履歴など）、Pi の状態の volume。

### 6. 新しい配置を入れる

```sh
kubectl apply -k <overlay>
kubectl -n $ns rollout status statefulset/penelope
```

init container `volumes` は、写したディレクトリを触らない（あるものは持ち主も権限もそのまま）。GitOps で入れるなら、ここで新しい配置の同期を始める。

### 7. 最初の起動を見る

見本の README の「最初の起動と確かめ方」の 2〜5 を見る。backend の記録に `avatar: copied <写し元> to /memory/avatar` の 1 行が出る（`kubectl -n $ns logs penelope-0 -c backend | grep avatar:`）。

### 8. 予約を入れる

5 の 3 で書き出した予約を、新しい Pod の sandbox から backend に main の予約として入れる。道具は手元の `move-schedules.mjs` を標準入力で渡す。宛先と token は sandbox の `PENELOPE_BACKEND_URL`・`PENELOPE_BACKEND_TOKEN`（サロゲート）である。

```sh
kubectl -n $ns exec -i penelope-0 -c sandbox -- \
  node --no-warnings --input-type=module - post /home/agent/.natsumi-schedules.json --past-due <skip|now> \
  < <migrate>/move-schedules.mjs
```

- `--past-due` は省けない。時刻の過ぎた 1 回の予約を、`skip` なら入れずに落とし、`now` なら 1 分後の時刻で入れる。オーナーが決める。
- 出るのは `posted`・`skipped past due`・断られた数と状態コード・入れる前と後の予約の数だけである。`posted` と `skipped past due` の和が 5 の 3 の `pending` と同じで、`after` が `before` と `posted` の和であること。
- 全部入れると JSON を消す。断られたものがあれば終了コード 1 で、残りだけが JSON に残る。もう一度流すと残りだけを入れる。
- cron の式はどちらも 5 欄で、natsumi は `loop.timeZone`、penelope は `PENELOPE_TIME_ZONE` で読む。2 つを同じ時間帯にしておく。読めない式は `400` で断られる。その予約は、オーナーがエージェントに頼んで入れ直してもらう。
- **届く時間が変わる。** penelope は、眠りの間に時刻が来た予約を起きたときに渡す。起きているときは、既定の `PENELOPE_DELIVERY_CRON=now` なら時刻どおりに渡す（[配送の条件](events.md#いつ渡すか)）。

### 9. 確かめる

中身は見ずに、数と動きで確かめる。

1. 記憶: オーナーが話しかけて返事が来た後に、`kubectl -n $ns exec penelope-0 -c backend -- git -C /memory rev-list --count HEAD` が 5 の 2 の `commits` より増えている。
2. アバター: `kubectl -n $ns exec penelope-0 -c sandbox -- avatar check` が誤りを出さない。Web UI に名前と表情のアイコンが出る。
3. 予約: sandbox で `curl -s -H "Authorization: Bearer $PENELOPE_BACKEND_TOKEN" "$PENELOPE_BACKEND_URL/v1/schedules?agent=main" | jq '.schedules | length'` が 8 の `after` と同じ。Web UI の予約の一覧でも数を見る。
4. Slack: bot を招いたチャンネルで bot にメンションすると出来事として届き、エージェントが `slackctl post` で返せる。
5. A2A: `curl -s https://<公開のホスト>/.well-known/agent-card.json | jq -r .name` が名前である（受け口を開いたとき）。エージェントから相手に頼め、Sentinel の記録に相手のホストが出る。
6. 絵: 自分の絵を頼むと、返事に画像が添えられる。Sentinel の記録に sd-webui のホストが出る。
7. Web Push: Web UI で知らせを許し、返事が届く（iPhone はホーム画面に置いた Web UI）。
8. backup: `components/backup/` を使うなら、手で 1 回動かして成功する（見本の README の「backup」）。

### 10. 最初のメッセージでパスの移り変わりを伝える

エージェントは新しい場所で起きたことを知らない。オーナーの最初のメッセージで、上の「パスの移り変わり」を伝える。たとえば:

> 新しい場所に引っ越したよ。`/work` は `~/work` に、`/home/natsumi/…` は `~/…` に移った（`/home/natsumi` の中身は持ってきていない）。頼める相手はコネクタの文書に、姿は `/memory/avatar/` にある。記憶に書いた古いパスも直しておいて。

natsumi の data directory の場所や作業環境の mount を変えていたなら、その natsumi の実際の置き場に合わせて書き換える。

### 後で

- 郵便ポスト: オーナーがエージェントに「`postbox/` の定期便を予約に移して」と頼む。エージェントが足した予約の数が、1 で数えた定期便の数と合うかを見る（止めてある定期便があれば少なくてよい）。
- natsumi の片付け: オーナーが確かめた後に、natsumi の配置（StatefulSet・Service・Ingress・CronJob・ConfigMap・Secret）を消す。natsumi の PVC と backup を消すかは、そのつどオーナーが決める（ADR-0026）。
- 共有していた鍵（sd-webui の token など）を新しい配置のために作り直したなら、古い方を無効にする。

## 相手ごとに違うもの

natsumi の配置は相手ごとに違う。次は、この手引きが決められないので、移す人が自分の配置で確かめる。

- natsumi の PVC の名前と、その中の data directory の場所（`pod.yaml` の `claimName`・`subPath`）。
- natsumi の StatefulSet・Pod・server のコンテナの名前と、backup・Ingress の名前。
- natsumi が A2A で使っていた ServiceAccount の名前と token の audience、相手の allow-list に足す身元。
- sd-webui の認証の形（Bearer か Basic か）。
- 作業環境の mount を natsumi の既定（`/work`・`/home/natsumi`）から変えていたかどうか。
