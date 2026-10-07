FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci
RUN npm run build -w @obsidian-crdt/server

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci --omit=dev --workspace @obsidian-crdt/server
COPY --from=build /app/packages/server/dist packages/server/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "packages/server/dist/server.js"]
