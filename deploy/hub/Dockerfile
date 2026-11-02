ARG NODE_IMAGE
ARG NGINX_IMAGE
FROM ${NODE_IMAGE} AS dependencies
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl git python3 python3-venv openssh-client sshpass acl && rm -rf /var/lib/apt/lists/*
COPY deploy/requirements.txt deploy/requirements.txt
RUN python3 -m venv /opt/ansible && /opt/ansible/bin/pip install --no-cache-dir -r deploy/requirements.txt
ENV PATH=/opt/ansible/bin:$PATH
COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/control-api/package.json apps/control-api/package.json
COPY apps/deploy-worker/package.json apps/deploy-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/automation/package.json packages/automation/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/platform/package.json packages/platform/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS source
COPY . .
RUN chmod -R a+rX /app && npm run db:generate
ENV npm_execpath=/usr/local/lib/node_modules/npm/bin/npm-cli.js

FROM source AS api-build
RUN node scripts/build-target.mjs api
FROM source AS worker-build
RUN node scripts/build-target.mjs worker
FROM source AS web-build
RUN node scripts/build-target.mjs web
FROM source AS tools
RUN node scripts/build-target.mjs tools
USER node

FROM api-build AS api
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund
ENV NODE_ENV=production
USER node
CMD ["node", "apps/control-api/dist/main.js"]
FROM worker-build AS worker
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund
ENV NODE_ENV=production
USER node
CMD ["node", "apps/deploy-worker/dist/main.js"]
FROM ${NGINX_IMAGE} AS web
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
