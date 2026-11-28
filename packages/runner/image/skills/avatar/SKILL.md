---
name: avatar
description: Your avatar in /memory/avatar/ (your figure, the params it is drawn with, and the faces shown in the house and on Slack), how to change it, and `avatar check`.
---

# Your avatar

Your avatar is yours to grow, in `/memory/avatar/`. The backend copied it there from the avatar the deployment chose, the
first time it started; from then on it is only what you make of it. It is in your memory, so every change is in its git
history, and an earlier one can be taken back from there.

## What is in it

| File | What it is | Who reads it |
| --- | --- | --- |
| `avatar.json` | The list of the rest: `name`, `icons` and `pngIcons` (below). Fields it does not know are kept | The backend |
| `icons/<face>.webp` | Each face, as listed in `icons`: the face cut out, square, 512×512 | Your personal page and the house when it uses your face URLs |
| `slack/<face>.png` | Each face as a PNG, as listed in `pngIcons`: 256×256 | Slack, as the icon of `slackctl post --face` |
| `appearance.yaml` | Your figure: what a picture of you is drawn with (skill `self-portrait`) | You |
| `sdctl-params.yaml` | The params your figure is drawn with. `SDCTL_PARAMS` points at it unless the deployment set another | `sdctl` |

`icons` and `pngIcons` map an expression to a file, relative to `/memory/avatar/`. The expressions are the nine of your
replies: neutral, happy, laughing, surprised, thinking, worried, sad, sleepy and angry. The house uses its configured face
for the expression. If it has no such face, it uses its configured neutral face or default resident image. An image of a
face is a PNG, JPEG, GIF, WebP or SVG of at most 4 MiB, a plain file inside `/memory/avatar/`, and what its extension says it is.

Your name is not yours to change: the deployment gives it, and others call you by it. `name` in `avatar.json` is only
used when the deployment gives none, and only from the backend's next start.

## Changing it

- Your figure: edit `appearance.yaml`. Its fields are in the skill `self-portrait`.
- How it is drawn: edit `sdctl-params.yaml`, the params of `sdctl` (`sdctl --help`, the skill `sd-generate` when it is
  listed).
- A face: draw it with `sdctl`, as the skill `self-portrait` says, cut the face out as a square, and write it at the
  sizes and in the formats above. Python with `uv run --with pillow` is one way to cut and convert. Then point `icons`
  (and `pngIcons`) of `avatar.json` at it.

After any change, run `avatar check`. It reads `/memory/avatar/` with the backend's own rules and prints what it would
leave out and why, or what it takes. The backend does not check: what breaks a rule is just not shown.

The backend reads `avatar.json` again when your turn's end commits your memory. The house and Slack use the updated
faces if their configured URLs point to those images. Slack and browsers may keep an old image for a while.
