import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../src/db/client.js';
import { createAccount } from '../../src/modules/accounts/create-account.js';
import { transferFunds } from '../../src/modules/ledger/commands/transfer-funds.js';
import { createCheckpoint } from '../../src/modules/checkpoints/create-checkpoint.js';
import {
  verifyCheckpoint,
  verifyCheckpointChain,
} from '../../src/modules/checkpoints/verify-checkpoint.js';
import { resetDatabase, createFundedWallet, simulatePrivilegedTamper } from './helpers.js';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.destroy();
});

describe('createCheckpoint — real Postgres', () => {
  it('creates a checkpoint capturing every account chain tip', async () => {
    const alice = await createFundedWallet('100.00');
    const bob = await createAccount({
      accountCode: `WALLET:USER:${crypto.randomUUID()}`,
      name: 'Bob',
      accountType: 'liability',
    });
    await transferFunds({
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      amount: '25.00',
      idempotencyKey: `key-${crypto.randomUUID()}`,
    });

    const checkpoint = await createCheckpoint();

    expect(checkpoint.sequenceNumber).toBe(1n);
    expect(checkpoint.checkpointHash).toMatch(/^[0-9a-f]{64}$/);

    const memberRows = await db
      .selectFrom('checkpoint_members')
      .selectAll()
      .where('checkpoint_id', '=', checkpoint.checkpointId.toString())
      .execute();

    // 3 accounts exist: alice's wallet, alice's funding house, bob's wallet.
    expect(memberRows).toHaveLength(3);
  });

  it('chains a second checkpoint to the first via previous_checkpoint_hash', async () => {
    await createFundedWallet('50.00');
    const first = await createCheckpoint();

    await createFundedWallet('10.00');
    const second = await createCheckpoint();

    const secondRow = await db
      .selectFrom('checkpoints')
      .selectAll()
      .where('id', '=', second.checkpointId.toString())
      .executeTakeFirstOrThrow();

    expect(secondRow.previous_checkpoint_hash).toBe(first.checkpointHash);
    expect(second.sequenceNumber).toBe(2n);
  });
});

describe('verifyCheckpoint — real Postgres', () => {
  it('validates a freshly created, untampered checkpoint', async () => {
    await createFundedWallet('100.00');
    const checkpoint = await createCheckpoint();

    const result = await verifyCheckpoint(checkpoint.checkpointId);
    expect(result.valid).toBe(true);
    expect(result.recomputedHash).toBe(result.storedHash);
  });

  it('detects tampering with a checkpoint_members row, even bypassing the append-only trigger', async () => {
    await createFundedWallet('100.00');
    const checkpoint = await createCheckpoint();

    // A plain UPDATE is now blocked outright by the append-only
    // trigger — so this simulates a more severe threat model: an
    // attacker with privileges to disable that trigger, tamper, then
    // re-enable it. Hash-chain verification is the layer that still
    // catches this even when the DB-level prevention is bypassed.
    await simulatePrivilegedTamper('checkpoint_members', async () => {
      await db
        .updateTable('checkpoint_members')
        .set({ latest_sequence: '999' })
        .where('checkpoint_id', '=', checkpoint.checkpointId.toString())
        .execute();
    });

    const result = await verifyCheckpoint(checkpoint.checkpointId);
    expect(result.valid).toBe(false);
    expect(result.recomputedHash).not.toBe(result.storedHash);
  });
});

describe('verifyCheckpointChain — real Postgres', () => {
  it('validates a chain of multiple untampered checkpoints', async () => {
    await createFundedWallet('10.00');
    await createCheckpoint();
    await createFundedWallet('20.00');
    await createCheckpoint();
    await createFundedWallet('30.00');
    await createCheckpoint();

    const result = await verifyCheckpointChain();
    expect(result.valid).toBe(true);
    expect(result.checkpointsVerified).toBe(3);
    expect(result.firstInvalidCheckpointId).toBeNull();
  });

  it('detects a broken chain link when an earlier checkpoint hash is altered, even bypassing the append-only trigger', async () => {
    await createFundedWallet('10.00');
    const first = await createCheckpoint();
    await createFundedWallet('20.00');
    await createCheckpoint();

    // Tamper with the FIRST checkpoint's own stored hash directly,
    // simulating a privileged attacker bypassing the append-only
    // trigger. This does not touch the second checkpoint's row at
    // all — the whole point of chaining is that the second
    // checkpoint's previous_checkpoint_hash now no longer matches the
    // (altered) first checkpoint's real stored hash, so this is
    // detectable without needing the tampered row to know it was
    // tampered with.
    await simulatePrivilegedTamper('checkpoints', async () => {
      await db
        .updateTable('checkpoints')
        .set({ checkpoint_hash: 'tampered'.padEnd(64, '0') })
        .where('id', '=', first.checkpointId.toString())
        .execute();
    });

    const result = await verifyCheckpointChain();
    expect(result.valid).toBe(false);
    expect(result.checkpointsVerified).toBe(0); // fails on the first checkpoint itself
  });
});