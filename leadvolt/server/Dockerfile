FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,target=/tmp/npm-ca.crt \
    if [ -f /tmp/npm-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.crt; fi; \
    npm ci --workspace server --include-workspace-root=false
COPY server server
RUN npm run build -w server

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server/package.json server/
COPY --chown=node:node web/package.json web/
RUN --mount=type=secret,id=npm_ca,target=/tmp/npm-ca.crt \
    if [ -f /tmp/npm-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.crt; fi; \
    npm ci --workspace server --omit=dev --include-workspace-root=false && npm cache clean --force
COPY --from=build --chown=node:node /app/server/dist server/dist
COPY --chown=node:node server/migrations server/migrations
USER node
WORKDIR /app/server
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh","-c","node dist/migrate.js && node dist/index.js"]
