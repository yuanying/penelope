# Pod の形の仕様

1 つの Pod に並ぶ 4 つのコンテナと、その UID・volume・網の向け直しを決める。sandbox の image と、配置のリポジトリの manifest は、これに合わせる。
方針は [ADR-0001](adr/0001-one-pod-with-pi-inside-the-sandbox.md)・[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)・[ADR-0003](adr/0003-all-egress-through-the-sentinel-passthrough-by-default.md)・[ADR-0004](adr/0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)・[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)・[ADR-0011](adr/0011-a-full-dev-image-and-a-generic-user-home.md)・[ADR-0013](adr/0013-event-contents-in-sources-and-summaries-in-turns.md)・[ADR-0014](adr/0014-sandbox-loopback-left-open-and-pod-ports-on-unix-sockets.md)・[ADR-0020](adr/0020-connectors-with-a-usage-document-listed-in-the-prompt.md)・[ADR-0021](adr/0021-her-own-ssh-key-in-home-for-the-vms-she-makes.md)・[ADR-0035](adr/0035-tool-usage-connectors-skills-and-avatars-in-the-image.md) にある。

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
| コネクタの文書（`/etc/penelope/connectors/`、配置が置く） | 読み取り | — | — | — |
| アバターの置き場（任意。`PENELOPE_AVATARS_DIR` に置く。下の「姿の素材」） | 読み取り | 読み取り | — | — |

- Pi のディレクトリ（設定・認証・モデル・skill）とセッションの記録は HOME の下に置く（`/home/agent/.pi/agent/`、セッションは `/home/agent/.pi/agent/sessions/main/`、サブエージェントの記録とセッションは `/home/agent/.pi/agent/sessions/agents/`）。別の volume にはしない。HOME が永続なので足りる。
- skill は `<名前>/SKILL.md` の並びで、runner は 3 か所から読む。同じ名前が 2 か所以上にあれば、この表の上の方が一覧に載る（[ADR-0035](adr/0035-tool-usage-connectors-skills-and-avatars-in-the-image.md)）。

| 順 | 置き場所 | 持ち主 |
| --- | --- | --- |
| 1 | `PENELOPE_OWNER_SKILLS_DIR` が指す場所（オーナーの skill。読み取りで mount するので、エージェントは書き換えられない。設定が無いか、場所が無ければ無い） | 配置 |
| 2 | 記憶の `skills/` | エージェント |
| 3 | `/opt/penelope/skills/`（sandbox の image の中。リポジトリの `packages/runner/image/skills/`。`self-portrait`・`goals`） | このリポジトリ |

- コネクタの文書は `<名前>.md` の並びで、runner は sandbox の image の中の `/opt/penelope/connectors/` と、`PENELOPE_CONNECTORS_DIR` が指す場所から読み、名前で突き合わせた一覧をシステムプロンプトに出す（[sentinel-config.md](sentinel-config.md) の「コネクタの文書」）。配置の文書は読み取りで mount する。設定が無いか、場所が無ければ、配置の文書は無い。
- 自分で作った VM への ssh の鍵は、エージェントが HOME に自分で作る（[ADR-0021](adr/0021-her-own-ssh-key-in-home-for-the-vms-she-makes.md)）。配置は ssh の鍵も ssh-agent も置かない。ssh の接続は、ほかの外向きと同じく Sentinel へ向け直され、既定の扱いに従う。
- `/memory` の `.git` は sandbox からは読むだけである。backend がターンの終わりにコミットする（[ADR-0006](adr/0006-memory-kept-compatible-without-checks-committed-outside.md)）。
- `/sources` を書くのは backend だけ（[events.md](events.md)）。receivers は mount しない。
- 取り込み口の socket は sandbox に mount しない。送れるのは socket が見えるコンテナだけである（[ADR-0002](adr/0002-one-intake-and-a-runner-that-pulls-events.md)）。
- 管理口の socket も sandbox に mount しない（[ADR-0005](adr/0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)）。
- backend の sandbox 向けの口の socket は、backend と Sentinel だけが mount する。Sentinel は backend の登録の `upstream` でこの socket につなぐ（[sentinel-config.md](sentinel-config.md) の「上流」）。
- コンテナの UID が違うので、配置は Pod の `fsGroup` で、共有する volume を 1 つのグループに置く。backend は sandbox が書いた `/memory` の作業ツリーを読み、`/memory/.git`・SQLite・`/sources` を書く。sandbox は `/sources` を読む。socket は backend が誰でも書ける mode で作るので、見えるかどうかは mount だけで決まる。

## 姿の素材

エージェントが自分の入る絵を描くときの姿は、アバターのディレクトリに、顔のアイコン（[backend.md](backend.md) の「設定」）と並べて置く（[ADR-0035](adr/0035-tool-usage-connectors-skills-and-avatars-in-the-image.md)）。

| ファイル | 中身 |
| --- | --- |
| `appearance.yaml` | 絵に描くときの姿。欄と使い方は image の skill `self-portrait` が書く |
| `sdctl-params.yaml` | その姿を描く `sdctl` の既定の params |

- sandbox の image には、backend の image と同じく、リポジトリの `assets/avatars/` が入っている（`/opt/penelope/avatars/`）。
- sandbox も backend と同じ名前の設定でアバターを選ぶ。`PENELOPE_AVATAR` がアバターの名前、`PENELOPE_AVATARS_DIR` が置き場所（sandbox の既定は `/opt/penelope/avatars`）。backend と sandbox に同じ値を渡す。
- このリポジトリに無いアバターを使う配置は、自分のアバターの置き場を 1 つ、backend と sandbox の両方に読み取りで mount し、両方の `PENELOPE_AVATARS_DIR` をそこにする。顔のアイコンも姿の素材も、そこから取られる。
- runner は、起動のときに姿のディレクトリを決め、シェルとその子に環境変数で伝える。
  - `/etc/penelope/avatar/appearance.yaml` があれば `/etc/penelope/avatar/`。前の形の配置が姿の素材を写して置く場所で、選んだアバターより先に使う。前の形の配置がアバターの置き場から姿を取るようになったら、読むのをやめてよい。
  - 無ければ、`PENELOPE_AVATARS_DIR` の下の `PENELOPE_AVATAR` の名前のディレクトリ。
  - 決まったディレクトリがあれば `PENELOPE_AVATAR_DIR` にする。どちらも無ければ設定しない（決まった姿は無い）。
  - 配置が `SDCTL_PARAMS` を設定していなければ（空の値は設定したものとして扱う）、そのディレクトリの `sdctl-params.yaml` を `SDCTL_PARAMS` にする。

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
