import { Global, Module } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

// Cloudflare deployment only (deploy/cloudflare): stands in for TemporalService
// when WORKFLOWS_URL is set. It covers exactly the client calls Postiz makes
// (workflow.start / signalWithStart / list, getWorkflowHandle, terminateWorkflow)
// and forwards them to the Worker, which runs the same workflows on Cloudflare
// Workflows.
const call = async (op: string, body: Record<string, unknown>) => {
  const res = await fetch(new URL(op, process.env.WORKFLOWS_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(data.error);
  }
  return data;
};

// Postiz only ever filters workflows by the postId search attribute
const postIdOf = (options: any): string | undefined =>
  options?.typedSearchAttributes
    ?.getAll?.()
    .find((p: any) => p.key?.name === 'postId')?.value;

const startBody = (name: string, options: any) => ({
  name,
  workflowId: options.workflowId,
  args: options.args || [],
  conflict: options.workflowIdConflictPolicy,
  postId: postIdOf(options),
});

const handle = (workflowId: string) => ({
  workflowId,
  describe: async () => ({
    status: { name: (await call('describe', { workflowId })).status },
  }),
  terminate: () => call('terminate', { workflowId }),
  result: async () => {
    const { status, output } = await call('result', { workflowId });
    if (status !== 'COMPLETED') {
      throw new Error(`Workflow ${workflowId} ${status.toLowerCase()}`);
    }
    return output;
  },
});

export const cloudflareTemporalService = {
  client: {
    getRawClient: () => ({
      workflow: {
        start: (name: string, options: any) =>
          call('start', startBody(name, options)),
        signalWithStart: (name: string, options: any) =>
          call('signal-with-start', {
            ...startBody(name, options),
            signal: options.signal,
            signalArgs: options.signalArgs || [],
          }),
        list: async function* ({ query }: { query: string }) {
          const postId = /postId="([^"]+)"/.exec(query)?.[1];
          yield* (await call('list', { postId })).workflows;
        },
      },
    }),
    getWorkflowHandle: async (workflowId: string) => handle(workflowId),
  },
  terminateWorkflow: (workflowId: string) => call('terminate', { workflowId }),
};

@Global()
@Module({
  providers: [
    { provide: TemporalService, useValue: cloudflareTemporalService },
  ],
  exports: [TemporalService],
})
export class CloudflareWorkflowsModule {}
