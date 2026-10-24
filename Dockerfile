FROM oven/bun:1.4.4-slim AS base
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
# 実行の段にはシェルが無いので、PVC を被せる data/ はここで作って持ち主ごと写す。
RUN mkdir -p /out/data

# 実行はシェルもパッケージマネージャも無い distroless の Bun。glibc・CA 証明書・
# tzdata は入っているので、TZ=Asia/Tokyo もそのまま効く。uid は slim の bun ユーザーと
# 同じ 1000:1000 のままにして、今の PVC をそのまま書けるようにする。
FROM oven/bun:1.4.4-distroless
WORKDIR /usr/src/app
EXPOSE 5173
ENV PORT=5173
ENV TZ=Asia/Tokyo
USER 1000:1000
# サーバもスクレイパも npm の依存を持たないので、実行イメージに
# node_modules は入れない。
COPY --from=builder --chown=1000:1000 /out/ ./
COPY --from=builder --chown=1000:1000 /usr/src/app/package.json ./
COPY --from=builder --chown=1000:1000 /usr/src/app/*.ts ./
COPY --from=builder --chown=1000:1000 /usr/src/app/sources ./sources
COPY --from=builder --chown=1000:1000 /usr/src/app/index.html ./
COPY --from=builder --chown=1000:1000 /usr/src/app/assets ./assets
# エントリポイントは bun そのもの (元のイメージもそう)。CMD は引数だけにするため明示する。
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["server.ts"]
