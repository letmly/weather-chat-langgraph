#!/bin/bash
# Первичная настройка weather-chat на сервере.
# Запуск локально: bash deploy/setup-server.sh
#
# ВАЖНО: creds сервера берутся из файла deploy/.deploy.env (см. .deploy.env.example).
# Этот файл в .gitignore — не коммить!
#
# Что делает:
#   1. Клонирует репу на сервер
#   2. Заливает .env
#   3. Билдит и запускает контейнеры (backend + frontend)
#   4. Регистрирует Kong service + route
#   5. Добавляет домен в ACME-plugin для SSL

set -e

DEPLOY_ENV="$(dirname "$0")/.deploy.env"
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "ERROR: deploy/.deploy.env не найден. Скопируй deploy/.deploy.env.example → deploy/.deploy.env и впиши значения."
  exit 1
fi
set -a
. "$DEPLOY_ENV"
set +a

: "${SSH_USER:?SSH_USER не задан в .deploy.env}"
: "${SSH_HOST:?SSH_HOST не задан в .deploy.env}"
: "${SSH_PORT:?SSH_PORT не задан в .deploy.env}"
: "${SSH_KEY:?SSH_KEY не задан в .deploy.env}"
: "${REMOTE_DIR:?REMOTE_DIR не задан в .deploy.env}"
: "${DOMAIN:?DOMAIN не задан в .deploy.env}"
: "${REPO_URL:?REPO_URL не задан в .deploy.env}"

SERVICE_NAME="${SERVICE_NAME:-weatherchat}"
CONTAINER_NAME="${CONTAINER_NAME:-weatherchat}"
CONTAINER_PORT="${CONTAINER_PORT:-80}"

SSH="ssh -i $SSH_KEY -p $SSH_PORT ${SSH_USER}@${SSH_HOST}"
SCP="scp -O -i $SSH_KEY -P $SSH_PORT"

echo "=== Weather Chat — setup ==="

echo "[1/5] Клонирую репу..."
$SSH "if [ ! -d $REMOTE_DIR/.git ]; then
  git clone $REPO_URL $REMOTE_DIR
else
  cd $REMOTE_DIR && git pull
fi"

echo "[2/5] Заливаю .env..."
if [ -f .env ]; then
  $SCP .env "${SSH_USER}@${SSH_HOST}:$REMOTE_DIR/.env"
  echo "  .env uploaded"
else
  echo "  WARNING: локального .env нет. Скопируй вручную в $REMOTE_DIR/.env"
  exit 1
fi

echo "[3/5] docker compose up -d --build..."
$SSH "cd $REMOTE_DIR && docker compose -f deploy/docker-compose.prod.yml up -d --build"

echo "[4/5] Kong service+route..."
$SSH "set -e
KONG_IP=\$(docker inspect kong --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}:{{end}}' | cut -d: -f1)
if curl -sf http://\$KONG_IP:8001/services/$SERVICE_NAME > /dev/null 2>&1; then
  curl -s -X PATCH http://\$KONG_IP:8001/services/$SERVICE_NAME \
    -d host=$CONTAINER_NAME -d port=$CONTAINER_PORT -d protocol=http > /dev/null
  echo '  сервис обновлён'
else
  curl -s -X POST http://\$KONG_IP:8001/services \
    -d name=$SERVICE_NAME -d host=$CONTAINER_NAME -d port=$CONTAINER_PORT -d protocol=http > /dev/null
  echo '  сервис создан'
fi
ROUTE_COUNT=\$(curl -s http://\$KONG_IP:8001/services/$SERVICE_NAME/routes | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get(\"data\",[])))')
if [ \"\$ROUTE_COUNT\" = '0' ]; then
  curl -s -X POST http://\$KONG_IP:8001/services/$SERVICE_NAME/routes \
    -H 'Content-Type: application/json' \
    -d '{\"name\":\"$SERVICE_NAME-route\",\"hosts\":[\"$DOMAIN\"],\"protocols\":[\"http\",\"https\"]}' > /dev/null
  echo '  route создан'
else
  echo '  route уже есть'
fi"

echo "[5/5] ACME домен..."
$SSH "set -e
KONG_IP=\$(docker inspect kong --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}:{{end}}' | cut -d: -f1)
ACME_ID=\$(curl -s http://\$KONG_IP:8001/plugins | python3 -c '
import sys,json
plugins=json.load(sys.stdin)[\"data\"]
acme=[p for p in plugins if p[\"name\"]==\"acme\"]
print(acme[0][\"id\"] if acme else \"\")')
if [ -n \"\$ACME_ID\" ]; then
  HAS=\$(curl -s http://\$KONG_IP:8001/plugins/\$ACME_ID | python3 -c '
import sys,json
domains=json.load(sys.stdin)[\"config\"][\"domains\"]
print(\"yes\" if \"$DOMAIN\" in domains else \"no\")')
  if [ \"\$HAS\" = 'yes' ]; then
    echo '  домен уже в ACME'
  else
    NEW=\$(curl -s http://\$KONG_IP:8001/plugins/\$ACME_ID | python3 -c '
import sys,json
d=json.load(sys.stdin)[\"config\"][\"domains\"]
d.append(\"$DOMAIN\")
print(json.dumps(d))')
    curl -s -X PATCH http://\$KONG_IP:8001/plugins/\$ACME_ID \
      -H 'Content-Type: application/json' \
      -d \"{\\\"config\\\":{\\\"domains\\\":\$NEW}}\" > /dev/null
    echo '  домен добавлен в ACME'
  fi
else
  echo '  WARNING: ACME plugin не найден'
fi"

echo ""
echo "=== Готово ==="
echo "URL: https://$DOMAIN"
