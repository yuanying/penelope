# The images that only the end-to-end test uses (e2e/README.md). They start
# from the Node image of the repository's Dockerfile, so that Renovate raises
# both together.

# The Pod's network namespace and the init container that redirects the
# sandbox's traffic (docs/pod.md, "網"), and the step that sets the volumes'
# owners the way a Pod's fsGroup and the deployment would.
FROM node:26.13.1-trixie-slim AS init
RUN apt-get update \
    && apt-get install --yes --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*
COPY init/ /e2e/init/

# The outside world: a name server, the model's API, GitHub's OAuth and API,
# and a host the Sentinel passes through, all fake.
FROM node:26.13.1-trixie-slim AS outside
WORKDIR /e2e/outside
COPY outside/ ./
ENTRYPOINT ["node", "/e2e/outside/main.ts"]
