#!/bin/sh
set -e

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

# Start nginx (data plane) in the background. The control plane writes configs
# to /data/nginx/conf.d and reloads nginx on every change.
echo "[nginux] starting nginx"
nginx -g 'daemon off;' &
NGINX_PID=$!

# Start the control plane (UI + API + nginx orchestration) in the foreground.
echo "[nginux] starting control plane on :${PORT}"
node --experimental-sqlite --disable-warning=ExperimentalWarning /app/server/src/index.ts &
APP_PID=$!

# If either process exits, bring the container down.
wait -n "$NGINX_PID" "$APP_PID"
exit $?
