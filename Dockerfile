FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps apps
RUN npm run build

FROM node:24-bookworm-slim AS api
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @regutrack/api
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
CMD ["node", "apps/api/dist/index.js"]

FROM build AS web
USER node
CMD ["npm", "run", "start", "--workspace", "@regutrack/web"]

FROM caddy:2-alpine AS production-web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
