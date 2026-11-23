# 0006. 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う

- Date: 2026-11-14
- Status: Accepted（一部を [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md) で置き換え。Git の保守は [ADR-0058](0058-read-memory-history-on-demand.md) で追加）

## Context

エージェントの記憶は、git のリポジトリの Markdown として持つ。今の natsumi の `/memory` には、常時記憶の `always.md`、性格の `personality.md`、夜の引き継ぎの `handoff.md`、索引の `INDEX.md`、日ごとの `diary/`、古い事実の要約を置く `archive/`、エージェントが自由に切るトピックのファイルがある。ペネロペの記憶もこの形であり、penelope に移っても持ち越す。

natsumi の server は、ターンの終わりに記憶をコミットし、そのときに検査を掛ける。検査は大きく 4 種類ある。

- 書き手の分担（`INDEX.md` と `archive/` は夜の整理係だけ、など）
- プロンプトに入るファイルの上限と、書き換えてよい時間帯（`always.md`・`personality.md` は夜だけ）
- 中身の衛生（`.md` だけ、空・大きすぎるもの、制御文字、chat template の制御文字列、日本語以外の文字）
- 書き手の時間帯（日中のエージェントか、夜の整理係か）

検査に当たったものは戻され、整理係の変更は工程ごとに全部か無しかで捨てられる。エージェントが自分で組み替えた記憶が、検査で一部だけ戻されることがある。

オーナーは「自分の記憶なのだから好きに書き換えればよい。git に履歴がある」と考えている。守りたいのは、履歴が書き換えられないことである。

## Decision

[ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md) は固定名と書き手の約束を一部更新する。[ADR-0052 夜の係が移動した記憶への参照は runner が直す](0052-repair-memory-references-after-nightly-moves.md) は runner による機械的な参照の修正を加える。検査を復活させず、コミットは sandbox の外で行う。

### `/memory` の形を保つ

- `/memory` は、natsumi の記憶のリポジトリと同じ形のまま持つ。固定のファイル名と置き場所（`always.md`・`personality.md`・`handoff.md`・`INDEX.md`・`diary/`・`archive/`）を変えない。penelope に移るときに、記憶を書き換えずに履歴ごと持ち込める。

### 検査をやめる

- コミットの前の検査を置かない。エージェントは、自分の記憶のどのファイルを、いつ書き換えてもよい。
- ファイルの持ち主（どのファイルを誰が書くか）の決まりも置かない。

### コミットは sandbox の外で backend がする

- `/memory` の `.git` は、sandbox からは読むだけにする。エージェントは履歴を見られるが、書き換えられない。
- ターンの終わりに、backend が sandbox の外で、変わったものをそのままコミットする。
- オーナーが ssh で自分の変更をコミットする道は残す。
- backend による定期的な Git の保守は [ADR-0058](0058-read-memory-history-on-demand.md) で加える。sandbox からは引き続き読むだけとする。

### プロンプトに入れるときだけ長さを見る

- `always.md` などのプロンプトに入るファイルが長すぎるときは、プロンプトを組むときにそれを入れず、入れなかったことをプロンプトに添える。ファイルそのものは戻さない。

### 本 ADR で決定しないこと

- プロンプトに入れるファイルの長さの上限の値（委譲先: backend の設定）
- コミットの作者とメッセージの形（委譲先: [backend の仕様書](../backend.md)）
- 記憶のリポジトリを外へ push するか（委譲先: オーナーの運用）

## Consequences

- エージェントは記憶を自由に組み替えられる。検査で戻されて、記憶がちぐはぐになることがなくなる。
- 履歴は sandbox の外でだけ作られるので、エージェントが過去の記憶を消して痕跡を隠すことはできない。
- 一方で、壊れた中身（制御文字、巨大なファイル）がそのままコミットされうる。気づくのはプロンプトに入るときか、オーナーが読んだときになる。git の履歴から戻せることを受け入れる。
- 強いモデルを前提にした判断である。検査が防いでいた壊れた書き込みは、弱いモデルで動かすと増える見込みがある。

## Alternatives Considered

- **エージェントが自分で git を使ってコミットする**: 履歴をエージェントが書き換えられる。
- **natsumi の検査を持ち込む**: エージェントが自分の記憶を自由に組み替えられず、守りたい線（履歴を書き換えられないこと）は `.git` を読むだけにすれば足りる。

## Related ADRs

- Related: ADR-0007 セッションは 1 本にし、夜に振り返り・整理係・新しいセッションの 3 段で切り替える（本体のセッションの切り替え）
- Related: [ADR-0044 夜は記憶を原本と照合してから整理し、週に一度は棚卸しする](0044-check-memory-against-records-before-nightly-organization.md)（照合はモデルの役目であり、コミット前の検査やファイルの持ち主は設けない）
- Related: ADR-0008 プロンプトは事実と環境だけを伝え、やり方は任せる
- Related（natsumi、このリポジトリの外）: ADR 0018「記憶を git で持ち、shell で読み書きし、夜に組み直す」、ADR 0055「記憶の組み直しは、人格を持たない整理係が夜に行う」、ADR 0067「本人が ssh で記憶を自分でコミットする」、ADR 0068「整理係は人間の記憶のように、工程を分けて古い記憶を要約し、出来事を知識にする」
- Superseded by（一部）: [ADR-0049 配置ごとの目的に沿って記憶を知識ベースに育てる](0049-grow-memory-around-an-instance-purpose.md)（Decision「`/memory` の形を保つ」と「検査をやめる」に任意の固定名と、強制しない書き手の約束を加える）。
- Related: [ADR-0052 夜の係が移動した記憶への参照は runner が直す](0052-repair-memory-references-after-nightly-moves.md)（Decision「コミットは sandbox の外で backend がする」は維持し、runner は参照を直す）。
- Superseded by（一部）: [ADR-0058 記憶の差分統計は必要な変更だけを計算し、Git の保守は backend が行う](0058-read-memory-history-on-demand.md)（Decision「コミットは sandbox の外で backend がする」に、backend による保守を加える）。

## References

- natsumi の README の記憶の節（https://github.com/yuanying/natsumi/blob/main/README.md 、2026-11-14 確認）: 固定のファイルと `INDEX.md`・`diary/`・`archive/`、書ける時間帯と書き手の決まり
- natsumi ADR 0018（https://github.com/yuanying/natsumi/blob/main/docs/adr/0018-memory-in-git-and-the-nightly-rebuild.md 、2026-11-14 確認）: 記憶を 1 つの git リポジトリで持ち、server は commit だけをする
- natsumi ADR 0055（https://github.com/yuanying/natsumi/blob/main/docs/adr/0055-a-memory-curator-at-night.md 、2026-11-14 確認）: 係のコミットにも `.md` 以外・空・大きすぎる・制御文字列・日本語以外の文字の検査を掛け、当たれば全部を捨てる
- natsumi ADR 0067（https://github.com/yuanying/natsumi/blob/main/docs/adr/0067-the-owner-commits-memory-over-ssh.md 、2026-11-14 確認）
- natsumi ADR 0068（https://github.com/yuanying/natsumi/blob/main/docs/adr/0068-a-curator-that-remembers-like-a-person.md 、2026-11-14 確認）
