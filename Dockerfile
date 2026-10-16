# syntax=docker/dockerfile:1.7
# One image, four roles (ROLE=api | worker | all | migrate). See docs/runbooks/deploy.md.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
# The runtime needs node only: drop the bundled package managers (and their dependencies' CVEs).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn*       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# Amazon RDS certificate authorities, for DATABASE_URL=...?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY dashboard ./dashboard
COPY checkout ./checkout
COPY ops ./ops
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 3000
# api: GET /healthz on localhost; worker: its heartbeat file is fresh (WORKER_STALL_MS).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "dist/ops/healthcheck.js"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
