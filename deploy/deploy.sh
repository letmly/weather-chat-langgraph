#!/bin/bash
# Апдейт деплоя: git pull + rebuild.
# Креды сервера — из deploy/.deploy.env (не коммитится).

set -e

DEPLOY_ENV="$(dirname "$0")/.deploy.env"
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "ERROR: deploy/.deploy.env не найден."
  exit 1
fi
set -a
. "$DEPLOY_ENV"
set +a

: "${SSH_USER:?}"; : "${SSH_HOST:?}"; : "${SSH_PORT:?}"; : "${SSH_KEY:?}"; : "${REMOTE_DIR:?}"

SSH="ssh -i $SSH_KEY -p $SSH_PORT ${SSH_USER}@${SSH_HOST}"

echo "=== Deploying weather-chat update ==="
$SSH "cd $REMOTE_DIR && git pull && docker compose -f deploy/docker-compose.prod.yml up -d --build"
echo "=== Done ==="
