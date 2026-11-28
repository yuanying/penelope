# 0063. 複数の配置をまとめる iPhone アプリを、一本の Passive View の木で作る

- Date: 2026-11-26
- Status: Accepted（一部を ADR-0080 で置き換え）

## Context

penelope の Web UI は配置ごとに別の URL とログインを持つ。複数のエージェントの状態や未読を確かめるには、そのつど Web を開き分ける必要がある。一覧は新しく必要だが、1 人と話すときの操作はオーナーが使い慣れたスマートフォンの Web UI とそろえたい。

natsumi の Mac アプリでは、共有モデルをどの View も直接参照していたため、描画に必要な情報と、接続や画面遷移の判断が混ざり、画面を開かずに操作をテストできなかった。natsumi はこれを一本の木と純粋な状態機械に分け、iPhone にも同じ方針を適用した。penelope でも両 OS でこの方針をそろえる。natsumi の画面や通信プロトコルは移植しない。

## Decision

### 配置ごとの Web UI の上に「みんな」を置く

- ネイティブアプリの表示名は「Penelope」、bundle ID は `io.github.yuanying.penelope.phone` とする。最初の対象は縦向きの iPhone。
- 通常の起動先は「みんな」。登録した配置は利用者が決めた順に並べ、1 行にアバター・名前、状態、最後の発言と時刻、未読とまだ見ていない失敗の数を出す。つながらない配置があっても一覧は出し、その行だけ接続切れを示す。
- アプリ自身の設定から URL を入力して配置を足し、並べ替え・削除もできる。配置の数を固定せず、URL・名前・アバターをアプリに組み込まない。名前とアバターは各 backend から取る。通信には penelope の UI 向け API を使い、natsumi の v1 の封筒とは互換を取らない。
- 1 人を開くと、スマートフォンの Web UI と同じ会話を出す。左上のメニューで場所を選び、浮いているアバターまたは入力欄上の状態の帯から「いまのエージェント」のシートを開く。シートにはアバター・承認待ち・サブエージェント・今の様子を出す。メニューの先頭の「みんな」、または左端から右へのスワイプで一覧に戻る。「みんな」には他の配置の未読の合計を出し、メニューボタンでは今の配置のまだ見ていない失敗を優先して示す。承認待ちを持つのは引き続き Sentinel であり、シートでのオーナーの答えは ADR-0005 の Decision「承認待ちの持ち主と答える場所」と同じく、エージェントの入力を通さず backend 経由で Sentinel に返す。
- 最初の版では、一覧・会話・シート・画像の送受信・通知をアプリ内で扱う。画像は Web と同じ backend の写しを使う。会話以外の場所（活動の記録・記憶・出来事・設定）は、同じ配置の Web の該当ページを Safari で開き、Web のログインを使う。これらは各場所をネイティブ化したときにアプリ内へ移す。アプリ自身の設定とは別である。

### UI の判断を View から分ける

- 画面のコンポーネントは Root を根とする一本の木に属する。Passive View が受け取るのは描画用の値（Props）とイベントを出す口だけで、ドメインの状態や次の動作を決める責任は持たない。
- 操作は起点のコンポーネントから親へ伝わり（Chain of Responsibility）、Root が Mediator に渡す。サーバーの出来事も Root から同じ入口へ入れ、順に裁定する。
- Mediator は `(State, Event) -> (State, [Effect])` の純粋な状態機械とする。Props は状態から純粋に導出する。通信や保存といった副作用（Effect）を実行するのは Root だけで、結果はイベントとして戻す。画面が増えても判断の入口を増やさず、描画や I/O なしで振る舞いを確かめられるようにする。
- `apple/` に Xcode プロジェクトと Core の Swift Package を置く。Core は Foundation だけに依存し、Mediator・Props の導出・API と認証の共通ロジックを持つ。UIKit・SwiftUI や Keychain など OS 固有の操作はアプリ側に置く。Mac の画面は今回作らないが、後で共通部分を使って画面を足せるようにする。
- 検証は二段に分ける。Core の振る舞いは Linux の `swift test` で検証できるようにし、アプリのビルド・UI テスト・iOS 固有の検証は CI の macOS で行う。

### 本 ADR で決定しないこと

- UI の具体的な実装規約（委譲先: natsumi の規約をもとに実装側で置く `apple/CLAUDE.md`）と、画面の寸法や見た目の細部（委譲先: Web UI のデザインの手引きと iPhone の画面実装の PR）。
- Mac の画面、iPad・横向き対応、ウィジェット（委譲先: それぞれのアプリ実装を扱う PR）。
- 通知から（ロック画面の操作で）許す・断るか（委譲先: 通知からの承認を検討するときの ADR）。

## Consequences

- 配置ごとの認証と状態を分けたまま、オーナーは 1 画面で全員の様子を見られる。接続先をアプリに組み込まないため、同じビルドで別の配置も使える。
- 新しい操作にはイベント・裁定・Props・Effect の境界を明示する手間がかかる。代わりにプラットフォーム固有の UI を起動せずに判断を検証できる。
- backend と同じリポジトリに置くので、API を変えるときにアプリの追従も同じ PR で扱える。一方、アプリのビルドと OS 固有の検証には macOS が要る。

## Related ADRs

- Superseded by（一部）: [ADR-0080 iPhone アプリは家に接続し、家から通知する](0080-connect-the-iphone-app-to-the-house.md)（配置ごとの一覧、会話、接続先。Passive View と Core は残す）。
- Related: [ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る](0009-web-ui-first-with-a-new-api-and-astryx.md)
- Related: [ADR-0005 承認待ちは Sentinel が持ち、オーナーは Web UI で答える](0005-approvals-held-by-the-sentinel-answered-in-the-web-ui.md)
- Related: [ADR-0016 最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる](0016-show-the-avatar-and-expression-from-the-first-web-ui.md)
- Related: [ADR-0032 返事に sandbox の画像を添え、backend が写して Web UI で見せる](0032-images-attached-to-a-reply-copied-by-the-backend.md) と [ADR-0034 オーナーが送った画像も backend が写し、会話の履歴の行に結び付ける](0034-images-the-owner-sends-copied-by-the-backend.md)
- Related: [ADR-0078 `reply` は今いる部屋か、出かけているときはオーナーに届ける](0078-route-replies-through-the-house.md)（家の発言の画像と表情）。
- Related: [ADR-0064 iPhone の Bearer token は配置の backend が端末ごとに発行する](0064-backend-issued-bearer-tokens-for-iphone.md)、[ADR-0065 iPhone へは各 backend が本文を暗号化して APNs で知らせる](0065-encrypted-reply-notifications-over-apns.md)、[ADR-0066 一覧は配置ごとの要約の流れを読み、未読は backend が持つ](0066-agent-summary-stream-and-shared-unread.md)
- Related（natsumi）: ADR 0015「Mac の UI は、一本の木の Passive View にする」、ADR 0028「iPhone のクライアント」

## References

- [Web UI デザインの手引き](../design/README.md) の「スマートフォン」と「会話の返事の決め直し」、[UI 向けの API の仕様書](../ui-api.md) の「エージェント」「画像」（2026-11-26 確認）
- natsumi [ADR 0015「Mac の UI は、一本の木の Passive View にする」](https://github.com/yuanying/natsumi/blob/main/docs/adr/0015-mac-ui-passive-view-tree.md) と [ADR 0028「iPhone のクライアント」](https://github.com/yuanying/natsumi/blob/main/docs/adr/0028-the-iphone-client.md)（2026-11-26 確認）
- natsumi [`mac/CLAUDE.md`「Mac アプリ（GUI）の作り方」](https://github.com/yuanying/natsumi/blob/main/mac/CLAUDE.md)（2026-11-26 確認）
