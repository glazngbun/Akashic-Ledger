import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../src/db/client.js';
import { createAccount } from '../../src/modules/accounts/create-account.js';
import { transferFunds } from '../../src/modules/ledger/commands/transfer-funds.js';
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

describe('concurrency — sorted lock ordering prevents deadlock', () => {
  it('handles 20 concurrent opposite-direction transfers between the same two accounts with zero deadlocks', async () => {
    const alice = await createFundedWallet('1000.00');
    const bob = await createFundedWallet('1000.00');

    const transfers: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      // Alice -> Bob would naturally lock Alice's row first.
      transfers.push(
        transferFunds({
          fromAccountId: alice.accountId,
          toAccountId: bob.accountId,
          amount: '1.00',
          idempotencyKey: `concurrency-a2b-${i}-${crypto.randomUUID()}`,
        })
      );
      // Bob -> Alice would naturally lock Bob's row first — the
      // classic opposite-order deadlock setup, UNLESS sorted account_id
      // locking is actually working, in which case both directions
      // always lock the lower account_id first regardless.
      transfers.push(
        transferFunds({
          fromAccountId: bob.accountId,
          toAccountId: alice.accountId,
          amount: '1.00',
          idempotencyKey: `concurrency-b2a-${i}-${crypto.randomUUID()}`,
        })
      );
    }

    const results = await Promise.allSettled(transfers);

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const reasons = failures
        .map((f) => (f.status === 'rejected' ? String(f.reason) : ''))
        .join('\n');
      throw new Error(
        `${failures.length}/20 transfers failed — likely a deadlock or lock-ordering bug:\n${reasons}`
      );
    }

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // Net effect of 10x $1 each direction should be exactly zero drift.
    expect(await getBalance(alice.accountId)).toBe('1000.0000');
    expect(await getBalance(bob.accountId)).toBe('1000.0000');
  });

  it('correctly serializes concurrent transfers FROM the same account without corrupting the balance', async () => {
    // A different concurrency shape: many transfers draining the SAME
    // sender concurrently. This tests that the FOR UPDATE lock on a
    // single account actually serializes writes correctly — if it
    // didn't, concurrent balance reads could race and produce a wrong
    // final balance (a classic lost-update bug).
    const alice = await createFundedWallet('100.00');
    const recipients = await Promise.all(
      Array.from({ length: 10 }, () =>
        createAccount({
          accountCode: `WALLET:USER:${crypto.randomUUID()}`,
          name: 'Recipient',
          accountType: 'liability',
        })
      )
    );

    const transfers = recipients.map((recipient, i) =>
      transferFunds({
        fromAccountId: alice.accountId,
        toAccountId: recipient.accountId,
        amount: '5.00',
        idempotencyKey: `drain-${i}-${crypto.randomUUID()}`,
      })
    );

    await Promise.all(transfers);

    // 10 x $5.00 = $50.00 drained from 100.00.
    expect(await getBalance(alice.accountId)).toBe('50.0000');
    for (const recipient of recipients) {
      expect(await getBalance(recipient.accountId)).toBe('5.0000');
    }
  });
});