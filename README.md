# penelope

A coding agent with one long-lived session, a sandbox and a sentinel at its egress

penelope は、1 人のオーナーのために 1 本の長いセッションで動き続ける Coding Agent です。
[Pi Coding Agent](https://github.com/earendil-works/pi) を基本のツールごと sandbox の中で動かし、開発の道具を最初から持たせます。
sandbox から外へ出る通信は、返事も含めてすべて Sentinel を通ります。Sentinel は通信を記録し、選んだホストでは sandbox が持つ代わりの値を本物の鍵に差し替えます。
出来事（オーナーの発言、Slack、webhook、予約した時刻、ほかのエージェントからの頼み）は backend の 1 つの取り込み口に集まり、記憶は git の Markdown として育ちます。

設計の判断は [docs/adr/](docs/adr/README.md) にあります。

## 動かす

各配置の image は ghcr.io にあります（`ghcr.io/yuanying/penelope-{sentinel,backend,sandbox,receivers}`）。
複数の配置がつながる[家のサーバー](docs/house.md)は `ghcr.io/yuanying/penelope-house` です。
Kubernetes で動かす kustomize の見本は [deploy/kubernetes/](deploy/kubernetes/README.md) にあります。
natsumi のインスタンスから移す手順は [docs/migrate-from-natsumi.md](docs/migrate-from-natsumi.md) にあります。

## 開発

入口は `Makefile` です。ターゲットの一覧は `make help` で出ます。

```sh
make help
make test     # Go と TypeScript の単体テスト（それぞれのツールチェーンだけで通る）
make images   # Dockerfile の target ごとの image
```

Go（Sentinel）と Node（ほかの部品）の版は、`go.mod` と `.github/workflows/ci.yml` の `setup-node` にあります。
リポジトリの形とテストの層は [AGENTS.md](AGENTS.md) にあります。
iPhone のアプリは [apple/](apple/) にあります（Xcode のプロジェクトと、Foundation だけに依存する Core の Swift Package）。作り方の規約は [apple/CLAUDE.md](apple/CLAUDE.md) にあります。
