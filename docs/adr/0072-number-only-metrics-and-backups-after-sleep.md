# 0072. backend は数だけの metrics を別の待ち受けに出し、backup は眠りが済んだ時刻と比べて始める

- Date: 2026-11-27
- Status: Accepted

## Context

配置の backup は、1 日 1 回、決まった時刻に 2 つの永続の場所を写す。時刻は夜の切り替えの後に置いてある。振り返りと記憶の整理が済んだ後の状態を写すためである。

エージェントが自分で眠るようになると（[ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md)）、切り替えの時刻は決まらない。決まった時刻の backup は、眠りの前の状態を写す日も、4 段の途中を写す日も出る。

オーナーは、penelope は「眠りの 4 段が済んだ」ことを見えるようにするだけにし、backup はそれを見た外の仕組みが始める形を求めた。backup を始めるための部品も権限も、penelope には足さない。

backend には metrics の口が無い。backend が TCP で待ち受けるのは、Pod の外から呼ばれる口（UI 向けの API と A2A の受け口）だけで、この口は配置の Ingress に載る。Pod の中の TCP の待ち受けには、sandbox からも loopback で届く。

## Decision

適用範囲は、backend が出す metrics と、配置の backup が始まる条件である。backup が何をどう写すかは変えない。

### 1. backend は、数だけの metrics を出す

- 出すのは数だけである。最後に眠りの 4 段が済んだ時刻、眠気（[ADR-0068](0068-sleepiness-as-one-value-with-its-facts.md)）、眠りの状態である。
- 「4 段が済んだ」は、新しいセッションが始まった切り替えを指す。途中の段が失敗していても、新しいセッションが始まっていれば済んだとする。
- 最後に済んだ時刻は、永続の記録から引く。backend が立ち上がり直しても同じ値を出す。
- 気分の文、会話、記憶、出来事の中身は出さない。

### 2. metrics は、UI 向けとは別の待ち受けに出す

- metrics の待ち受けは、Pod の外から呼ばれる口と分ける。配置が設定したときだけ開く。配置はこの待ち受けを Ingress に載せない。

### 3. backup は、状態を比べて始める

- penelope は backup を始めず、終わりも待たない。エージェントは、backup が済んでいなくても起きる。
- 配置の backup は、短い間隔で「最後に眠りの 4 段が済んだ時刻」と「最後に backup を取った時刻」を比べ、眠りのほうが新しいときに写す。合図を取りこぼしても、次の比べで追いつく。
- 眠りが 1 回も無い日も、最後の backup から 1 日たっていれば写す。
- このリポジトリの配置の見本の backup も、この条件に従う。

### 守る対象と、失敗したときの倒し方

- 守る対象は、会話と記憶の中身である。metrics には数しか出さないので、待ち受けには確かめを置かない。
- 許す範囲は、Pod の metrics の待ち受けに届く者が、項 1 の数を読めることである。sandbox からも loopback で読める。同じ数は、ターンの始まりの知らせでエージェントにも渡っている。
- 設定が無ければ待ち受けを開かない。backup が metrics を読めないときは、1 日 1 回の条件だけで写す側に倒す。

### 本 ADR で決定しないこと

- metrics の名前と形、待ち受けの設定（委譲先: [backend の仕様書](../backend.md) と [Pod の形の仕様書](../pod.md) の「待ち受け」。metrics を実装する作業単位で足す）
- backup の間隔と、比べるための時刻の読み方と残し方（委譲先: [Kubernetes の配置の見本](../../deploy/kubernetes/README.md) の「backup」と、配置のリポジトリ）
- 家の記録の backup（委譲先: [ADR-0074](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md) の Decision 項 6（家が止まっているときと、家の backup））

## Consequences

- backup が、眠りで整理された後の状態を写す。penelope に backup のための部品も権限も増えない。
- 状態を比べるので、backup の仕組みが止まっていた間に済んだ眠りにも、戻ってから追いつく。
- 一方で、backup の仕組みは短い間隔で動き続ける。写すものが無い回でも、比べる分の手間はかかる。
- エージェントは backup を待たずに起きるので、睡眠時間が短いと、写している最中にターンが始まることがある。
- metrics の待ち受けが 1 つ増える。Pod に届く者は、眠気と眠りの時刻を読める。

## Alternatives Considered

- **backend が backup を起こす**: backend に、クラスタの仕事を作る権限と、backup の形の知識が要る。
- **「眠りが済んだ」を出来事や webhook で知らせる**: 受ける側が止まっていた間の合図を失う。状態を比べれば失わない。
- **決まった時刻のままにする**: 眠りの前や 4 段の途中の状態を写す日が出る。
- **UI 向けの待ち受けに metrics を載せる**: Ingress に出るので、オーナーのログインと同じ確かめを通すか、外から読めるかのどちらかになる。

## Related ADRs

- Related: [ADR-0068 眠気は backend が 1 つの値にし、元の事実と並べてターンの始まりと heartbeat に渡す](0068-sleepiness-as-one-value-with-its-facts.md)
- Related: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（眠りの記録）
- Related: [ADR-0074 家は居場所と会話を持つ 1 つのサーバーにし、receivers のプラグインと CLI で差し込む](0074-a-house-server-plugged-in-through-receivers-and-a-cli.md)（家の記録の backup）
- Related: ADR-0014 sandbox の loopback は sandbox に任せ、Pod の中の口は Unix socket だけで待ち受ける（TCP の待ち受けには sandbox から届く）
- Related: ADR-0038 活動の記録は backend が 1 行の要約として持ち、ターンの結果と夜の段の結果を runner が知らせる（切り替えの知らせの記録）

## References

- [Kubernetes の配置の見本](../../deploy/kubernetes/README.md) の「backup」と `deploy/kubernetes/components/backup/cronjob.yaml`（2026-11-27 確認）: 1 日 1 回、夜の切り替えの後の決まった時刻に写す
- [Pod の形の仕様書](../pod.md) の「待ち受け」（2026-11-27 確認）: backend が TCP で待ち受けるのは Pod の外から呼ばれる口だけ。TCP の待ち受けには sandbox からも loopback で届く
- [backend の仕様書](../backend.md) の「設定」（2026-11-27 確認）: 待ち受けの設定は UI 向けの TCP と 2 つの Unix socket で、metrics の口は無い
