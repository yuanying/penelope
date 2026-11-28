# 0067. iPhone アプリは CI で署名し、TestFlight の内部テストだけに配る

- Date: 2026-11-26
- Status: Accepted（一部を ADR-0080 で置き換え）

## Context

ネイティブの iPhone アプリを実機へ届けるには、macOS の Xcode と署名が必要である。natsumi では、Xcode で実機に直接入れると開発用の署名が切れるたびに入れ直す必要があった。GitHub Actions でビルドし、TestFlight の内部テストにアップロードすることで、この負担をなくした。penelope でもその配り方を採るが、公開リポジトリの PR の検証に署名の資格は渡さない。

## Decision

### 署名して配るジョブは PR の検証と分ける

- GitHub Actions の macOS runner で署名し、App Store Connect にアップロードする。配る先は TestFlight の内部テストだけとし、外部テスト・App Store での公開は行わない。
- ワークフローは手動、main への push のうちアプリに含まれるものや配布設定が変わったとき、月 1 回の定期実行で起動する。月 1 回とするのは、TestFlight ビルドの 90 日の期限より十分短い間隔を取るためである。署名・配布のジョブを `pull_request` では起動せず、PR は配布の資格を持たないジョブで検証する。
- natsumi と同じく、archive では用意した Apple Development 証明書を使い、export ではクラウド管理の配布用証明書で署名する。毎回新しい開発用証明書を作らず、配布用の秘密鍵もリポジトリ側で持たない。

### 署名の資格は配布ジョブだけで使う

- App Store Connect の API キーを `ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`、開発用の証明書とそのパスワードを `APPLE_DEVELOPMENT_P12`・`APPLE_DEVELOPMENT_P12_PASSWORD` の Secrets から渡す。natsumi と名前をそろえる。
- 署名の鍵と証明書はジョブの一時領域と一時 Keychain だけで扱い、ログ・成果物・リポジトリには残さない。必要な資格がない、または署名に失敗したときは、代わりの資格や署名なしのビルドで配らず、ジョブを失敗にする。
- 現在の暗号の用途は HTTPS、ログインの保護、通知の復号であり、OS が提供する暗号を使い、独自の暗号や暗号ライブラリを同梱しない前提で、`ITSAppUsesNonExemptEncryption` を `NO` とする。前提が変われば申告を見直す。
- TestFlight 版の APNs は production を使う。配布用かどうかはアプリの登録に反映されるため、backend の送り先を手で切り替えない。

### 本 ADR で決定しないこと

- Xcode の版、runner イメージ、ビルド番号の付け方、監視方法（委譲先: iPhone の配布ワークフローの実装 PR）。
- 署名の資格の値や、配布先に加える個々の利用者（委譲先: リポジトリと App Store Connect を管理するオーナー）。

## Consequences

- 内部テスターは Mac に iPhone をつなぎ直さなくても新しいビルドを受け取れる。公開リポジトリの PR を検証するだけでは署名の資格に触れない。
- 開発用証明書や App Store Connect の資格は保守が必要である。定期実行が止まったときは、次のビルドが配られるよう手動実行などで補う必要がある。

## Related ADRs

- Superseded by（一部）: [ADR-0080 iPhone アプリは家に接続し、家から通知する](0080-connect-the-iphone-app-to-the-house.md)（APNs の送信元のみ。TestFlight 版が production を使う点と、署名・配布の決定は変えない）。
- Related: [ADR-0063 複数の配置をまとめる iPhone アプリを、一本の Passive View の木で作る](0063-native-iphone-app-with-a-passive-view-tree.md)、[ADR-0065 iPhone へは各 backend が本文を暗号化して APNs で知らせる](0065-encrypted-reply-notifications-over-apns.md)
- Related（natsumi）: ADR 0031「iPhone のアプリを GitHub Actions でビルドし、TestFlight で配る」

## References

- natsumi [ADR 0031「iPhone のアプリを GitHub Actions でビルドし、TestFlight で配る」](https://github.com/yuanying/natsumi/blob/main/docs/adr/0031-the-iphone-app-through-testflight.md) と [`iPhone TestFlight` ワークフロー](https://github.com/yuanying/natsumi/blob/main/.github/workflows/iphone-testflight.yml)（2026-11-26 確認）
- Apple [TestFlight](https://developer.apple.com/testflight/)、[`ITSAppUsesNonExemptEncryption`](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)（2026-11-26 確認）
