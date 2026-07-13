import { db } from '../../db/client.js';
import type { AccountType } from '../../db/schema.js';
import { normalBalanceSide } from '../../shared/domain/normal-balance.js';
import { toMinorUnits } from '../../shared/utils/decimal.js';

export interface BalanceReconciliationResult {
  accountId: bigint;
  valid: boolean;
  expectedBalanceMinorUnits: bigint;
  actualBalanceMinorUnits: bigint;
}

/**
 * Recomputes an account's balance purely from its journal_entries
 * history and compares it against the stored account_state.
 * current_balance — the same claim CQRS/event-sourcing systems make
 * ("the read model can always be rebuilt from the log"), verified
 * directly rather than just asserted.
 *
 * journal_entries.signed_amount is stored under the universal
 * debit(+)/credit(-) convention, not the real balance delta — this is
 * the exact inverse of toStoredSignedAmount() in ledger.service.ts:
 * for a debit-normal account, stored == delta; for a credit-normal
 * account, delta == -stored.
 */
export async function verifyBalanceReconciliation(
  accountId: bigint
): Promise<BalanceReconciliationResult> {
  const accountRow = await db
    .selectFrom('accounts')
    .select(['account_type'])
    .where('id', '=', accountId.toString())
    .executeTakeFirstOrThrow();

  const normalSide = normalBalanceSide(accountRow.account_type as AccountType);

  const entries = await db
    .selectFrom('journal_entries')
    .select(['signed_amount'])
    .where('account_id', '=', accountId.toString())
    .execute();

  const expectedBalanceMinorUnits = entries.reduce((total, entry) => {
    const stored = toMinorUnits(entry.signed_amount);
    const delta = normalSide === 'debit' ? stored : -stored;
    return total + delta;
  }, 0n);

  const stateRow = await db
    .selectFrom('account_state')
    .select(['current_balance'])
    .where('account_id', '=', accountId.toString())
    .executeTakeFirstOrThrow();

  const actualBalanceMinorUnits = toMinorUnits(stateRow.current_balance);

  return {
    accountId,
    valid: expectedBalanceMinorUnits === actualBalanceMinorUnits,
    expectedBalanceMinorUnits,
    actualBalanceMinorUnits,
  };
}