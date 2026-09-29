// Bundled by wrangler through `alias` (see wrangler.jsonc); typed loosely here
// so tsc doesn't type-check the orchestrator with this package's settings.
declare module '@gitroom/orchestrator/workflows' {
  const workflows: Record<string, (...args: unknown[]) => Promise<unknown>>;
  export = workflows;
}
