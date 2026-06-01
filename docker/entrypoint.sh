#!/bin/sh
# Runs under tini (PID 1), which reaps zombies and forwards signals to us.
set -eu

# --- runtime user (PUID / PGID) ----------------------------------------------
# NginUX runs nginx + the control plane as an unprivileged user so everything it
# writes to the /data volume is owned by *your* host user (manageable from your
# file browser / NAS share), like other self-hosted containers. nginx still binds
# :80/:443 via the NET_BIND_SERVICE ambient capability (setpriv), not as root.
#
# By default we adopt the owner of the mounted /data directory - so NginUX runs
# as whoever owns the folder you mounted (the same user you deploy with), with no
# configuration. Override with the PUID/PGID env vars. A root-owned /data (e.g. a
# fresh named volume) resolves to uid 0 → runs as root.

# Persistent dirs on the mounted volume
mkdir -p /data/nginx/conf.d /data/nginx/stream.d /data/logs /data/certs /data/geoip
touch /data/logs/access.log /data/logs/stream.log /data/logs/error.log /data/nginx/banned.conf

# Adopt the data-dir owner unless PUID/PGID were set explicitly.
PUID="${PUID:-$(stat -c %u /data 2>/dev/null || echo 0)}"
PGID="${PGID:-$(stat -c %g /data 2>/dev/null || echo 0)}"

# nginx.conf includes geoip.conf and its log_format references
# $geoip2_country_iso_code, so geoip.conf must define BOTH variables before nginx
# starts. Seed a safe default if it's absent; the control plane regenerates it
# from settings moments later.
if [ ! -f /data/nginx/geoip.conf ]; then
  {
    echo 'map $remote_addr $geoip2_country_iso_code { default ""; }'
    echo 'geo $nginux_allowed_country { default 1; }'
  } > /data/nginx/geoip.conf
fi

# Bootstrap a self-signed cert so SSL server blocks are valid before ACME runs.
if [ ! -f /data/nginx/selfsigned.crt ]; then
  echo "[nginux] generating bootstrap self-signed certificate"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /data/nginx/selfsigned.key \
    -out /data/nginx/selfsigned.crt \
    -subj "/CN=nginux.local" >/dev/null 2>&1
fi

# --- decide privilege model --------------------------------------------------
ROOT_MODE=0
if [ "$PUID" = "0" ]; then
  ROOT_MODE=1
  echo "[nginux] running as root (data dir is root-owned, or PUID=0)"
else
  # Resolve or create a group at PGID.
  if getent group "$PGID" >/dev/null 2>&1; then
    APP_GROUP="$(getent group "$PGID" | cut -d: -f1)"
  else
    APP_GROUP="nginux"
    addgroup -g "$PGID" "$APP_GROUP"
  fi
  # Resolve or create a user at PUID. Reuse an existing uid (e.g. node:24-alpine
  # already ships uid 1000 'node') rather than colliding with it.
  if getent passwd "$PUID" >/dev/null 2>&1; then
    APP_USER="$(getent passwd "$PUID" | cut -d: -f1)"
  else
    APP_USER="nginux"
    adduser -D -H -u "$PUID" -G "$APP_GROUP" "$APP_USER"
  fi
  echo "[nginux] running as ${APP_USER}:${APP_GROUP} (${PUID}:${PGID})"
  # Own the data volume + nginx's writable runtime dirs.
  chown -R "$PUID:$PGID" /data /var/lib/nginx /var/log/nginx 2>/dev/null || true
  # With a non-root master the 'user' directive is ignored (master + workers run
  # as our user already) - comment it out so nginx doesn't warn on every reload.
  sed -i 's/^user .*/# (user directive omitted: master runs unprivileged)/' /etc/nginx/nginx.conf
fi

# setpriv wrapper: drop to PUID:PGID. nginx additionally keeps NET_BIND_SERVICE
# (inheritable + ambient) so it can bind low ports unprivileged.
run_user() {    # run_user <extra-setpriv-args...> -- <cmd...>
  setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"
}

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
if [ "$ROOT_MODE" = "1" ]; then
  nginx -g 'daemon off;' &
else
  run_user --inh-caps=+net_bind_service --ambient-caps=+net_bind_service \
    nginx -g 'daemon off;' &
fi
NGINX_PID=$!

# Wait for nginx to write its pid file so the control plane's boot-time reload
# doesn't race a not-yet-ready master.
i=0
while [ ! -s /tmp/nginx.pid ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done

# Start the control plane (UI + API + nginx orchestration).
echo "[nginux] starting control plane on :${PORT}"
if [ "$ROOT_MODE" = "1" ]; then
  node --experimental-sqlite --disable-warning=ExperimentalWarning /app/server/src/index.ts &
else
  run_user node --experimental-sqlite --disable-warning=ExperimentalWarning /app/server/src/index.ts &
fi
APP_PID=$!

# Supervise: if either process exits, stop the other and let the container exit.
while kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$APP_PID" 2>/dev/null; do
  sleep 1
done

echo "[nginux] a process exited - bringing the container down"
term
wait 2>/dev/null || true
