import { sql } from 'kysely';
import { db } from '../../src/db/client.js';
import { createAccount } from '../../src/modules/accounts/create-account.js';
import { depositFunds } from '../../src/modules/ledger/commands/deposit-funds.js';

/**
 * Resets all domain tables between tests. Uses TRUNCATE, not DELETE —
 * journal_entries/events/checkpoints/checkpoint_members are now
 * protected by a DB-level trigger blocking UPDATE and DELETE (true
 * append-only enforcement). TRUNCATE deliberately does not fire
 * per-row DELETE triggers (documented Postgres behavior), so it's the
 * correct tool for a bulk test-fixture reset without weakening the
 * actual immutability guarantee those tables have in production.
 */
export async function resetDatabase(): Promise<void> {
  await sql`
    TRUNCATE
      checkpoint_members,
      checkpoints,
      idempotency_keys,
      journal_entries,
      events,
      transactions,
      account_state,
      accounts
    RESTART IDENTITY CASCADE
  `.execute(db);
}

export interface FundedWallet {
  accountId: bigint;
}

/**
 * Test-only: simulates a privileged attacker (one with ALTER TABLE
 * rights) who disables the append-only trigger, tampers with a row,
 * then re-enables it. A plain UPDATE is now blocked outright by that
 * trigger — this helper exists specifically to still exercise the
 * hash-chain verification layer against the more severe threat model
 * it's actually meant to defend against: someone with elevated DB
 * privileges, not just an ordinary UPDATE statement.
 */
export async function simulatePrivilegedTamper(
  table: string,
  mutate: () => Promise<void>
): Promise<void> {
  await sql`ALTER TABLE ${sql.raw(table)} DISABLE TRIGGER trg_block_mutation`.execute(db);
  try {
    await mutate();
  } finally {
    await sql`ALTER TABLE ${sql.raw(table)} ENABLE TRIGGER trg_block_mutation`.execute(db);
  }
}

/**
 * Creates a wallet (liability account) and funds it via a real deposit
 * from a fresh house/asset account. This exercises depositFunds as
 * part of setup rather than seeding balances directly via SQL — the
 * whole point of building depositFunds was to make that SQL shortcut
 * unnecessary.
 */
export async function createFundedWallet(
  initialBalance: string
): Promise<FundedWallet> {
  const wallet = await createAccount({
    accountCode: `WALLET:USER:${crypto.randomUUID()}`,
    name: 'Test Wallet',
    accountType: 'liability',
  });

  const house = await createAccount({
    accountCode: `BANK:CASH:${crypto.randomUUID()}`,
    name: 'Test House Cash',
    accountType: 'asset',
  });

  await depositFunds({
    fundingAccountId: house.accountId,
    toAccountId: wallet.accountId,
    amount: initialBalance,
    idempotencyKey: `fund-${crypto.randomUUID()}`,
  });

  return { accountId: wallet.accountId };
}