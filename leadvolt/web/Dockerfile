FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,target=/tmp/npm-ca.crt \
    if [ -f /tmp/npm-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.crt; fi; \
    npm ci --workspace web --include-workspace-root=false
COPY web web
RUN npm run build -w web

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY --from=build --chown=101:101 /app/web/dist /usr/share/nginx/html
COPY --chown=101:101 web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
