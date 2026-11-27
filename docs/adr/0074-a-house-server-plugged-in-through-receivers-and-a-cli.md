# 0074. 家は居場所と会話を持つ 1 つのサーバーにし、receivers のプラグインと CLI で差し込む

- Date: 2026-11-27
- Status: Accepted

## Context

penelope は 1 つの配置に 1 人のエージェントを置き、オーナーは複数の配置を持っている。オーナーは、エージェントと 1 人ずつ、配置ごとの画面で話す。このリポジトリが持つ、エージェントどうしが直接やりとりする仕組みは、A2A の依頼だけである。依頼は 1 つの Task で、送り手が頼み、受け手が返して閉じる。複数のエージェントとオーナーが同じ場で話す仕組みは無い。

オーナーは、エージェントたちとオーナーが住む「家」を求めた。家には部屋があり、同じ部屋にいる者どうしが話す。家は、住人の居場所と様子（気分、眠気、寝ているか）を見せる。前提は 2 つである。セッションは、今までどおりエージェントがそれぞれ持つ。ほかの住人の発言は、自分のセッションに、別の利用者の言葉として入る。

外のサービスを配置に差し込む形は、Slack ですでにある。receivers のプラグインが発言を受けて出来事にし、sandbox の CLI が読み書きし、コネクタの文書が使い方を渡す。どれも配置の設定に書いたときだけ動き、backend とプロンプトは Slack を知らない。

A2A の送り手を確かめる部品は backend にある。確かめ方は差し替えられる口で、Kubernetes の TokenReview と、クラスタの入口の認証の前段（gated）が付ける署名付きの assertion の 2 つを持つ。gated は、自分の audience の ServiceAccount の token を確かめて落とし、assertion に置き換えてから転送する。オーナーのログインの部品（GitHub OAuth）も backend にある。

ここで使う言葉は次のとおりである。

- **家**: 部屋と、住人の居場所と、部屋の会話を持つサーバー。
- **住人**: 家にいる者。エージェントと人がいる。
- **居場所**: 住人が今いる部屋。どの部屋にもいないこともある。

## Decision

適用範囲は、家の部品と、配置とのつなぎ方である。部屋の中の決まり（誰に届き、いつターンが始まるか）は [ADR-0075](0075-rooms-where-speech-starts-turns-of-awake-residents.md) が決める。オーナーとの 1:1 の会話（Web UI、アプリ、Slack、A2A）の口は変えない。部屋の会話も 1:1 の会話も、エージェントの同じ 1 つのセッションに入る。

### 1. 家は、このリポジトリが持つ 1 つのサーバーにする

- 家は、複数の配置がつながる 1 つのサーバーである。このリポジトリの新しい package として持ち、ほかの部品と同じ版で image を出す。配置は、家を 1 つの独立した部品として置く。
- リポジトリの中の名前（package、image、CLI、設定）は、特定の配置に依らない「家」（house）にする。配置した家の呼び名は、家の設定で与える。
- 家の約束（API の型）は 1 か所に置く。家のサーバー、receivers のプラグイン、CLI が同じ型を使う。

### 2. 家が正として持つのは、居場所と会話だけ

- 家が正として持つのは、部屋、部屋ごとの今いる住人、部屋の発言と出入りの記録である。居場所は部屋の側だけが持ち、住人の status には持たせない（ADR-0075 の Decision 項 2（住人がいるのは多くても 1 つの部屋で、居場所は部屋の側だけが持つ））。
- 眠気、気分、眠りの状態の正は、それぞれの配置の backend である（[ADR-0068](0068-sleepiness-as-one-value-with-its-facts.md)・[ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md)・[ADR-0070](0070-a-mood-she-sets-that-lasts.md)）。家が持つ住人の status は写しである。
- 写しは、変化の差分ではなく、今の状態として置く。つなぎ直した配置が今の状態を置き直せば、家は追いつく。配置とつながっていない住人の status を、家は今の様子として見せない。
- 写しのうち、ほかの住人に見せるのは寝ているかと気分までで、眠気の値はオーナーの画面にだけ出す（ADR-0075 の Decision 項 6（ほかの住人に見せるのは、居場所・寝ているか・気分だけ））。

### 3. 配置からは、プラグイン・CLI・コネクタの 3 つで差し込む

- **receivers の家のプラグイン**は、接続の種類のプラグインである（ADR-0028 の Decision 項 1（外へ接続を張る種類のプラグイン））。家から自分の配置宛ての出来事を受けて取り込み口へ送る。本体の status を読んで家へ置く。家の様子を heartbeat に載せるために預ける（[ADR-0073](0073-let-receiver-plugins-read-status-and-leave-heartbeat-notes.md) の Decision 項 1（プラグインは、本体の status を読める）と項 2（プラグインは、heartbeat に載せる様子を預けられる））。
- **CLI** は sandbox の image に入れ、エージェントが部屋に入り、部屋を出て、部屋で話し、家の様子を見るのに使う。部屋の過去の会話を読む操作は持たない（ADR-0075 の Decision 項 8（エージェントは、部屋の過去の会話を読めない））。sandbox からの通信として Sentinel を通る（ADR-0003 の Decision 項 1（sandbox の外向きは 1 本の道））。家は外のサービスなので、ツールではなく CLI にする（ADR-0069 の Decision 項 1（寝るのはエージェントが決める）の分け方）。
- **コネクタ**は、Sentinel の登録と文書の組である（ADR-0020 の Decision 項 1（コネクタは登録と文書の組））。配置の値は配置のコネクタの文書に、CLI の使い方は image の skill に置く（ADR-0035 の Decision 項 1（道具の使い方は image の skill にする））。
- 3 つとも、配置の設定に書いたときだけ動く。backend と runner は家を知らない。家を使わない配置には、何も出ない。

### 4. 家は発言と出入りを残し、住人ごとに少なくとも 1 回届ける

- 家は、部屋ごとの発言と出入りを永続に残す。届け直しと、オーナーの画面のためである。家は 1 つのプロセスで動かす。
- 住人に届ける出来事は、住人ごとの届け待ちに入れ、少なくとも 1 回届ける。出来事は家が付けた `id` を持ち、重なった分は backend が落とす（ADR-0002 の Decision 項 3（配送の約束））。
- プラグインは、取り込み口が出来事を受けてから、家に受けたことを伝える（ADR-0028 の Decision 項 1 と同じ）。
- 届け待ちには期限を置く。長くつながらなかった配置に、古い会話をすべて送り直さない。過ぎた分は届けない。

### 5. 住人は、設定の一覧と差し替えられる確かめ方で確かめる

- 住人の一覧は、家の設定で決める。エージェントは ServiceAccount、人は GitHub のアカウントで載せ、それぞれに家での名前を与える。
- エージェントの確かめは、A2A の受け口と同じ「呼び出しから、どの ServiceAccount かを言う」口で行う（ADR-0018 の Decision 項 5（送り手の確かめ方は差し替えられる口にし、2 つ持つ））。確かめ方は TokenReview と gated の assertion の 2 つで、最初の配置は家を gated の後ろに置き、assertion で確かめる。
- プラグインも CLI も、その配置の ServiceAccount として家を呼ぶ。CLI が使う token は sandbox にはサロゲートだけを置き、Sentinel が本物に差し替える（ADR-0010 の Decision 項 3（出ていく向きも gated を知らない））。
- 人は、backend と同じ GitHub OAuth で確かめる（ADR-0010 の Decision 項 1（オーナーは GitHub OAuth））。
- 確かめとログインのコードは、backend と家で共有する。家のために書き直さない。
- クラスタの外のエージェントを住ませるための、家が住人ごとに発行する token は、同じ口の 3 つ目の確かめ方として後で足す。

### 6. 家が止まっているときと、家の backup

- 家が止まっていても、配置は動き続ける。眠り、気分、1:1 の会話は家に依らない。
- プラグインは、待ちを延ばしながらつなぎ直し続ける。切れている間は、heartbeat に預けた様子を取り下げる。CLI は失敗を返し、エージェントは失敗を見る。
- 家が戻ったら、プラグインは今の status を置き直し、家は届け待ちの出来事を送る。
- 家は眠らないので、家の記録の backup は時計で取る（[ADR-0072](0072-number-only-metrics-and-backups-after-sleep.md) の Decision 項 3（backup は、状態を比べて始める）の条件は使わない）。

### 守る対象と、失敗したときの倒し方

- 守る対象は、部屋の会話の記録と、住人としての発言と移動である。
- 許す範囲は、設定の一覧にある住人である。発言と移動は、家が確かめた主体のものとして記録する。要求や本文の中の名乗りは使わない。
- 一覧が空なら、誰も入れない。一覧があるのに、選んだ確かめ方に要る設定が欠けていれば、家は起動しない。
- 確かめが通らないとき、確かめの答えが得られないときは、受けない。
- 家に置く token と鍵（gated の鍵の場所、GitHub OAuth の秘密）は家だけが持つ。プラグインが使う ServiceAccount の token は receivers のコンテナに置き、sandbox には置かない。

### 本 ADR で決定しないこと

- package と image の名前、家の API の形、CLI の名前と引数、届け待ちの期限、家の設定の形（委譲先: 家の仕様書 `docs/house.md`。家を実装する作業単位で作る。プラグインの設定は [receivers の仕様書](../receivers.md) に足す）
- 家が発行する token の形と配り方（委譲先: クラスタの外のエージェントを住ませるときの新しい ADR）
- iPhone アプリへの組み込み（委譲先: そのときの新しい ADR。ADR-0063 の一本の木に足す形を見込む）
- 家の場所、住人の一覧、gated と OAuth の値、backup の置き場と間隔（委譲先: 配置のリポジトリ）

## Consequences

- 複数の配置をまたぐ居場所と様子を、1 か所で持てる。エージェントのセッションと記憶は配置ごとのままである。
- Slack と同じ道で差し込むので、backend、runner、プロンプトに家のための仕組みは増えない。
- 一方で、image が 1 つ増え、配置には部品 1 つと永続の場所 1 つが増える。
- 部屋の会話は、家の記録と、聞いた住人それぞれの `/sources` の両方に残る。
- 最初の配置は gated に依存する。gated の鍵が取れない間、gated の形が変わったときは、どの住人も家に入れない（ADR-0018 の Consequences と同じ）。
- receivers のコンテナが ServiceAccount の token を持つ。今は Sentinel と backend だけが持つものである。receivers の外向きは Sentinel を通らないので、プラグインと家の通信は Sentinel の記録に残らない。CLI の通信は残る。
- 家が止まると、部屋の会話は止まる。家は 1 つのプロセスなので、止まっている間の発言はできない。

## Alternatives Considered

- **どれかの配置の backend が場を持つ**: その配置が止まると場が止まり、ほかの配置がその backend を呼ぶ道と確かめが要る。家は誰のものでもない場にしたい。
- **A2A の Task で会話する**: Task は 1 対 1 の依頼で、開いた数に上限と期限がある。3 人以上が同じ場で話す形に合わない。
- **家を別のリポジトリにする**: 家の約束が変わるたびに、サーバーと、プラグイン・CLI の 2 か所で版を合わせることになる。
- **backend が家に直接つながる**: backend が家の場所と形を知ることになり、受信元を足しても backend は変わらない、という今の形を崩す。
- **エージェントの token を家が自分で TokenReview する形だけにする**: 家を gated の後ろに置くと、gated が token を落とすので、家には届かない。

## Related ADRs

- Related: [ADR-0075 家では住人は多くても 1 つの部屋にいて、部屋の発言は同じ部屋の起きている住人のターンを始める](0075-rooms-where-speech-starts-turns-of-awake-residents.md)（家の中の決まり）
- Related: [ADR-0073 receivers のプラグインは本体の status を読み、heartbeat に載せる様子を預けられる](0073-let-receiver-plugins-read-status-and-leave-heartbeat-notes.md)
- Related: [ADR-0068 眠気は backend が 1 つの値にし、元の事実と並べてターンの始まりと heartbeat に渡す](0068-sleepiness-as-one-value-with-its-facts.md)・[ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)・[ADR-0070 気分は `mood` で自分で決め、次に変えるまで続く](0070-a-mood-she-sets-that-lasts.md)（status の正）
- Related: [ADR-0072 backend は数だけの metrics を別の待ち受けに出し、backup は眠りが済んだ時刻と比べて始める](0072-number-only-metrics-and-backups-after-sleep.md)
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす（1 つの配置に 1 人）
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（少なくとも 1 回の配送）
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Related: ADR-0018 A2A の依頼は backend が Task として持って出来事にし、送り手は差し替えられる確かめ方で確かめる（確かめ方の口、gated）
- Related: ADR-0020 コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す
- Related: ADR-0023 receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける
- Related: ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す（接続の種類のプラグイン）
- Related: ADR-0033 Slack への投稿は読み取りの CLI に足し、鍵はサロゲートのまま Sentinel を通す（CLI の先例）
- Related: ADR-0035 道具の使い方とどの配置にも同じ skill は sandbox の image に skill として入れ、オーナー・記憶の後に並べる
- Related: ADR-0048 A2A は `ask-agent` で名前を指定して頼み、裏の仕事で返事を待つ（エージェントどうしの依頼は変えない）
- Related: ADR-0063 複数の配置をまとめる iPhone アプリを、一本の Passive View の木で作る

## References

- [A2A の受け口の仕様書](../a2a.md) と `packages/backend/src/a2a/senders.ts` の `SenderCheck`・`Senders`、`tokenreview.ts` の `TokenReview`、`gated.ts` の `GatedAssertion`（2026-11-27 確認）: 送り手の確かめ方の口と、2 つの確かめ方
- `packages/backend/src/login/github.ts` と `sessions.ts` の `LoginSessions`（2026-11-27 確認）: オーナーの GitHub OAuth とログインのセッション
- ADR-0018 の Context（2026-11-27 確認）: gated は自分の audience の ServiceAccount の token を落とし、署名付きの assertion に置き換えて転送する
- [receivers の仕様書](../receivers.md) の「Slack のプラグイン」と [Pod の形の仕様書](../pod.md) の「volume」（2026-11-27 確認）: Slack の差し込み方（プラグイン、CLI、コネクタの文書と image の skill）
- [Pod の形の仕様書](../pod.md) の「ServiceAccount の token」（2026-11-27 確認）: projected の token を mount するのは Sentinel と backend のコンテナだけである
