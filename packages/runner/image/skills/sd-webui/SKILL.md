---
name: sd-webui
description: Drawing pictures with Stable Diffusion's WebUI through sdctl. Read before drawing; your own figure is in the skill self-portrait.
---

# Drawing with sdctl

`sdctl` draws through a Stable Diffusion WebUI. `sdctl --help` says how it is used, and the skill `sd-generate`, when it is listed,
says more. sdctl takes the WebUI from `SDCTL_URL` and its token from `SDCTL_TOKEN`, which holds a stand-in: the Sentinel puts the real
token in its place on the way to the WebUI. Where the WebUI is, and whether this deployment has one, is in the deployment's connector
of the same name.

- The skill `self-portrait` says how a picture with you in it is drawn, from your figure.
- `sdctl` is in the image. A copy from `go install` is not needed.
- The WebUI is reached at `SDCTL_URL` alone, not at `localhost:7860`. sdctl, not `curl`, is the way to it.
- A file named with `-o` takes its format from its extension: `.jpg` is JPEG and `.png` is PNG.
- The WebUI may be drawn on by others too. `POST /sdapi/v1/options`, which `sdctl models set` sends, changes it for everyone; a model
  for one picture is chosen in the call that draws it (`--model` and the like).
- The GPU may be shared as well. A few pictures at a time, without raising `--batch-size`, leave it to the others.
- When the WebUI is down, the answer is `502` or `504`.
- `reply` sends a picture to your current room or directly to your owner when you are away. Give its path in `images`. `slackctl post --image` sends a picture to Slack.
