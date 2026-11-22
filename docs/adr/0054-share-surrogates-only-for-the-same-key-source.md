# 0054. 同じ出どころの鍵に限り、複数の登録でサロゲートを共有できる

- Date: 2026-11-22
- Status: Accepted

## Context

Sentinel は、sandbox に置いたサロゲートを、登録されたホストと置き場所でだけ本物の鍵に差し替える。これまでは、同じサロゲートを複数の登録に書くと、鍵の出どころが同じでも設定を拒んでいた。

GitHub の API と git の HTTPS は、同じ本物の鍵を使うが、ホストと置き場所が違う。`gh repo create --push` は GitHub の API を呼んでから git を起動し、そのとき git の資格情報ヘルパーを自身のものに切り替える。このヘルパーは API 用と同じサロゲートを git に返す。git はそれを `github.com` 向けの Basic のパスワードに入れるため、API 用と git 用を別のサロゲートで登録した配置では、リポジトリを作れても push は Sentinel に拒まれた。リリースのファイルを送る場合も、API とは別のホストへの登録が必要である。

## Decision

- 同じサロゲートを複数の鍵の登録に書いてよいのは、鍵の出どころが同じときだけとする。出どころが異なれば起動せず、動作中の読み直しなら前の設定を使い続ける。
- 守る対象は本物の鍵である。差し替えには、その要求に当たったホストの登録だけを使い、その登録に書いた置き場所でだけ差し替える。サロゲートの共有によって、他のホストや置き場所が暗黙に許されることはない。完全な名前の登録が勝つときも、ワイルドカードの登録から鍵や置き場所を引き継がない。
- 読める要求に差し替えられないサロゲートが残れば、これまでどおり上流へ送らずに断る。差し替えのための鍵を読めないときも断る。素通しの TLS は開かず、本物の鍵を加えない。

### 本 ADR で決定しないこと

- 各配置でどのホストにどの鍵を登録するか（委譲先: 配置のリポジトリ。GitHub での登録の使い分けは References の GitHub スキルを参照）

## Consequences

- 一つのサロゲートしか渡せないクライアントでも、明示的に登録した複数のホストや認証方式で同じ鍵を使える。共有によって別の本物の鍵に手が届くことはない。
- 登録を増やした分だけ同じ鍵が届く宛先は増える。配置は、その鍵を受け取ってよい宛先だけを登録する責任を引き続き持つ。

## Related ADRs

- Supersedes（一部）: [ADR-0025 Sentinel のホストの登録に、左端の 1 ラベルだけのワイルドカードを書ける](0025-wildcard-host-registrations-for-one-left-most-label.md) の Decision 項 4（サロゲートは登録ごとに 1 つで、当たるすべての名前で使える）のうち、複数の登録で同じサロゲートを使えないという制約だけを置き換える。Decision 項 2（完全な名前の登録が、ワイルドカードの登録に勝つ）と、勝った登録だけで差し替える規則は変えない。
- Related: [ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする](0004-the-sentinel-keeps-the-keys-through-a-replaceable-source.md)

## References

- [Sentinel の設定と記録の仕様書](../sentinel-config.md#鍵の差し替え) の「鍵の差し替え」、`internal/config/config.go` の `parseHost`、`internal/credentials/credentials.go` の `Swap`、`cmd/sentinel/serve.go` の `reloader.check`（2026-11-22 確認）
- GitHub CLI v2.104.0 の [`createFromLocal`](https://github.com/cli/cli/blob/v2.104.0/pkg/cmd/repo/create/create.go)、[`AuthenticatedCommand` と `Push`](https://github.com/cli/cli/blob/v2.104.0/git/client.go)、[`helperRun`](https://github.com/cli/cli/blob/v2.104.0/pkg/cmd/auth/gitcredential/helper.go)、go-gh v2.17.0 の [`tokenForHost`](https://github.com/cli/go-gh/blob/v2.17.0/pkg/auth/auth.go)（2026-11-22 確認）
- [GitHub REST API「Upload a release asset」](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)（2026-11-22 確認）: ファイルを送る宛先は `uploads.github.com`。
- [GitHub スキル](../../packages/runner/image/skills/github/SKILL.md)
