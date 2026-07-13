import { createCheckpoint } from '../modules/checkpoints/create-checkpoint.js';

export interface CheckpointJobHandle {
  stop: () => void;
}

// 5 minutes — matches the dual-trigger design decided earlier
// (automatic scheduled job + manual POST /checkpoints for demos/ops).
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Runs createCheckpoint() on a fixed interval. Failures are logged,
 * not thrown or retried — a missed checkpoint isn't data loss (the
 * next tick tries again), and this system deliberately keeps the
 * ledger itself free of failed-attempt records (see: ledger-errors.ts
 * design note on why failures go to observability, not the ledger).
 *
 * Returns a handle to stop the job, for clean shutdown — an unbounded
 * setInterval with no way to stop it is a real (if small) production
 * smell, worth avoiding even at this scope.
 */
export function startCheckpointJob(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  onLog: (message: string) => void = console.log,
  onError: (error: unknown) => void = console.error
): CheckpointJobHandle {
  const timer = setInterval(() => {
    createCheckpoint()
      .then((result) => {
        onLog(
          `[checkpoint-job] created checkpoint #${result.sequenceNumber.toString()} ` +
            `(${result.memberCount} accounts, hash ${result.checkpointHash.slice(0, 8)}...)`
        );
      })
      .catch((error: unknown) => {
        onError(error);
      });
  }, intervalMs);

  // Don't let this interval keep the process alive on its own once
  // everything else has shut down.
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}