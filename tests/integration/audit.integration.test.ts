import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'kysely';
import { db } from '../../src/db/client.js';
import { createAccount } from '../../src/modules/accounts/create-account.js';
import { transferFunds } from '../../src/modules/ledger/commands/transfer-funds.js';
import { createCheckpoint } from '../../src/modules/checkpoints/create-checkpoint.js';
import { verifyAccountChain } from '../../src/modules/audit/verify-account-chain.js';
import { runFullAudit } from '../../src/modules/audit/run-audit.js';
import { computeEntryHash } from '../../src/shared/crypto/journal-entry-hash.js';
import { resetDatabase, createFundedWallet, simulatePrivilegedTamper } from './helpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.destroy();
});

describe('runFullAudit — clean state', () => {
  it('passes on a healthy ledger with transfers and a checkpoint', async () => {
    const alice = await createFundedWallet('100.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });
    await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '30.00',
      idempotencyKey: `key-${crypto.randomUUID()}`,
    });
    await createCheckpoint();

    const report = await runFullAudit();

    expect(report.passed).toBe(true);
    expect(report.accountChainFailures).toEqual([]);
    expect(report.balanceFailures).toEqual([]);
    expect(report.checkpointsValid).toBe(true);
    expect(report.zeroSumValid).toBe(true);
    expect(report.accountsChecked).toBe(3); // alice, house, bob
  });

  it('reports progress through onSection callbacks in the documented order', async () => {
    await createFundedWallet('10.00');
    const sections: string[] = [];

    await runFullAudit({ onSection: (s) => sections.push(s) });

    expect(sections).toEqual([
      'Checking journal chains...',
      'Checking checkpoints...',
      'Checking balances...',
      'Checking zero-sum invariant...',
    ]);
  });
});

describe('runFullAudit — detects tampering', () => {
  it('detects a corrupted journal_entries row via chain verification', async () => {
    const alice = await createFundedWallet('100.00');

    await simulatePrivilegedTamper('journal_entries', async () => {
      await db
        .updateTable('journal_entries')
        .set({ signed_amount: '999.0000' })
        .where('account_id', '=', alice.accountId.toString())
        .where('sequence_number', '=', '1')
        .execute();
    });

    const report = await runFullAudit();
    expect(report.passed).toBe(false);
    expect(report.accountChainFailures).toContain(alice.accountId);
  });

  it('detects a drifted account_state balance that disagrees with the journal', async () => {
    const alice = await createFundedWallet('100.00');

    // account_state is NOT protected by the append-only trigger (only
    // the event-sourced tables are) — a plain UPDATE works here,
    // simulating e.g. a bug that wrote a wrong balance directly.
    await db
      .updateTable('account_state')
      .set({ current_balance: '999.0000' })
      .where('account_id', '=', alice.accountId.toString())
      .execute();

    const report = await runFullAudit();
    expect(report.passed).toBe(false);
    expect(report.balanceFailures).toContain(alice.accountId);
    // The journal itself is untouched — chain verification should
    // still pass. This demonstrates the two checks catch genuinely
    // different failure modes, not the same one twice.
    expect(report.accountChainFailures).toEqual([]);
  });

  it('zero-sum verification catches an internally-consistent-but-imbalanced event that chain verification alone would miss', async () => {
    const alice = await createFundedWallet('10.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });

    // Construct a deliberately imbalanced pair of entries where each
    // entry_hash is computed CORRECTLY for its own (wrong) stored
    // signed_amount — i.e. a self-consistent chain that nonetheless
    // doesn't sum to zero. This is exactly the "attacker with write
    // access constructs a fraudulent-but-internally-consistent
    // history" scenario hash chains alone cannot detect — proving why
    // an independent zero-sum re-check is a genuinely separate layer,
    // not a redundant one.
    await sql`ALTER TABLE journal_entries DISABLE TRIGGER trg_check_journal_entries_balance`.execute(db);
    try {
      const transactionRow = await db
        .insertInto('transactions')
        .values({ status: 'completed', type: 'test', metadata: '{}' })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      const eventRow = await db
        .insertInto('events')
        .values({
          event_type: 'TestEvent',
          transaction_id: transactionRow.id,
          effective_at: new Date().toISOString(),
          payload: '{}',
        })
        .returning(['id', 'recorded_at'])
        .executeTakeFirstOrThrow();

      const recordedAt = new Date(eventRow.recorded_at as unknown as string);
      const effectiveAt = recordedAt;

      // alice's real previous_hash from her funding-deposit entry:
      const alicePrior = await db
        .selectFrom('journal_entries')
        .select(['entry_hash'])
        .where('account_id', '=', alice.accountId.toString())
        .where('sequence_number', '=', '1')
        .executeTakeFirstOrThrow();

      const aliceHashCorrect = computeEntryHash({
        previousHash: alicePrior.entry_hash,
        sequenceNumber: 2n,
        accountId: alice.accountId,
        eventId: BigInt(eventRow.id),
        signedAmount: '20.0000',
        effectiveAt,
        recordedAt,
      });

      await db
        .insertInto('journal_entries')
        .values({
          event_id: eventRow.id,
          account_id: alice.accountId.toString(),
          signed_amount: '20.0000',
          sequence_number: '2',
          effective_at: effectiveAt.toISOString(),
          recorded_at: recordedAt.toISOString(),
          previous_hash: alicePrior.entry_hash,
          entry_hash: aliceHashCorrect,
        })
        .execute();

      const bobHash = computeEntryHash({
        previousHash: null,
        sequenceNumber: 1n,
        accountId: bob.accountId,
        eventId: BigInt(eventRow.id),
        signedAmount: '-5.0000', // does NOT offset alice's +20 — imbalanced on purpose
        effectiveAt,
        recordedAt,
      });

      await db
        .insertInto('journal_entries')
        .values({
          event_id: eventRow.id,
          account_id: bob.accountId.toString(),
          signed_amount: '-5.0000',
          sequence_number: '1',
          effective_at: effectiveAt.toISOString(),
          recorded_at: recordedAt.toISOString(),
          previous_hash: null,
          entry_hash: bobHash,
        })
        .execute();
    } finally {
      await sql`ALTER TABLE journal_entries ENABLE TRIGGER trg_check_journal_entries_balance`.execute(db);
    }

    // Chain verification passes for BOTH accounts — every hash is
    // genuinely self-consistent with its own stored data.
    const aliceChain = await verifyAccountChain(alice.accountId);
    const bobChain = await verifyAccountChain(bob.accountId);
    expect(aliceChain.valid).toBe(true);
    expect(bobChain.valid).toBe(true);

    // But the independent zero-sum check catches it.
    const report = await runFullAudit();
    expect(report.passed).toBe(false);
    expect(report.zeroSumValid).toBe(false);
    expect(report.accountChainFailures).toEqual([]); // confirms the chain check alone would have missed this
  });
});