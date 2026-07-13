import { db } from './src/db/client.js';
import { createAccount } from './src/modules/accounts/create-account.js';
import { transferFunds } from './src/modules/ledger/commands/transfer-funds.js';
import { InsufficientFundsError } from './src/shared/errors/ledger-errors.js';

async function main() {
  console.log('--- Creating accounts ---');
  const alice = await createAccount({
    accountCode: `WALLET:USER:${crypto.randomUUID()}`,
    name: 'Alice',
    accountType: 'liability',
  });
  const bob = await createAccount({
    accountCode: `WALLET:USER:${crypto.randomUUID()}`,
    name: 'Bob',
    accountType: 'liability',
  });
  console.log('Alice:', alice.accountId.toString());
  console.log('Bob:', bob.accountId.toString());

  console.log('\n--- Seeding Alice with 100.00 ---');
  console.log('(NOTE: seeding house balance directly via SQL — transferFunds is');
  console.log(' not the right tool for this; its overdraft check correctly');
  console.log(' applies to ANY fromAccountId, including a house/system account,');
  console.log(' which is a real scope gap flagged separately, not fixed here.)');
  const house = await createAccount({
    accountCode: `BANK:CASH:${crypto.randomUUID()}`,
    name: 'House Cash',
    accountType: 'asset',
  });

  await db
    .updateTable('account_state')
    .set({ current_balance: '1000000.0000' })
    .where('account_id', '=', house.accountId.toString())
    .execute();

  // House is an asset (debit-normal), Alice's wallet is a liability
  // (credit-normal). A deposit debits house cash and credits Alice.
  await transferFunds({
    fromAccountId: house.accountId,
    toAccountId: alice.accountId,
    amount: '100.00',
    idempotencyKey: `seed-${crypto.randomUUID()}`,
  });

  const aliceState1 = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', alice.accountId.toString())
    .executeTakeFirstOrThrow();
  console.log('Alice balance after seed:', aliceState1.current_balance);
  console.assert(aliceState1.current_balance === '100.0000', 'FAIL: Alice should have 100.0000');

  console.log('\n--- Transfer 1: Alice sends Bob 40.00 ---');
  const result1 = await transferFunds({
    fromAccountId: alice.accountId,
    toAccountId: bob.accountId,
    amount: '40.00',
    idempotencyKey: `test-transfer-1-${crypto.randomUUID()}`,
  });
  console.log('Result:', result1);

  const aliceState2 = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', alice.accountId.toString())
    .executeTakeFirstOrThrow();
  const bobState2 = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', bob.accountId.toString())
    .executeTakeFirstOrThrow();

  console.log('Alice balance:', aliceState2.current_balance, '(expect 60.0000)');
  console.log('Bob balance:', bobState2.current_balance, '(expect 40.0000)');
  console.assert(aliceState2.current_balance === '60.0000', 'FAIL: Alice balance wrong');
  console.assert(bobState2.current_balance === '40.0000', 'FAIL: Bob balance wrong');

  console.log('\n--- Checking journal_entries hash chain ---');
  const aliceEntries = await db
    .selectFrom('journal_entries')
    .selectAll()
    .where('account_id', '=', alice.accountId.toString())
    .orderBy('sequence_number', 'asc')
    .execute();
  console.log(`Alice has ${aliceEntries.length} journal entries (expect 2: seed credit, transfer debit)`);
  for (const entry of aliceEntries) {
    console.log(
      `  seq=${entry.sequence_number} amount=${entry.signed_amount} prev_hash=${entry.previous_hash?.slice(0, 8) ?? 'GENESIS'} entry_hash=${entry.entry_hash.slice(0, 8)}`
    );
  }
  console.assert(
    aliceEntries[0]?.previous_hash === null,
    'FAIL: first entry should have null previous_hash'
  );
  console.assert(
    aliceEntries[1]?.previous_hash === aliceEntries[0]?.entry_hash,
    'FAIL: second entry previous_hash should equal first entry_hash — chain broken'
  );

  console.log('\n--- Transfer 2: idempotent replay (same idempotency key twice) ---');
  const replayKey = `test-replay-${crypto.randomUUID()}`;
  const first = await transferFunds({
    fromAccountId: alice.accountId,
    toAccountId: bob.accountId,
    amount: '10.00',
    idempotencyKey: replayKey,
  });
  const second = await transferFunds({
    fromAccountId: alice.accountId,
    toAccountId: bob.accountId,
    amount: '10.00',
    idempotencyKey: replayKey,
  });
  console.log('First call idempotentReplay:', first.idempotentReplay, '(expect false)');
  console.log('Second call idempotentReplay:', second.idempotentReplay, '(expect true)');
  console.assert(first.idempotentReplay === false, 'FAIL: first call should not be a replay');
  console.assert(second.idempotentReplay === true, 'FAIL: second call should be a replay');
  console.assert(
    first.transactionId === second.transactionId,
    'FAIL: replay should return the same transaction id'
  );

  const aliceState3 = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', alice.accountId.toString())
    .executeTakeFirstOrThrow();
  console.log('Alice balance after replay attempt:', aliceState3.current_balance, '(expect 50.0000, NOT 40.0000 — replay must not double-post)');
  console.assert(aliceState3.current_balance === '50.0000', 'FAIL: replay double-posted!');

  console.log('\n--- Transfer 3: insufficient funds (Alice has 50.00, tries to send 999.00) ---');
  try {
    await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '999.00',
      idempotencyKey: `test-overdraft-${crypto.randomUUID()}`,
    });
    console.log('FAIL: expected InsufficientFundsError, but transfer succeeded');
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      console.log('Correctly rejected:', err.message);
    } else {
      console.log('FAIL: wrong error type thrown:', err);
    }
  }

  const aliceState4 = await db
    .selectFrom('account_state')
    .selectAll()
    .where('account_id', '=', alice.accountId.toString())
    .executeTakeFirstOrThrow();
  console.log('Alice balance after failed overdraft attempt:', aliceState4.current_balance, '(expect unchanged: 50.0000)');
  console.assert(aliceState4.current_balance === '50.0000', 'FAIL: balance changed despite rejected transfer!');

  console.log('\n--- All checks complete ---');
  await db.destroy();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});