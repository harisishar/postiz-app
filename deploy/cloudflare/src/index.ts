import { Container, getContainer } from '@cloudflare/containers';
import {
  callActivity,
  handleWorkflowsRequest,
  TemporalWorkflowBase,
} from './workflows';

interface Env {
  APP: DurableObjectNamespace<PostizContainer>;
  DB: D1Database;
  TEMPORAL_WF: Workflow;
  [key: string]: unknown;
}

const ORCHESTRATOR_PORT = 3002;

// Postiz itself, one named instance: nginx :5000 (Next.js + backend) and the
// orchestrator :3002, which only runs activities (see src/workflows.ts).
export class PostizContainer extends Container<Env> {
  defaultPort = 5000;
  requiredPorts = [5000, ORCHESTRATOR_PORT];
  sleepAfter = '15m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      // every string var/secret on the Worker is handed to the app as-is
      ...Object.fromEntries(
        Object.entries(env).filter(([, v]) => typeof v === 'string')
      ),
      D1_BRIDGE_URL: 'http://d1.internal/',
      WORKFLOWS_URL: 'http://wf.internal/',
      // required by the sqlite datasource, never opened (queries go through the adapter)
      DATABASE_URL: 'file:/tmp/unused.db',
    } as Record<string, string>;
  }

  runActivity(name: string, args: unknown[], timeoutMs: number) {
    return callActivity(
      (request) => this.containerFetch(request, ORCHESTRATOR_PORT),
      name,
      args,
      timeoutMs
    );
  }
}

// The container has no bindings; libraries/.../prisma/d1.bridge.ts calls this.
export const handleD1Request = async (request: Request, env: Env) => {
  try {
    const {
      op,
      sql,
      args = [],
    } = (await request.json()) as {
      op: 'raw' | 'run' | 'exec';
      sql: string;
      args?: unknown[];
    };
    if (op === 'exec') {
      return Response.json(await env.DB.exec(sql));
    }
    const stmt = env.DB.prepare(sql).bind(...args);
    if (op === 'run') {
      return Response.json(await stmt.run());
    }
    const rows = await stmt.raw({ columnNames: true });
    // blobs don't survive JSON, send them as byte arrays like PrismaD1 expects
    return Response.json(
      rows.map((row) =>
        row.map((v) =>
          v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v
        )
      )
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
};

PostizContainer.outboundByHost = {
  'd1.internal': (request, env: Env) => handleD1Request(request, env),
  'wf.internal': (request, env: Env) => handleWorkflowsRequest(request, env),
};

export class TemporalWorkflow extends TemporalWorkflowBase<Env> {
  activity(name: string, args: unknown[], timeoutMs: number) {
    return getContainer(this.env.APP, 'main').runActivity(
      name,
      args,
      timeoutMs
    );
  }
}

export default {
  fetch(request: Request, env: Env) {
    return getContainer(env.APP, 'main').fetch(request);
  },
};
