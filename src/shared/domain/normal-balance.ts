import type { AccountType } from '../../db/schema.js';

export type NormalBalanceSide = 'debit' | 'credit';

// asset -> debit-normal. liability, equity, revenue -> credit-normal.
// (expense would also be debit-normal, but expense accounts are
// deliberately out of v1 scope — see accounts schema decision.)
const DEBIT_NORMAL_TYPES: ReadonlySet<AccountType> = new Set(['asset']);

export function normalBalanceSide(accountType: AccountType): NormalBalanceSide {
  return DEBIT_NORMAL_TYPES.has(accountType) ? 'debit' : 'credit';
}