# Pure Foodmart ERP — web app (static, nginx) with /api proxied to the API service
# Build from the repo root:  docker build -f infra/web.Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY db ./db
RUN pnpm install --frozen-lockfile && pnpm --filter @pfm/web build

FROM nginx:1.27-alpine
# API_UPSTREAM (e.g. http://pfm-api.internal:3000) is substituted at start.
ENV API_UPSTREAM=http://api:3000
COPY infra/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
