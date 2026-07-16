FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci
COPY packages ./packages
RUN npm run build --workspace @product/contracts && npm run build --workspace @product/server
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --uid 10001 app
COPY --from=build --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/packages/contracts ./packages/contracts
COPY --from=build --chown=app:app /app/packages/server ./packages/server
USER app
EXPOSE 8080
CMD ["node", "packages/server/dist/api.js"]
