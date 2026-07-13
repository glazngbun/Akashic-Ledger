import { runFullAudit } from './run-audit.js';
import { db } from '../../db/client.js';

async function main(): Promise<void> {
  const report = await runFullAudit({
    onSection: (section) => console.log(section),
  });

  if (report.accountChainFailures.length === 0) {
    console.log(`\u2713 ${report.accountsChecked} accounts verified`);
  } else {
    console.log(
      `\u2717 ${report.accountChainFailures.length} account(s) FAILED chain verification: ` +
        report.accountChainFailures.map((id) => id.toString()).join(', ')
    );
  }

  if (report.checkpointsValid) {
    console.log(`\u2713 ${report.checkpointsChecked} checkpoints verified`);
  } else {
    console.log(`\u2717 checkpoint chain verification FAILED`);
  }

  if (report.balanceFailures.length === 0) {
    console.log(`\u2713 All balances reconcile`);
  } else {
    console.log(
      `\u2717 ${report.balanceFailures.length} account(s) FAILED balance reconciliation: ` +
        report.balanceFailures.map((id) => id.toString()).join(', ')
    );
  }

  if (report.zeroSumValid) {
    console.log(`\u2713 ${report.entriesChecked.toLocaleString()} journal entries balanced`);
  } else {
    console.log(`\u2717 zero-sum invariant FAILED`);
  }

  console.log(report.passed ? '\nAudit complete.' : '\nAudit FAILED.');

  await db.destroy();
  process.exit(report.passed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('Audit crashed:', err);
  process.exit(1);
});