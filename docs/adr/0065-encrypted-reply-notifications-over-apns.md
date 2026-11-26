# 0065. iPhone へは各 backend が本文を暗号化して APNs で知らせる

- Date: 2026-11-26
- Status: Accepted

## Context

penelope は、オーナーへの返事を配置ごとの Web Push 購読に送る。iPhone のネイティブアプリが前面にないときにも返事を知らせ、どの配置の返事か分かるようにしたい。iOS に通知を届ける APNs（Apple Push Notification service）を使うと通知データは Apple を通るが、返事の内容は Web Push と同じく配送サービスから読めないようにする必要がある。

## Decision

### Web Push に APNs の送り先を加える

- 各配置の backend が、Web Push と並ぶ送り先として、最初の iPhone 版から APNs に直接送る。中継は置かない。APNs の送信を認証する .p8 鍵は、配置が Secret として backend に渡す。
- ADR-0027 の Decision「送り先の種類を足せる形にする」が予定した追加である。同 ADR の題の「すべて Web Push で」は、返事を選別せず Web Push の購読に知らせるという Web 向けの決定であり、APNs を排除するものではない。Web Push の通知対象・購読・暗号化の決定は置き換えない。APNs もオーナーへの返事を対象とし、失敗や承認待ちの通知は本 ADR の対象外とする。
- アプリは、ログインした配置ごとに APNs の device token と environment をその backend に登録する。backend は登録された environment で sandbox と production を選ぶ。TestFlight 版は production に登録する。iPhone のアプリ用 token の失効と通知登録を結び付け、アプリから配置を外したときも登録を消す。

### 返事の本文は端末で初めて読めるようにする

- アプリは通知のための鍵を端末で作り、ログイン時に公開鍵だけを backend に渡す。秘密鍵は端末の Keychain に残し、アプリと Notification Service Extension だけで共有する。アプリ用 Bearer token は拡張と共有しない。
- backend は natsumi と同じく、送信ごとの一時鍵と端末の公開鍵を使い、P-256 ECDH と HKDF-SHA256 で鍵を導出して、通知の内容を AES-256-GCM で暗号化する。端末では CryptoKit を使い、Notification Service Extension が復号して、エージェントの名前を題に、返事の冒頭を本文に出す。通知を押すと、その配置の会話を開く。

### 守る対象と、失敗したときの倒し方

- 守る対象は返事の内容・端末の登録・送信用の鍵である。登録を許すのはその配置にログインしたオーナーの端末だけとし、有効な登録にだけ送る。会話の内容、device token、秘密鍵はログに出さない。
- 送信鍵の設定がないか使えない場合、または宛先や端末の公開鍵を確認できない場合は、その端末への APNs 送信を行わない。暗号化に失敗しても内容を平文で送らない。拡張が復号できないときは、内容を含まない汎用通知を出す。
- APNs の送信に失敗しても、返事を失敗にしない。会話を開けば、backend に残った返事を読める。

### 本 ADR で決定しないこと

- 登録 API、payload の形式、本文の上限、送信エラーごとの扱い（委譲先: [UI 向けの API の仕様書](../ui-api.md) の「知らせ」と [backend の仕様書](../backend.md)、型は `packages/contract`）。
- .p8 の値と置き場（委譲先: 配置のリポジトリ）。

## Consequences

- 配置ごとの登録を保ちながら、一つのアプリで複数の配置から通知を受けられる。各 backend から Apple への通信が増えるが、中継の運用や障害点は増えない。
- Apple に平文の会話は渡らないが、通知があったこと、送信時刻や大きさは隠れない。端末に表示された後のロック画面での見え方は iOS の通知設定に従う。
- 配置に送信鍵の管理が、アプリに復号用の拡張と署名の設定が増える。配送は保証されず、同じ配置で Web Push も使っている場合は両方で通知を受け取ることがある。

## Related ADRs

- Related: [ADR-0027 本人への返事はすべて Web Push で知らせ、購読は配置ごとに backend が持つ](0027-every-reply-sent-by-web-push-with-subscriptions-per-deployment.md)（送り先を追加し、Web Push は変更しない）
- Related: [ADR-0064 iPhone の Bearer token は配置の backend が端末ごとに発行する](0064-backend-issued-bearer-tokens-for-iphone.md)、[ADR-0067 iPhone アプリは CI で署名し、TestFlight の内部テストだけに配る](0067-distribute-iphone-builds-through-internal-testflight.md)
- Related（natsumi）: ADR 0029「iPhone に通知を届ける」

## References

- [UI 向けの API の仕様書](../ui-api.md) の「知らせ」（2026-11-26 確認）
- natsumi [ADR 0029「iPhone に通知を届ける」](https://github.com/yuanying/natsumi/blob/main/docs/adr/0029-push-notifications-on-the-iphone.md) の Decision 項 3（本文は端末の公開鍵で暗号化し、端末で復号する）と「追記: iPhone の実装で決めた細部」（2026-11-26 確認）
- Apple [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、[`UNNotificationServiceExtension`](https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension)（2026-11-26 確認）
