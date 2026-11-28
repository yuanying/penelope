# 0064. iPhone の Bearer token は配置の backend が端末ごとに発行する

- Date: 2026-11-26
- Status: Superseded by ADR-0080

## Context

Web UI では、各配置の backend が GitHub OAuth でオーナーを確認し、ブラウザのセッション cookie で UI 向けの API を認証する。iPhone アプリは複数の配置に接続し、Web の cookie とは別に API を呼ぶ資格が必要になる。GitHub のアカウントがオーナーであることの確認は再利用できるが、端末の持つ資格は、その配置の API だけに使え、紛失した端末だけを失効させられるものにしたい。

## Decision

### GitHub ログインを backend の token に引き換える

- iPhone アプリは `ASWebAuthenticationSession` で、追加しようとしている配置の backend の GitHub ログインを開く。Web と同じ OAuth App とオーナーの判定を使う。これは ADR-0010 の Decision 項 1（オーナーは GitHub OAuth）が委ねた、iPhone 向け token の発行の決定である。Web の cookie と A2A の認証は変えない。
- ログインが済むと backend は短命で一度きりの code をアプリに返す。アプリは元の配置の backend で code を長く使えるアプリ用の Bearer token に引き換え、配置ごとに 1 つ、Keychain に保存する。
- backend は token を端末ごとに記録する。Web の設定から端末を指定して失効できる。アプリで配置を外すときも、その端末の token を失効させて通知登録を消し、端末から token を削除する。Web のセッションや別端末の token は失効させない。

### 守る対象と、失敗したときの倒し方

- 守る対象はオーナー向けの API とその認証情報である。GitHub の token は端末に渡さない。アプリ用の token は発行した配置の HTTPS の UI 向け API にだけ使い、他の配置・GitHub・Safari には渡さない。
- オーナーを確認できないときは発行しない。code の引き換えはログインを始めたアプリの要求に結び付け、対応しない code・期限切れ・再利用は断る。token がない、無効、失効済み、または有効性を確認できないときは API を許可しない。
- 配置を外す際に backend での失効を確認できなければ、端末側からは資格を削除するが、サーバー側も失効したとは扱わない。失効を確認できなかったことを示し、Web の設定から失効できるようにする。

### 本 ADR で決定しないこと

- code の引き換えの検証方式、API のパスと欄、token の寿命と保存形式（委譲先: [UI 向けの API の仕様書](../ui-api.md) の「認証」、型は `packages/contract`、保存は [backend の仕様書](../backend.md)）。
- 通知の鍵と送信先（委譲先: ADR-0065）。

## Consequences

- GitHub の認証情報はアプリに不要である。iPhone の紛失時も、オーナーは他の端末や Web のログインを維持したまま、その端末の資格だけを取り消せる。
- backend は Web のセッションとは別に端末の資格を管理する。配置を追加するたびに、その配置でログインが必要になる。

## Alternatives Considered

- **GitHub の token をアプリが持つ**: アプリに必要なのは penelope のオーナー向け API を呼ぶ権限だけである。GitHub でも使える資格を端末に置く必要はない。

## Related ADRs

- Superseded by: [ADR-0080 iPhone アプリは家に接続し、家から通知する](0080-connect-the-iphone-app-to-the-house.md)。
- Related: [ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる](0010-github-oauth-for-people-tokenreview-for-a2a.md)（iPhone 向け token の発行の委譲元）
- Related: [ADR-0063 複数の配置をまとめる iPhone アプリを、一本の Passive View の木で作る](0063-native-iphone-app-with-a-passive-view-tree.md)、[ADR-0065 iPhone へは各 backend が本文を暗号化して APNs で知らせる](0065-encrypted-reply-notifications-over-apns.md)

## References

- [UI 向けの API の仕様書](../ui-api.md) の「認証」（2026-11-26 確認）
- Apple [`ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)（2026-11-26 確認）
