FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm install

COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux bash ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/backend/package.json /app/backend/package.json
COPY --from=build /app/frontend/package.json /app/frontend/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/backend/dist /app/backend/dist
COPY --from=build /app/frontend/dist /app/frontend/dist
COPY --from=build /app/.env.example /app/.env.example

ENV TOUCHMUX_PORT=8787
ENV TOUCHMUX_HOST=0.0.0.0
ENV TOUCHMUX_DATA_DIR=/data
ENV TOUCHMUX_WORKSPACE_ROOTS=/workspace

VOLUME ["/data", "/workspace"]

EXPOSE 8787

CMD ["node", "backend/dist/server.js"]
