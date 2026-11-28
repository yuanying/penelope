# 0002. 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく

- Date: 2026-11-14
- Status: Accepted（Decision「runner が取りにいく」の loopback を塞ぐ点は ADR-0014 で置き換え。一部を ADR-0078 で置き換え）

## Context

エージェントには、オーナーの発言のほかに、Slack のメッセージ、監視の警報、GitHub の webhook、予約した時刻、ほかのエージェントからの頼み（A2A）が届く。受信元は今後も増える。

今の natsumi では、受信元ごとに server の中に受け口と読み方がある。webhook の受け口は 1 つにまとめたが、届いたものの読み方は受信元ごとの型としてコードに持っている。受信元を足すたびに server のコードとプロンプトが変わる。

penelope では Pi が sandbox の中で動く（ADR-0001）。出来事を sandbox の中の Pi に渡す道と、Pi の返事・途中経過を backend に戻す道が要る。sandbox は外から呼ばれる口を持たないようにしたい。sandbox に入ってくる口が増えるほど、守るべき面が増えるためである。

ここで使う言葉は次のとおりである。

- **出来事**: エージェントに届くものの単位。オーナーの発言、Slack のメッセージ、警報、予約した時刻など。
- **取り込み口**: backend が出来事を受け取る唯一の入口。
- **待ち行列**: 取り込み口が受けた出来事を、受けた順に並べる 1 本の列。

## Decision

### 取り込み口は 1 つ、契約も 1 つ

- backend に取り込み口を 1 つだけ置く。どの受信元も、正規化した出来事をここへ入れる。
- 出来事は、小さな共通の封筒と、受信元ごとに自由な中身からなる。封筒が持つのは、受信元、受信元が付ける ID（重複を除くキー）、起きた時刻、1 行の要約、中身である。
- backend は中身の形を知らない。中身の読み方を受信元ごとにプロンプトに書かない。読み方が要るなら skill にする（ADR-0008）。

### 基本の受信元は backend の中、それ以外は receivers

- オーナーの発言（UI）、予約した時刻（cron）、A2A の受け口は backend の一部とする。backend の中からも、外のプラグインと同じ「正規化した出来事を待ち行列へ入れる」処理を通す。
- Slack・監視の警報・GitHub の webhook などは、receivers のコンテナの 1 つのプロセスにプラグインとして載せる。受信元を足すときは、プラグインを 1 つ足す。
- 受信元の鍵（Slack の token、webhook の署名の鍵など）は receivers だけが持つ。backend は受信元の鍵を持たない。
- receivers から取り込み口へは、Unix socket で送る。socket は、backend と receivers だけが共有する volume に置き、sandbox には mount しない。送れるのは socket が見える者だけであり、共有の token や Secret は使わない。

### 配送の約束

- 配送は「少なくとも 1 回」とする。受信元は、送れなければ同じ ID で送り直す。backend は ID で重複を落とす。
- 順番は、backend が受けた順の 1 本の列である。受信元をまたいだ順序は保証しない。
- backend の状態（待ち行列の「渡した・済んだ」、会話の履歴、思考と途中経過の記録、予約、A2A の task）は、永続ボリューム上の SQLite の 1 つのファイルに置く。待ち行列の状態は transaction で進め、取りこぼさない。schema は natsumi と互換にせず新しく作り、migration の仕組みを最初から持つ。

### runner が取りにいく

- sandbox の中の runner が、backend へ long-poll で出来事を取りにいく。backend から sandbox へ呼びにいく口は作らない。
- runner は、溜まった出来事をまとめて 1 ターンの入力にする。ターンの途中に届いた出来事は、Pi の steer か follow-up でそのセッションに入れる。
- runner は Pi の出来事を購読し、途中の思考、ツールの呼び出しと結果、返事の区切り、ターンの始まりと終わりを backend へ送る。
- runner から backend への通信も、ほかの外向きと同じく Sentinel を通る。sandbox の UID から同じ Pod の loopback へ直に届く道は塞ぐ。backend への鍵はサロゲートとして sandbox に置き、Sentinel が本物に差し替える（ADR-0003、ADR-0004）。
  - 2026-11-14 追記: ADR-0014 で置き換え。loopback は塞がず、backend の sandbox 向けの口を Unix socket だけで待ち受けて、Sentinel を通る道に限る。

### 失敗したときの倒し方

- runner が受け取ったまま済んだと伝えられなかった出来事は、渡していないものとして扱い、もう一度渡す。

### 本 ADR で決定しないこと

- 封筒の各欄の型と、取り込み口の API の形（委譲先: [出来事の仕様書](../events.md)）
- 最初に作る receivers のプラグインの順番（委譲先: 最小版の作業単位の一覧）
- UI へ流す途中経過の細かさ（トークンごとか、ブロックごとか）（委譲先: ADR-0009 の「本 ADR で決定しないこと」）
- 出来事と会話の履歴をいつまで残すか（委譲先: [backend の仕様書](../backend.md)）

## Consequences

- 受信元を足しても、backend とプロンプトは変わらない。プラグイン 1 つで済む。
- 受信の鍵が receivers だけにあるので、backend と sandbox はそれを知らない。
- sandbox は入ってくる口を持たない。backend への道も Sentinel を通るので、記録に残る。
- 一方で、Sentinel が止まると、runner は出来事を受け取れず、返事も送れない。返事のための別の道は持たないので、Sentinel の故障はエージェントが黙ることとして現れる。
- receivers の取り込み口への道は、socket の置き場所（volume を mount するコンテナ）だけで守る。確かめる token が無いので、Secret の配布と更新が要らない。代わりに、receivers は backend と同じ Pod に置くことになる。
- 重複を除く責任は backend にあり、ID を付ける責任は受信元にある。受信元が ID をいい加減に付けると、出来事が落ちるか重なる。
- SQLite の 1 ファイルなので、backend は 1 つのプロセスに限られる。1 配置に 1 人のエージェント（ADR-0001）の範囲では足りる。

## Alternatives Considered

- **基本の受信元も別のプロセスにする**: 境目はきれいになるが、同じ Pod のプロセスが 1 つ増える。オーナーの発言と予約は backend の UI と状態に密着しているので、backend の中に置いた。
- **backend が sandbox へ出来事を押し込む**: sandbox に外から呼ばれる口が要る。
- **receivers から取り込み口へ localhost の HTTP と共有の token で送る**: receivers を Pod の外に出しても使えるが、共有の token の Secret が要る。同じ Pod の中では、socket の見える範囲で送り手を限れば足りる。
- **返事だけ専用の口を持つ**: Sentinel が止まっても話せるが、外向きの道が 2 つになる。

## Related ADRs

- Superseded by（一部）: [ADR-0078 `reply` は今いる部屋か、出かけているときはオーナーに届ける](0078-route-replies-through-the-house.md)（Decision 項 3（配送の約束）のうち、会話の履歴を置く先）。
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す
- Superseded by（一部）: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける（Decision「runner が取りにいく」の loopback を塞ぐ点）

## References

- natsumi ADR 0091「webhook の受け口を 1 つにし、届いたものの読み方は型としてコードに持つ」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0091-one-way-in-for-webhooks-with-formats-in-the-code.md 、2026-11-14 確認）
- natsumi ADR 0008「単一の思考ループと Mac との会話」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0008-single-thinking-loop-and-mac-conversation.md 、2026-11-14 確認）
- Pi Coding Agent の SDK の文書 `docs/sdk.md`（https://github.com/earendil-works/pi 、npm の `@earendil-works/pi-coding-agent` 1.5.2 に同梱のもの、2026-11-14 確認）: 実行中のセッションへの入力は `steer()`（今のアシスタントのターンとそのツール呼び出しの後に入る）か `followUp()`（今の実行が終わった後に入る）を選ぶ
