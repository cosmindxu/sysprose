# Sysprose's OMG SysML v2 API & Services server (Express) — the optional networked REST +
# OSLC surface. The browser app itself needs no server; this container is only for
# teams that want a shared HTTP API. Run:  docker build -t sysprose-api . &&
# docker run -p 5178:5178 sysprose-api  → OpenAPI at :5178/openapi.json, OSLC at /oslc/*.
FROM node:22-slim
WORKDIR /app

# Install dependencies against the lockfile first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# App sources (node_modules, dist, tests excluded via .dockerignore).
COPY . .

ENV PORT=5178
# Bind all interfaces inside the container (the published port is the boundary);
# operators front this with auth/a reverse proxy.
ENV HOST=0.0.0.0
EXPOSE 5178

# Drop privileges — the node:22-slim image ships a non-root `node` user.
USER node

# `npm run serve` = tsx src/server/index.ts (resolves @-aliases + the bundled library).
CMD ["npm", "run", "serve"]
