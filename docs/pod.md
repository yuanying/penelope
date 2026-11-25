# Pod の形の仕様

1 つの Pod に並ぶ 4 つのコンテナと、その UID・volume・網の向け直しを決める。sandbox の image と、配置のリポジトリの manifest は、これに合わせる。
方針は [ADR-0001](adr/0001-one-pod-with-pi-inside-the-sandbox.md)・[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)・[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)・[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)・[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)・[ADR-0011](adr/0011-a-full-dev-image-and-a-generic-user-home.md)・[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md)・[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)・[ADR-0020](adr/0020-connectors-with-a-usage-document-listed-in-the-prompt.md)・[ADR-0021](adr/0021-her-own-ssh-key-in-home-for-the-vms-she-makes.md)・[ADR-0035](adr/0035-tool-usage-and-shared-skills-as-image-skills.md) にある。

「未決」と書いた点は、実装の作業単位が決めて、この文書を直す。

## コンテナ

| コンテナ | UID | 持つもの |
| --- | --- | --- |
| sandbox | 1000（ユーザー `agent`、HOME `/home/agent`） | runner と Pi、開発の道具。サロゲートだけ |
| backend | 1001 | 取り込み口と待ち行列、sandbox 向けの口、UI 向けの API |
| Sentinel | 65532（distroless の `nonroot`） | 透過の受け口、本物の鍵、CA の鍵、管理口 |
| receivers | 1002 | 受信のプラグイン、受信の鍵（[receivers.md](receivers.md)） |

- 4 つとも別の UID にする。網の向け直しは sandbox の UID で選ぶので（下の「網」）、ほかのコンテナが同じ UID だと、その外向きまで Sentinel へ向け直される。
- backend と receivers の image は、ユーザーを作らず数値の UID と GID で動く。

## volume

| volume | sandbox | backend | Sentinel | receivers |
| --- | --- | --- | --- | --- |
| `/memory` の作業ツリー（永続） | 読み書き | 読み書き | — | — |
| `/memory/.git`（同じ永続の場所） | 読み取りで重ねる | 読み書き | — | — |
| `/home/agent`（永続） | 読み書き | — | — | — |
| backend の SQLite と、作ったものの写し（永続、既定では同じ場所。[backend.md](backend.md)） | — | 読み書き | — | — |
| `/sources`（永続） | 読み取り | 読み書き | — | — |
| 取り込み口の socket（emptyDir） | — | 読み書き | — | 読み書き |
| backend の sandbox 向けの口の socket（emptyDir） | — | 読み書き | 読み書き | — |
| Sentinel の管理口の socket（emptyDir） | — | 読み書き | 読み書き | — |
| 鍵の Secret・CA の鍵 | — | — | 読み取り | — |
| Sentinel の CA の公開の証明書（`/etc/penelope/ca/`） | 読み取り | — | — | — |
| projected の ServiceAccount の token | — | 読み取り | 読み取り | — |
| 受信の鍵の Secret | — | — | — | 読み取り |
| オーナーの skill（例 `/skills`、配置が置く） | 読み取り | — | — | — |
| オーナーの Pi 拡張（例 `/etc/penelope/extensions`、任意） | 読み取り | — | — | — |
| コネクタの文書（`/etc/penelope/connectors/`、配置が置く） | 読み取り | — | — | — |
| 配置のアバターの置き場（`PENELOPE_AVATARS_DIR`、任意） | — | 読み取り | — | — |

- Pi のディレクトリ（設定・認証・モデル・skill）とセッションの記録は HOME の下に置く（`/home/agent/.pi/agent/`、セッションは `/home/agent/.pi/agent/sessions/main/`、サブエージェントの記録とセッションは `/home/agent/.pi/agent/sessions/agents/`）。別の volume にはしない。HOME が永続なので足りる。
- skill は `<名前>/SKILL.md` の並びで、runner は次の 3 か所から並べて読む。同じ名前が 2 か所以上にあれば、この表の上の方が一覧に載る（[ADR-0035](adr/0035-tool-usage-and-shared-skills-as-image-skills.md)）。場所が無ければ、そこの skill は無い。

| 順 | 置き場所 | 持ち主 |
| --- | --- | --- |
| 1 | `PENELOPE_OWNER_SKILLS_DIR` が指す場所（オーナーの skill）。読み取りで mount するので、エージェントは書き換えられない。設定が無ければ無い | 配置 |
| 2 | 記憶の `skills/` | エージェント |
| 3 | `/opt/penelope/skills/`（sandbox の image の中。リポジトリの `packages/runner/image/skills/`）。配置は `PENELOPE_IMAGE_SKILLS` で一覧に載せるものを選べる | このリポジトリ |

- sandbox の `PENELOPE_IMAGE_SKILLS` が未設定なら、image の skill はすべて一覧の対象になる。設定する場合は `goals,self-portrait` のように名前（`SKILL.md` が入っているディレクトリ名）をカンマで区切る。名前の前後の空白と空の項目は無視し、空の値なら image の skill を 1 つも載せない。image にない名前は runner のログに出して飛ばす。
- この選択は本人・サブエージェントのセッションに適用し、拡張の読み直し後も保つ。照合係・整理係は skill を読み込まない。オーナーと記憶の skill は絞らない。一覧に載らない skill も image の中に残り、ファイルは読める（[ADR-0042](adr/0042-select-image-skills-per-deployment.md)）。
- image の skill は、image の道具の使い方（`slack`・`sd-webui`・`a2a`・`github`・`x-search` など）と、どの配置にも同じ skill（`self-portrait`・`goals`）である。配置の値は持たず、それは配置のコネクタの文書にある。image の skill とコネクタは名前で突き合わせない。
- コネクタの文書は `<名前>.md` の並びで、runner は `PENELOPE_CONNECTORS_DIR` が指す場所から読み、一覧をシステムプロンプトに出す（[sentinel-config.md](sentinel-config.md) の「コネクタの文書」）。読み取りで mount する。設定が無いか、場所が無ければ、コネクタの一覧は無い。
- 自分で作った VM への ssh の鍵は、エージェントが HOME に自分で作る（[ADR-0021](adr/0021-her-own-ssh-key-in-home-for-the-vms-she-makes.md)）。配置は ssh の鍵も ssh-agent も置かない。ssh の接続は、ほかの外向きと同じく Sentinel へ向け直され、既定の扱いに従う。
- `/memory` の `.git` は sandbox からは読むだけである。backend がターンの終わりにコミットする（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）。
- runner はコミットの依頼の直前に、作業ツリーのうち共有グループに属して sandbox ユーザーが所有する通常ファイルに `g+rw`、ディレクトリに `g+rwx` を補う。元の権限（set-group-ID を含む）は保つ。共有グループは作業ツリーのルートのグループとする。`.git` は走査せず、シンボリックリンクはたどらない。外に同じファイルがあるか分からないハードリンクのファイルも変更しない（[ADR-0061](adr/0061-share-memory-worktree-access-before-turn-commits.md)）。
- `/sources` を書くのは backend だけ（[events.md](events.md)）。receivers は mount しない。
- 取り込み口の socket は sandbox に mount しない。送れるのは socket が見えるコンテナだけである（[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)）。
- 管理口の socket も sandbox に mount しない（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。
- backend の sandbox 向けの口の socket は、backend と Sentinel だけが mount する。Sentinel は backend の登録の `upstream` でこの socket につなぐ（[sentinel-config.md](sentinel-config.md) の「上流」）。
- コンテナの UID が違うので、配置は共有する volume を 1 つのグループに置く。そのグループを Pod の `supplementalGroups` で全コンテナに与え、共有するディレクトリを set-group-ID にする。`fsGroup` は使わない。kubelet が volume の中身を丸ごとそのグループに開け、backend の SQLite と sandbox の HOME を持ち主だけのものに保てないためである。持ち主と権限は init container が付ける（見本は [deploy/kubernetes/](../deploy/kubernetes/README.md) の「volume と持ち主」）。backend は sandbox が書いた `/memory` の作業ツリーを読み、`/memory/.git`・SQLite・`/sources` を書く。sandbox は `/sources` を読む。socket は backend が誰でも書ける mode で作るので、見えるかどうかは mount だけで決まる。

### A2A の宛先

[ADR-0048](adr/0048-ask-agents-by-name-and-wait-in-a-background-job.md) の `ask-agent` は、`PENELOPE_CONNECTORS_DIR`（未設定なら `/etc/penelope/connectors`）の `.md` 文書の YAML frontmatter にある `a2a` の一覧を読む。通常の frontmatter と Markdown 本文はそのまま残す。

```yaml
a2a:
  - name: helper
    label: ヘルパー
    url: https://helper.agents.example.com/
    token: HELPER_AGENT_TOKEN
```

- `name` は英数字から始まる 64 文字以内の英数字・`_`・`-`、`label` は 100 文字以内の空でない表示名。大小文字を区別して、どちらかに完全一致する項目を 1 件だけ選ぶ。文書をまたいでも、別々の項目が同じ名前・表示名に一致してはならない。
- `url` は Agent Card を見つけるための HTTP(S) のルート URL。`token` は Bearer サロゲートを渡す環境変数の**名前**であり、値は文書に書かない。URL のホストとサロゲートの組を Sentinel に登録する。
- 一意に選べない、選んだ項目に欠けがある、または設定が読めないときは送らない。認証が通らなくても別の宛先や認証は試さない。使い方は [sandbox 向けの口の仕様](sandbox-api.md#ask-agent) を参照。

## Pi 拡張

本人のセッションとサブエージェントには、Pi の基本ツールに加えて `codemode` がある。JavaScript から既存のツールを呼び、結果を絞って返せる。`reply` と `reply_to_agent` はこれまでどおり本人のセッションだけにあり、モデルが直接呼ぶ。夜の照合係・整理係と記憶評価には `codemode` を渡さない。MCP と `tool_search` は読み込まない（[ADR-0062](adr/0062-add-codemode-to-main-and-sub-agent-sessions.md)）。

### ディスク上の拡張

runner は本人のセッションを開くときと、置き場が変わってターンの前に読み直すとき、次の順に置き場を Pi に渡す（[ADR-0039](adr/0039-load-owner-and-memory-extensions-in-the-main-session.md)）。

| 順 | 置き場所 | 持ち主 |
| --- | --- | --- |
| 1 | `PENELOPE_OWNER_EXTENSIONS_DIR` が指す絶対パス。任意。sandbox に読み取り専用で mount する | 配置 |
| 2 | `/memory/extensions/`。無ければ読み込まない | エージェント |

- 各置き場は Pi のローカル拡張ソースとして扱う。単独の拡張なら直下の `index.ts` に置く。複数なら、配下の `extensions/` に各 `.ts` ファイルか `index.ts` を持つサブディレクトリを置く。たとえば記憶で複数の拡張を使うときは `/memory/extensions/extensions/greet.ts` に置く。詳しい規則は sandbox の `/opt/penelope/runner/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` にある。
- HOME や作業ディレクトリからは拡張を自動検出しない。サブエージェントと夜の照合係・整理係のセッションには読み込まない。runner は対話 UI を起動しない。
- 書き換えは進行中のターンには反映されない。次に本人のターンを始める前に、拡張の置き場の追加・変更・削除を見て、変わっていればセッションの拡張を読み直す。このとき skill も読み直すが、`codemode` は引き続き使える。夜の切り替えや runner の再起動でセッションを開くときも読み込む。
- Pi が報告した読み込みエラーやハンドラの例外は、sandbox のログと次のターンの入力に出す。読み込みエラーの拡張は読み込まず、ハンドラの例外は Pi の扱いに従う（例: `tool_call` の例外はそのツール呼び出しを止める）。
- 記憶の拡張は、初めて試す内容の指紋を HOME の `.penelope-extension-trials.json` に未確認として記録してから読む。その最初のターンが `done` なら確認済みにする。それ以外で終わるか、未確認のまま runner が再起動したら、その内容は次のターンから読み込まない。外した場所と理由はログとターンの入力に出す。未確認の内容に変更すると再び試せるが、すでに外した内容に戻しても読み込まない。オーナーの拡張はこの仕組みでは外さない。

### 記憶の拡張を戻す

最初のターンが `done` でも振る舞いがおかしい場合や、ハンドラが戻らずターンが終わらない場合（runner にターン全体の時間上限はない）は、自動では検出しない。本人のセッションが動くなら、オーナーは拡張を外すよう頼める。動かない場合は、runner の外から sandbox のシェルを開く（Kubernetes なら `kubectl exec -it <pod> -c sandbox -- sh`）。

記憶の `.git` は sandbox から読み取り専用で、`git restore --worktree` も index のロックを作るため使えない。動いていたコミットの `extensions/` だけを取り出し、作業ツリーを戻す。以下の `<正常なコミット>` はコミットの参照に置き換える。

```sh
backup=$(mktemp -d)
git -C /memory archive --format=tar --output="$backup/extensions.tar" '<正常なコミット>' -- extensions/ &&
  mv /memory/extensions "$backup/broken-extensions" &&
  tar -xf "$backup/extensions.tar" -C /memory
```

記憶の拡張を全部外すだけなら、`/memory/extensions` を読み込み対象外へ移すだけでよい。ターンを処理できる場合は次のターンで反映される。止まったままなら、拡張を外すか戻してから runner を再起動する。

## アバター

エージェントのアバターは `/memory/avatar/` にある（[ADR-0036](adr/0036-the-avatar-grown-in-memory-copied-once-by-the-backend.md)、[backend.md](backend.md) の「アバター」）。

- backend は、`/memory/avatar/` が無ければ、選んだアバター（`PENELOPE_AVATAR`）を、配置の置き場（`PENELOPE_AVATARS_DIR`）か image の基本のアバターから写す。配置の置き場を先に探す。そのため backend は `/memory` の作業ツリーの一番上にディレクトリを作れる必要がある（共有のグループに書ける）。写したものは `/memory` のグループにし、グループが書けるようにする（ディレクトリには set-group-ID を付ける）。そのため backend は `/memory` のグループに入っている必要がある。
- sandbox の image にアバターは入っていない。エージェントは `/memory/avatar/` だけを読み書きする。
- 自分特有のアバターを使う配置は、アバターのディレクトリ（`<名前>/avatar.json` と表情の画像、`appearance.yaml`・`sdctl-params.yaml`）を置いた volume を backend に読み取りで mount し、`PENELOPE_AVATARS_DIR` で指す。写すのは `/memory/avatar/` が無いときの 1 回だけなので、写したあとは mount を外してよい。記憶にすでにアバターがある配置で置き場を替えても、写し直されない。
- sandbox の `avatar check` は、`/memory/avatar/` を backend と同じ規則で読み、使えないものとその理由を出す（既定の場所は `/memory/avatar`、ほかの場所を引数で渡せる）。
- 配置が `SDCTL_PARAMS` を置いていなければ（空の値も置いたうちに入る）、sandbox の entrypoint が `SDCTL_PARAMS` を `/memory/avatar/sdctl-params.yaml` にする。image の `sdctl` はそのファイルがあるかを呼ぶたびに見て、無ければ params のファイル無しで動く。sandbox が backend より先に起動しても、写されたあとから効く。
- 使い方は image の skill `avatar` にある。
- 記憶の外の姿の置き場（`/etc/penelope/avatar/` など）を、penelope の image は読まない。配置がそこを `SDCTL_PARAMS` やオーナーの skill で指している間は、その配置の道具がそこを読む。

## 待ち受け

Pod の中のコンテナは網の名前空間を共有するので、TCP の待ち受けには sandbox からも loopback で届く。そのため、Pod の中のコンテナどうしのための口は Unix socket だけで待ち受ける（[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)）。

| コンテナ | Unix socket だけで待ち受ける口 | TCP で待ち受ける口 |
| --- | --- | --- |
| backend | 取り込み口、sandbox 向けの口 | Pod の外から呼ばれる口（UI 向けの API と A2A の受け口） |
| Sentinel | 管理口 | 向け直しの受け口（直に届いた通信は断る） |
| receivers | なし | Pod の外から呼ばれる口（webhook の受け口。[receivers.md](receivers.md) の「HTTP の口」） |
| sandbox | — | sandbox の自由（loopback は止めない） |

- TCP で待ち受ける Pod の外から呼ばれる口は、Pod の外から届くのと同じ確かめ（ログインのセッション、ServiceAccount の token、webhook の署名）を通す。sandbox からも loopback で届くが、扱いは外から届くのと同じである。

未決:

- 永続の場所を PVC いくつに分けるか、各 volume の mount の場所（`/memory`・`/home/agent`・`/sources` のほか）。

## 網

- init container が iptables で、sandbox の UID の外向きの通信（TCP と名前解決、IPv4 と IPv6）を Sentinel へ向け直す。sandbox のコンテナは NET_ADMIN を持たない。
- sandbox の UID の loopback への通信は、向け直しも止めもしない。backend の取り込み口・sandbox 向けの口と Sentinel の管理口には、TCP の待ち受けが無いので、loopback からは届かない（上の「待ち受け」）。
- リンクローカル（169.254.0.0/16、fe80::/10）への通信も Sentinel へ向け直し、Sentinel が断って記録に残す。
- ほかのコンテナの UID の通信は向け直さない。

未決:

- UDP（名前解決のほか）の扱い。
- 向け直しの先のポート。

## ServiceAccount の token

- Pod は `automountServiceAccountToken: false`。
- projected の token は Sentinel と backend のコンテナにだけ明示して mount する。Sentinel はそれを鍵の出どころにし、backend は A2A の送り手を TokenReview で確かめるときに使う（[ADR-0010](adr/0010-github-oauth-for-people-tokenreview-for-a2a.md)、[ADR-0018](adr/0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md)。gated の assertion だけで確かめる配置では使わない）。
- sandbox には、サロゲートを持つ kubeconfig だけを置く。

## CA

- Sentinel の CA の公開の証明書を、sandbox のシステムの信頼の置き場に入れ、Node と Python がシステムの束を使うよう環境変数を設定する（[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md) の Decision「CA は image で信頼させる」）。
- CA の証明書と鍵は Secret に置き、Sentinel のコンテナにだけ mount する。Sentinel は設定の `ca.cert`・`ca.key` でそのファイルを読む（[sentinel-config.md](sentinel-config.md)）。CA は Pod を作り直しても変わらない。
- sandbox は公開の証明書を、image を作るときではなく、起動のときに volume から足す。image は配置ごとの CA を持たず、すべての配置で 1 つにできる（[ADR-0011](adr/0011-a-full-dev-image-and-a-generic-user-home.md)）。
  - 公開の証明書（PEM、拡張子 `.crt`）だけを sandbox の `/etc/penelope/ca/` に読み取りで mount する。CA の鍵の入った Secret をそのまま sandbox に mount しない（証明書だけの ConfigMap か、Secret の `items` で証明書だけを選ぶ）。
  - image の entrypoint が、runner を動かす前に、Debian の束（image が `/usr/share/penelope/ca-certificates.crt` に写しておくもの）とその証明書をつないで、システムの束 `/etc/ssl/certs/ca-certificates.crt` に書く。この束は image でユーザー `agent` が書けるようにしてある。Pi のモデルへの最初の通信より前に入る。
  - `SSL_CERT_FILE`・`NODE_EXTRA_CA_CERTS`・`REQUESTS_CA_BUNDLE` は image でシステムの束を指す。
  - sandbox のルートのファイルシステムは書けるままにする（`readOnlyRootFilesystem` にしない）。
  - `/etc/penelope/ca/` に証明書が無ければ、束は Debian のままである。
