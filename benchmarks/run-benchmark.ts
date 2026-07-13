/**
 * Benchmark script — produces REAL numbers from a live Postgres
 * instance, not estimates. Run with: npx tsx benchmarks/run-benchmark.ts
 *
 * Three deliberately different scenarios, because a single throughput
 * number is easy to cherry-pick and doesn't tell an honest story:
 *
 *   1. Sequential latency  — one transfer at a time, same pair.
 *      What a single request actually costs, no concurrency involved.
 *   2. Concurrent, independent pairs — many transfers in parallel,
 *      each between a DIFFERENT pair of accounts. Best-case achievable
 *      throughput, since sorted lock ordering never causes any of
 *      these to wait on each other.
 *   3. Concurrent, same pair (contention) — many transfers in
 *      parallel, all on the SAME two accounts. Worst-case: every
 *      transfer serializes behind the FOR UPDATE lock. This number
 *      being much lower than (2) is EXPECTED and correct, not a
 *      performance bug — it's proof the locking is actually locking.
 *
 * All results are specific to whatever machine/container this runs
 * on. They are not a production capacity claim.
 */

import { db } from '../src/db/client.js';
import { createAccount } from '../src/modules/accounts/create-account.js';
import { transferFunds } from '../src/modules/ledger/commands/transfer-funds.js';
import { depositFunds } from '../src/modules/ledger/commands/deposit-funds.js';
import { createCheckpoint } from '../src/modules/checkpoints/create-checkpoint.js';

interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function computeStats(durationsMs: number[]): LatencyStats {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] ?? 0;
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sum / sorted.length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
  };
}

function formatStats(stats: LatencyStats): string {
  return (
    `n=${stats.count}  ` +
    `min=${stats.minMs.toFixed(1)}ms  ` +
    `mean=${stats.meanMs.toFixed(1)}ms  ` +
    `p50=${stats.p50Ms.toFixed(1)}ms  ` +
    `p95=${stats.p95Ms.toFixed(1)}ms  ` +
    `p99=${stats.p99Ms.toFixed(1)}ms  ` +
    `max=${stats.maxMs.toFixed(1)}ms`
  );
}

async function makeWallet(name: string) {
  return createAccount({
    accountCode: `WALLET:BENCH:${crypto.randomUUID()}`,
    name,
    accountType: 'liability',
  });
}

async function makeHouse(name: string) {
  return createAccount({
    accountCode: `BANK:BENCH:${crypto.randomUUID()}`,
    name,
    accountType: 'asset',
  });
}

async function benchmarkSequential(n: number): Promise<LatencyStats> {
  const alice = await makeWallet('Bench Sequential Alice');
  const bob = await makeWallet('Bench Sequential Bob');
  const house = await makeHouse('Bench Sequential House');

  await depositFunds({
    fundingAccountId: house.accountId,
    toAccountId: alice.accountId,
    amount: '1000000.00',
    idempotencyKey: `bench-seed-${crypto.randomUUID()}`,
  });

  const durations: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '1.00',
      idempotencyKey: `bench-seq-${i}-${crypto.randomUUID()}`,
    });
    durations.push(performance.now() - start);
  }
  return computeStats(durations);
}

async function benchmarkConcurrentIndependentPairs(
  n: number
): Promise<{ stats: LatencyStats; throughputPerSec: number }> {
  const pairs = await Promise.all(
    Array.from({ length: n }, async () => {
      const from = await makeWallet('Bench Indep From');
      const to = await makeWallet('Bench Indep To');
      const house = await makeHouse('Bench Indep House');
      await depositFunds({
        fundingAccountId: house.accountId,
        toAccountId: from.accountId,
        amount: '100.00',
        idempotencyKey: `bench-seed-${crypto.randomUUID()}`,
      });
      return { from: from.accountId, to: to.accountId };
    })
  );

  const durations: number[] = [];
  const overallStart = performance.now();
  await Promise.all(
    pairs.map(async (pair) => {
      const start = performance.now();
      await transferFunds({
        fromAccountId: pair.from,
        toAccountId: pair.to,
        amount: '1.00',
        idempotencyKey: `bench-indep-${crypto.randomUUID()}`,
      });
      durations.push(performance.now() - start);
    })
  );
  const totalMs = performance.now() - overallStart;

  return { stats: computeStats(durations), throughputPerSec: (n / totalMs) * 1000 };
}

async function benchmarkContentionSamePair(
  n: number
): Promise<{ stats: LatencyStats; throughputPerSec: number }> {
  const alice = await makeWallet('Bench Contend Alice');
  const bob = await makeWallet('Bench Contend Bob');
  const house = await makeHouse('Bench Contend House');
  await depositFunds({
    fundingAccountId: house.accountId,
    toAccountId: alice.accountId,
    amount: '10000.00',
    idempotencyKey: `bench-seed-${crypto.randomUUID()}`,
  });

  const durations: number[] = [];
  const overallStart = performance.now();
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const start = performance.now();
      await transferFunds({
        fromAccountId: alice.accountId,
        toAccountId: bob.accountId,
        amount: '1.00',
        idempotencyKey: `bench-contend-${i}-${crypto.randomUUID()}`,
      });
      durations.push(performance.now() - start);
    })
  );
  const totalMs = performance.now() - overallStart;

  return { stats: computeStats(durations), throughputPerSec: (n / totalMs) * 1000 };
}

async function benchmarkCheckpoint(): Promise<{ durationMs: number; accountCount: number }> {
  const countRow = await db
    .selectFrom('accounts')
    .select(db.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();

  const start = performance.now();
  await createCheckpoint();
  const durationMs = performance.now() - start;

  return { durationMs, accountCount: Number(countRow.count) };
}

async function main() {
  console.log('Akashic Benchmark');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log('='.repeat(70));

  console.log('\n[1/4] Sequential transfers (n=200, single account pair)...');
  const sequential = await benchmarkSequential(200);
  console.log(formatStats(sequential));

  console.log('\n[2/4] Concurrent transfers, independent pairs (n=100)...');
  const independent = await benchmarkConcurrentIndependentPairs(100);
  console.log(formatStats(independent.stats));
  console.log(`throughput=${independent.throughputPerSec.toFixed(1)} transfers/sec`);

  console.log('\n[3/4] Concurrent transfers, SAME pair — contention (n=50)...');
  const contention = await benchmarkContentionSamePair(50);
  console.log(formatStats(contention.stats));
  console.log(`throughput=${contention.throughputPerSec.toFixed(1)} transfers/sec`);

  console.log('\n[4/4] Checkpoint creation...');
  const checkpoint = await benchmarkCheckpoint();
  console.log(
    `checkpoint over ${checkpoint.accountCount} accounts: ${checkpoint.durationMs.toFixed(1)}ms`
  );

  console.log('\n' + '='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Sequential transfer:        p50=${sequential.p50Ms.toFixed(1)}ms  p99=${sequential.p99Ms.toFixed(1)}ms`);
  console.log(`Concurrent (independent):   ${independent.throughputPerSec.toFixed(1)} transfers/sec  (p50=${independent.stats.p50Ms.toFixed(1)}ms)`);
  console.log(`Concurrent (same pair):     ${contention.throughputPerSec.toFixed(1)} transfers/sec  (p50=${contention.stats.p50Ms.toFixed(1)}ms)`);
  console.log(`Checkpoint (${checkpoint.accountCount} accounts):     ${checkpoint.durationMs.toFixed(1)}ms`);
  console.log('\nNOTE: numbers are specific to this machine/container and are not a production capacity claim.');

  await db.destroy();
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});