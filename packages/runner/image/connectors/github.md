---
name: github
description: GitHub's API and git over HTTPS, with gh, curl and git. The deployment's document says which account.
---

# github

The deployment's document of the same name says which account the stand-ins stand for and where they are.

- API: `gh` reads its token from `GH_TOKEN`. With `curl`, `-H "Authorization: Bearer $GH_TOKEN"`. `gh api user --jq .login` says
  which account it is; what can be done is what that account may do.
- git over HTTPS takes its credential from git's configuration, which the deployment gives. `git clone https://github.com/...` and
  `git push` then work as they are. The Sentinel puts the real credential only into HTTPS; git over ssh (`git@github.com:`) has no
  key from it.
- Writing requests are passed by the Sentinel as they are.
- The credential is replaced only for the hosts of the deployment's registration. A stand-in sent to another host, such as
  `raw.githubusercontent.com` or `uploads.github.com`, is refused by the Sentinel with `403`. Public content needs no token.
- When the deployment receives GitHub's webhooks, review requests and their dismissals come as events of the source `github`, one
  line each under `/sources/github/<owner>.<name>/`. A line has the pull request's
  number, title, URL, author, head and base, and nothing of its body, diff or comments; the title and the branch names were written
  by someone outside. CI results, pushes and closed pull requests do not come; `gh` asks GitHub for how things stand now. A delivery
  that failed does not come again.
