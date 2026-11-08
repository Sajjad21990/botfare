#!/bin/sh
# Entrypoint for the web and demo containers of docker-compose.full.yml.
# Loads /run/botfare/judge.env, which the one-shot "setup" service writes on the shared volume
# (SESSION_SECRET, BOTFARE_RECEIPT_KEY_SEED, BOTFARE_SITE_ID, BOTFARE_SITE_SECRET, BOTFARE_AGENT_KEY), then runs the
# container's command.
# A variable that compose already sets keeps its value. Values are never printed.
set -eu

JUDGE_ENV=/run/botfare/judge.env

if [ -r "$JUDGE_ENV" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    # Only plain variable names; anything else is skipped.
    case "$key" in
      *[!A-Za-z0-9_]* | [0-9]*) continue ;;
    esac
    eval "already=\${$key+set}"
    if [ -z "$already" ]; then
      export "$key=$value"
    fi
  done <"$JUDGE_ENV"
else
  echo "[entrypoint] $JUDGE_ENV not found; run the setup service first" >&2
fi

exec "$@"
