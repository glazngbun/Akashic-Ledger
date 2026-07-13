import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../src/db/client.js';
import { createAccount } from '../../src/modules/accounts/create-account.js';
import { transferFunds } from '../../src/modules/ledger/commands/transfer-funds.js';
import { depositFunds } from '../../src/modules/ledger/commands/deposit-funds.js';
import {
  InsufficientFundsError,
  InvalidAccountTypeError,
} from '../../src/shared/errors/ledger-errors.js';
import { resetDatabase, createFundedWallet } from './helpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.destroy();
});

async function getBalance(accountId: bigint): Promise<string> {
  const row = await db
    .selectFrom('account_state')
    .select(['current_balance'])
    .where('account_id', '=', accountId.toString())
    .executeTakeFirstOrThrow();
  return row.current_balance;
}

describe('depositFunds — real Postgres', () => {
  it('correctly balances a cross-account-type deposit (asset funding, liability destination)', async () => {
    // This is the exact case that was mathematically broken under the
    // old balance-relative signed_amount convention (see: the
    // direction-based leg model redesign). If this fails, the
    // zero-sum invariant is broken again.
    const wallet = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Alice',
      accountType: 'liability',
    });
    const house = await createAccount({
      accountCode: `BANK:CASH:${crypto.randomUUID()}`,
      name: 'House',
      accountType: 'asset',
    });

    await depositFunds({
      fundingAccountId: house.accountId,
      toAccountId: wallet.accountId,
      amount: '100.00',
      idempotencyKey: `key-${crypto.randomUUID()}`,
    });

    expect(await getBalance(wallet.accountId)).toBe('100.0000');
  });

  it('rejects a deposit with swapped account roles, even though it happens to zero-sum', async () => {
    // funding=liability, destination=asset zero-sums correctly by
    // coincidence under the universal debit/credit convention — this
    // specifically tests that the account-type hook itself fires,
    // not that some other check incidentally catches the misuse.
    const liabilityAccount = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Wrong Funding',
      accountType: 'liability',
    });
    const assetAccount = await createAccount({
      accountCode: `BANK:CASH:${crypto.randomUUID()}`,
      name: 'Wrong Destination',
      accountType: 'asset',
    });

    await expect(
      depositFunds({
        fundingAccountId: liabilityAccount.accountId,
        toAccountId: assetAccount.accountId,
        amount: '10.00',
        idempotencyKey: `key-${crypto.randomUUID()}`,
      })
    ).rejects.toThrow(InvalidAccountTypeError);
  });
});

describe('transferFunds — real Postgres', () => {
  it('moves balance correctly between two wallets', async () => {
    const alice = await createFundedWallet('100.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });

    await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '40.00',
      idempotencyKey: `key-${crypto.randomUUID()}`,
    });

    expect(await getBalance(alice.accountId)).toBe('60.0000');
    expect(await getBalance(bob.accountId)).toBe('40.0000');
  });

  it('chains journal entries correctly — second entry links to the first via previous_hash', async () => {
    const alice = await createFundedWallet('100.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });

    await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '40.00',
      idempotencyKey: `key-${crypto.randomUUID()}`,
    });

    const aliceEntries = await db
      .selectFrom('journal_entries')
      .selectAll()
      .where('account_id', '=', alice.accountId.toString())
      .orderBy('sequence_number', 'asc')
      .execute();

    expect(aliceEntries).toHaveLength(2); // funding deposit + transfer debit
    expect(aliceEntries[0]?.previous_hash).toBeNull();
    expect(aliceEntries[1]?.previous_hash).toBe(aliceEntries[0]?.entry_hash);
  });

  it('does not double-post on idempotent replay', async () => {
    const alice = await createFundedWallet('100.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });
    const idempotencyKey = `key-${crypto.randomUUID()}`;

    const first = await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '10.00',
      idempotencyKey,
    });
    const second = await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '10.00',
      idempotencyKey,
    });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await getBalance(alice.accountId)).toBe('90.0000'); // NOT 80 — replay must not double-post
  });

  it('hard-blocks a transfer that would overdraw the sender, and changes nothing', async () => {
    const alice = await createFundedWallet('50.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });

    await expect(
      transferFunds({
        fromAccountId: alice.accountId,
        toAccountId: bob.accountId,
        amount: '999.00',
        idempotencyKey: `key-${crypto.randomUUID()}`,
      })
    ).rejects.toThrow(InsufficientFundsError);

    expect(await getBalance(alice.accountId)).toBe('50.0000'); // unchanged
    expect(await getBalance(bob.accountId)).toBe('0.0000');
  });

  it('rejects a transfer 1 minor unit short of sufficient — precision, not just gross shortfalls', async () => {
    const alice = await createFundedWallet('49.9999');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });

    await expect(
      transferFunds({
        fromAccountId: alice.accountId,
        toAccountId: bob.accountId,
        amount: '50.00',
        idempotencyKey: `key-${crypto.randomUUID()}`,
      })
    ).rejects.toThrow(InsufficientFundsError);
  });
});

describe('DB-level enforcement — real Postgres', () => {
  it('the deferred constraint trigger rejects an imbalanced insert even bypassing application code', async () => {
    const accountA = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'A',
      accountType: 'liability',
    });
    const accountB = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'B',
      accountType: 'liability',
    });

    await expect(
      db.transaction().execute(async (trx) => {
        const transactionRow = await trx
          .insertInto('transactions')
          .values({ status: 'completed', type: 'test', metadata: '{}' })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        const eventRow = await trx
          .insertInto('events')
          .values({
            event_type: 'TestEvent',
            transaction_id: transactionRow.id,
            effective_at: new Date().toISOString(),
            payload: '{}',
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        // Deliberately imbalanced: +10 and +5, should sum to zero and don't.
        await trx
          .insertInto('journal_entries')
          .values({
            event_id: eventRow.id,
            account_id: accountA.accountId.toString(),
            signed_amount: '10.0000',
            sequence_number: '1',
            effective_at: new Date().toISOString(),
            recorded_at: new Date().toISOString(),
            previous_hash: null,
            entry_hash: 'fake_hash_1',
          })
          .execute();

        await trx
          .insertInto('journal_entries')
          .values({
            event_id: eventRow.id,
            account_id: accountB.accountId.toString(),
            signed_amount: '5.0000',
            sequence_number: '1',
            effective_at: new Date().toISOString(),
            recorded_at: new Date().toISOString(),
            previous_hash: null,
            entry_hash: 'fake_hash_2',
          })
          .execute();
      })
    ).rejects.toThrow(/do not sum to zero/);
  });

  it('rejects changing account_type once an account has journal entries', async () => {
    const wallet = await createFundedWallet('10.00');

    await expect(
      db
        .updateTable('accounts')
        .set({ account_type: 'asset' })
        .where('id', '=', wallet.accountId.toString())
        .execute()
    ).rejects.toThrow(/already has journal entries/);
  });
});