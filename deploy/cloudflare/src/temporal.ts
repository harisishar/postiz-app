// Stands in for '@temporalio/workflow' and '@temporalio/common' (see `alias`
// in wrangler.jsonc) so Postiz's workflows in apps/orchestrator/src/workflows
// run unchanged on Cloudflare Workflows. Only the API those workflows use is
// implemented.
//
// Every operation becomes a Cloudflare step named by a per-instance counter.
// Cloudflare replays run() and returns cached step results, like Temporal
// replays history, so names stay stable as long as the workflow code is
// deterministic. Time is deterministic too (Temporal semantics): Date inside a
// workflow is the instance start time, advanced by each step.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowStep } from 'cloudflare:workers';

export type ActivityOutcome =
  | { ok: true; at: number; result: unknown }
  | { ok: false; at: number; timeout: true }
  | {
      ok: false;
      at: number;
      failure: {
        message: string;
        type: string;
        nonRetryable: boolean;
        details?: unknown[];
      };
    };

export interface Runtime {
  step: WorkflowStep;
  workflowId: string;
  now: number;
  seq: number;
  handlers: Map<string, (...args: any[]) => void>;
  nameOf: (fn: unknown) => string;
  activity: (
    name: string,
    args: unknown[],
    timeoutMs: number
  ) => Promise<ActivityOutcome>;
  start: (
    name: string,
    workflowId: string,
    args: unknown[],
    postId?: string
  ) => Promise<void>;
  status: (workflowId: string) => Promise<{ status: string; output?: any }>;
}

export const runtime = new AsyncLocalStorage<Runtime>();

const rt = () => {
  const r = runtime.getStore();
  if (!r) {
    throw new Error('Temporal workflow API used outside of a workflow');
  }
  return r;
};

// step calls run outside the workflow context so the step bodies (and the
// Workflows runtime) see the real clock
const outside = <T>(fn: () => Promise<T>) => runtime.exit(fn);

// ---- deterministic time ----
const RealDate = Date;
class WorkflowDate extends RealDate {
  constructor(...args: any[]) {
    const r = runtime.getStore();
    if (args.length === 0 && r) {
      super(r.now);
    } else {
      super(...(args as [any]));
    }
  }
  static now() {
    return runtime.getStore()?.now ?? RealDate.now();
  }
}
globalThis.Date = WorkflowDate as DateConstructor;

// ---- durations ('10 minute', '2 minutes', 3600000, ...) ----
const UNITS: Record<string, number> = {
  '': 1,
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60000,
  minute: 60000,
  minutes: 60000,
  h: 3600000,
  hour: 3600000,
  hours: 3600000,
  d: 86400000,
  day: 86400000,
  days: 86400000,
};
export const toMs = (value: string | number | undefined, fallback: number) => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === 'number') {
    return value;
  }
  const [, amount, unit] = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(value) || [];
  if (!amount || UNITS[unit.toLowerCase()] === undefined) {
    throw new Error(`Unsupported duration ${value}`);
  }
  return Number(amount) * UNITS[unit.toLowerCase()];
};

// ---- failures (@temporalio/common) ----
export class TemporalFailure extends Error {
  constructor(message?: string, public override cause?: Error) {
    super(message);
  }
}
export class ApplicationFailure extends TemporalFailure {
  constructor(
    message?: string,
    public type?: string,
    public nonRetryable = false,
    public details?: unknown[]
  ) {
    super(message);
    this.name = 'ApplicationFailure';
  }
  static create(options: {
    message?: string;
    type?: string;
    nonRetryable?: boolean;
    details?: unknown[];
  }) {
    return new ApplicationFailure(
      options.message,
      options.type,
      options.nonRetryable,
      options.details
    );
  }
  static nonRetryable(message?: string, type?: string, ...details: unknown[]) {
    return new ApplicationFailure(message, type, true, details);
  }
}
export enum TimeoutType {
  START_TO_CLOSE = 1,
  SCHEDULE_TO_START = 2,
  SCHEDULE_TO_CLOSE = 3,
  HEARTBEAT = 4,
}
export class TimeoutFailure extends TemporalFailure {
  constructor(
    message: string,
    public lastHeartbeatDetails: unknown,
    public timeoutType: TimeoutType
  ) {
    super(message);
    this.name = 'TimeoutFailure';
  }
}
export class ActivityFailure extends TemporalFailure {
  constructor(message: string, public activityType: string, cause?: Error) {
    super(message, cause);
    this.name = 'ActivityFailure';
  }
}
export class ChildWorkflowFailure extends TemporalFailure {
  constructor(message: string, public workflowId: string) {
    super(message);
    this.name = 'ChildWorkflowFailure';
  }
}

// ---- search attributes (@temporalio/common) ----
export enum SearchAttributeType {
  TEXT = 'TEXT',
  KEYWORD = 'KEYWORD',
  INT = 'INT',
  DOUBLE = 'DOUBLE',
  BOOL = 'BOOL',
  DATETIME = 'DATETIME',
  KEYWORD_LIST = 'KEYWORD_LIST',
}
export const defineSearchAttributeKey = (
  name: string,
  type: SearchAttributeType
) => ({ name, type });
export class TypedSearchAttributes {
  constructor(
    private pairs: { key: { name: string }; value: unknown }[] = []
  ) {}
  getAll() {
    return this.pairs;
  }
}
const postIdOf = (options: any): string | undefined =>
  options?.typedSearchAttributes
    ?.getAll?.()
    .find((p: any) => p.key?.name === 'postId')?.value;

// ---- activities ----
interface ActivityOptions {
  startToCloseTimeout?: string | number;
  retry?: {
    maximumAttempts?: number;
    initialInterval?: string | number;
    backoffCoefficient?: number;
    maximumInterval?: string | number;
    nonRetryableErrorTypes?: string[];
  };
  [key: string]: unknown;
}

// Temporal's default is unlimited attempts; a Cloudflare instance has a step
// budget, so cap it
const DEFAULT_MAX_ATTEMPTS = 10;

const runActivity = async (
  name: string,
  args: unknown[],
  options: ActivityOptions
) => {
  const r = rt();
  const id = r.seq++;
  const timeout = toMs(options.startToCloseTimeout, 10 * 60 * 1000);
  const retry = options.retry || {};
  const maxAttempts = retry.maximumAttempts || DEFAULT_MAX_ATTEMPTS;
  const initial = toMs(retry.initialInterval, 1000);
  const coefficient = retry.backoffCoefficient ?? 2;
  const maxInterval = toMs(retry.maximumInterval, initial * 100);

  for (let attempt = 1; ; attempt++) {
    // The step only throws when the container can't be reached (e.g. still
    // starting); Cloudflare retries that. Activity results and failures are
    // returned, so they are cached and never re-run on replay.
    const outcome = await outside(() =>
      r.step.do(
        `${id}:${name}:${attempt}`,
        {
          retries: { limit: 10, delay: '15 seconds', backoff: 'exponential' },
          timeout: timeout + 60000,
        },
        () => r.activity(name, args, timeout) as Promise<any>
      )
    );
    r.now = outcome.at;
    if (outcome.ok) {
      return outcome.result;
    }

    const cause =
      'timeout' in outcome
        ? new TimeoutFailure(
            'Activity StartToClose timeout',
            undefined,
            TimeoutType.START_TO_CLOSE
          )
        : new ApplicationFailure(
            outcome.failure.message,
            outcome.failure.type,
            outcome.failure.nonRetryable,
            outcome.failure.details
          );
    const retryable =
      !(cause instanceof ApplicationFailure && cause.nonRetryable) &&
      !(retry.nonRetryableErrorTypes || []).includes(
        (cause as ApplicationFailure).type || ''
      );
    if (!retryable || attempt >= maxAttempts) {
      throw new ActivityFailure('Activity task failed', name, cause);
    }

    const delay = Math.min(initial * coefficient ** (attempt - 1), maxInterval);
    await outside(() =>
      r.step.sleep(`${id}:${name}:${attempt}:backoff`, delay)
    );
    r.now += delay;
  }
};

export const proxyActivities = <T>(options: ActivityOptions = {}): T =>
  new Proxy(
    {},
    {
      get:
        (_, name: string) =>
        (...args: unknown[]) =>
          runActivity(name, args, options),
    }
  ) as T;

// ---- timers ----
export const sleep = async (duration: string | number) => {
  const r = rt();
  // always a step, even for 0: skipping it would shift every later step name
  const ms = Math.max(1, toMs(duration, 0));
  const name = `${r.seq++}:sleep`;
  await outside(() => r.step.sleep(name, ms));
  r.now += ms;
};

// ---- signals ----
export const defineSignal = <Args extends any[] = []>(name: string) =>
  ({ name, type: 'signal' } as { name: string; type: 'signal'; args?: Args });

export const setHandler = (
  definition: { name: string },
  handler: (...args: any[]) => void
) => {
  rt().handlers.set(definition.name, handler);
};

// Signals are Cloudflare events of type "signal", sent by the Worker with the
// signal name, arguments and send time. They are applied while the workflow
// waits in condition(), which is where Postiz's workflows consume them.
const waitForSignal = async (timeoutMs: number) => {
  const r = rt();
  const name = `${r.seq++}:signal`;
  try {
    const event = await outside(() =>
      r.step.waitForEvent<{ name: string; args: any[]; at: number }>(name, {
        type: 'signal',
        timeout: `${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds`,
      })
    );
    r.now = event.payload.at;
    r.handlers.get(event.payload.name)?.(...event.payload.args);
    return true;
  } catch (err) {
    console.error('waitForSignal failed', name, err);
    return false;
  }
};

const MAX_WAIT = 24 * 60 * 60 * 1000;

export const condition = async (
  fn: () => boolean,
  timeout?: string | number
) => {
  const r = rt();
  const deadline = timeout === undefined ? undefined : r.now + toMs(timeout, 0);
  while (!fn()) {
    const wait = deadline === undefined ? MAX_WAIT : deadline - r.now;
    if (wait <= 0) {
      return false;
    }
    if (!(await waitForSignal(wait)) && deadline !== undefined) {
      r.now = deadline;
    }
  }
  return true;
};

// ---- child workflows ----
interface ChildOptions {
  workflowId: string;
  args?: unknown[];
  [key: string]: unknown;
}

export const startChild = async (fn: unknown, options: ChildOptions) => {
  const r = rt();
  const name = r.nameOf(fn);
  const step = `${r.seq++}:start:${name}`;
  await outside(() =>
    r.step.do(step, () =>
      r.start(name, options.workflowId, options.args || [], postIdOf(options))
    )
  );
  return { workflowId: options.workflowId };
};

export const executeChild = async (fn: unknown, options: ChildOptions) => {
  await startChild(fn, options);
  const r = rt();
  // children can be awaited together (Promise.all), so their polling steps are
  // named per child: a shared counter would follow the completion order, which
  // differs on replay
  for (let poll = 0; ; poll++) {
    const key = `child:${options.workflowId}:${poll}`;
    const { status, output } = await outside(() =>
      r.step.do(`${key}:status`, () => r.status(options.workflowId))
    );
    if (status === 'COMPLETED') {
      return output;
    }
    if (status !== 'RUNNING') {
      throw new ChildWorkflowFailure(
        `Child workflow ${status.toLowerCase()}`,
        options.workflowId
      );
    }
    await outside(() => r.step.sleep(`${key}:sleep`, 10000));
  }
};

// ---- continue as new ----
export class ContinueAsNew extends Error {
  constructor(public args: unknown[]) {
    super('continueAsNew');
  }
}

export const continueAsNew = async (...args: unknown[]): Promise<never> => {
  // apply signals already sent to this instance, they would be lost with it;
  // handlers update the state that was passed in args
  while (await waitForSignal(1000)) {
    /* keep draining */
  }
  throw new ContinueAsNew(args);
};

// ---- misc ----
export const patched = (_id: string) => true;
export const workflowInfo = () => ({ workflowId: rt().workflowId });
export const log = console;
export const CancellationScope = {
  nonCancellable: <T>(fn: () => Promise<T>) => fn(),
  cancellable: <T>(fn: () => Promise<T>) => fn(),
};
export const isCancellation = (_err: unknown) => false;
