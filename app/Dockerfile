FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.19.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/src/app ./dist/src/app
RUN mkdir /data && chown node:node /data
USER node
ENV AI_REVIEW_LEDGER_PATH=/data/commands.sqlite PORT=3000
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/src/app/server.js"]
