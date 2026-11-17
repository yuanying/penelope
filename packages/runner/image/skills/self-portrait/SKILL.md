---
name: self-portrait
description: Drawing a picture with you in it, from your figure in $PENELOPE_AVATAR_DIR/appearance.yaml, with sdctl.
---

# Drawing yourself

How sdctl is used is in the connector `sd-webui` and `sdctl --help`, and in the skill `sd-generate` when it is listed. How a prompt
is written for a model is in its skill when one is listed (such as `anima-prompt`, `moss-prompt` or `illustrious-prompt`).
This skill is about your figure.

## Where your figure is

`PENELOPE_AVATAR_DIR` is the directory of your avatar: the one the deployment chose with `PENELOPE_AVATAR`, under
`PENELOPE_AVATARS_DIR` (the image's avatars unless the deployment gave its own), or a figure the deployment mounted at
`/etc/penelope/avatar`, which comes first. In it:

- `appearance.yaml`: your figure, below.
- `sdctl-params.yaml`: the params your figure is drawn with. `SDCTL_PARAMS` points at it unless the deployment set another, so sdctl
  uses it without `--params`; what you write is the prompt.

When `PENELOPE_AVATAR_DIR` is not set or has no `appearance.yaml`, you have no fixed figure; the person in the picture is written
for the scene.

## appearance.yaml

| Field | What it is and how it is used |
| --- | --- |
| `body` | The lines of the body. Copied **as they are** to the head of every prompt. A figure drawn with a LoRA has `<lora:name:weight>` first |
| `lora` | The name of your LoRA, to check that the LoRA line of `body` is still there |
| `outfit` | The line of the clothes, right after `body`. Only this line changes for the clothes or the scene asked for |
| `outfitName` | What you wear when no clothes are asked for |
| `keep` | Tags of what must stay: not dropped when the clothes change, nor when the scene is written in sentences |
| `examples` | Scenes (`title`, `outfit`, `scene`). `body` + that `outfit` + `scene` is one prompt |

## Putting a prompt together

1. A picture with you in it (a selfie or not, alone or with others) starts with `body` as it is, then the clothes, then the scene.
   The words of `body` are not dropped, reworded or reordered.
2. Before drawing, every word of `lora` and `keep` is in the prompt.
3. After drawing, `read` the picture and see that what `keep` names (the colour of the hair, of the eyes, …) is in it. When it is
   not, look at whether `body` was copied whole and whether a word of the scene works against it (another colour of hair, …), and
   draw again.
