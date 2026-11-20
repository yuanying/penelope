---
name: extensions
description: Pi extensions in memory, when changes take effect, and how to recover. Read when adding, changing, or removing a Pi extension.
---

# Pi extensions

Your extensions live in `/memory/extensions/`. Pi reads this directory as a local extension source. A single extension can use
`/memory/extensions/index.ts`; a collection can use `/memory/extensions/extensions/` with individual `.ts` files or
subdirectories with an `index.ts`.

The extension API and examples are documented in
`/opt/penelope/runner/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` inside the sandbox image.

Changes take effect before the next main turn, not during the current turn. The runner also loads extensions when it
opens the main session. Night workers and sub-agents do not load these extensions.

The runner reports extension errors in the turn input. If the first turn with a changed set of memory extensions does
not finish successfully, or the runner restarts before it finishes, that set is disabled. The runner checks again when
the contents change.

An extension can leave the session unable to fix itself. The owner can move it out of `/memory/extensions/` or recover a
working revision from memory's Git history with `git archive`. The owner can then restart the runner if the current turn
is stuck.
