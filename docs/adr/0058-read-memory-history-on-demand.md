# 0058. 記憶の差分統計は必要な変更だけを計算し、Git の保守は backend が行う

- Date: 2026-11-23
- Status: Accepted

## Context

記憶の画面はコミット済みの版を読む。従来は backend が初回の要求で、第一親の全履歴について移動を検出し、追加・削除行数を計算してメモリに索引を作っていた。変更一覧の最初の 50 件を返すだけでも古い本文の差分が必要で、backend が再起動するたびにその処理をやり直す。一方、ファイル一覧には長く変更されていないファイルの最終変更も必要になる。ターン末などのコミットが作る loose object をまとめる定期処理もなかった。

## Decision

- 履歴は要求で選んだ第一親の範囲から読み、追加・削除行数は返す変更の分だけ計算する。移動の検出も原則としてその要求に必要な変更だけを対象にする。日別のファイル数は絞り込み後の一日全体を対象とし、移動は新しいパスだけを数えるため、一覧に現れる日に限り、ページ外でも移動を検出する。
- ファイル一覧の最終変更だけは、差分統計や移動の検出を伴わないパスの索引としてメモリに持つ。起動時に裏で準備し、以後は履歴の続きだけを反映する。履歴がつながらなければ作り直す。コミットの写しを永続ストアには置かない。
- backend が Git のオブジェクトを定期的にまとめる。ターン末のコミットやオーナーの保存と同じ待ち行列に並べる。sandbox の `.git` は引き続き読み取り専用で、まとめた後も読めるようにする。保守に失敗しても夜の切り替え・後続のコミットを止めず、Git の出力や記憶の中身はログに載せない。
- 閲覧の要求ごとに版を固定し、現在の HEAD の第一親の履歴だけをオーナーに返す。閲覧・保存とも認証できない要求は拒否し、閲覧の口からは書き込まない。

### 本 ADR で決定しないこと

- 索引の構造、Git の呼び出し方と保守の間隔（委譲先: References の backend の仕様書）。
- 閲覧と保存の契約（委譲先: References の UI API の仕様書）。

## Consequences

- 一覧の最初のページは古い本文の差分を計算せずに返せる。履歴の時刻順を保つためにコミット情報を読むことや、同じページ・日を再度開くと必要な差分を計算し直すことは受け入れる。
- ファイル一覧が裏の索引より先に来た場合は、同じ処理の完了を待つ。backend は起動時に軽い履歴の読み取りを一度行う。
- loose object はまとまるが、保守が実行中であれば、新しいコミットは同じ待ち行列で待つ。

## Alternatives Considered

- **全履歴の差分統計を永続ストアに置く**: backend が再起動しても再利用できるが、初回の差分計算は残り、Git の履歴と別のストアの整合も維持する必要がある。

## Related ADRs

- Supersedes（一部）: [ADR-0056 記憶の画面はコミット済みの版を読み、活動の記録と行き来できるようにする](0056-read-committed-memory.md) の Decision（検索と履歴の索引）および Consequences（初回の索引の費用）。
- Supersedes（一部）: [ADR-0006 記憶は `/memory` の形を保ち、検査をやめ、コミットだけを sandbox の外で行う](0006-memory-kept-compatible-without-checks-committed-outside.md) の Decision（コミットは sandbox の外で backend がする）に、backend による保守を加える。
- Related: [ADR-0057 オーナーによる記憶の編集と復元は、backend が 1 ファイルずつ確定する](0057-edit-existing-memory-in-the-backend.md) の保存とコミットの直列化を保つ。

## References

以下は 2026-11-23 に確認。

- 変更前の [`memory.ts` の `Memory.commit`](https://github.com/yuanying/penelope/blob/b35370f/packages/backend/src/memory.ts): ターン末のコミットと待ち行列。保守の定期処理はなかった。
- 変更前の [`memory-view.ts` の `MemoryView.loadIndex`](https://github.com/yuanying/penelope/blob/b35370f/packages/backend/src/memory-view.ts) と [`memory-git.ts` の `MemoryGit.changes`](https://github.com/yuanying/penelope/blob/b35370f/packages/backend/src/memory-git.ts): 初回の全履歴の読み取りと統計の計算。
- [backend の「コミット済みの記憶の閲覧」](../backend.md#コミット済みの記憶の閲覧) と「[`/memory` のコミット](../backend.md#memory-のコミット)」: 読み取りの範囲と保守の実行条件。
- [UI API の「記憶」](../ui-api.md#記憶): ページと日別集計、閲覧・保存の契約。
