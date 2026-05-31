# ---------- build stage: compile the React SPA ----------
FROM node:24-alpine AS build
WORKDIR /app

# install workspace deps reproducibly (cached on lockfile/manifests)
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

# build the web bundle
COPY . .
RUN npm run build --workspace web

# ---------- deps stage: production-only node_modules ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev

# ---------- runtime stage: nginx (data plane) + node (control plane) ----------
FROM node:24-alpine AS runtime
WORKDIR /app

# nginx is the data plane; openssl bootstraps the self-signed cert; tini is a
# proper init (PID 1) that reaps zombies and forwards signals to both processes.
# setpriv (util-linux) drops the runtime user to PUID/PGID while keeping the
# NET_BIND_SERVICE ambient capability so nginx can still bind :80/:443 unprivileged
# (works under no-new-privileges, where setcap file-caps would be neutralised).
RUN apk add --no-cache nginx nginx-mod-stream nginx-mod-http-geoip2 libmaxminddb openssl tini setpriv

# prod-only deps + app code (server runs straight from TS via type-stripping)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist

# nginx base config + entrypoint
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    PORT=4600 \
    HOST=0.0.0.0 \
    NGINUX_DATA_DIR=/data \
    NGINX_CONF_DIR=/data/nginx/conf.d \
    NGINX_STREAM_DIR=/data/nginx/stream.d \
    NGINX_BANNED_FILE=/data/nginx/banned.conf \
    NGINX_DEFAULT_CERT=/data/nginx/selfsigned.crt \
    NGINX_DEFAULT_KEY=/data/nginx/selfsigned.key \
    NGINX_ACCESS_LOG=/data/logs/access.log \
    CERT_DIR=/data/certs

# 4600 = control-plane UI/API · 80/443 = proxied traffic (data plane)
EXPOSE 4600 80 443
VOLUME ["/data"]

# Container is healthy only when the control plane answers and the DB is live.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:4600/api/health >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
