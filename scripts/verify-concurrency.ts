import { db } from './src/db/client.js';
import { createAccount } from './src/modules/accounts/create-account.js';
import { transferFunds } from './src/modules/ledger/commands/transfer-funds.js';

async function main() {
  const alice = await createAccount({
    accountCode: `WALLET:USER:${crypto.randomUUID()}`,
    name: 'Alice-Concurrency',
    accountType: 'liability',
  });
  const bob = await createAccount({
    accountCode: `WALLET:USER:${crypto.randomUUID()}`,
    name: 'Bob-Concurrency',
    accountType: 'liability',
  });

  // Seed both directly — this is the concurrency test, not another
  // deposit-flow test.
  await db
    .updateTable('account_state')
    .set({ current_balance: '1000.0000' })
    .where('account_id', '=', alice.accountId.toString())
    .execute();
  await db
    .updateTable('account_state')
    .set({ current_balance: '1000.0000' })
    .where('account_id', '=', bob.accountId.toString())
    .execute();

  console.log('Alice id:', alice.accountId.toString(), '(lower)');
  console.log('Bob id:', bob.accountId.toString(), '(higher)');
  console.log('\nFiring 20 concurrent transfers: 10x Alice->Bob and 10x Bob->Alice, interleaved...');

  const transfers: Promise<unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    // Alice -> Bob would naturally lock Alice first, then Bob.
    transfers.push(
      transferFunds({
        fromAccountId: alice.accountId,
        toAccountId: bob.accountId,
        amount: '1.00',
        idempotencyKey: `concurrency-a2b-${i}-${crypto.randomUUID()}`,
      })
    );
    // Bob -> Alice, WITHOUT sorted lock ordering, would naturally lock
    // Bob first, then Alice — the classic opposite-order deadlock
    // setup. If postLedgerEntries' sorted account_id locking is
    // actually working, this should never deadlock regardless of
    // which "direction" the transfer conceptually runs.
    transfers.push(
      transferFunds({
        fromAccountId: bob.accountId,
        toAccountId: alice.accountId,
        amount: '1.00',
        idempotencyKey: `concurrency-b2a-${i}-${crypto.randomUUID()}`,
      })
    );
  }

  const start = Date.now();
  const results = await Promise.allSettled(transfers);
  const elapsed = Date.now() - start;

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected');

  console.log(`\nCompleted in ${elapsed}ms`);
  console.log(`Succeeded: ${succeeded}/20`);
  console.log(`Failed: ${failed.length}/20`);

  if (failed.length > 0) {
    console.log('\nFailure reasons:');
    for (const f of failed) {
      if (f.status === 'rejected') {
        console.log(' -', f.reason?.message ?? f.reason);
      }
    }
  }

  // Since each side sends 10x $1.00 to the other, net effect should be
  // zero — both balances should be back to exactly 1000.0000.
  const aliceFinal = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', alice.accountId.toString())
    .executeTakeFirstOrThrow();
  const bobFinal = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', bob.accountId.toString())
    .executeTakeFirstOrThrow();

  console.log('\nAlice final balance:', aliceFinal.current_balance, '(expect 1000.0000)');
  console.log('Bob final balance:', bobFinal.current_balance, '(expect 1000.0000)');

  console.assert(succeeded === 20, 'FAIL: not all transfers succeeded — check for deadlock errors above');
  console.assert(aliceFinal.current_balance === '1000.0000', 'FAIL: Alice balance drifted');
  console.assert(bobFinal.current_balance === '1000.0000', 'FAIL: Bob balance drifted');

  await db.destroy();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});