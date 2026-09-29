# Postiz on Cloudflare

Runs Postiz on Cloudflare only: a Container for the app, D1 for the database,
R2 for media, and Workflows in place of Temporal. See "Known gaps" before using
it in production.

## One-time setup
Requires the Workers Paid plan and Docker with `buildx`.

```sh
cd deploy/cloudflare
pnpm install --ignore-workspace
pnpm exec wrangler login
pnpm exec wrangler d1 create postiz            # paste database_id into wrangler.jsonc
pnpm exec wrangler r2 bucket create postiz-media
# R2 dashboard: attach a custom domain (e.g. media.example.com) to the bucket,
# and create an R2 API token (S3 access key + secret).
```

Edit `vars` in `wrangler.jsonc` (your domains), then add secrets:

```sh
for s in JWT_SECRET CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ACCESS_KEY CLOUDFLARE_SECRET_ACCESS_KEY \
         FACEBOOK_APP_ID FACEBOOK_APP_SECRET INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET \
         THREADS_APP_ID THREADS_APP_SECRET RESEND_API_KEY; do
  pnpm exec wrangler secret put $s
done
```

## Deploy
```sh
pnpm run migrations:init     # regenerate migrations/0001_init.sql from the upstream schema
pnpm run migrations:apply
pnpm run deploy
```
Attach your app domain to the `postiz` Worker in the dashboard (Workers → Settings → Domains).

## Meta app
In your Meta app, set the OAuth redirect URIs to `https://<app-domain>/integrations/social/{facebook,instagram,instagram-standalone,threads}`.
Media URLs must be on the public R2 custom domain; Meta downloads every image and video from it.

## How it works
- **Database.** `to-d1-schema.sh` converts the upstream Postgres schema to SQLite during the image build, so there's no forked schema. The app reaches D1 through `libraries/nestjs-libraries/src/database/prisma/d1.bridge.ts`, which calls `http://d1.internal`. The Worker's outbound handler (`src/index.ts`) runs the query.
- **Workflows.** Postiz's Temporal workflows (`apps/orchestrator/src/workflows`) are bundled into the Worker unchanged. `src/temporal.ts` provides the Temporal workflow API on Cloudflare Workflows steps (activities, timers, signals, child workflows, continueAsNew, deterministic time). Each activity runs in the container on the orchestrator's `/activity/:name` endpoint (`apps/orchestrator/src/activity.controller.ts`, port 3002).
- **Starting workflows.** The backend and orchestrator start, signal and terminate workflows through `libraries/nestjs-libraries/src/temporal/cloudflare.workflows.service.ts`. It replaces `TemporalService` when `WORKFLOWS_URL` is set and calls `http://wf.internal`. Temporal workflow ids map to Cloudflare instances in the `workflow_runs` D1 table.

## Known gaps
- D1 has no transactions: `$transaction` runs its queries one at a time.
- `count`/`updateMany`/`deleteMany` with more than 98 values in an `in: [...]` list fail on D1 (`findMany` is fine). Only `detachAnchorsForPost` in `posts.repository.ts` builds such a list.
- The image build removes `mode: 'insensitive'` and `skipDuplicates` from its copy of the code, because the SQLite client rejects both. Searches stay case-insensitive for ASCII, but `getUserByEmail` becomes case-sensitive, and caching an already-cached mention (`insertMentions`) throws.
- Per-provider activity concurrency (`maxConcurrentJob`, Temporal task queues) isn't enforced: activities for one provider can run in parallel.
- Activities send no heartbeats, so a publish that times out is always treated as "outcome unknown" (the post is marked unconfirmed, never retried).
- Workflows that loop forever (`missingPostWorkflow`, `autoPostWorkflow`) use about 2 steps per hour, so they eventually hit Cloudflare's per-instance step limit and error. Restart them by redeploying (RUN_CRON) or re-enabling the autopost.
- An activity result larger than 1 MiB (Cloudflare's step output limit) fails the step instead of returning.
- Race: a signal sent in the moment between a workflow ending and its `continueAsNew` successor being registered (`send_email`, digest emails) starts a second instance.
- `@mastra/pg` (the AI agent) still expects Postgres.
- A single container instance (`max_instances: 1`) serves everything; Redis is replaced by in-memory state.
