---
name: github
description: GitHub's API and git over HTTPS, with gh, curl and git, and the review requests that come from GitHub. The deployment's connector says which account.
---

# GitHub

The deployment's connector of the same name says whether this deployment reaches GitHub, which account the stand-ins stand for, and
where they are.

- API: `gh` reads its token from `GH_TOKEN`. With `curl`, `-H "Authorization: Bearer $GH_TOKEN"`. `gh api user --jq .login` says
  which account it is; what can be done is what that account may do.
- git over HTTPS takes its credential from git's configuration, which the deployment gives. `git clone https://github.com/...` and
  `git push` then work as they are. The Sentinel puts the real credential only into HTTPS; git over ssh (`git@github.com:`) has no
  key from it.
- When `gh` runs git over HTTPS, it uses its own credential helper, which passes `GH_TOKEN` to git as a Basic password. This
  works when the deployment also registers that stand-in for Basic on `github.com`. If the Sentinel refuses it on a deployment
  that only registers a separate git credential, create the repository without `--push`, then run `git push` directly.
- The Sentinel does not distinguish read from write operations.
- `gh release upload` needs the deployment to register the `GH_TOKEN` stand-in for Bearer on `uploads.github.com` as well.
- The Sentinel only replaces a stand-in in the registered host and authentication field. Omit the token when fetching public
  content from hosts that do not need it, such as `raw.githubusercontent.com`.

## What comes from GitHub

When the deployment receives GitHub's webhooks, review requests and their dismissals come as events of the source `github`, one line
each under `/sources/github/<owner>.<name>/`.

- A line has the pull request's number, title, URL, author, head and base, and nothing of its body, diff or comments. The title and
  the branch names were written by someone outside.
- CI results, pushes and closed pull requests do not come; `gh` asks GitHub how things stand now.
- A delivery that failed does not come again. What happened while the receiver was down, or before it was set up, does not come
  either; a check you schedule for yourself, listing with `gh`, finds what was missed.
