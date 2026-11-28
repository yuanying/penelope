# 0016. 最初の Web UI からアバターを表情ごとの絵で出し、アバターは 1 つの部品に閉じる

- Date: 2026-11-14
- Status: Accepted（一部を ADR-0078 で置き換え）

## Context

ADR-0009 の Decision「Astryx と React 19」は、最初の Web UI にアバターを出さず、返事の API に表情（expression）の欄だけを残すと決めた。画面の見た目は、オーナーが Claude design で詰めるまで決まっていなかった。

その後、オーナーは Claude design で画面を詰め、アバターと expression を最初の版から出すと決めた。決まった見た目は、このリポジトリの `docs/design/`（デザインの手引きと、採用した画面）にある。手引きでは、アバターは PC の右のパネル、PC の上の帯、スマートフォンで上に浮く位置、下からのシート、返事の名前の横、ログインの画面に出る。expression は、アバターに添える文字の札と、返事の名前の横の文字で示す。

手引きを決めた時点では、アバターは固定のアイコン 1 枚に expression の札を添え、expression ごとに絵を差し替えないとしていた。その後オーナーは、natsumi と同じように、表情ごとに絵を切り替えると決めた。natsumi には、ペネロペの表情のアイコンが 9 種（neutral・happy・laughing・surprised・thinking・worried・sad・sleepy・angry）あり、natsumi のアバターは、考えている最中は thinking になり、ほかの表情は一定の時間見せると neutral に戻る。

オーナーは、ゆくゆくはアバターを 3D のモデルなどに替えたいと考えている。

## Decision

本 ADR は、ADR-0009 の Decision「Astryx と React 19」のうち「最初の Web UI にアバターは出さない」の点を置き換える。返事の API に expression の欄があること、エージェントの名前とアイコンを設定から出すこと（ADR-0001）は変えない。

- 最初の Web UI から、アバターと expression を出す。どこにどの大きさで出すかは `docs/design/` の手引きに従う。
- アバターの絵は、expression ごとに差し替える。絵は、backend の設定で選んだアバターの表情のアイコンである。コードは特定のアバターに依存しない（ADR-0001）。
- expression の語は、アバターの表情の 9 種（neutral・happy・laughing・surprised・thinking・worried・sad・sleepy・angry）とする。知らない語や、アバターに無い表情は neutral として出す。
- 返事に添えるアバターは、その返事の expression の絵にする。エージェントの今の姿として出すアバターは、ターンの最中は thinking の絵にし、出来事を待っているときは、いちばん新しい返事の expression の絵にして、一定の時間がたつと neutral に戻す。
- アバターは Web UI の中の 1 つの部品に閉じる。部品が受け取るのは expression と大きさだけで、絵と名前は設定から入る。絵の描き方を替えるときは、この部品の中だけを替え、画面の側は変えない。

### 本 ADR で決定しないこと

- neutral に戻るまでの時間（委譲先: `docs/design/` の手引きの「6. アバター」と「まだ決めていないこと」）
- アバターのファイルの形と、設定での選び方（委譲先: [backend の仕様書](../backend.md) の「設定」と [UI 向けの API の仕様書](../ui-api.md) の「エージェント」）
- 3D のモデルなどに替える時期と方式（委譲先: そのときの ADR）
- Mac・iPhone のアプリでのアバター（委譲先: ADR-0009 の「本 ADR で決定しないこと」の、つなぎ直す時期の ADR）

## Consequences

- オーナーは最初の版から、natsumi と同じく、エージェントの返事とともに表情を見られる。返事の API に残してあった expression の欄が使われる。
- アバターを 1 つの部品に閉じるので、絵を替えるときに画面の側を書き換えずに済む。
- 一方で、expression の語はアバターの表情に縛られる。表情の違うアバターを選ぶと、エージェントが付ける語と絵が合わなくなり、合わない語は neutral になる。
- 画面にアバターの置き場所が増えるので、どの大きさでも表情を見分けられる絵である必要がある。

## Related ADRs

- Superseded by（一部）: [ADR-0078 `reply` は今いる部屋か、出かけているときはオーナーに届ける](0078-route-replies-through-the-house.md)（会話の表情を表示する画面。表情の語彙は引き継ぐ）。
- Supersedes（一部）: ADR-0009 最初の UI は Web だけにし、新しい API と Astryx で作る（Decision「Astryx と React 19」の、最初の Web UI にアバターを出さない点）
- Related: ADR-0001 1 つの Pod に backend・Sentinel・sandbox・receivers を置き、Pi ごと sandbox の中で動かす

## References

- Web UI のデザインの手引き `docs/design/README.md` の「6. アバター」（2026-11-14 確認）
- natsumi のペネロペのアバター `assets/avatars/penelope/`（https://github.com/yuanying/natsumi 、2026-11-14 確認）: 表情のアイコン 9 種
- natsumi の `src/server/scheduler.ts` の `DEFAULT_EXPRESSION_RESET_MINUTES`（3 分）と `src/server/thinking-loop.ts` の `relaxExpression`（https://github.com/yuanying/natsumi 、2026-11-14 確認）: 表情を一定の時間見せると neutral に戻す
