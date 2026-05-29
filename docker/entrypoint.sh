#!/bin/sh
# Runs under tini (PID 1), which reaps zombies and forwards signals to us.
set -eu

# Persistent dirs on the mounted volume
mkdir -p /data/nginx/conf.d /data/nginx/stream.d /data/logs /data/certs
touch /data/logs/access.log /data/logs/stream.log /data/nginx/banned.conf

# Bootstrap a self-signed cert so SSL server blocks are valid before ACME runs.
if [ ! -f /data/nginx/selfsigned.crt ]; then
  echo "[nginux] generating bootstrap self-signed certificate"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /data/nginx/selfsigned.key \
    -out /data/nginx/selfsigned.crt \
    -subj "/CN=nginux.local" >/dev/null 2>&1
fi

NGINX_PID=""
APP_PID=""

# Forward shutdown to both processes so docker stop drains gracefully.
term() {
  echo "[nginux] shutting down"
  [ -n "$APP_PID" ] && kill -TERM "$APP_PID" 2>/dev/null || true
  nginx -s quit 2>/dev/null || { [ -n "$NGINX_PID" ] && kill -TERM "$NGINX_PID" 2>/dev/null; } || true
}
trap term TERM INT

# Start nginx (data plane).
echo "[nginux] starting nginx"
nginx -g 'daemon off;' &
NGINX_PID=$!

# Wait for nginx to write its pid file so the control plane's boot-time reload
# doesn't race a not-yet-ready master.
i=0
while [ ! -s /run/nginx.pid ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done

# Start the control plane (UI + API + nginx orchestration).
echo "[nginux] starting control plane on :${PORT}"
node --experimental-sqlite --disable-warning=ExperimentalWarning /app/server/src/index.ts &
APP_PID=$!

# Supervise: if either process exits, stop the other and let the container exit.
while kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$APP_PID" 2>/dev/null; do
  sleep 1
done

echo "[nginux] a process exited — bringing the container down"
term
wait 2>/dev/null || true
