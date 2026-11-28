# 0047. A2A のメッセージで画像を受け、Task の成果として返す

- Date: 2026-11-21
- Status: Accepted

## Context

penelope の A2A の受け口は、メッセージに文章以外の部品があるとメッセージごと断る。Task の完了時に返せる成果も文章だけである。そのため、エージェント間でスクリーンショットや図を見せて依頼することも、画像を成果として返すこともできない。A2A 1.0 では、メッセージも Task の成果（artifact）も部品の並びを持てる。ファイルの部品は、画像そのものを base64 で持つ `raw` と、取りに行く先を示す `url` のどちらかを持てる。画像そのものを渡せば、受け取る側が別の宛先へ取りに行く必要はない。

## Decision

適用範囲は、penelope が `SendMessage` で受ける新しい依頼と聞き返しへの答え、`reply_to_agent` で完了した Task の成果、および送り手への入出力形式の案内である。Task の持ち主・状態遷移は変えない。

### 1. 文章に加え、受け付ける種類の画像の中身だけを受ける

- ファイルの部品は A2A 1.0 の `raw` に画像の中身があるものに限る。種類はオーナーの画像と同じ PNG・JPEG・GIF・WebP とする。backend は復号した中身で種類を見分け、`mediaType` があれば中身と一致することを確かめる。ファイル名や宣言だけで画像とみなさない。
- `url` の部品、構造のあるデータ、許可した種類と確認できないファイル、復号できない部品は断る。backend は画像を取りに行かない。不適合な部品だけを捨てて残りを届けることもしない。
- 文章だけ、画像だけ、文章と画像を混ぜたメッセージを受ける。空白以外の文章も有効な画像もないメッセージは断る。`input-required` への答えにも同じ条件を適用する。

### 2. 画像は 1 枚 5 MiB・4 枚まで、JSON-RPC 本文は 32 MiB まで受ける

- 復号後で 1 枚 5 MiB まで、1 メッセージに 4 枚までとする。runner が 1 入力に画像として載せる既定の大きさと枚数に合わせる。文章の上限は UTF-8 で 1 MiB のままとする。
- A2A の JSON-RPC 本文全体の上限を 2 MiB から 32 MiB に広げる。上限までの 4 枚（計 20 MiB）は base64 で約 26.7 MiB となる。文章 1 MiB と通常の JSON の付加分を一緒に送れる余裕を持たせる。本文の上限は実際に届いた JSON 全体に読み込み中から適用するので、エスケープなどで 32 MiB を超えたら断る。上限に合わないメッセージは保存・配送しない。

### 3. backend が出来事の添付に写し、既存の道でターンに渡す

- backend は、受け付けた画像の中身を `/sources/a2a` の添付に写す。送り手の文章と画像は同じ `a2a` の出来事に結び付ける。画像だけの場合も受信元と送り手は分かり、画像があることを要約で示す。既存の Task の上限などで出来事にしないメッセージでは、画像も保存しない。添付を保存できなければメッセージを受け付けず、出来事も残さず、Task を新規作成したり、聞き返しへの答えとして `working` に戻したりしない。
- inline の出来事では runner が添付を読み、既存の枚数と大きさの範囲で画像としてターンに載せる。inline にする受信元の設定は変えない。inline でない場合や上限で載らなかった場合は、添付をあとから開ける。モデル要求には接続先ごとの画像の上限もそのまま適用する。
- `GetTask` などで返す Task の `history` は文章と添付の有無を示すだけとし、受けた画像の中身や sandbox 内のパスを載せない。送信済みの画像を送り手に毎回返さず、受信画像を Task のために二重に保存しない。

### 4. 完了の返事に画像を添え、Task の artifact に載せる

- `reply_to_agent` は `completed` の返事に画像を添えられる。文章は任意で、画像だけの成果も返せる。`input-required` での聞き返しは従来どおり文章で行う。返す画像の種類、大きさと枚数の上限は受ける画像と同じにする。オーナーに返す `reply` の上限は変えない。
- runner が sandbox のファイルを読み、backend が返事を受けた時点で写しを取る。これは ADR-0032 の Decision 項 1（`reply` は sandbox の画像の場所を添えられる）と項 2（backend は呼んだ時点で写し、写しを返事に結び付ける）と同じ境界である。backend は sandbox のファイルを読みに行かない。写しは元のファイルが変わっても変わらず、Task の成果として backend の永続する場所で Task と同じ寿命を持つ。
- 成果の文章があれば文章の部品を置き、画像は同じ artifact に `raw`・`mediaType`・`filename` を持つファイルの部品として置く。`filename` はディレクトリを持たず、同じ artifact 内で重ならない。a2a-cli が同名の部品を一つのファイルにまとめるためである。画像の中身は artifact にだけ載せ、`history` には重ねない。
- 読めない画像、種類や上限が合わない画像、写しを保存できない画像があれば、文章も含めて返事ごと断り、Task を完了にしない。送り手自身の Task を既存の認証付きの口で読むときにだけ成果を返す。sandbox のパスや、認証なしで取れる画像の URL は渡さない。

### 5. Agent Card で入出力形式を知らせ、skill で送受信の仕方を示す

- Agent Card の `defaultInputModes` と `defaultOutputModes` の両方に `text/plain` と受ける 4 種類の画像の media type を載せる。
- `a2a` skill は、宛先の Agent Card で対応を確かめ、`a2a send` の `--file-part` に URL でなくローカルの画像ファイルのパスを渡す使い方を示す。文章と混ぜる送り方と、base64 を含む本文上限も示す。対応形式が Card に無い相手には、画像が届く前提で送らない。
- 返ってきた画像は `a2a task get --save-fileparts <ディレクトリ>` でファイルに保存できることを示す。テキスト出力のファイル名・種類・大きさは画像本体ではない。以前のファイルを上書きしないよう、取得先には空のディレクトリを使う。

### 6. 画像の中身は送り手から届いたデータとして扱う

- 守る対象は、添付の保存先と他の送り手の Task、オーナーの指示との区別である。本文を読む前に送り手を確かめ、allow-list にある送り手だけを受ける。認証や Task の持ち主の確認が通らなければ受けない。送り手が指定したファイル名で添付の保存先の外に書き込めないよう、既存の添付の命名規則を使う。画像から読める文字も送り手の文章と同じく外から届いたデータであり、オーナーの指示としては従わない。画像を受けても送り手の権限は増えない。

### 本 ADR で決定しないこと

- 受信画像・返事の画像を Web UI に出すこと。会話の履歴はオーナーのメッセージとオーナー向けの返事だけを持つ。A2A の出来事はオーナー向けの返事が名指したときに要約が出るだけで、A2A の返事自体も履歴に載らない。既存の画像の配信口を使えても、双方を画像付きの行として出すには、A2A の行と送り手・返し先を履歴と画面で新たに扱う必要がある。画像のためだけに会話の履歴を広げず、今回は両方とも表示しない。受信画像の Web UI 用の写しも作らない（委譲先: 会話の履歴で A2A を扱うときの ADR と UI 向けの API の仕様）。
- 断り方、Task 履歴の表示文言、写しの保存形式、CLI のコマンド例（委譲先: A2A の受け口・出来事・sandbox 向けの口の仕様、`a2a` skill）。

## Consequences

- エージェント間で、図を文章で説明し直さなくても、依頼や聞き返しへの答えに画像を添え、成果として画像を返せる。画像を使わない送り手の呼び方は変わらない。
- 受け口の本文上限を広げるので、受け付けた要求が読み込みと検証に使うメモリが増える。成果の写しは Task とともに残り、画像を載せた Task の取得は応答も大きくなる。受信画像を履歴に再掲せず、成果のみに画像を載せる。
- Web UI の会話の履歴から A2A の画像を見ることはできない。A2A の画像は、受け取った側の出来事または送り手が読む Task の成果で見る。

## Related ADRs

- Supersedes（一部）: [ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる](0018-a2a-tasks-in-the-backend-and-replaceable-sender-checks.md) の Decision「受け口は backend の外向きの待ち受けに置き、A2A 1.0 で受ける」のうち「受けるのは文章だけ」を置き換える。送り手の確かめ方と Task の持ち主の扱いは変えない。
- Related: [ADR-0032 返事に sandbox の画像を添え、backend が写して Web UI で見せる](0032-images-attached-to-a-reply-copied-by-the-backend.md)。返事の時点で写すのは同じにし、オーナーへの返事と A2A の成果は別のままにする。
- Related: [ADR-0034 オーナーが送った画像も backend が写し、会話の履歴の行に結び付ける](0034-images-the-owner-sends-copied-by-the-backend.md)。オーナーの画像と同じ種類を受けるが、会話の履歴用の写しは作らない。
- Related: [ADR-0078 `reply` は今いる部屋か、出かけているときはオーナーに届ける](0078-route-replies-through-the-house.md)（家の発言の画像。A2A の画像とその上限は変えない）。
- Related: [ADR-0046 モデル要求では接続先の上限に合わせて古い画像を省き、失敗を次のターンに伝える](0046-budget-images-before-model-requests.md)。A2A で受けた画像も接続先ごとの画像上限の対象にする。

## References

- [A2A の受け口の仕様](../a2a.md)「送り手の確かめ」「依頼の扱い」「Task の見せ方」「状態」と、[受け口の実装](../../packages/backend/src/a2a/endpoint.ts) の `MAX_A2A_BODY_BYTES`、`Requests.sendMessage`、`toTask`（2026-11-21 確認）: 変更前の本文上限は 2 MiB、文章は 1 MiB。受ける部品も成果の部品も文章のみ。Task は backend が永続に持つ。
- [出来事の仕様](../events.md)「A2A の出来事」「`inline`」「`/sources`」「ひとつの出来事」と、[添付の実装](../../packages/backend/src/sources.ts) の `imageTypeOf`、[画像の写しの実装](../../packages/backend/src/assets.ts) の `splitOwnerFiles`・`Assets.record`（2026-11-21 確認）: runner は inline の画像を 1 入力 4 枚まで、既定で 1 枚 5 MiB まで載せる。オーナーの画像の写しは PNG・JPEG・GIF・WebP を中身で見分け、履歴の行に紐付ける。
- [UI 向けの API の仕様](../ui-api.md)「履歴」「画像」、[会話の実装](../../packages/backend/src/conversation.ts) の `Conversation.page`・`Conversation.triggerOf`、[UI の型](../../packages/contract/src/ui.ts) の `HistoryEntry`、[会話画面の実装](../../packages/web/src/ui/Timeline.tsx) の `EventLine`、[sandbox 向けの口の仕様](../sandbox-api.md)「A2A の Task に返す」（2026-11-21 確認）: 会話の履歴は `owner` と `agent` の行のみで、A2A の返事は Task に返す。出来事は通常の返事のきっかけとして出せるが、そこに出るのは受信元と要約のみ。
- A2A 1.0 仕様の [Part](https://a2a-protocol.org/v1.0.0/specification/#416-part)、[Artifact](https://a2a-protocol.org/v1.0.0/specification/#417-artifact)、[AgentCard](https://a2a-protocol.org/v1.0.0/specification/#441-agentcard)（2026-11-21 確認）: JSON のファイルの部品は `raw`（base64）か `url` を持ち、`mediaType` と `filename` は任意。artifact は部品の並びを持ち、Agent Card は media type で入出力形式を示せる。
- [Dockerfile](../../Dockerfile) の `A2A_VERSION` と、a2a-cli v0.4.0 の [`buildFilePart`](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/flagparse/parts.go)・[`send`](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/cli/send.go)（2026-11-21 確認）: `--file-part ./diagram.png` は中身を入れ、URL は参照にする。文章は位置引数や `--text-part` で同送できる。
- a2a-cli v0.4.0 の [`task get`](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/cli/task_get.go)・[`filePartText`](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/output/output.go)・[`Saver.save`](https://github.com/a2aproject/a2a-cli/blob/v0.4.0/internal/fileparts/saver.go)（2026-11-21 確認）: テキスト出力は名前・種類・大きさを表示する。`--save-fileparts` は artifact の `raw` をファイルに書き、同じ artifact 内でファイル名が重なる部品は結合する。以前の実行でできた同名ファイルは上書きする。
