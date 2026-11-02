/** Stub for cloudflare:workers — 只提供 SSR bundle 在纯 Node 里需要的最小面 */
export class WorkerEntrypoint {
  constructor(env, ctx) {
    this.env = env;
    this.ctx = ctx ?? { waitUntil() {}, passThroughOnException() {} };
  }
}
export default WorkerEntrypoint;
export class DurableObject {}
export class WorkflowEntrypoint {}