/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as WorkerEnv } from "../src/env";

/**
 * Teach `cloudflare:test` what this Worker's bindings are, so `env` in a test is the
 * same shape as `env` in the Worker rather than an untyped bag — and so a test that
 * reaches for a binding that does not exist fails at `npm run typecheck` rather than
 * at runtime.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
