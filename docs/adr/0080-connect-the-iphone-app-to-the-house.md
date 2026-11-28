# 0080. iPhone アプリは家に接続し、家から通知する

- Date: 2026-11-28
- Status: Accepted

## Context

iPhone アプリの当初の設計では、アプリが配置ごとに backend にログインし、「みんな」の一覧を作るために各 backend の要約の流れを購読する。backend はそのために端末ごとの token・要約の流れ・既読・APNs の登録と送信を持つ。会話を家に集めると、部屋と 1 対 1 の正は家にあり、配置ごとの会話はなくなる。各 backend につないだままでは家の会話を読んだり、どの部屋の発言を知らせるか決めたりできない。

## Decision

### 1. アプリは家の会話を読み、家で話す

- アプリの接続先を複数の配置から一つの家へ替える。家の間取りと居場所を見て、部屋の会話を読み書きする。1 対 1 の履歴は相手の居場所にかかわらず読める。1 対 1 の発言を送れるのは相手が出かけている間だけである。発言の表情と画像は家の Web と同じ記録から表示する。アプリを閉じることは退室ではなく、ブラウザから使うときと同じ居場所を使う。個人のページを開くときはブラウザーを使い、家の認証情報を渡さない。
- 配置ごとのアプリ用 token・会話の要約の流れ・既読・APNs を backend から外す。各配置の会話を購読する一覧は作らない。失敗を見たことを示す活動の記録は残す。
- `apple/` の Xcode プロジェクトと Linux でも確かめられる Swift の Core、一本の Passive View と状態機械の構成は使い続ける。配置ごとの会話・一覧を前提にした画面と通信は残さない。TestFlight の内部テストだけに配り、PR の検証に署名の資格を渡さない方針も変えない。

### 2. 家がアプリを認証し、通知する

- アプリは家の GitHub ログインを使う。アプリ用の資格は家がオーナーの端末ごとに発行し、その家の API にだけ使う。端末を失効させても、別の端末やブラウザーの家のセッションは失効させない。GitHub の token はアプリへ渡さない。
- APNs は家から直接送る。TestFlight 版には引き続き production で送る。端末の通知登録は家のアプリ用の資格に結び付け、有効なオーナーの端末にだけ送る。対象はオーナーが読む権限を持つ会話である。通知を開いても、会話の閲覧には家の認証を要する。
- 守る対象は会話の内容、端末の登録、家のアプリの認証情報と APNs の鍵である。認証できない端末には会話も通知も渡さない。返事の本文を含む通知は、端末だけが読めるよう暗号化する。送信先や鍵が確認できないときは送らず、暗号化に失敗しても本文を平文にしない。失効した端末へ新たな通知は送らない。通知に失敗しても、家に受け付けた発言は残る。

### 本 ADR で決定しないこと

- API、端末の資格の引き換えや保存、通知先の会話の選び方、通知を押したときに会話が開けない場合の画面（委譲先: [家の仕様書](../house.md) と [iPhone アプリの実装規約](../../apple/CLAUDE.md) に従う実装）。

## Consequences

- オーナーがアプリでログインする先は家一つになる。各配置にアプリ用の認証情報や通知登録を置かなくてよい。
- 家が停止している間は iPhone も会話や通知を受け取れない。通知鍵と端末管理の責任は各 backend から家に移る。
- 配置で発行済みのアプリ用の資格や通知登録を家へ移さない。アプリが接続先を替えるときは家でログインし直す。

## Alternatives Considered

- **配置ごとの一覧に家を一つ足す**: 認証と会話の出口が二種類のまま残る。家の部屋と 1 対 1 を見せるには、配置ごとの一覧と既読は不要である。

## Related ADRs

- Supersedes（一部）: [ADR-0063 複数の配置をまとめる iPhone アプリを、一本の Passive View の木で作る](0063-native-iphone-app-with-a-passive-view-tree.md)（配置ごとの一覧、会話、接続先。Passive View と Core は残す）。
- Supersedes: [ADR-0064 iPhone の Bearer token は配置の backend が端末ごとに発行する](0064-backend-issued-bearer-tokens-for-iphone.md)、[ADR-0065 iPhone へは各 backend が本文を暗号化して APNs で知らせる](0065-encrypted-reply-notifications-over-apns.md)、[ADR-0066 一覧は配置ごとの要約の流れを読み、未読は backend が持つ](0066-agent-summary-stream-and-shared-unread.md)。
- Supersedes（一部）: [ADR-0067 iPhone アプリは CI で署名し、TestFlight の内部テストだけに配る](0067-distribute-iphone-builds-through-internal-testflight.md)（APNs の送信元のみ。TestFlight 版が production を使う点と、署名・配布の決定は変えない）。
- Related: [ADR-0074 家は居場所と会話を持つ 1 つのサーバーにし、receivers のプラグインと CLI で差し込む](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)（「本 ADR で決定しないこと」の iPhone アプリへの組み込みの委譲元）。
- Related: [ADR-0078 `reply` は今いる部屋か、出かけているときはオーナーに届ける](0078-route-replies-through-the-house.md)、[ADR-0079 会話する配置は家に住み、承認は家で答え、個人のページは家から開く](0079-open-resident-pages-from-the-house.md)。
- Related: [ADR-0082 人の居場所はブラウザの接続で変えない](0082-keep-people-in-rooms-until-they-leave.md)（人の居場所は接続先の端末や接続の開閉では変わらない）。

## References

- [UI 向けの API の仕様書](../ui-api.md) の「iPhone のログインと端末の失効」「要約の流れ（SSE）」「会話の既読」「iPhone アプリの APNs 登録」「APNs の中身」（2026-11-28 確認）。
- [家の仕様書](../house.md) の「人のログイン」「人の画面の API」と [iPhone アプリの実装規約](../../apple/CLAUDE.md)（2026-11-28 確認）。
