# 0029. Slack の出来事はターンに inline で載せ、前のターンからの変化をチャンネルとスレッドの形で描く

- Date: 2026-11-16
- Status: Accepted

## Context

Slack の出来事は、receivers のプラグインが 1 件ずつ取り込み口へ送り、backend が `/sources` に追記する（ADR-0028、ADR-0013）。発言・スレッドの返信・編集・削除・リアクションは、どれも起きた日のファイルに 1 行として足される。今の姿は、読む側が行を組み立てて作る。

ターンに入る形は次のとおりである（ADR-0013、ADR-0017、ADR-0015）。

- inline の受信元の出来事は、中身をそのままターンに載せる。どの受信元を inline にするかは backend の設定で決める。いまはオーナーのメッセージ（`ui`）と制御の出来事だけである。inline の出来事は、1 件ごとに 1 行になり、中身は `payload` の `text`、無ければ `payload` を JSON にした文字列である。
- inline でない出来事は、要約（200 文字まで）と、中身を足した場所だけが入る。`batch` の出来事は、受信元と `stream` ごとに 1 行にまとめ、件数と `seq` の一覧と要約と場所を持つ。
- 終わったターンを畳むとき、届いた出来事は受け取ったときの形のまま残る。ツールの出力は残らない。

このため、Slack をほかの受信元と同じ形で受けると、困ることがある。エージェントが Slack の中身を読むには `/sources` のファイルを開くが、その出力はターンが終わると畳まれ、残るのは要約と場所だけになる。1 日の中で Slack の流れの覚えが途切れ途切れになる。中身を inline にしても、1 件 1 行の JSON では、リアクションやスレッドの返信が元の発言から離れて並び、何への反応かが分かりにくい。

ADR-0013 は、受信元のプラグインが `/sources` の中身を読むための CLI を持てると決めている。backend は `payload` の形を知らない（ADR-0002 の Decision 項 1（取り込み口は 1 つ、契約も 1 つ））。

## Decision

適用範囲は、Slack のプラグイン（ADR-0028）の出来事が、エージェントの日中のセッションのターンに入る形である。ほかの受信元（Alertmanager・GitHub・A2A など）の入り方は変えない。

### 1. Slack の出来事は inline にする

- Slack のプラグインの出来事を受ける配置では、その `source` を inline の受信元にする（ADR-0013 の Decision 項 2（ターンには要約と場所だけを渡す）の、backend の設定で決める inline）。
- backend は、これまでどおり `payload` の形を知らずに、inline の出来事として `payload` を runner に渡す。

### 2. 描き方は Slack のプラグインの package に置き、runner と CLI が同じコードを使う

- 出来事の `payload` から Slack の様子を人の読む文に描くコードは、Slack のプラグインの package に置く。receivers のプラグイン、ターンの入力を作る runner、sandbox の image に入る読み取り用の CLI が、同じ package の型と描き方を使う。
- runner は、配置の設定で、どの `source` を Slack の描き方で描くかを知る。`source` の名前は有効化ごとに配置が決めるためである（ADR-0023 の Decision 項 3（`source` は有効化ごとに 1 つ、既定はプラグインの名前））。設定が無ければ、Slack の出来事もほかの inline の出来事と同じ形で入る。

### 3. 前のターンからの変化を、チャンネル → スレッド → 発言の形で描く

- 一度に渡された Slack の出来事は、前に渡してから起きた変化である。runner はそれを `stream`（チャンネルや DM）ごとにまとめ、1 つの文に描く。
- 文は、チャンネル → スレッド（親の発言を短く添える）→ 発言・編集・削除・リアクション・添付の置き場所、の順に入れ子で描く。リアクションと返信は、元の発言の下に並べる。
- 描くために、runner は `/sources` の前の行を読んでよい（スレッドの親、リアクションの付いた発言、DM の直前の流れ）。`/sources` は sandbox から読めるので（ADR-0013）、新しい口は要らない。
- `batch` の出来事は、`stream` ごとに 1 行のまとめにし、件数・`seq` の一覧・要約・足された場所に加えて、描いた文を持つ。`now` の出来事は 1 件ずつの行とし、描いた文に直前の流れを短く添える。返事の `in_reply_to` で名指せるように、`seq` は今までどおり行にある（ADR-0017）。

### 4. 載せる量に上限を置き、超えたら CLI で読める場所を添える

- 1 回の入力に載せる Slack の文の量に上限を置く。上限は runner の設定で決める。
- 超えたときは、新しい変化を残して古い変化を省き、省いたことと、CLI でその `stream` を読む書き方を文の中に添える。省いた出来事も、足された場所は行に残る。

### 5. 読み取り用の CLI は、深く読むときのもの

- 読み取り用の CLI は、`/sources` を読み、チャンネル・スレッドの今の姿を同じ描き方で出す。sandbox の image に入れる。
- ターンに載るのは変化だけで、遡って読みたいときや省かれた分を読むときに、エージェントが CLI を使う。CLI の出力はほかのツールの出力と同じく、ターンが終わると畳まれる（ADR-0015）。

### 6. 描けないときは、ふつうの inline の行に倒す

- `payload` が描き方の知らない形のとき、`/sources` の前の行が読めないときは、その出来事を、ふつうの inline の出来事の行（`payload` の JSON）としてターンに入れる。描けないことで出来事を落とさない。runner のログに理由を書く。

### 本 ADR で決定しないこと

- 描いた文の形、行の欄の名前（`batch` のまとめに描いた文を持たせる欄）、直前の流れの長さ、量の上限の既定、省いたときの添え方（委譲先: [出来事の仕様書](../events.md) の「ターンに入る形」と `packages/contract` の `src/turn.ts`。Slack の出来事を inline にする作業単位で足す）
- runner の設定の名前（委譲先: runner のコード `packages/runner/src/config.ts`）
- Slack のプラグインの package の置き場所と名前、CLI の名前と引数（委譲先: [receivers の仕様書](../receivers.md) の「Slack のプラグイン」）
- Alertmanager・GitHub を構造化して inline にすること（委譲先: 要るとなったときの新しい ADR）
- システムプロンプトに描いた文のことを書くか、書くならその 1 文（委譲先: プロンプトのファイル `packages/runner/src/prompts.ts`。ADR-0008 の方針に従う）

## Consequences

- Slack の流れが、届いた出来事としてターンに残り、畳まれても消えない。エージェントは 1 日の中で Slack の様子を覚えていられる。
- リアクションと返信が元の発言の下に並ぶので、何への反応かが文の形で分かる。
- 描き方が 1 か所にあるので、ターンに載る形と CLI の形が食い違わない。backend は Slack の形を知らないままである。
- 一方で、Slack の文が文脈に積もる。畳み込みは Slack の文を減らさないので、日中の文脈は Slack の量に比例して伸び、compaction が起きやすくなる。上限は、そこで効く。
- runner が Slack のプラグインの package に依存する。描き方の版は、receivers と runner と CLI で同じ版になる（同じリポジトリの同じ版で image を作るため）。
- 描くために `/sources` の前の行を読むので、ターンの入力を作るときに runner のディスクの読みが増える。
- 上限を超えた分は省かれるので、量の多い日は、エージェントが CLI で読まないと見えない変化が出る。
- 行の形が Slack だけ違う（`batch` のまとめが描いた文を持つ）ので、ターンの入力の契約に Slack のための欄が増える。

## Alternatives Considered

- **inline にせず、要約と場所のまま渡す**: 中身を読んだツールの出力は畳まれ、Slack の覚えが途切れ途切れになる。
- **inline にして、1 件 1 行の JSON のまま載せる**: リアクションと返信が元の発言から離れ、何への反応かを読み取るのが難しい。JSON の欄の名前で字数も増える。
- **backend が描く**: backend が Slack の `payload` の形を知ることになり、ADR-0002 の「backend は中身の形を知らない」に反する。
- **receivers が描いた文を `payload` に入れて送る**: receivers は `/sources` を読めない（ADR-0013）ので、スレッドの親やリアクションの付いた発言を描けない。

## Related ADRs

- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（backend は中身の形を知らない）
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す（inline の受信元、受信元のプラグインの CLI）
- Related: ADR-0015 終わったターンは、モデルに送る直前に機械的に畳み、セッションの記録は書き換えない（届いた出来事は畳まない）
- Related: ADR-0017 ターンの入力は 1 行 1 件の JSON を `<events>` で囲み、1 件の型を契約にする（`batch` のまとめの行に、描いた文を足す）
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける（`source` は配置が決める）
- Related: ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す
- Related: ADR-0033 Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す（読み取り用の CLI に投稿を足した）
- Related: [ADR-0077 畳んだターンのツール呼び出しを、呼び出しと結果の組で残す](0077-keep-folded-tool-calls-as-tool-messages.md)（CLI の元の出力は引き続き省く）

## References

- [出来事の仕様書](../events.md) の「`inline`」と「ターンに入る形」（2026-11-16 確認）: inline の出来事は 1 件 1 行で `text` を持つ、`batch` のまとめは inline でない出来事を受信元と `stream` ごとにまとめる
- [backend の仕様書](../backend.md) の「設定」の `PENELOPE_INLINE_SOURCES`（2026-11-16 確認）
- penelope `packages/runner/src/fold.ts` の `foldTurns`（2026-11-16 確認）: 畳むときに残すツールは `reply` と `reply_to_agent` だけで、ほかの呼び出しは 200 文字の 1 行に短くし、出力は残さない（呼び出しと結果の表現は後に [ADR-0077](0077-keep-folded-tool-calls-as-tool-messages.md) で置き換え）
