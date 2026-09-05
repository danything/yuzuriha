FROM oven/bun:1.4.2-slim AS base
WORKDIR /usr/src/app
EXPOSE 5173
ENV PORT=5173
ENV TZ=Asia/Tokyo

# maplibre-gl は devDependency。dist を assets/ へ写すためだけに要る。
FROM base AS builder
COPY package.json bun.lock ./
RUN bun i --frozen-lockfile
COPY . .
RUN bun build-web.ts

FROM base
# サーバもスクレイパも npm の依存を持たないので、実行イメージに
# node_modules は入れない。
RUN mkdir -p data && chown bun:bun data
USER bun
COPY --from=builder --chown=bun:bun /usr/src/app/package.json ./
COPY --from=builder --chown=bun:bun /usr/src/app/*.ts ./
COPY --from=builder --chown=bun:bun /usr/src/app/sources ./sources
COPY --from=builder --chown=bun:bun /usr/src/app/index.html ./
COPY --from=builder --chown=bun:bun /usr/src/app/assets ./assets
CMD ["bun", "server.ts"]
