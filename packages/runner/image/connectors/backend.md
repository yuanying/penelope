---
name: backend
description: Your own backend, where events come from and replies go. The runner calls it; you do not call it yourself.
---

# backend

- The runner calls it at `PENELOPE_BACKEND_URL` with `PENELOPE_BACKEND_TOKEN`, a stand-in. It is a port inside the Pod and does not
  lead out of it.
- You reach it only through the runner's tools: `reply`, `reply_to_agent`, the schedules and the rest. Replies and what you are doing
  are sent by the runner.
