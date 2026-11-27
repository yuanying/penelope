# iPhone のアプリ（`apple/`）の作り方

> すべてのコンポーネントを Root からなる階層構造下に置き、各コンポーネントは MVP パターンの
> Passive View として描画に関わるパラメータだけを操作し、動作は Chain of Responsibility で
> イベントをバブリングさせて、ステートマシンとして振る舞う Mediator に裁定させること。

この一文がこのディレクトリの規約である。以下はそれを、判断に使える形に開いたものである。
この構造の理由と、アプリが何を出すかは [ADR-0063](../docs/adr/0063-native-iphone-app-with-a-passive-view-tree.md) にある。
画面の寸法・文言・色は [デザインの手引き](../docs/design/README.md) の 18 章（1 人の画面は 4・5・16 章）にある。

画面は、みんな（一覧）・1 人の画面・メニュー・シート・エージェントを足す・アプリの設定である。
いまあるのは、みんなの骨組みだけである。足すときは下の規約に従い、「ファイルの置きどころ」の表を一緒に直す。

## 1. Root からなる階層構造

- 画面に出るものはすべて `Component`（`TreeComponent<AppEvent>`）として木に属し、根は `RootComponent` ひとつである。
  親が子を作り、子は親を弱く持つ。`adopt` で親子にし、木の形は生涯変わらない。
- 画面（みんな・1 人の画面・足す・アプリの設定）は Root の直下の子にする。メニューとシートは 1 人の画面の子にする。
  画面の中でイベントを出す部分（見出しの釦、一覧の行、入力欄など）は、さらにその子にする。
  イベントがどこから出たかを、木の上の場所で言えるようにするためである。
- **木の外から個々のコンポーネントを掴まない。** アプリが持ってよいのは Root だけで、`AppDelegate` もそれしか持たない。
  画面を足すときは、Root の子として作り、Root から描画パラメータを渡す。
- SwiftUI へは `ScreenModel` で渡す。これは Root が書き View が読む受け渡しの箱であり、状態ではない。

## 2. Passive View（MVP）

- View が受け取るのは、**自分の描画パラメータ（Props）と、イベントを出す口（`EventSink`）だけ**である。
- **View にドメインの型を渡さない。** `AppState`・`SavedAgent` や、API の答えの型を View の引数にしない。
  件数・本文・時刻の書き方・有効かどうかまで、すべて Props にして渡す。
- View の中の分岐は「この値をどう描くか」に限る。「次に何が起きるべきか」を決めない。
  状態で変わる釦は、文言と出すイベントを Props（`ActionProps`）に入れ、View はそれを描いて投げるだけにする。
- 状態に依らない固定の見出し（「みんな」など）とアクセシビリティの名前は View に置いてよい。
  **状態で変わる文言は Props に入れる。**
- Props に固定の大きさ（px）を入れない。文字は Dynamic Type に従わせる。
- View は状態を持たない。SwiftUI の `@State` は、描画に閉じたものに限り、理由をコメントに書く
  （入力メソッドの変換中の下書きのように、OS の側にあるべきもの）。
- Props は値型で `Equatable` にし、**`AppProps` の純粋関数だけが作る。** 導出は `PenelopeCore` に置き、テストする。
  Root は Props が変わったときだけ描き直す。

## 3. Chain of Responsibility

- 利用者の操作は `AppEvent` として、**それが起きたコンポーネントから** `dispatch` する（View はそのコンポーネントの `sink` に投げる）。
- コンポーネントが処理しなければ、そのまま親へ渡る。Root まで上がったものは Mediator へ渡る。
- **途中で握りつぶしてよいのは、自分の描画パラメータだけで完結するものに限る。** 既定は「握りつぶさない」。
  `handle` の既定は `false` であり、いまこれを `true` にしているのは Root だけである。
  握りつぶす箇所を作るなら、理由をコメントに書く。
- 外から来る出来事（backend の答え、要約の流れ、ログインの結果、保存したものの読み出し、通知、アプリが前に出た・裏に回った）も、
  同じ `AppEvent` の形で Root から Mediator へ入れる。**入口を 2 本にしない。**
- イベントは 1 件ずつ順に裁定する。Effect が次のイベントを生むので、Root は入れ子にせずに待ち行列に積み、最後に 1 回だけ描く。

## 4. ステートマシンとしての Mediator

- `AppMediator.reduce` は `(State, Event) -> (State, [Effect])` の純粋な関数である。
  **UIKit・SwiftUI・ネットワーク・`UserDefaults`・Keychain・`Bundle`・今の時刻に依存しない。** `PenelopeCore` に置く。
- `AppState` から Props を導出する。**`AppProps` の外で Props を作らない。**
- `AppEffect` は外の世界への指示である。**実行するのは Root だけ**であり、Mediator は実行しない。
  結果が要るものは、Root がイベントにして返す（`.loadAgents` には `.agentsLoaded`）。Effect を足すときは、返るイベントを Effect の説明に書く。
- 今の時刻・暦・乱数（ID）は Root がイベントに入れて渡すか、生成器を差し込む形にする。Mediator の中で `Date()` や `UUID()` を呼ばない。
- 見せ方（アニメーション、シートの出し入れの動き）は Root と View が持つ。Mediator が決めるのは「何が出ているか」だけである。

## `PenelopeCore` は Foundation だけ

`PenelopeCore` が import してよいのは Foundation だけである（UIKit・SwiftUI・Security・AuthenticationServices・CryptoKit を import しない）。
CI が Linux で `swift test` を回すので、破るとそこで落ちる。OS に触る部分はアプリの側のアダプタに置き、Core には
値と、その読み書きの形（組み立てる・読む）だけを置く。

## ファイルの置きどころ

| 置き場所 | 中身 |
|---|---|
| `PenelopeCore/Sources/PenelopeCore/Tree/` | `TreeComponent<Event>`（木とバブリング）、`EventSinkOf<Event>`、iPhone の別名 `Component`・`EventSink` |
| `PenelopeCore/Sources/PenelopeCore/App/` | `AppEvent`・`AppEffect`・`AppState`・`AppMediator`（裁定）・`AppProps`（Props の型と導出） |
| `PenelopeCore/Tests/PenelopeCoreTests/` | Mediator・Props の導出・木の伝播のテスト |
| `PenelopePhone/PenelopeApp.swift` | アプリの入口と、Root を持つ `AppDelegate` |
| `PenelopePhone/Components/` | Root（`RootComponent`）と各画面のコンポーネント、受け渡しの箱（`ScreenModel`） |
| `PenelopePhone/Views/` | SwiftUI の Passive View |
| `Penelope.xcodeproj` | アプリのターゲット `PenelopePhone`。`PenelopePhone/` はフォルダごと入るので、ファイルを足してもプロジェクトは変わらない |

名前の付け方は、画面のコンポーネントが `<名前>Component`、その View が `<名前>View`、その描画パラメータが `<名前>Props` である。
子のコンポーネントの名前は `"everyone.header"` のように親から辿れる形にする。
木はイベントの型について汎用なので、Mac の画面を作るときは、同じ Core の上に自分の Event・State・Mediator・Props を持たせる。

## やってはいけない形

- View がドメインの型（`AppState`・`SavedAgent`・API の答えなど）を受け取る。
- View が分岐で動作を決める（「未読があれば既読にする、なければ開く」を View で書く）。
- コンポーネントを木の外から掴む。Root 以外を `AppDelegate` やアダプタが持つ。
- `AppProps` の外で Props を作る。View の中で件数や文言を組み立てる。
- Mediator に I/O を持たせる。`URLSession`・`UserDefaults`・Keychain・`Bundle`・`Date()` を触る。
- 外の出来事を Root を通さずに Mediator へ入れる。入口を増やす。
- URL・名前・アバター・チーム ID をコードやプロジェクトに書く（接続先はアプリの設定から足し、署名のチームは各自が選ぶ）。

## build とテスト

リポジトリの根の `Makefile` が入口である。

```sh
make apple-test    # PenelopeCore の swift test（Linux でも macOS でも）
make apple-build   # iPhone のアプリを simulator 向けに署名なしで build（Xcode の入った macOS）
```

- Mediator・Props の導出・木の伝播は、**すべて `PenelopeCoreTests` でテストする。** UI なしで確かめられることが、
  この構造を選んだ理由のひとつである。
- テストは先に書く。期待する入出力を書き、失敗を見てから実装する。実装に合わせてテストを書き換えない。
- 実機に入れるときは、Xcode で各自のチームを選ぶ。選んだチームをコミットしない。
