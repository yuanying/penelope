---
name: x-search
description: Search X with Grok through llm-proxy in xAI mode.
hosts:
  - llm-proxy-xai.example.com
---

- `X_SEARCH_URL` points to the proxy's HTTPS origin, `X_SEARCH_TOKEN` holds a surrogate, and `X_SEARCH_MODEL` selects the Grok model.
- The Sentinel swaps the surrogate for this Pod's ServiceAccount token. The proxy is behind gated and holds the xAI login.
