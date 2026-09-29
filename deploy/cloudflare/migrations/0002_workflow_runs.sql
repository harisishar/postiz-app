-- Cloudflare Workflows instances per Temporal workflow id (src/workflows.ts).
-- Not part of the Prisma schema, Postiz never reads it.
CREATE TABLE "workflow_runs" (
    "instance_id" TEXT NOT NULL PRIMARY KEY,
    "workflow_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "post_id" TEXT,
    "created_at" INTEGER NOT NULL
);
CREATE INDEX "workflow_runs_workflow_id_idx" ON "workflow_runs"("workflow_id", "created_at");
CREATE INDEX "workflow_runs_post_id_idx" ON "workflow_runs"("post_id");
