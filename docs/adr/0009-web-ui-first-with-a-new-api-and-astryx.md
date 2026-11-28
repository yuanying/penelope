# 0009. 最初の UI は Web だけにし、新しい API と Astryx で作る

- Date: 2026-11-14
- Status: Accepted（Decision「Astryx と React 19」の、最初の Web UI にアバターを出さない点は ADR-0016 で置き換え。一部を ADR-0079 で置き換え）

## Context

natsumi には、Web のダッシュボードのほかに Mac と iPhone のアプリがあり、server とは natsumi の v1 の封筒の形で話す。ペネロペは、Mac と iPhone のアプリを使っていない。

penelope の UI は backend と分けて作る（オーナーの求め）。UI が backend から受け取るものは、エージェントの返事のほかに、途中の思考、ツールの呼び出しと結果、ターンの始まりと終わり（ADR-0002）、Sentinel の承認待ち（ADR-0005）である。

オーナーは、Web UI のデザインを洗練したものにしたいと考えており、デザインシステムに Astryx を使いたいとしている。Astryx は Meta が公開しているデザインシステムで、MIT ライセンス、React 19 以降を前提とし、StyleX で書かれた 150 以上のコンポーネントを持つ。Beta である。

オーナーは、画面の見た目を Claude design で詰めたいと考えている。Claude design を操作するのはオーナーである。

## Decision

### 最初は Web だけ

- 最初の UI は Web だけにする。
- UI 向けの API は新しく作る。API が持つのは、発言を送る、履歴を読む、出来事の流れ（思考・途中経過・返事）を受け取る、承認に答える、の 4 つである。出来事の流れは、サーバーから押し出す方式（SSE か WebSocket）で受け取る。
- natsumi の v1 の封筒との互換は取らない。Mac と iPhone のアプリは、後で新しい API につなぎ直す。
- Slack は UI ではなく、受信は receivers、投稿は Sentinel を通る外向きの通信として扱う（ADR-0002、ADR-0003）。

### Astryx と React 19

- Web UI は React 19 と Astryx で作る。Astryx は Beta なので、版を固定する。
- エージェントの名前とアイコンは、設定から表示する。決め打ちの名前を UI に残さない（ADR-0001）。
- 最初の Web UI にアバターは出さない。返事の API には表情（expression）の欄を残し、後でアバターを足せるようにする。
  - 2026-11-14 追記: ADR-0016 で置き換え。オーナーが画面を詰めた結果、最初の Web UI からアバターを表情ごとの絵で出す。返事の API の expression の欄は変わらない。

### 画面の合意の進め方

- 画面の骨組み（画面の一覧と流れ）は、文書でオーナーと合意する。
- 見た目は、骨組みとデザインの依頼書（Astryx を使うこと、画面の一覧、出来事の流れの形、テーマの方向）をもとに、オーナーが Claude design で詰める。
- 決まった見た目（画像と、コードか handoff）は、このリポジトリの `docs/design/` に置く。実装はそれを正として Astryx で組む。

### 本 ADR で決定しないこと

- SSE と WebSocket のどちらにするか、出来事の流れの細かさ（トークンごとか、ブロックごとか）（委譲先: [UI 向けの API の仕様書](../ui-api.md)）
- 画面の一覧と流れ（委譲先: 画面の骨組みの文書。後で `docs/design/` に置く）
- 固定する Astryx の版（委譲先: Web UI の実装の PR）
- Mac・iPhone のアプリをつなぎ直す時期（委譲先: そのときの ADR）
- 承認待ちの知らせを Web Push と Slack のどちらにするか（委譲先: ADR-0005 の「本 ADR で決定しないこと」）
- ログイン（委譲先: ADR-0010）

## Consequences

- API を新しく作るので、penelope の出来事の形（ADR-0002）にそのまま合わせられる。v1 の封筒の都合を持ち込まない。
- 画面の見た目は文書ではなく、オーナーが Claude design で作ったものが正になる。実装の worker が見た目を推測で決めずに済む。
- 一方で、Mac と iPhone からは、つなぎ直すまで使えない。
- Astryx は Beta なので、版を上げるたびに壊れる可能性がある。版を固定し、上げるときに確かめる手間を受け入れる。
- 見た目を詰める作業がオーナーの手にあるので、UI の実装はその作業を待つ。

## Alternatives Considered

- **natsumi の v1 の封筒と互換にして、今の Mac・iPhone のアプリをつなぐ**: ペネロペは Mac・iPhone を使っておらず、互換のために古い形を持ち込む理由が無い。

## Related ADRs

- Superseded by（一部）: [ADR-0079 会話する配置は家に住み、承認は家で答え、個人のページは家から開く](0079-open-resident-pages-from-the-house.md)（配置ごとの会話と、アプリがその会話 API を使う方針）。
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0005 承認待ちは Sentinel が持ち、オーナーは Web UI で答える
- Related: ADR-0010 人は GitHub OAuth で、A2A の送り手は ServiceAccount の token で確かめる
- Superseded by（一部）: ADR-0016 最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる（Decision「Astryx と React 19」の、最初の Web UI にアバターを出さない点）

## References

- Astryx（https://github.com/meta/astryx 、2026-11-14 確認）: MIT、React 19 以降、StyleX で書かれ、150 以上のコンポーネントを持つ。"Currently in Beta"
- natsumi の client の契約 `docs/client-contract.md`（https://github.com/yuanying/natsumi/blob/main/docs/client-contract.md 、2026-11-14 確認）
