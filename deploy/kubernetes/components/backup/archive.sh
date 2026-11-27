#!/bin/sh
# Writes a backup into /backup/<UTC time>/ (README.md, "Backup"):
#   backend.sqlite  the consistent copy the init container made
#   state.tar.gz    PVC penelope, without the SQLite itself and the caches
#                   that can be made again
#   memory.tar.gz   PVC penelope-memory (the work tree and .git)
# and removes the backups older than KEEP_DAYS days. Owners and modes are
# kept (tar as root, numeric IDs).
set -eu

if [ ! -f /staging/backup-stamp ]; then
  exit 0
fi
KEEP_DAYS=${KEEP_DAYS:-14}
out="/backup/$(cat /staging/backup-stamp)"
mkdir -m 0700 "$out.partial"

cp /staging/backend.sqlite "$out.partial/backend.sqlite"

# The caches under HOME (home/) are left out; Pi's directory (.pi) is kept
# whole.
tar -C /volume/state -czf "$out.partial/state.tar.gz" --numeric-owner \
  --exclude ./lost+found \
  --exclude ./backend/backend.sqlite \
  --exclude './backend/backend.sqlite-*' \
  --exclude ./home/.cache \
  --exclude ./home/go/pkg/mod \
  --exclude ./home/.npm \
  --exclude './home/work/*/node_modules' \
  --exclude ./home/.kube/cache \
  .
tar -C /volume/memory -czf "$out.partial/memory.tar.gz" --numeric-owner \
  --exclude ./lost+found \
  .

mv -T "$out.partial" "$out"
echo "backup: $out"
ls -l "$out"

find /backup -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime "+$((KEEP_DAYS - 1))" -print -exec rm -rf {} +
