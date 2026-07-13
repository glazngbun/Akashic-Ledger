import { db } from '../../db/client.js';
import { verifyAccountChain } from './verify-account-chain.js';
import { verifyBalanceReconciliation } from './verify-balance-reconciliation.js';
import { verifyZeroSumIndependent } from './verify-zero-sum.js';
import { verifyCheckpointChain } from '../checkpoints/verify-checkpoint.js';

export interface AuditReport {
  accountsChecked: number;
  accountChainFailures: bigint[];
  balanceFailures: bigint[];
  checkpointsValid: boolean;
  checkpointsChecked: number;
  zeroSumValid: boolean;
  entriesChecked: number;
  passed: boolean;
}

export interface AuditProgressCallbacks {
  onSection?: (section: string) => void;
}

/**
 * Runs all four independent verification layers against the current
 * database state:
 *
 *   1. Per-account hash chain integrity (every entry, every account)
 *   2. Checkpoint chain integrity
 *   3. Balance reconciliation (account_state vs. recomputed from log)
 *   4. Zero-sum invariant, independently of the DB trigger
 *
 * Kept as a pure function (no console output) so it's directly
 * testable; the CLI wrapper supplies onSection for live progress
 * output, the same callback pattern already used in checkpoint.job.ts.
 */
export async function runFullAudit(
  callbacks: AuditProgressCallbacks = {}
): Promise<AuditReport> {
  callbacks.onSection?.('Checking journal chains...');
  const accountRows = await db.selectFrom('accounts').select(['id']).execute();
  const accountIds = accountRows.map((row) => BigInt(row.id));

  const accountChainFailures: bigint[] = [];
  for (const accountId of accountIds) {
    const result = await verifyAccountChain(accountId);
    if (!result.valid) accountChainFailures.push(accountId);
  }

  callbacks.onSection?.('Checking checkpoints...');
  const checkpointResult = await verifyCheckpointChain();

  callbacks.onSection?.('Checking balances...');
  const balanceFailures: bigint[] = [];
  for (const accountId of accountIds) {
    const result = await verifyBalanceReconciliation(accountId);
    if (!result.valid) balanceFailures.push(accountId);
  }

  callbacks.onSection?.('Checking zero-sum invariant...');
  const zeroSumResult = await verifyZeroSumIndependent();

  const passed =
    accountChainFailures.length === 0 &&
    balanceFailures.length === 0 &&
    checkpointResult.valid &&
    zeroSumResult.valid;

  return {
    accountsChecked: accountIds.length,
    accountChainFailures,
    balanceFailures,
    checkpointsValid: checkpointResult.valid,
    checkpointsChecked: checkpointResult.checkpointsVerified,
    zeroSumValid: zeroSumResult.valid,
    entriesChecked: zeroSumResult.entriesChecked,
    passed,
  };
}