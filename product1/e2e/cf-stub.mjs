/** Stub for cloudflare:workers — only what the SSR bundle needs in plain Node. */
export class WorkerEntrypoint {
  constructor(env, ctx) {
    this.env = env;
    this.ctx = ctx ?? { waitUntil() {}, passThroughOnException() {} };
  }
}
export default WorkerEntrypoint;
