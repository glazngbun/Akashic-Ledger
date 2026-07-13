import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // DB round-trips + the concurrency test's 20 parallel transactions
    // need more headroom than the default unit-test timeout.
    testTimeout: 20_000,
    // Run integration test FILES sequentially, not in parallel worker
    // pools — they share one Postgres database and truncate tables
    // between tests, so concurrent files would stomp on each other.
    fileParallelism: false,
  },
});