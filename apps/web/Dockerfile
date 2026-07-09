FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl fontconfig fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci

# render_proof (scripts/render-materialized-artifact.ts) launches Chromium via
# Playwright to verify generated artifacts actually render without console
# errors before publish. Without the browser binary + its system deps, that
# check silently fails ("unparsed") and blocks every publish.
RUN npx playwright install --with-deps chromium

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
# DATABASE_URL は実行時に Cloud Run から注入する（Cloud SQL postgres、Secret Manager）。
# イメージには provider=postgresql の Prisma クライアントを焼き込む。

# ビルド時のみダミーURL（postgres）を設定し、createPrismaClient() が pg adapter を選ぶようにする。
# next build の "Collecting page data" フェーズでモジュール初期化が走るため必要。
# 実際の接続は行われない（force-dynamic ページはクエリを発行しない）。
# DATABASE_URL は実行時に Cloud Run から Secret Manager 経由で注入される。
RUN DATABASE_URL="postgresql://build:build@localhost/build" npm run db:generate:postgres && \
    DATABASE_URL="postgresql://build:build@localhost/build" npm run build

EXPOSE 8080

# 起動毎の再seedは廃止。スキーマ初期化(db push)+seedは1回だけ別Job(prodia-db-init)で実行する。
CMD ["npm", "run", "start"]
