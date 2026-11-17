# ミャオのアバター

backend の設定で `PENELOPE_AVATAR=myao` を選ぶと、Web UI の名前と表情のアイコンがこのアバターになる（[docs/backend.md](../../../docs/backend.md) の「設定」）。`slackctl post --face` は Slack 用の PNG を投稿のアイコンにする（[docs/receivers.md](../../../docs/receivers.md) の「投稿の CLI」）。コードはどのアバターにも依存しない（[ADR-0001](../../../docs/adr/0001-one-pod-with-pi-inside-the-sandbox.md)）。

| ファイル | 中身 |
| --- | --- |
| `avatar.json` | ID・表示名と、表情ごとのアイコンと Slack 用の PNG の場所 |
| `icons/<表情>.webp` | 顔を切り出した 512×512 の WebP。Web UI が使う。neutral・happy・laughing・surprised・thinking・worried・sad・sleepy・angry の 9 種 |
| `slack/<表情>.png` | 同じ 9 種の 256×256 の PNG。Slack の投稿のアイコンに使う |
| `appearance.yaml` | 絵に描くときの姿（体・服・残す特徴・場面の例）。sandbox の skill `self-portrait` が読む（[docs/pod.md](../../../docs/pod.md) の「姿の素材」） |
| `sdctl-params.yaml` | この姿を描く sdctl の既定の params（モデル・サンプラー・大きさなど）。sandbox の `SDCTL_PARAMS` の既定になる |

## 出どころ

[yuanying/natsumi](https://github.com/yuanying/natsumi)（MIT）の `assets/avatars/myao/` から、コミット `0187c41eafef444a89667ded34d4895f139a2a48` の `icons/*.webp` と `slack/*.png` をそのまま写した。生成の手順と設定は、写し元の README にある。

`avatar.json` は写し元の `id`・`name`・`icons` に、Slack 用の PNG の場所（`pngIcons`）を足したもの。写し元にあるスプライトシートの項目（`spritesheet`・`atlas`・`animations`・`expressions` など）は、スプライトシートを写していないので落とした。

`appearance.yaml` と `sdctl-params.yaml` は、同じ写し元のコミット `002af754f14cace55919ab310c9474be94fbf684` からそのまま写した。

スプライトシート、`pet.json`、生成元の PNG、`personality.md` は写していない（性格は記憶の側で持つ）。
