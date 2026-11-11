#!/bin/sh
# One-shot "setup" service of docker-compose.full.yml: prepares the judge database and hands the
# demo publisher its credentials. Safe to run again (every step is idempotent).
#
#   1. pnpm db:migrate     applies the Drizzle migrations to the judge database
#   2. pnpm seed           judge personas, the Saffron & Salt site, a $5.00 wallet, a demo agent key
#   3. pnpm seed:traffic   two weeks of settled demo traffic for the dashboards
#   4. writes /run/botfare/judge.env (SESSION_SECRET, BOTFARE_RECEIPT_KEY_SEED, BOTFARE_SITE_ID,
#      BOTFARE_SITE_SECRET, BOTFARE_AGENT_KEY for the research agent) for the web and demo
#      containers
#
# pnpm seed reads and writes the repo-root .env (/app/.env). Here that file is a link to
# /run/botfare/seed.env on the shared volume, so a rerun keeps the same site secret and agent key.
# Secrets are never printed: the seed shows only IDs and last four characters.
set -eu

SHARED=/run/botfare
mkdir -p "$SHARED"
umask 077
ln -sf "$SHARED/seed.env" /app/.env

value_of() {
  [ -r "$2" ] && sed -n "s/^$1=//p" "$2" | tail -n 1 || true
}

random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(36).toString("base64url"))'
}

session_secret=$(value_of SESSION_SECRET "$SHARED/judge.env")
if [ -z "$session_secret" ]; then
  session_secret=$(random_secret)
fi
# The receipt-signing seed: seed:traffic settles and refunds demo receipts and signs their
# statements, so it must sign with the same key the web container publishes.
receipt_seed=$(value_of BOTFARE_RECEIPT_KEY_SEED "$SHARED/judge.env")
if [ -z "$receipt_seed" ]; then
  receipt_seed=$(random_secret)
fi
export BOTFARE_RECEIPT_KEY_SEED="$receipt_seed"

cd /app
pnpm db:migrate
pnpm seed
pnpm seed:traffic

tmp="$SHARED/judge.env.tmp"
{
  echo "# Written by docker/setup.sh for the web and demo containers. Do not commit or share."
  echo "SESSION_SECRET=$session_secret"
  echo "BOTFARE_RECEIPT_KEY_SEED=$receipt_seed"
  echo "BOTFARE_SITE_ID=$(value_of BOTFARE_SITE_ID "$SHARED/seed.env")"
  echo "BOTFARE_SITE_SECRET=$(value_of BOTFARE_SITE_SECRET "$SHARED/seed.env")"
  # The seeded demo agent key (10c per request, $1.00 a day): the web app's research agent pays with it.
  echo "BOTFARE_AGENT_KEY=$(value_of BOTFARE_AGENT_KEY "$SHARED/seed.env")"
} >"$tmp"
mv "$tmp" "$SHARED/judge.env"
# The web and demo containers run as the unprivileged node user.
chown node:node "$SHARED/judge.env" "$SHARED/seed.env"

echo "[setup] Wrote $SHARED/judge.env for the web and demo containers"
