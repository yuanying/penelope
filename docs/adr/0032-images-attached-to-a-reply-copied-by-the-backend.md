# 0032. 返事に sandbox の画像を添え、backend が写して Web UI で見せる

- Date: 2026-11-16
- Status: Accepted（一部を ADR-0078 で置き換え）

## Context

エージェントの返事（`reply`）は文だけである（sandbox 向けの口の「返事」）。オーナーに画像を見せる道が無い。natsumi のなつみは、Stable Diffusion の WebUI を sdctl で使って絵を描き（natsumi ADR 0044）、返事に画像を添えてオーナーに見せていた（natsumi ADR 0045）。なつみを penelope に移すと（ADR-0026）、これが無くなる。

前提になる事実は次のとおりである。

- エージェントの作業の場所は HOME で、永続する（ADR-0011）。sandbox で作った画像は HOME にある。
- 返事は sandbox から Sentinel を通って backend の sandbox 向けの口に届く（ADR-0002、ADR-0003）。sandbox の外の backend は、sandbox の HOME を読めない（[Pod の形の仕様書](../pod.md) の「volume」）。
- `/sources` は、届いた出来事の中身の置き場で、backend だけが書き、追記するだけである（ADR-0013）。
- natsumi は、画像を返事のツールを呼んだ時点でサーバーに写し、会話の行に結び付けていた。本人が見るのは写しで、元のファイルが後で書き換わっても変わらない。種類（PNG・JPEG・WebP、中身で見分ける）・大きさ（1 枚 10 MB）・枚数（1 回 4 枚）を確かめ、合わなければ返事ごと送らなかった。
- Stable Diffusion の WebUI は sandbox の外のサービスで、鍵が要る。鍵は Sentinel が差し替える（ADR-0004）。
- オーナーは、後でエージェントたちが作った画像などを一覧で扱う画面を Web UI に作りたいと考えている。

## Decision

適用範囲は、エージェントの本体が `reply` でオーナーに画像を見せることである。A2A の Task への返事（ADR-0018）、Slack への投稿は扱わない。

### 1. `reply` は sandbox の画像の場所を添えられる

- `reply` は、文に加えて、sandbox の中の画像のファイルの場所をいくつか添えられる。
- runner はそのファイルを読み、返事と一緒に sandbox 向けの口へ送る。backend は sandbox のファイルを読まない。

### 2. backend は呼んだ時点で写し、写しを返事に結び付ける

- backend は、受けた画像を自分の永続する場所に写し、返事に結び付ける。オーナーが見るのは写しで、sandbox のファイルが後で変わっても変わらない。
- 写しの置き場は、`/sources`（届いた出来事の中身）とも `/memory` とも分け、エージェントが作ったものの置き場とする。1 つの写しは ID・種類・大きさ・作った時刻・結び付いた返事を持つ。後で、作ったものの一覧を Web UI に出せる形にする。
- 写しは消さない。会話の履歴と同じく、いつまで残すかは量が問題になったときに決める。

### 3. 確かめて、合わなければ返事ごと断る

- 画像の種類は中身で見分け、Web UI がそのまま出せる画像の種類に限る。1 枚の大きさと 1 回の枚数に上限を置く。
- 種類・大きさ・枚数のどれかが合わない、ファイルが読めないときは、文も送らずに、`reply` の結果で理由を返す。画像の欠けた返事が半端に届かないようにするためである。

### 4. Web UI で見せる

- 返事の履歴と流れに、結び付いた画像の一覧を載せる。画像そのものは、ログインした UI 向けの API の口で ID から取る。
- 同じ ID の画像は変わらないので、UI は一度取ったものを使い回せる。
- 返事の知らせ（ADR-0027）には画像を載せず、画像の数を添える。

### 5. 絵を描く道具は、sandbox の image と Sentinel の登録

- sandbox の image に sdctl を入れる（ADR-0011 の Decision「最初から持つ道具」に足す）。
- Stable Diffusion の WebUI のホストは、配置が Sentinel に登録し、鍵を差し替える。使い方はコネクタの文書に書く（ADR-0020）。描くかどうかはエージェントに任せ、プロンプトには書かない（ADR-0008）。

### 守る対象と、失敗したときの倒し方

- 守る対象は、オーナーに見せる画像と、backend の永続する場所である。
- 写しを取れるのは `reply` の呼び出し（sandbox 向けの口の token を持つ sandbox）だけであり、見られるのはオーナーのログインのセッションだけである（ADR-0010）。
- 確かめに通らないものは写さず、返事も届けない側に倒す。
- 写しに失敗したとき（永続する場所が埋まっているなど）も、返事ごと失敗として `reply` に返す。

### 本 ADR で決定しないこと

- `reply` の引数と sandbox 向けの口の形、画像を取る UI 向けの API の口、履歴と流れの欄、種類・大きさ・枚数の上限の値、写しの置き場所（委譲先: [sandbox 向けの口の仕様書](../sandbox-api.md) の「返事」、[UI 向けの API の仕様書](../ui-api.md)、[backend の仕様書](../backend.md)。返事に画像を添える作業単位で足す）
- Web UI での見せ方（縮小、拡大）（委譲先: Web UI の実装の PR と `docs/design/`）
- 作ったものの一覧の画面（委譲先: その画面を作るときの ADR か UI 向けの API の仕様書）
- sdctl の版（委譲先: sandbox の image の Dockerfile と Renovate の設定）
- Stable Diffusion の WebUI のホスト名と鍵の名前・置き場（委譲先: 配置のリポジトリ）

## Consequences

- エージェントが描いた絵や、作業で作った図を、オーナーに返事と一緒に見せられる。なつみの絵を描く仕事が、penelope でも続けられる。
- 写しを返事に結び付けるので、オーナーが後で見ても、返したときの画像が出る。
- 作ったものの置き場が backend に 1 つできるので、後で一覧の画面を足すときに、置き場を作り直さずに済む。
- 一方で、写しは消さないので、backend の永続する場所が画像の分だけ伸びる。
- 画像は sandbox から Sentinel を通って backend に届くので、返事の要求が大きくなり、Sentinel の記録も大きくなる。
- 合わない画像があると返事ごと届かないので、エージェントは結果を見て直して返し直すことになる。

## Alternatives Considered

- **画像を `/sources` に置く**: `/sources` は届いた出来事の中身の置き場で（ADR-0013）、エージェントが作ったものが混ざる。一覧を作るときに、届いたものと作ったものを分け直すことになる。
- **backend が sandbox の HOME を読みに行く**: backend に sandbox の HOME を mount することになり、sandbox の中のファイルの持ち主の境目が崩れる。写しでなく元を見せるので、後で書き換わると返したときの画像が失われる。
- **合わない画像だけを落として、文は届ける**: オーナーには、画像が欠けたことが分からない。

## Related ADRs

- Superseded by（一部）: [ADR-0078 `reply` は今いる部屋か、出かけているときはオーナーに届ける](0078-route-replies-through-the-house.md)（`reply` の届け先、画像の保管と配信。sandbox の画像を読み、検証して送る方針は引き継ぐ）。
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（返事は sandbox から backend へ）
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Related: ADR-0011 sandbox の image は開発の一式を持ち、汎用のユーザーの HOME で作業する（sdctl を足す）
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す
- Related: ADR-0020 コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す
- Related: ADR-0026 なつみ・ミャオ・アキも 1 人 1 つの配置で penelope に移し、記憶は履歴ごと写して、戻し道は持たない
- Related: ADR-0027 本人への返事はすべて Web Push で知らせ、購読は配置ごとに backend が持つ（知らせに画像の数を添える）
- Related: [ADR-0079 会話する配置は家に住み、承認は家で答え、個人のページは家から開く](0079-open-resident-pages-from-the-house.md)（配置ごとの Web Push は廃止）。
- Related: ADR-0034 オーナーが送った画像も backend が写し、会話の履歴の行に結び付ける（同じ置き場と確かめ方をオーナーの画像に広げる）
- Related（natsumi、このリポジトリの外）: ADR 0044「なつみは作業環境の sdctl で画像を作り、ポッポさんへの依頼で Slack に投稿する」、ADR 0045「なつみは reply_to_mac の返事に画像を添えて、本人に見せる」

## References

- [sandbox 向けの口の仕様書](../sandbox-api.md) の「返事」（2026-11-16 確認）: body は `{agent, text, expression?, in_reply_to?}`
- [Pod の形の仕様書](../pod.md) の「volume」（2026-11-16 確認）: `/home/agent` は sandbox だけが mount する
- natsumi ADR 0045（https://github.com/yuanying/natsumi/blob/main/docs/adr/0045-showing-the-owner-images-with-a-reply.md 、2026-11-16 確認）: 呼んだ時点で写して会話の行に結び付ける、種類は中身で見分ける、1 枚 10 MB・1 回 4 枚、合わなければ本文も送らない
- natsumi ADR 0044（https://github.com/yuanying/natsumi/blob/main/docs/adr/0044-drawing-with-sdctl-and-posting-images.md 、2026-11-16 確認）
