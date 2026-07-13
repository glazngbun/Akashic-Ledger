import { db } from '../../db/client.js';
import type { AccountType } from '../../db/schema.js';

export interface CreateAccountInput {
  accountCode: string;
  name: string;
  accountType: AccountType;
}

export interface CreateAccountResult {
  accountId: bigint;
  accountUuid: string;
}

/**
 * Creates an account and its corresponding account_state row in one
 * transaction. account_state has no default row — every account needs
 * exactly one, created here, or postLedgerEntries' FOR UPDATE lookup
 * on account_state would find nothing to lock.
 *
 * Deliberately minimal: no update/list/deactivate operations yet.
 * Built only to unblock integration testing of the ledger write path.
 */
export async function createAccount(
  input: CreateAccountInput
): Promise<CreateAccountResult> {
  return db.transaction().execute(async (trx) => {
    const account = await trx
      .insertInto('accounts')
      .values({
        account_code: input.accountCode,
        name: input.name,
        account_type: input.accountType,
      })
      .returning(['id', 'account_uuid'])
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('account_state')
      .values({
        account_id: account.id,
        current_balance: '0.0000',
        latest_hash: null,
        latest_sequence: '0',
      })
      .execute();

    return {
      accountId: BigInt(account.id),
      accountUuid: account.account_uuid,
    };
  });
}