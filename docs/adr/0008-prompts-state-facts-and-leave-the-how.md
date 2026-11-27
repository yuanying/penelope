# 0008. プロンプトは事実と環境だけを伝え、やり方は任せる

- Date: 2026-11-14
- Status: Accepted（一部を [ADR-0045 夜のプロンプトは目的を伝え、印の付いたモデルだけに手順を足す](0045-tell-nightly-roles-their-goals-and-add-guidance-by-model.md) と [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md)、[ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md) で置き換え）

## Context

natsumi のシステムプロンプトは 1 ファイルで 511 行・約 58KB ある。中には、書き方の規則、手順、出来事ごとの扱い、禁止が並んでいる。オーナーは、新しい形では「あれこれ指図や制限をする」プロンプトにしたくないと考えている。

penelope では、エージェントは Pi の基本のツールで何でもでき（ADR-0001）、守りたい線の多くは仕組みで守る。外向きの通信は Sentinel が受け（ADR-0003）、鍵は sandbox の外にあり（ADR-0004）、記憶の履歴は sandbox から書き換えられない（ADR-0006）。

## Decision

対象は、システムプロンプト、ツールの説明、ターンの入力の文面である。

[ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md) は、日中に加える記憶と、日中・夜の係に共通の記憶の形の説明に限って例外を加える。

- 事実と環境を伝え、やり方はエージェントに任せる。指図と禁止を積み重ねない。
- システムプロンプトに書くのは次のものだけである。
  - 誰か（名前・役目・オーナー）
  - どこにいるか（sandbox の中であること、外向きは Sentinel を通ること、内部の CA）
  - 出来事がどう届き、どう返すか
  - `/memory` の骨組み
  - 2026-11-27 追記: [ADR-0069](0069-sleep-by-her-own-call-until-a-wake-time.md) で、この一覧に「自分の様子（眠り、眠気、気分）がどう働くか」を足した。
- 書き方の規則、手順、出来事ごとの扱いはプロンプトに書かない。要るものは、オーナーが `always.md` か skill に書く。
- 守らなければならない線は、文ではなく仕組み（Sentinel、書けないファイル）で守る。
- プロンプトは英語で書く。オーナーと話す言葉は `personality.md` に任せる。
- 性格、常時記憶、引き継ぎは、そのままプロンプトの後ろに足す。日本語の記憶は日本語のまま入れる。
- 受信元ごとの出来事の中身の読み方は、プロンプトに書かない（ADR-0002）。

この方針は、リポジトリの `AGENTS.md` の「Prompts」の節にも置き、コードを書く者が参照できるようにする。

### 本 ADR で決定しないこと

- システムプロンプトの文面（委譲先: プロンプトのファイル。実装の作業単位で書く）
- skill の置き場所と読み込み方（委譲先: runner の仕様書）

## Consequences

- プロンプトが短くなり、何がエージェントに伝わっているかを読み取りやすくなる。
- 振る舞いを直したいときは、プロンプトに 1 文足すのではなく、記憶・skill・仕組みのどれで直すかを考えることになる。
- 一方で、モデルが誤った判断をしたときに、プロンプトで止める手段を自分から捨てる。仕組みで守れない線は、記録で気づいて記憶か skill で直すことを受け入れる。
- 英語のプロンプトと日本語の記憶が混ざる。モデルが両方を読めることを前提にする。

## Alternatives Considered

- **今のプロンプトを英訳して削る**: 指図の多い形が残る。

## Related ADRs

- Superseded by（一部）: [ADR-0069 エージェントは `sleep` で自分で眠り、起きる時刻まで出来事を受け取らない](0069-sleep-by-her-own-call-until-a-wake-time.md)（Decision の、システムプロンプトに書くものの一覧に「自分の様子（眠り、眠気、気分）がどう働くか」を足す）
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす
- Related: ADR-0002 出来事は取り込み口 1 つの待ち行列に入れ、sandbox の runner が取りにいく
- Related: ADR-0003 sandbox の外向きはすべて Sentinel を通し、既定は素通しで記録する
- Related: ADR-0004 本物の鍵は Sentinel が持ち、鍵の出どころは差し替えられる口にする
- Related: ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う
- Related: ADR-0007 セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える（本体のセッションの切り替え）
- Related: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md)（夜の各段に渡す目的と資料）
- Superseded by（一部）: [ADR-0045 夜のプロンプトは目的を伝え、印の付いたモデルだけに手順を足す](0045-tell-nightly-roles-their-goals-and-add-guidance-by-model.md)（Decision のプロンプトに書く内容と手順を置かない方針に、夜に限った例外を設ける）
- Superseded by（一部）: [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md)（Decision のうち、プロンプトに足す記憶の範囲と書き方の規則を置かない点に例外を加える）。

## References

- natsumi `src/server/prompts.ts`（https://github.com/yuanying/natsumi/blob/main/src/server/prompts.ts 、511 行・58,095 バイト、2026-11-14 確認）
