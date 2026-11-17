---
name: sd-webui
description: Drawing with Stable Diffusion's WebUI through sdctl. Your own figure is in the skill self-portrait.
---

# sd-webui

`sdctl` draws through the WebUI at `SDCTL_URL`, with `SDCTL_TOKEN`, a stand-in the Sentinel replaces with the real token. The
deployment's document of the same name says where the WebUI is. `sdctl --help` says how it is used.

- The skill `self-portrait` says how a picture with you in it is drawn, from your figure.
- `sdctl` is in the image. A copy from `go install` is not needed.
- A file named with `-o` takes its format from its extension: `.jpg` is JPEG and `.png` is PNG.
- The WebUI may be drawn on by others too. `POST /sdapi/v1/options`, which `sdctl models set` sends, changes it for everyone; a model
  for one picture is chosen in that call (`--model` and the like).
- The GPU may be shared as well. A few pictures at a time leave it to the others.
- When the WebUI is down, the answer is `502` or `504`.
- A picture is shown to your owner by giving its path in `reply`'s `images`, and posted to Slack with `slackctl post --image`.
