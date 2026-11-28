# Kubernetes の配置の見本

penelope の Pod（[docs/pod.md](../../docs/pod.md)）を Kubernetes で動かすための、kustomize の見本である。
1 人のエージェントを 1 つの名前空間に、1 つの StatefulSet（replicas 1）で置く。

- 対象の版は **v0.9.1 以降**。v0.9.0 から、道具の使い方と誰にも同じ skill（`self-portrait`・`goals` など）が sandbox の image の skill に入り（[ADR-0035](../../docs/adr/0035-tool-usage-and-shared-skills-as-image-skills.md)）、アバターは記憶の `/memory/avatar/` で育つ（[ADR-0036](../../docs/adr/0036-the-avatar-grown-in-memory-copied-once-by-the-backend.md)）。配置が渡すのは、その配置だけのことである。
- v0.9.0 は使わない。v0.9.0 の backend が記憶に写したアバターは、`/memory` の set-group-ID が効かない配置では backend のグループのまま残り、エージェントが上書きできない。v0.9.1 から、写したものを `/memory` のグループにする（[docs/backend.md](../../docs/backend.md) の「アバター」）。アバターは最初の起動で 1 回だけ写されるので、v0.9.0 で写した後に版を上げても直らない。
- natsumi のインスタンスから移すなら、[natsumi からの移行の手引き](../../docs/migrate-from-natsumi.md)に沿って、この見本から新しい配置を作る。
- `example/` の値はすべて作りものである。そのままでは動かない。下の「置き換える値」を自分のものにする。

## 置き場

| 場所 | 中身 |
| --- | --- |
| `base/` | 誰にも同じもの。StatefulSet（4 つのコンテナと init container）、init の台本（`init/`）、PVC 2 つ、Service、ServiceAccount |
| `components/backup/` | 任意の部品。睡眠完了後、または前回から 24 時間たったら写す CronJob（下の「backup」） |
| `example/` | 1 人分の overlay の例。設定の ConfigMap、Ingress、名前空間、image の版、Slack・A2A・sd-webui・X 検索・自分のアバターの例 |
| `migrate/` | natsumi から移すときに 1 回だけ使う、作業用の Pod と予約を移す道具（[natsumi からの移行の手引き](../../docs/migrate-from-natsumi.md)） |
| `example_test.go` | `example/` の設定どうしが合っていることの確かめ（`make test`） |

`base/` はそれだけでは組めない。overlay が下の「overlay が渡すもの」を揃えて初めて組める。

## 組み方

`example/` を自分の配置のリポジトリに写し、`base/` は版を指して読む。

```yaml
# kustomization.yaml（自分のリポジトリ）
resources:
- https://github.com/yuanying/penelope//deploy/kubernetes/base?ref=v0.9.1
components:
- https://github.com/yuanying/penelope//deploy/kubernetes/components/backup?ref=v0.9.1
images:
- name: ghcr.io/yuanying/penelope-sentinel
  newTag: v0.9.1
# backend・sandbox・receivers も同じ版にする
```

`base/` を写して使ってもよい。そのときは版を上げるたびに、その版の `base/` と見比べる。

組んで確かめ、入れる:

```sh
kubectl kustomize <overlay>            # 組めることを確かめる
kubectl apply -k <overlay>
```

ConfigMap には中身のハッシュが名前に付くので、設定を変えて入れ直すと Pod が作り直される。

## 名前

名前空間ごとに 1 人で、`base/` の名前は変えない。[natsumi からの移行の手引き](../../docs/migrate-from-natsumi.md)もこの名前を指す。

| 種類 | 名前 | 中身 |
| --- | --- | --- |
| StatefulSet | `penelope` | Pod は `penelope-0` |
| PersistentVolumeClaim | `penelope` | subPath `home/`（sandbox の `/home/agent`。Pi の設定とセッション）・`backend/`（backend の SQLite と画像の写し）・`sources/`（`/sources`） |
| PersistentVolumeClaim | `penelope-memory` | subPath `memory/`（`/memory` の作業ツリーと `.git`） |
| Service | `penelope` | `http`（80 → backend の 8080）・`webhooks`（8081 → receivers） |
| ServiceAccount | `penelope` | RBAC は付けない |
| CronJob・PVC（backup） | `penelope-backup` | `components/backup/` を使うときだけ |

PVC の大きさ（`penelope` 20Gi、`penelope-memory` 5Gi）と StorageClass は、overlay の patch で変える。Go と Node のキャッシュが HOME に溜まるので、`penelope` は大きめにしてある。

## overlay が渡すもの

| 種類 | 名前 | 使うコンテナ | 中身 |
| --- | --- | --- | --- |
| ConfigMap | `penelope-backend-env` | backend | 環境変数（[docs/backend.md](../../docs/backend.md) の「設定」）。例は `example/backend.env` |
| ConfigMap | `penelope-sandbox-env` | sandbox | 環境変数。名前・役目・オーナー・モデル・サロゲート・宛先。例は `example/sandbox/env` と `example/sandbox/surrogates.env` |
| ConfigMap | `penelope-models` | sandbox（init が HOME に書く） | Pi の `models.json` |
| ConfigMap | `penelope-sentinel` | Sentinel | `sentinel.yaml`（[docs/sentinel-config.md](../../docs/sentinel-config.md)） |
| ConfigMap | `penelope-connectors` | sandbox | その配置だけのコネクタの文書 `<名前>.md` |
| ConfigMap | `penelope-receivers` | receivers | `config.json`（[docs/receivers.md](../../docs/receivers.md)）。受けるものが無ければ `{"plugins": []}` |
| ConfigMap | `penelope-skills` | init container skills | 任意。その配置だけの skill（下の「skill」） |
| Secret | `penelope-sentinel-ca` | Sentinel、sandbox（証明書だけ） | Sentinel の CA（`kubernetes.io/tls`） |
| Secret | `penelope-sentinel` | Sentinel | 本物の鍵。キーごとに `/run/secrets/penelope-sentinel/keys/<キー>` |
| Secret | `penelope-backend` | backend | `github-client-secret` |
| Secret | `penelope-receivers` | receivers | 任意。受信の鍵。キーごとに `/run/secrets/penelope-receivers/<キー>` |

base が決めている場所:

| 場所 | 中身 |
| --- | --- |
| backend `PENELOPE_LISTEN` | `[::]:8080` |
| backend `PENELOPE_DATABASE` | `/var/lib/penelope/backend.sqlite` |
| backend `PENELOPE_GITHUB_CLIENT_SECRET_FILE` | `/run/secrets/penelope-backend/github-client-secret` |
| sandbox `PENELOPE_BACKEND_URL` | `https://backend.penelope.internal`（Pod の `hostAliases`。Sentinel が backend の socket へつなぐ） |
| sandbox `PENELOPE_CONNECTORS_DIR` | `/etc/penelope/connectors` |
| sandbox `PENELOPE_OWNER_SKILLS_DIR` | `/skills` |
| sandbox `PENELOPE_IMAGE_SKILLS` | 未設定（image のすべての skill が一覧の対象） |
| Sentinel の受け口 | `15001`（TCP）・`15053`（名前解決）。`sentinel.yaml` の `listen` をこれに合わせる |
| Sentinel の API server 向けの token | `/run/secrets/penelope-sentinel/kube/token`・`ca.crt`（`kubernetes.default.svc` を登録するときに使う） |

## 置き換える値

`example/` の作りものの値と、置き換えるもの:

| 場所 | 値 | 置き換えるもの |
| --- | --- | --- |
| `kustomization.yaml` | `namespace: penelope`、`namespace.yaml` | 名前空間 |
| `kustomization.yaml` | `images` の `newTag` | 使う版（v0.9.1 以降）。4 つとも同じ版 |
| `backend.env`・`sandbox/env` | `https://penelope.example.com` | backend に届く公開の URL |
| `backend.env` | `PENELOPE_GITHUB_CLIENT_ID`・`PENELOPE_OWNER_GITHUB_ID` | GitHub の OAuth App の client ID と、オーナーの数値の user ID（`gh api users/<名前> --jq .id`） |
| `backend.env` | `PENELOPE_TIME_ZONE`・`PENELOPE_HEARTBEAT_MINUTES` | 時間帯、heartbeat。眠りの既定は [backend の設定](../../docs/backend.md#設定) |
| `backend.env` | `PENELOPE_AVATAR=example`、`PENELOPE_AGENT_NAME` | 最初に写すアバターと、UI に出す名前（下の「アバター」） |
| `sandbox/env` | `PENELOPE_NAME` | システムプロンプトに入る名前。`PENELOPE_AGENT_NAME` と同じにする |
| `sandbox/env` | `PENELOPE_ROLE`・`PENELOPE_OWNER` | 役目とオーナー（システムプロンプトに入る） |
| `sandbox/env`・`sandbox/models.json` | `PENELOPE_MODEL=openai/gpt-5.5`、provider `openai` | Pi の既定のモデルと選べるモデルの定義 |
| `sandbox/env` | `PENELOPE_THINKING`（任意） | 既定の思考の深さ。未指定は Pi の設定に従う |
| `sandbox/env` | `PENELOPE_OWNER_EXTENSIONS_DIR`（任意、見本では未設定） | オーナーの Pi 拡張を読み取り専用で mount した絶対パス（下の「Pi 拡張」） |
| `sandbox/surrogates.env`・`sandbox/models.json`・`sentinel/sentinel.yaml` | `surrogate-example-*` | 自分のサロゲート（下の「サロゲート」） |
| `sentinel/sentinel.yaml` | `api.openai.com`・`sd-webui.example.com`・`helper.agents.example.com`・`llm-proxy-xai.example.com` | 鍵を差し替えるホスト |
| `sandbox/surrogates.env` | `SDCTL_URL`・`X_SEARCH_URL` | sd-webui・xAI モードの llm-proxy の URL |
| `sandbox/env` | `X_SEARCH_MODEL` | X 検索に使う Grok のモデル ID（Pi のモデルとは別） |
| `receivers/config.json`・`connectors/slack.md` | ワークスペース `work` | Slack のワークスペースの短い名前 |
| `connectors/*.md` | ホスト・token の環境変数・宛先 | その配置のもの |
| `patches/statefulset.yaml` | `AVATAR_REPO` など | 自分のアバターの置き場と名前（下の「アバター」） |
| `patches/statefulset.yaml` | audience `a2a`・`https://auth.example.com` | A2A の相手・gated がそれぞれ求める ServiceAccount の token の audience |
| `ingress.yaml` | `ingressClassName: example`、ホスト、`penelope-tls` | 使う Ingress と証明書 |
| `skills/skills.list` | 上流の skill | 要る skill（要らなければ ConfigMap ごと消す） |

## サロゲート

sandbox には本物の鍵を置かず、サロゲート（代わりの値）を置く。Sentinel が登録したホストへの要求で、サロゲートを本物の鍵に差し替える（[ADR-0004](../../docs/adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)）。

- 1 つの鍵に 1 つのサロゲートを決め、sandbox の置き場（`sandbox/surrogates.env` か `sandbox/models.json`）と `sentinel/sentinel.yaml` の `surrogate` の両方に同じ値を書く。
- 16 バイト以上で、登録ごとに違う値にする（同じ値が 2 つあると Sentinel は起動しない）。例: `echo "surrogate-model-$(openssl rand -hex 16)"`。
- サロゲートは秘密ではないが、見本の値は使い回さない。
- 揃っていることは `example_test.go` が `example/` について確かめている。自分の overlay にも同じ確かめを置くとよい。

## Secret の作り方

鍵の値はリポジトリに書かない。名前空間を作ってから、`kubectl create secret` で作る（sealed-secrets・SOPS などで置くなら、同じ名前とキーにする）。

```sh
ns=penelope
kubectl create namespace "$ns"

# Sentinel の CA。Pod を作り直しても変わらないよう、作ったら長く保つ。
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
  -subj "/CN=penelope sentinel CA" -addext basicConstraints=critical,CA:TRUE \
  -addext keyUsage=critical,keyCertSign,cRLSign -keyout ca.key -out ca.crt
kubectl -n "$ns" create secret tls penelope-sentinel-ca --cert=ca.crt --key=ca.key

# Sentinel が差し替える本物の鍵。キーの名前は sentinel.yaml の source の file と揃える。
kubectl -n "$ns" create secret generic penelope-sentinel \
  --from-file=model-api-key=./model-api-key \
  --from-file=slack-bot-token=./slack-bot-token \
  --from-file=sd-webui-token=./sd-webui-token

# backend の GitHub OAuth 用の鍵。
kubectl -n "$ns" create secret generic penelope-backend \
  --from-file=github-client-secret=./github-client-secret

# receivers。キーの名前は receivers/config.json の *_file と揃える。
kubectl -n "$ns" create secret generic penelope-receivers \
  --from-file=slack-work-app-token=./slack-work-app-token \
  --from-file=slack-work-bot-token=./slack-work-bot-token
```

- Slack の bot の token は、receivers（受ける）と Sentinel（`slackctl post` で送る）の両方が使うので、2 つの Secret に同じ値を入れる。Slack App の用意は [docs/receivers.md](../../docs/receivers.md) の「Slack App の用意」。
- GitHub の OAuth App の callback は `<公開の URL>/auth/github/callback`。
- 鍵を変えたら Pod を作り直す（`kubectl -n "$ns" rollout restart statefulset/penelope`）。receivers は鍵を起動のときにだけ読む。

## 記憶の評価

sandbox の image に入る `penelope-memory-eval` は、配置の `PURPOSE.md` にある問いで記憶を評価する。見本の Pod では次のように起動する。

```sh
kubectl -n penelope exec penelope-0 -c sandbox -- penelope-memory-eval
```

既定の出力には問いや答えを含めない。問いの書式、過去の記憶の指定、結果の比較は [記憶評価 CLI の仕様](../../docs/memory-eval.md) を参照。

## モデルの設定

`PENELOPE_MODEL` と `PENELOPE_THINKING` は、オーナーが Web UI の「設定」で選ぶまでの既定である。保存した組は backend の SQLite に残り、本体・サブエージェント・夜の整理係の次のターンから使う。候補を増やすには sandbox の `models.json` にモデルを追加し、必要な鍵の差し替えは従来どおり Sentinel に設定する。候補には Pi が認証を確認できたモデルだけが出る。候補から保存済みのモデルが外れたら、runner は既定で動き、そのことをログに残す。

接続先が 1 回に受け付ける画像の上限は、`sandbox/models.json` の provider の定義に `maxImagesPerRequest` を足して指定する。たとえば 3 枚までの `sakura` では、既存の定義に次の項目を足す（既存の `baseUrl`・`api`・`apiKey`・`models` はそのまま）。

```json
{
  "providers": {
    "sakura": {
      "maxImagesPerRequest": 3
    }
  }
}
```

この項目は Pi ではなく runner が起動時に読む。未指定なら制限せず、0 なら画像を送らない。[同梱の OpenAI の見本](example/sandbox/models.json)では上限を指定していない。設定の反映には Pod を作り直す。詳しくは [sandbox の仕様](../../docs/sandbox-api.md#モデル要求の画像の上限) を参照。

設定用の schema 8 への migration は一方通行である。更新前に SQLite を backup し、版 7 までの backend に戻すときは更新前の backup も戻す。

## X 検索（任意）

`x-search` skill を含む sandbox image と、gated の背後で稼働する [xAI モードの llm-proxy](https://github.com/yuanying/llm-proxy) が必要である。`X_SEARCH_URL` はその HTTPS オリジン（`/v1` は付けない）、`X_SEARCH_MODEL` はそのログインで使える Grok のモデル ID にする。ホストは `sentinel.yaml` と `connectors/x-search.md` にも同じものを書く。`PENELOPE_IMAGE_SKILLS` で一覧を絞っているなら `x-search` を含める。

`patches/statefulset.yaml` の例では、gated の `--serviceaccount-audience` を指定した projected token を Sentinel にだけ mount する。Sentinel が `X_SEARCH_TOKEN` のサロゲートをこの token に差し替える。gated の `NetworkRole` で `POST /v1/responses` を対象にし、Pod の ServiceAccount を `NetworkRoleBinding` と llm-proxy の `--allowed-subjects` の両方で許す。xAI のログインは llm-proxy が持ち、Pod には置かない。

X 検索を使わない場合は、`X_SEARCH_*` の環境変数、コネクタ（`kustomization.yaml` の参照も含む）、Sentinel のホスト登録、`patches/statefulset.yaml` の `x-search-token` volume と mount を外す。

## 家を有効にする

見本は既定で家に接続しない。家、receivers、sandbox の同じ版の image を使う。家は別に用意し、[家の設定](../../docs/house.md#設定)の `agents` と gated の許可にこの Pod の ServiceAccount を載せる。出かけているときに `reply` を届ける相手は、家の `owner_login` で設定する。gated では `GET /v1/agent/house`、`POST /v1/agent/rooms/<room-id>/enter`、`DELETE /v1/agent/room`、`POST /v1/agent/reply`、`POST /v1/agent/sync`、`GET /v1/agent/images/<image-id>` を許可の対象にする。

1. [`house/statefulset.yaml`](example/house/statefulset.yaml) を `kustomization.yaml` の `patches` に加える。`audience` は gated の `--serviceaccount-audience` に合わせる。token の mount は receivers と Sentinel だけに置く。
2. [`house/receivers-entry.json`](example/house/receivers-entry.json) の項目を `receivers/config.json` の `plugins` に足す。`url` は配置の値に替える。旧版のプラグインに `owner_id` を設定していた場合は削除する。
3. `backend.env` の `PENELOPE_INLINE_SOURCES` に `house` を足す。有効化の `source` を変えた場合は、その値を足す。
4. `sandbox/surrogates.env` で `HOUSE_URL` に家の HTTPS オリジン、`HOUSE_TOKEN` にサロゲートを設定する。`sentinel/sentinel.yaml` の `hosts` にそのホストを登録する。同じサロゲートを使い、鍵の出どころを projected token にする。

   ```yaml
   - name: house.example.com
     credentials:
       - place: bearer
         surrogate: surrogate-example-house-0001
         source: { file: /run/secrets/penelope-house/token }
   ```

5. [`house/house.md`](example/house/house.md) のホストと受信元を配置に合わせる。`kustomization.yaml` の `penelope-connectors.files` に `house/house.md` を足す。

## アバター

アバター（名前、表情の画像、姿の `appearance.yaml`、描画の既定の `sdctl-params.yaml`）は記憶の `/memory/avatar/` にあり、エージェントが育てる（[ADR-0036](../../docs/adr/0036-the-avatar-grown-in-memory-copied-once-by-the-backend.md)、[docs/backend.md](../../docs/backend.md) の「アバター」）。

- backend は起動のとき、`/memory/avatar/` が無ければ、`PENELOPE_AVATAR` の名前のアバターを、`PENELOPE_AVATARS_DIR`（あれば）、image の基本のアバターの順に探して写し、コミットする。**写すのは最初の 1 回だけ**で、`/memory/avatar/` があれば触らない。置き場や `PENELOPE_AVATAR` を後から替えても、写し直されない。
- UI に出す名前は `PENELOPE_AGENT_NAME`。無ければ `/memory/avatar/avatar.json` の名前。
- sandbox には何も mount しない。sdctl の描画の既定は、配置が `SDCTL_PARAMS` を書かなければ `/memory/avatar/sdctl-params.yaml` になる。

置き方は 2 つ。

- **image に入っているアバター**（`penelope`・`natsumi`・`myao`・`aki`）を使うなら、backend の `PENELOPE_AVATAR` に名前を書くだけでよい。`example/patches/statefulset.yaml` の avatar の部分（init container `avatar`、volume `avatars` とその mount、`PENELOPE_AVATARS_DIR`）を消す。
- **自分のアバター**を使うなら（`example/` の形）、`<名前>/` にアバターのディレクトリ（`avatar.json` と表情の画像、`appearance.yaml`・`sdctl-params.yaml`）を置いた volume を、**backend にだけ**読み取りで mount して `PENELOPE_AVATARS_DIR` で指し、`PENELOPE_AVATAR` をその名前にする。写したあとは mount を外してよい。

画像は ConfigMap の大きさの上限（1 MiB）を超えやすいので、置き方は次から選ぶ。

| 置き方 | やり方 |
| --- | --- |
| init で取る（`example/` の形） | public な git のリポジトリに置き、init container が `base/init/avatar.sh` で emptyDir に取る。Pod を作り直すたびに取り直す |
| PVC | アバター専用の PVC に `<名前>/` を置き、backend に読み取りで mount する。中身は一度だけ `kubectl cp` などで入れる |
| image を作る | `ghcr.io/yuanying/penelope-backend` を元に、`/app/avatars/<名前>/` を足した image を作る。mount は要らないが、版を上げるたびに作り直す |

## skill

image の skill は設定しなければすべて一覧の対象になる。絞るには、配置の sandbox の環境変数 `PENELOPE_IMAGE_SKILLS` に載せる名前をカンマ区切りで書く（例: `goals,self-portrait`）。空の値なら image の skill は載らない。image にない名前は runner がログに出して飛ばす。一覧から外した skill のファイルも image に残る。

init container `skills`（`base/init/skills.sh`）が置くオーナーの skill と、記憶の skill はこの設定では絞らない。同じ名前があれば、オーナー、記憶、image の順で先のものが一覧に載る（[docs/pod.md](../../docs/pod.md) の「volume」）。

- ConfigMap `penelope-skills` の `<名前>.SKILL.md` は `/skills/<名前>/SKILL.md` になる。
- `skills.list` の 1 行は `<git の URL> <枝> <skill>...` で、そのリポジトリの `skills/<skill>/` を写す。リポジトリは public であること（向け直しの前に、鍵なしで取る）。
- 取れなかった skill は飛ばして Pod は起動する。ログに出る（`kubectl -n penelope logs penelope-0 -c skills`）。

## Pi 拡張

オーナーの拡張を使う配置は、overlay で sandbox に読み取り専用の volume を追加し、`PENELOPE_OWNER_EXTENSIONS_DIR` でその mount 先（例 `/etc/penelope/extensions`）を指定する。見本は volume も環境変数も追加しない。オーナーの拡張のほかに、本人のセッションは記憶の `/memory/extensions/` も読む。

拡張は runner のプロセス内で動く。配置が渡す拡張とその依存先は、エージェントが書き換えられない場所に置く。反映の時期、ログ、戻し方は [Pod の形の仕様「Pi 拡張」](../../docs/pod.md#pi-拡張) を参照。

## コネクタの文書

`penelope-connectors` に置くのは、その配置だけのこと（ホスト、token の環境変数、ワークスペース、宛先）である。`slackctl`・`sdctl`・`a2a` などの道具の使い方は image の skill にある。

- 文書の `hosts` は `sentinel.yaml` の登録の `name` と同じにし、鍵を差し替える登録はどれかの文書の `hosts` に入れる（[docs/sentinel-config.md](../../docs/sentinel-config.md) の「コネクタの文書」）。
- `example/connectors/` にあるのは、Slack（`slack.md`）、A2A の相手（`agents.md`）、sd-webui（`sd-webui.md`）、X 検索（`x-search.md`）、モデル（`model.md`）、backend（`backend.md`。runner が使う。どの配置にも要る）。

## A2A

- **送る**（`example/` の形）: 相手のホストを `sentinel.yaml` に登録し、ServiceAccount `penelope` の token に差し替える。token は `patches/statefulset.yaml` が Sentinel にだけ projected で渡す（audience `a2a`）。audience は相手が求めるものにする。相手の側で、この ServiceAccount（`system:serviceaccount:<名前空間>:penelope`）を許す。
- **受ける**（見本には無い）: backend の `PENELOPE_A2A_*` を `penelope-backend-env` に書く（[docs/a2a.md](../../docs/a2a.md)・[docs/backend.md](../../docs/backend.md)）。`tokenreview` で確かめるなら、backend に API server の audience の token を projected で mount し、ServiceAccount `penelope` に `system:auth-delegator` を付ける。外から呼ぶ場合は、Ingress で `/.well-known/agent-card.json`（token なしの GET）と `/a2a`（JSON-RPC）を backend に届ける。

## volume と持ち主

4 つのコンテナは UID が違う（[docs/pod.md](../../docs/pod.md) の「コンテナ」）。共有する volume は、Pod の `supplementalGroups` のグループ 2000 に置き、setgid のディレクトリにする。`fsGroup` は使わない。kubelet が PVC の中身を丸ごとグループに開けてしまい、backend の SQLite と sandbox の HOME を 0700 に保てないためである。

init container `volumes`（`base/init/volumes.sh`）が、無いディレクトリだけを持ち主と権限を付けて作る。あるものは触らない。ほかから写した中身を置くときは、同じ持ち主と権限にする。

| 場所 | 持ち主 | 権限 |
| --- | --- | --- |
| `penelope` の `home/` | 1000:1000 | 0700 |
| `penelope` の `backend/` | 1001:1001 | 0700 |
| `penelope` の `sources/` | 1001:2000 | 2770 |
| `penelope-memory` の `memory/` | 1000:2000 | 2770。backend もグループで書く（`/memory/avatar/` を写すため） |
| `penelope-memory` の `memory/.git` | 1001:2000 | 2770 |

init container `redirect` は NET_ADMIN で iptables（nft）の規則を張る。ノードが nftables を使えることが要る。

## 最初の起動と確かめ方

1. 上の Secret を作り、`kubectl apply -k <overlay>` で入れる。
2. Pod が `Running` で 4 つとも Ready になるのを待つ: `kubectl -n penelope get pod penelope-0 -w`。
3. init container の記録を見る:
   - `kubectl -n penelope logs penelope-0 -c volumes` — 置き場の持ち主と権限
   - `kubectl -n penelope logs penelope-0 -c redirect` — 張った規則
   - `kubectl -n penelope logs penelope-0 -c skills`・`-c avatar` — 取った skill とアバター
4. Sentinel の記録（1 通信 1 行の JSON）で、モデルの API が `open` になっていることを見る: `kubectl -n penelope logs penelope-0 -c sentinel | grep api.openai.com`。
5. sandbox から外へ出られることを見る: `kubectl -n penelope exec penelope-0 -c sandbox -- curl -sI https://github.com`。
6. 公開の URL を開き、GitHub でログインして話しかける。返事が来れば、`/memory` にコミットが積まれる: `kubectl -n penelope exec penelope-0 -c sandbox -- git -C /memory log --oneline -3`。
7. Slack を使うなら、receivers の起動の 1 行（`receivers: listening on ...; connections: slack ...`）を見て、bot を入れたチャンネルで話しかける。

設定の誤りがあると、そのコンテナが起動せずに理由を 1 行書いて終わる（backend・receivers は終了コード 2、Sentinel は標準エラー）。`kubectl -n penelope logs penelope-0 -c <コンテナ> --previous` で見る。

## backup

`components/backup/` の CronJob は 15 分ごとに、Pod を止めずに 2 つの PVC を写す必要があるか確かめる。判定には、[metrics](../../docs/backend.md#metrics) の `penelope_sleep_last_completed_timestamp_seconds` と、最後に成功した backup の開始時刻を使う。

- 眠りの 4 段が済んだ時刻が前回の backup の開始より新しければ写す。backup がまだ無いか、前回の開始から 24 時間以上たっていれば、眠りの有無や metrics を読めるかどうかに関係なく写す。
- component は backend の `PENELOPE_METRICS_LISTEN` を `[::]:9100` に設定する。CronJob はクラスタ内の Service `penelope-metrics` の `GET /metrics` を読む。Service は Ingress に載せない。metrics 未対応の backend image では 24 時間の条件だけで動く。
- 時刻は完成した backup のディレクトリ名から読む。作業中・失敗した `.partial` は数えない。開始時刻を使うため、backup の途中で眠りが済んだ場合は次の回で写す。

- backend の SQLite は、そのまま写すと書きかけや WAL の分を落とし得るので、SQLite の online backup（`sqlite3` の `.backup` と同じ仕組み）で整合したコピーを取る（`sqlite-backup.mjs`。backend の image の Node で動く）。
- `penelope` は SQLite の本体と作り直せるキャッシュ（`~/.cache`・`~/go/pkg/mod`・`~/.npm`・`node_modules`・`~/.kube/cache`）を除いて tar に、`penelope-memory` はそのまま tar にする。持ち主と権限は数値のまま残る。
- 置き場は `<UTC の開始時刻>/`（`backend.sqlite`・`state.tar.gz`・`memory.tar.gz`）で、14 日分を残す（`KEEP_DAYS`）。
- 置き場の volume は、見本では同じクラスタの PVC `penelope-backup` である。同じストレージの故障では一緒に失うので、patch で NFS などの別の場所に向ける。
- PVC は ReadWriteOnce なので、Job は agent の Pod と同じノードで動く。Pod を止めている間は Pending のまま期限で終わる。

手で取るとき（版を上げる前など）は、実行中の backup がないことを確かめてから `FORCE_BACKUP=1` を渡す。

```sh
kubectl -n penelope create job --from=cronjob/penelope-backup penelope-backup-manual --dry-run=client -o yaml |
  kubectl set env --local -f - --containers=select-backup FORCE_BACKUP=1 -o yaml |
  kubectl -n penelope create -f -
kubectl -n penelope wait --for=condition=complete job/penelope-backup-manual --timeout=1h
```

restore は Pod を止めてから行う。

1. `kubectl -n penelope scale statefulset/penelope --replicas=0`
2. 2 つの PVC と backup の置き場を mount した root の Pod を立て、`penelope` に `state.tar.gz`、`penelope-memory` に `memory.tar.gz` を `tar --numeric-owner -xzf` で戻す。
3. `backend.sqlite` を `penelope` の `backend/backend.sqlite` に置き、同じ場所の `backend.sqlite-wal`・`backend.sqlite-shm` を消す。持ち主は 1001:1001、権限は 0600。
4. その Pod を消して `kubectl -n penelope scale statefulset/penelope --replicas=1`。

## 版の上げ方

1. 上げる版の Release の説明と、`base/` の差分を読む（`git diff vA.B.C vX.Y.Z -- deploy/kubernetes/`）。overlay が渡すものが増えていれば足す。
2. **backend の SQLite の migration は一方通行である**（[docs/backend.md](../../docs/backend.md) の「状態」。backend は自分より新しい版のファイルを開かない）。migration のある版に上げる前に、手で backup を取る（上の「backup」）。戻すときは、その backup の SQLite ごと戻す。
3. overlay の `images` の 4 つを同じ版にし、`base/` を版で指しているならその `ref` も同じ版にする。
4. `kubectl kustomize <overlay>` で組めることを確かめ、`kubectl apply -k <overlay>` で入れる。StatefulSet が Pod を作り直す。
5. 「最初の起動と確かめ方」の 2〜6 を見る。

この見本の版（`example` の image、`base` の `distroless-iptables` など）は Renovate が上げるが、`deploy/` だけの変更は週次の release を出さない。次の release に乗る。

## 見本に無いもの

- クラスタの API を使わせること。使うなら、ServiceAccount `penelope` に RBAC を付け、`kubernetes.default.svc` を `sentinel.yaml` に登録し（鍵は `/run/secrets/penelope-sentinel/kube/token`、`upstream_ca` は同じ場所の `ca.crt`）、サロゲートを持つ kubeconfig を sandbox に置いて `KUBECONFIG` で指す。
- Alertmanager・GitHub の webhook。使うなら、`receivers/config.json` に足し、Ingress に `/v1/webhooks/` → Service の `webhooks` を足す。
- Sentinel の既定を `passthrough` 以外にすること（[ADR-0003](../../docs/adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)）。
