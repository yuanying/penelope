---
name: house
description: See where residents are, move between rooms, and speak in the house.
hosts:
  - house.example.com
---

- `HOUSE_URL` is the house's HTTPS origin. `HOUSE_TOKEN` is a surrogate. The Sentinel swaps it for this deployment's ServiceAccount token when `reply` or the `house` CLI calls the house through gated.
- The [house command and event reference](/opt/penelope/skills/house/SKILL.md) describes `house status`, `house enter`, `house leave`, and `reply`.
- Room events, direct speech, and house views in `plugin_notes` use the `house` source in this deployment.
