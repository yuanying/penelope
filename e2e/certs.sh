#!/bin/sh
# Makes the test's keys afresh in the directory given (e2e/.run/): the
# Sentinel's CA, a CA for the outside world and the outside's certificate,
# and the real keys that only the Sentinel, the backend and the fakes hold.
set -eu
dir="$1"
mkdir -p "$dir"
cd "$dir"

ca() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
    -subj "/CN=$2" -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -keyout "$1.key" -out "$1.crt" 2>/dev/null
}
ca sentinel-ca "penelope e2e Sentinel CA"
ca outside-ca "penelope e2e outside CA"

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=outside" \
  -keyout outside.key -out outside.csr 2>/dev/null
printf 'subjectAltName=DNS:model.example.com,DNS:github.com,DNS:api.github.com,DNS:plain.example.net,DNS:kubernetes.example.com,DNS:auth.example.com,DNS:a.apps.example.com,DNS:slack.com,DNS:wss-primary.slack.com,DNS:files.slack.com,DNS:helper.example.com\nextendedKeyUsage=serverAuth\n' > outside.ext
openssl x509 -req -in outside.csr -CA outside-ca.crt -CAkey outside-ca.key -CAcreateserial -days 2 \
  -extfile outside.ext -out outside.crt 2>/dev/null
rm -f outside.csr outside.ext outside-ca.srl

# kube-token is the backend's ServiceAccount token, which the fake API server takes for TokenReview;
# sender-token and stranger-token are the ServiceAccount tokens of an A2A sender and of a ServiceAccount
# that is not one, held only by the test. alertmanager-token is what Alertmanager would send to the
# receivers' webhook, and github-webhook-secret what GitHub would sign its deliveries with.
for name in model-key backend-token github-client-secret kube-token sender-token stranger-token alertmanager-token github-webhook-secret; do
  openssl rand -hex 24 > "$name"
done
# The Slack App's tokens, which the receivers and the fake Slack hold: the plugin refuses a token without its prefix.
printf 'xapp-1-A0E2E-%s\n' "$(openssl rand -hex 24)" > slack-app-token
printf 'xoxb-e2e-%s\n' "$(openssl rand -hex 24)" > slack-bot-token

# The containers run as different users; these are the test's own throwaway keys.
chmod 0644 ./*
