# Same image as /Dockerfile.dev, but with the Prisma client generated for D1 and
# without Temporal: workflows run on Cloudflare Workflows (src/workflows.ts).
# Build context is the repo root.
FROM node:22.20-bookworm-slim
ARG NEXT_PUBLIC_VERSION
ENV NEXT_PUBLIC_VERSION=$NEXT_PUBLIC_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    make \
    python3-pip \
    bash \
    nginx \
&& rm -rf /var/lib/apt/lists/*

RUN addgroup --system www \
 && adduser --system --ingroup www --home /www --shell /usr/sbin/nologin www \
 && mkdir -p /www \
 && chown -R www:www /www /var/lib/nginx

RUN npm --no-update-notifier --no-fund --global install pnpm@10.6.1 pm2

WORKDIR /app

COPY . /app
COPY var/docker/nginx.conf /etc/nginx/nginx.conf

# postinstall runs `prisma generate`, so convert the schema first
RUN ./deploy/cloudflare/to-d1-schema.sh libraries/nestjs-libraries/src/database/prisma/schema.prisma
# The SQLite client has no `mode: 'insensitive'` (LIKE is already
# case-insensitive for ASCII) and no `skipDuplicates`; drop them from this
# image's copy of the code so it type-checks and runs against D1.
RUN grep -rlE "mode: .insensitive.|skipDuplicates: true" libraries apps --include="*.ts" \
  | xargs sed -i -E \
    -e "/^\s*mode: .insensitive.( as const)?,?$/d" \
    -e "s/, mode: .insensitive.//" \
    -e "/^\s*skipDuplicates: true,?$/d"
RUN pnpm install
# Drop the build caches in the same layer: they're unused at runtime and made
# the layer too big to push to registry.cloudflare.com.
RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build \
 && rm -rf apps/frontend/.next/cache /root/.cache

# No `prisma db push` (D1 is migrated with wrangler). The orchestrator only
# serves activities to Cloudflare Workflows (WORKFLOWS_URL is set).
CMD ["sh", "-c", "nginx && pnpm --filter ./apps/backend run pm2 && pnpm --filter ./apps/frontend run pm2 && pnpm --filter ./apps/orchestrator run pm2 && pm2 logs"]
