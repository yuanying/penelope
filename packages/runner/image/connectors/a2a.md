---
name: a2a
description: Asking other agents over A2A with the a2a CLI. The deployment's documents say which agents and with which tokens.
---

# a2a

`a2a` sends requests to other agents over A2A. Where the agents are and which environment variable holds the stand-in for each is in
the deployment's documents; the Sentinel replaces the stand-in with the real token on the way to that agent.

- Asking: `a2a send -a <URL> --auth "Bearer $<TOKEN>" "<what to ask>"`.
- What an agent can do is in its Agent Card: `a2a card get -a <URL>`, which needs no token.
- Work that takes time returns a Task. To go on with your turns while it runs, wait for it as a background job:

  ```
  a2a task get -a <URL> --auth "Bearer $<TOKEN>" --wait --poll-interval 30s --timeout 2h <task ID>
  ```

  Started with `job_start`, it ends when the Task ends or asks back, and its end comes as an event of the source `job`. Past
  `--timeout`, the command ends even if the Task has not; to go on waiting, start it again.
- A Task that asks back (`input-required`) takes the answer by `a2a send` to the same Task, and is waited for again.
- Each agent's stand-in is its own. One sent to another agent is refused by the Sentinel with `403`.
- Requests from other agents to you come as events of the source `a2a`, and are answered with `reply_to_agent`.
