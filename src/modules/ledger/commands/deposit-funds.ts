import {
  postLedgerEntries,
  type LockedAccountState,
  type PostLedgerEntriesResult,
} from '../ledger.service.js';
import { toMinorUnits } from '../../../shared/utils/decimal.js';
import { InvalidAccountTypeError } from '../../../shared/errors/ledger-errors.js';

export interface DepositFundsInput {
  /**
   * The asset/house account money is entering from (e.g. a bank/cash
   * account representing settled external funds). Explicit, not looked
   * up internally — this system has no "canonical system account"
   * registry; if one is added later, this parameter could become
   * optional with a default lookup.
   */
  fundingAccountId: bigint;
  toAccountId: bigint;
  amount: string; // positive decimal string, e.g. "100.00"
  idempotencyKey: string;
  effectiveAt?: Date;
}

/**
 * Deposit: external funds entering the system. Unlike a transfer, BOTH
 * accounts increase — the funding account (asset, e.g. house cash)
 * increases because money was received, and the destination wallet
 * (liability) increases because the platform now owes the customer
 * more. This is why depositFunds cannot be built as "transferFunds
 * with the house as sender" — transferFunds' fixed decrease-sender/
 * increase-recipient shape does not fit a deposit at all (see: the
 * cross-account-type zero-sum bug this exact case surfaced earlier).
 *
 * No overdraft check here — unlike transferFunds, there's no sender
 * whose balance could be insufficient; a deposit is money arriving,
 * not leaving. Instead, this command validates that the two accounts
 * actually play the roles a deposit requires (funding = asset,
 * destination = liability), catching misuse rather than silently
 * posting whatever two accounts were passed in.
 */
export async function depositFunds(
  input: DepositFundsInput
): Promise<PostLedgerEntriesResult> {
  const effectiveAt = input.effectiveAt ?? new Date();
  const amountMinorUnits = toMinorUnits(input.amount);

  if (amountMinorUnits <= 0n) {
    throw new Error(`Deposit amount must be positive, got: ${input.amount}`);
  }

  return postLedgerEntries({
    idempotencyKey: input.idempotencyKey,
    eventType: 'DepositExecuted',
    transactionType: 'deposit',
    effectiveAt,
    payload: {
      fundingAccountId: input.fundingAccountId.toString(),
      toAccountId: input.toAccountId.toString(),
      amount: input.amount,
    },
    legs: [
      { accountId: input.fundingAccountId, direction: 'increase', amount: input.amount },
      { accountId: input.toAccountId, direction: 'increase', amount: input.amount },
    ],
    validateBeforePosting: (lockedAccounts: LockedAccountState[]) => {
      const funding = lockedAccounts.find(
        (acc) => acc.accountId === input.fundingAccountId
      );
      const destination = lockedAccounts.find(
        (acc) => acc.accountId === input.toAccountId
      );

      if (!funding || !destination) {
        // Unreachable: both IDs are always among the legs' accounts.
        throw new Error('Missing locked state for deposit accounts');
      }

      if (funding.accountType !== 'asset') {
        throw new InvalidAccountTypeError(
          input.fundingAccountId,
          'asset',
          funding.accountType
        );
      }
      if (destination.accountType !== 'liability') {
        throw new InvalidAccountTypeError(
          input.toAccountId,
          'liability',
          destination.accountType
        );
      }
    },
  });
}