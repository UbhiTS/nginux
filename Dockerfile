# ---------- build stage: compile the React SPA ----------
FROM node:24-alpine AS build
WORKDIR /app

# install workspace deps (cached on lockfile/manifests)
COPY package.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install

# build the web bundle
COPY . .
RUN npm run build --workspace web

# ---------- runtime stage: nginx (data plane) + node (control plane) ----------
FROM node:24-alpine AS runtime
WORKDIR /app

# nginx is the data plane; openssl makes the bootstrap self-signed cert
RUN apk add --no-cache nginx openssl

# app code + deps (server runs straight from TS via Node 24 type-stripping)
COPY --from=build /app/node_modules ./node_modules
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

ENTRYPOINT ["/entrypoint.sh"]
