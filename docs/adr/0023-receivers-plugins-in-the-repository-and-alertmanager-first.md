# 0023. receivers のプラグインはリポジトリの中に持って配置の設定で有効にし、最初に Alertmanager の webhook を受ける

- Date: 2026-11-15
- Status: Accepted

## Context

receivers は Pod の 4 つ目のコンテナで、Slack・監視の警報・GitHub の webhook などの受信元を、1 つのプロセスのプラグインとして載せる（ADR-0001、ADR-0002 の Decision「基本の受信元は backend の中、それ以外は receivers」）。受信の鍵は receivers だけが持ち、出来事は Unix socket の取り込み口（`POST /v1/events`）へ送る。配送は少なくとも 1 回で、backend は `(source, id)` で重複を落とす。いまの receivers は版を出すだけで、受信元を 1 つも持たない。

ここで使う言葉は次のとおりである。

- **プラグイン**: 受信元 1 種類の受け方を実装したもの（例: Alertmanager の webhook を受けるもの）。
- **プラグインの有効化**: 配置の設定で、プラグイン 1 つに名前と設定を与えて動かすこと。同じプラグインを、名前と設定を変えて 2 つ以上有効にできる。
- **送り手**: receivers に知らせを送ってくる外のサービス（Alertmanager など）。

このプロジェクトには、次の事情がある。

- エージェントはクラスタの運用係であり、クラスタの Alertmanager の警報を受ける必要がある。なつみベースの前の形（natsumi ADR 0091）は、警報を `https://penelope.fraction.jp/v1/webhooks/fraction` で、Bearer の token で確かめて受けていた。Alertmanager の設定（送り先・token・送り直し）はこの形のまま配置にある。新しい形はこのパスを受ける口を持たない。
- Alertmanager の webhook は、まとめた警報の組（group）を 1 回の POST で送る。1 回の POST は、複数のアラートと、Alertmanager の場所（`externalURL`）を持つ。アラートはそれぞれ、状態（`firing`・`resolved`）、ラベル、注釈、始まりと終わりの時刻、出どころの URL、ラベルから作る fingerprint を持つ。
- Alertmanager は、2xx を受けたら送れたとし、5xx を受けたら同じ知らせを送り直す。4xx は送り直さない。同じ組がまだ鳴っていれば、`repeat_interval` ごとに同じアラートを送り直す。
- エージェントは、オーナーへの知らせの口として Alertmanager にアラートを足すことができる。そのアラートも同じ route で receivers に戻ってくる。
- 出来事の `stream` は `/sources` のパスの一部になるので、英小文字・数字・`.`・`_`・`-` だけで、`.` で始まらないものに限られる。外れた出来事は取り込み口が `400` で断る。Prometheus のラベルの値は任意の Unicode の文字列であり、アラートの名前（`alertname` のラベル）は `KubePodCrashLooping` のように大文字を含むのがふつうである。

## Decision

本 ADR は receivers のプラグインの載せ方と、送り手への答え方と、最初のプラグインである Alertmanager の webhook の受け方を決める。取り込み口・封筒・配送の約束は ADR-0002 と ADR-0013 のまま変えない。

### 1. プラグインはリポジトリの中に持ち、配置の設定で有効にする

- プラグインは、このリポジトリの receivers の中のモジュールとして持ち、receivers の image に入れる。プラグインを足すときは、このリポジトリに足して版を上げる。外から差し込む口は作らない。
- 配置は receivers の設定のファイルで、どのプラグインを有効にするかと、有効化ごとの設定（鍵のファイルの場所、`delivery` の決め方など）を決める。設定に書かないプラグインは動かない。
- 有効化はそれぞれ名前を持つ。名前は配置の中で一意である。
- 知らない欄、知らないプラグイン、重なる名前、使えない値が設定にあれば、receivers は起動しない。書き損じを黙って無視しない。

### 2. webhook のプラグインは 1 つの HTTP サーバーの下に並ぶ

- receivers は TCP の HTTP サーバーを 1 つだけ持つ。webhook のプラグインの有効化は、そのサーバーの `/v1/webhooks/<有効化の名前>` を受け持つ。
- URL の `<有効化の名前>` は配置が決める。送り手に渡してある URL を変えずに、受け持つプラグインを替えられる。
- このサーバーは Pod の外から呼ばれる口なので、受けた要求はすべて、送り手の確かめ（署名や token）をプラグインごとに通す。確かめを通らない要求からは出来事を作らない。sandbox からも loopback で届くが、扱いは外から届くのと同じである（ADR-0014）。

### 3. `source` は有効化ごとに 1 つ、既定はプラグインの名前

- 有効化は、取り込み口に送る出来事の `source` を 1 つ持つ。既定はプラグインの名前（Alertmanager なら `alertmanager`）で、配置は別の名前を与えられる。
- 2 つの有効化が同じ `source` を持つ設定は、起動しない。1 つの配置に Alertmanager が 2 つあるときは、2 つ目に別の `source` を与える。`id` は `source` の中で一意であればよいので、送り手をまたいで ID が重なっても、片方の出来事が重複として落ちない。
- `source` は封筒の `source` の文字の制限を満たし、backend の中の受信元の名前（`ui`・`cron`・`a2a`・`self`・`control`）と重ならないものに限る。外れれば起動しない。
- こうして、URL の名前（送り手との約束）と `source`（`/sources` の場所とエージェントの見え方）とプラグインの名前（実装）は、別々に決められる。たとえば前の形の URL `/v1/webhooks/fraction` を保ったまま、`source` を `alertmanager` にできる。

### 4. 取り込み口がすべて受けてから、送り手に成功を返す

- 送り手からの 1 回の要求が出来事を何件作っても、そのすべてが取り込み口から `202` を受けてから、送り手に成功（2xx）を返す。1 件でも `202` を受けられなければ、送り手に `5xx` を返す。
- 送り直しは送り手に任せる。receivers は、受けたものを溜める永続の場所も、送り直しの待ち行列も持たない。送り手の送り直しで同じ出来事がもう一度届いても、同じ `id` なので backend が重複として落とす。
- 送り手の要求そのものが確かめを通らない、または読めない形なら、送り手に 4xx を返す。送り直しても通らないためである。
- 後に足すプラグイン（Slack の ack など、送り手に受けたことを返す形のもの）も、この形に従う。

### 5. Alertmanager のプラグイン

#### 確かめ方

- 要求の `Authorization: Bearer <token>` を、有効化の設定が指すファイルの token と照らす。token の値は設定のファイルにも環境変数にも書かず、ファイルから読む。
- token のファイルが設定に無い、または読めなければ、receivers は起動しない。token の無い受け口を開かない。
- token が無い・違う要求は `401` で断り、出来事を作らない。

#### 出来事の単位と封筒

- アラート 1 件の状態の変わり目ごとに、出来事を 1 件作る。1 回の POST に複数のアラートがあれば、アラートごとに 1 件である。
- `id` は fingerprint・状態・始まりの時刻から作る。同じアラートの同じ状態の送り直し（`repeat_interval` によるものも、5xx の後のものも）は同じ `id` になり、backend が重複として落とす。同じアラートが一度止んで再び鳴れば、始まりの時刻が変わるので別の出来事になる。
- エージェントには、鳴り始めと鳴り止みだけが届く。鳴り続けていることの知らせは届かない。今鳴っているアラートを知りたければ、エージェントが Alertmanager やクラスタに尋ねる。
- `stream` は `alertname` から作る（`/sources/<source>/<alertname から作った名前>/`）。`alertname` の中の、`stream` に使えない文字は使える文字に写す。大文字は小文字にし、そのほかの使えない文字は 1 つの決まった文字に替える。写した結果が同じになるアラートは同じ `stream` に入るが、元の `alertname` は `payload` のラベルにそのまま残る。`alertname` が無い、または写すと空になるアラートは、`stream` を省く。写し方の細部は仕様書が決める。
- `payload` は、Alertmanager のアラート 1 件をそのまま（ラベル・注釈・始まりと終わりの時刻・出どころの URL・fingerprint・状態）と、その POST の `externalURL` である。組の共通のラベルなど、1 件のアラートに無いものは足さない。
- `summary` は、状態・`severity` のラベル・`alertname`・注釈の `summary` を `[FIRING critical] <alertname>: <注釈の summary>` の形で 1 行にしたもので、200 文字までに切る。
- `payload` と `summary` の中身は外から来た文として扱う。アラートの読み方をプロンプトに書かない。読み方が要るなら skill にする（ADR-0008）。

#### `delivery`

- 鳴り始め（`firing`）のアラートのうち、`severity` のラベルが設定の一覧にあるものだけを `now` にする。一覧の既定は `critical` だけである。
- ほかの鳴り始めと、鳴り止み（`resolved`）はすべて `batch` にする。

#### 自分で足したアラートを捨てる

- 設定の印のラベル（名前と値。既定は例えば `sender="penelope"`）を持つアラートは、出来事にせずに捨てる。エージェントがオーナーへの知らせとして足したアラートが、自分への出来事として戻らないようにするためである。
- 捨てたアラートは、取り込み口に送れたものと同じに数える。そのアラートしか無い要求にも成功を返す。
- 印を付けるのはエージェントである。付け方はコネクタの文書に書く（ADR-0020）。付け忘れたアラートは、ふつうのアラートとして戻ってくるだけである。

### 守る対象と、失敗したときの倒し方

- 守る対象は、エージェントの出来事の入口である。確かめを通らない要求から出来事を作らない。token が読めない設定では起動しないので、確かめの無い口が開いたままにはならない。
- 受信の鍵（Alertmanager の token）は receivers のコンテナにだけ置く。backend と sandbox は持たない（ADR-0002）。
- 取り込み口に送れないときは、送り手に `5xx` を返す側に倒す。出来事を黙って失わない。代わりに、送り手が送り直す限り同じ知らせが何度か届くが、backend が重複を落とす。

### 本 ADR で決定しないこと

- 設定のファイルの形、待ち受けのアドレス、HTTP の応答と health の口の細部、プラグインの内側の契約、Alertmanager の `id`・`stream`・`summary` の作り方の細部（委譲先: [receivers の仕様書](../receivers.md)）
- GitHub の webhook のプラグイン（委譲先: GitHub の webhook を受けるときの ADR。docs/receivers.md の「後に足すプラグイン」に挙げる）
- Slack のプラグイン（委譲先: Slack を受けるときの ADR。docs/receivers.md の「後に足すプラグイン」に挙げる）
  - 2026-11-16 追記: ADR-0028 で決めた。
- 鳴り続けているアラートをエージェントに知らせるか（委譲先: 同上の「後に足すプラグイン」。要るとなったときに別の ADR にする）
- オーナーへの知らせの仕組みと、Alertmanager にアラートを足す道との関係（委譲先: オーナーへの知らせの仕組みを決める ADR。docs/receivers.md の「後に足すプラグイン」に挙げる）
  - 2026-11-16 追記: 返事の知らせは ADR-0027 で決めた（Web Push）。Alertmanager にアラートを足す道との関係は決めていない。
- 個別の配置の設定（有効にするプラグイン、URL の名前、token の置き場所、印のラベルの値）（委譲先: 配置のリポジトリ）

## Consequences

- 受信元を足すときに、backend とプロンプトは変わらない。receivers にプラグインを 1 つ足し、配置の設定に 1 つ書く。
- 送り手に渡してある URL と token を変えずに、受け持つ側をなつみベースの形から receivers に替えられる。送り手の設定を触らずに済み、戻すときも送り手は触らない。
- receivers は状態を持たないので、再起動しても失うものが無く、永続の volume も要らない。
- 一方で、取り込み口に送れない間の出来事は、送り手の送り直しに頼る。送り手が送り直しを諦めれば（Alertmanager なら、次の通知の時期まで）その出来事は届かない。receivers が溜めて送り直す形より、取りこぼしの面が送り手の性質に左右されることを受け入れる。
- 1 回の要求の一部だけが取り込み口に入った後に失敗すると、送り手はその要求の全部を送り直す。入った分は backend が重複として落とすので、出来事は重ならない。
- プラグインは外から差し込めないので、受信元を足すたびにこのリポジトリの版上げが要る。代わりに、image に入るコードはすべてこのリポジトリで確かめられる。
- `stream` の名前を写すので、`alertname` の大文字と小文字だけが違うアラートは同じ `stream` に入る。エージェントは `payload` のラベルで元の名前を読める。
- 鳴り続けていることは知らせないので、エージェントが今の状態を知るには、自分で尋ねる必要がある。

## Alternatives Considered

- **プラグインを別の image や別のプロセスとして外から差し込む**: プラグインごとに別の版と配置が要り、受信の鍵の置き場所も増える。いまの受信元は数が少なく、すべてこのリポジトリで書くので、差し込む口の分だけ複雑になる。
- **receivers が受けたものを永続の場所に溜めて、自分で送り直す**: 取りこぼしの面は送り手に左右されなくなるが、receivers に永続の volume と待ち行列が要る。送り手（Alertmanager・Slack・GitHub）はいずれも失敗のときに送り直すので、その送り直しに乗る方が単純である。
- **Alertmanager の 1 回の POST（組）を 1 件の出来事にする**: 組の中身は時とともに変わり、同じ組の送り直しにどの ID を付けても、変わったアラートと送り直しを分けられない。アラート 1 件の状態の変わり目ならば、送り直しは同じ `id` になる。
- **`source` を URL の名前と同じにする**: 前の形の URL `/v1/webhooks/fraction` を保つと、`source` が `fraction` になり、`/sources` の中で何の受信元かが分からない。
- **`alertname` が `stream` の制限に外れたアラートを断る、または `stream` を付けない**: Alertmanager の多くのアラートの名前は大文字を含むので、断れば多くの警報が届かず、付けなければアラートごとの分けが無くなる。

## Related ADRs

- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす（receivers のコンテナ）
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく（プラグイン、受信の鍵、取り込み口、少なくとも 1 回の配送）
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる（アラートの読み方をプロンプトに書かない）
- Related: ADR-0013 出来事の中身は backend が `/sources` に追記し、ターンには要約と場所だけを渡す（`stream` と `summary`）
- Related: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける（receivers の TCP の口は外から呼ばれる口として確かめる）
- Related: ADR-0020 コネクタは Sentinel の登録と使い方の文書の組にし、文書の一覧をシステムプロンプトに出す（自分で足すアラートの印の付け方はコネクタの文書に書く）
- Related: ADR-0027 本人への返事はすべて Web Push で知らせ、購読は配置ごとに backend が持つ（オーナーへの知らせの仕組み）
- Related: [ADR-0079 会話する配置は家に住み、承認は家で答え、個人のページは家から開く](0079-open-resident-pages-from-the-house.md)（配置ごとの Web Push は廃止）。
- Related: ADR-0028 Slack は receivers のプラグインが Socket Mode で受け、つなぎ直しのたびに最近の発言を取り直す（Slack のプラグイン、外へ接続を張る種類）
- Related（natsumi、このリポジトリの外）: ADR 0091「webhook の受け口を 1 つにし、届いたものの読み方は型としてコードに持つ」（前の形の受け口。URL と token を引き継ぐ）

## References

- Alertmanager の設定の文書「`<webhook_config>`」（https://prometheus.io/docs/alerting/latest/configuration/#webhook_config 、2026-11-15 確認）: 1 回の POST の JSON の形（`version`・`groupKey`・`status`・`receiver`・`groupLabels`・`commonLabels`・`commonAnnotations`・`externalURL`・`alerts`。アラートは `status`・`labels`・`annotations`・`startsAt`・`endsAt`・`generatorURL`・`fingerprint`）、`http_config` の `authorization` の `type` の既定が `Bearer` で、`credentials_file` から読めること
- Alertmanager の `notify/util.go` の `Retrier.Check`（https://github.com/prometheus/alertmanager/blob/main/notify/util.go 、2026-11-15 確認）: 2xx は成功、5xx は送り直し、ほかは送り直さない
- Prometheus の文書「Data model」の「Metric names and labels」（https://prometheus.io/docs/concepts/data_model/ 、2026-11-15 確認）: ラベルの値は任意の Unicode の文字を持てる
- natsumi ADR 0091「webhook の受け口を 1 つにし、届いたものの読み方は型としてコードに持つ」（https://github.com/yuanying/natsumi/blob/main/docs/adr/0091-one-way-in-for-webhooks-with-formats-in-the-code.md 、2026-11-15 確認）: なつみベースの前の形の受け口 `POST /v1/webhooks/<名前>`、webhook ごとの bearer token、型 `alertmanager`、書き終えてから 2xx・書けなければ 5xx で送り手の送り直しに任せること
- Alertmanager の設定の文書「`<route>`」（https://prometheus.io/docs/alerting/latest/configuration/#route 、2026-11-15 確認）: `repeat_interval` は、送れた知らせを再び送るまでの待ち
- [Pod の形の仕様書](../pod.md) の「待ち受け」: TCP で待ち受ける Pod の外から呼ばれる口は、Pod の外から届くのと同じ確かめを通す
- [出来事の仕様書](../events.md) の「封筒」（`source` と `stream` に使える文字）と「取り込み口」（応答の意味、backend の中の受信元の名前を断ること）
