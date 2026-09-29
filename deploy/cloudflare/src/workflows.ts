import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import * as workflows from '@gitroom/orchestrator/workflows';
import { ActivityOutcome, ContinueAsNew, runtime } from './temporal';

// Runs Postiz's Temporal workflows (apps/orchestrator/src/workflows) on
// Cloudflare Workflows. A Temporal workflow id maps to a chain of Cloudflare
// instances (restarts, continueAsNew); workflow_runs tracks them.

export interface WorkflowsEnv {
  DB: D1Database;
  TEMPORAL_WF: Workflow;
}

interface Params {
  name: string;
  workflowId: string;
  args: unknown[];
  postId?: string;
}

const registry = workflows as unknown as Record<
  string,
  (...args: unknown[]) => Promise<unknown>
>;

const RUNNING = [
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
  'unknown',
];
const TEMPORAL_STATUS: Record<string, string> = {
  complete: 'COMPLETED',
  errored: 'FAILED',
  terminated: 'TERMINATED',
};

const current = async (env: WorkflowsEnv, workflowId: string) => {
  const row = await env.DB.prepare(
    'SELECT instance_id FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(workflowId)
    .first<{ instance_id: string }>();
  if (!row) {
    return undefined;
  }
  const instance = await env.TEMPORAL_WF.get(row.instance_id);
  return { instance, ...(await instance.status()) };
};

export const startWorkflow = async (
  env: WorkflowsEnv,
  name: string,
  workflowId: string,
  args: unknown[],
  postId?: string
) => {
  if (!registry[name]) {
    throw new Error(`Unknown workflow ${name}`);
  }
  const instanceId = `${workflowId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)}-${crypto.randomUUID().slice(0, 8)}`;
  await env.TEMPORAL_WF.create({
    id: instanceId,
    params: { name, workflowId, args, postId } satisfies Params,
  });
  await env.DB.prepare(
    'INSERT INTO workflow_runs (instance_id, workflow_id, name, post_id, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(instanceId, workflowId, name, postId ?? null, Date.now())
    .run();
};

const describe = async (env: WorkflowsEnv, workflowId: string) => {
  const run = await current(env, workflowId);
  if (!run) {
    return undefined;
  }
  return {
    status: RUNNING.includes(run.status)
      ? 'RUNNING'
      : TEMPORAL_STATUS[run.status] || 'UNKNOWN',
    output: run.output,
    instance: run.instance,
  };
};

// Handles the calls made by
// libraries/nestjs-libraries/src/temporal/cloudflare.workflows.service.ts
export const handleWorkflowsRequest = async (
  request: Request,
  env: WorkflowsEnv
) => {
  const op = new URL(request.url).pathname.slice(1);
  const body = (await request.json()) as any;
  try {
    switch (op) {
      case 'start':
      case 'signal-with-start': {
        const run = await describe(env, body.workflowId);
        const running = run?.status === 'RUNNING';
        if (running && op === 'signal-with-start') {
          // signalWithStart always signals the running execution
        } else if (running && body.conflict === 'USE_EXISTING') {
          return Response.json({ workflowId: body.workflowId });
        } else if (running && body.conflict === 'TERMINATE_EXISTING') {
          await run.instance.terminate();
        } else if (running) {
          return Response.json(
            { error: `Workflow execution already started: ${body.workflowId}` },
            { status: 409 }
          );
        }
        if (!running || op === 'start') {
          await startWorkflow(
            env,
            body.name,
            body.workflowId,
            body.args,
            body.postId
          );
        }
        if (op === 'signal-with-start') {
          const { instance } = (await current(env, body.workflowId))!;
          await instance.sendEvent({
            type: 'signal',
            payload: {
              name: body.signal,
              args: body.signalArgs,
              at: Date.now(),
            },
          });
        }
        return Response.json({ workflowId: body.workflowId });
      }
      case 'list': {
        const { results } = await env.DB.prepare(
          'SELECT DISTINCT workflow_id FROM workflow_runs WHERE post_id = ?'
        )
          .bind(body.postId)
          .all<{ workflow_id: string }>();
        const workflows = [];
        for (const { workflow_id } of results) {
          if ((await describe(env, workflow_id))?.status === 'RUNNING') {
            workflows.push({ workflowId: workflow_id });
          }
        }
        return Response.json({ workflows });
      }
      case 'describe':
      case 'result': {
        const run = await describe(env, body.workflowId);
        if (!run) {
          return Response.json(
            { error: 'Workflow not found' },
            { status: 404 }
          );
        }
        return Response.json({ status: run.status, output: run.output });
      }
      case 'terminate': {
        const run = await describe(env, body.workflowId);
        if (run?.status === 'RUNNING') {
          await run.instance.terminate();
        }
        return Response.json({});
      }
    }
    return Response.json({ error: `Unknown operation ${op}` }, { status: 404 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
};

// Calls an activity on the orchestrator (apps/orchestrator/src/activity.controller.ts).
// Throws only when the orchestrator can't be reached, so the step retries.
export const callActivity = async (
  fetcher: (request: Request) => Promise<Response>,
  name: string,
  args: unknown[],
  timeoutMs: number
): Promise<ActivityOutcome> => {
  const request = fetcher(
    new Request(`http://orchestrator/activity/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
  );
  // like a Temporal StartToClose timeout: stop waiting, the call may still finish
  const timedOut = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs)
  );
  const res = await Promise.race([request, timedOut]);
  if (res === 'timeout') {
    return { ok: false, at: Date.now(), timeout: true };
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`orchestrator returned ${res.status}`);
  }
  const data = (await res.json()) as any;
  if (res.status === 404) {
    return {
      ok: false,
      at: Date.now(),
      failure: { message: data.error, type: 'NotFound', nonRetryable: true },
    };
  }
  return data.failure
    ? { ok: false, at: Date.now(), failure: data.failure }
    : { ok: true, at: Date.now(), result: data.result };
};

export abstract class TemporalWorkflowBase<
  Env extends WorkflowsEnv
> extends WorkflowEntrypoint<Env, Params> {
  abstract activity(
    name: string,
    args: unknown[],
    timeoutMs: number
  ): Promise<ActivityOutcome>;

  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { name, workflowId, args, postId } = event.payload;
    const r = {
      step,
      workflowId,
      now: new Date(event.timestamp).getTime(),
      seq: 0,
      handlers: new Map(),
      nameOf: (fn: unknown) =>
        typeof fn === 'string'
          ? fn
          : Object.keys(registry).find((key) => registry[key] === fn)!,
      activity: (n: string, a: unknown[], t: number) => this.activity(n, a, t),
      start: (n: string, id: string, a: unknown[], p?: string) =>
        startWorkflow(this.env, n, id, a, p),
      status: async (id: string) => {
        const run = await describe(this.env, id);
        return { status: run?.status || 'UNKNOWN', output: run?.output };
      },
    };
    try {
      return await runtime.run(r, () => registry[name](...args));
    } catch (err) {
      if (!(err instanceof ContinueAsNew)) {
        throw err;
      }
      await step.do('continue-as-new', () =>
        startWorkflow(this.env, name, workflowId, err.args, postId)
      );
    }
  }
}
