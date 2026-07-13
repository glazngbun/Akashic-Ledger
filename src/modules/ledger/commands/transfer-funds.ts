import {
  postLedgerEntries,
  type LockedAccountState,
  type PostLedgerEntriesResult,
} from '../ledger.service.js';
import { toMinorUnits } from '../../../shared/utils/decimal.js';
import { InsufficientFundsError } from '../../../shared/errors/ledger-errors.js';

export interface TransferFundsInput {
  fromAccountId: bigint;
  toAccountId: bigint;
  amount: string; // positive decimal string, e.g. "50.00"
  idempotencyKey: string;
  /**
   * When the transfer actually happened in the real world. Defaults to
   * now — pass an earlier timestamp for late-arriving/backdated
   * transfers (see: bitemporal design, effective_at vs recorded_at).
   */
  effectiveAt?: Date;
}

/**
 * Wallet-to-wallet transfer, with a hard-block overdraft policy: the
 * sender's account cannot go negative. This is a business-policy
 * decision specific to this command — a wallet/payments product
 * processes valid transactions rather than modeling credit, unlike a
 * banking ledger that might allow negative balances deliberately.
 *
 * The overdraft check reads the sender's balance from the SAME locked
 * row the ledger engine already holds (via validateBeforePosting), so
 * there is no TOCTOU gap between checking the balance and it still
 * being true when the entries are written.
 */
export async function transferFunds(
  input: TransferFundsInput
): Promise<PostLedgerEntriesResult> {
  const effectiveAt = input.effectiveAt ?? new Date();
  const requestedMinorUnits = toMinorUnits(input.amount);

  if (requestedMinorUnits <= 0n) {
    throw new Error(
      `Transfer amount must be positive, got: ${input.amount}`
    );
  }

  // Note: under the direction-based leg model, this command no longer
  // computes or negates any signed amount itself — it only states
  // business intent (sender decreases, recipient increases). The
  // ledger engine derives the correct universal debit/credit signed
  // amount internally, from each account's type. This is exactly the
  // separation the leg-model redesign was for: transferFunds shouldn't
  // need to know or care about accounting conventions at all.

  return postLedgerEntries({
    idempotencyKey: input.idempotencyKey,
    eventType: 'TransferExecuted',
    transactionType: 'transfer',
    effectiveAt,
    payload: {
      fromAccountId: input.fromAccountId.toString(),
      toAccountId: input.toAccountId.toString(),
      amount: input.amount,
    },
    legs: [
      { accountId: input.fromAccountId, direction: 'decrease', amount: input.amount },
      { accountId: input.toAccountId, direction: 'increase', amount: input.amount },
    ],
    validateBeforePosting: (lockedAccounts: LockedAccountState[]) => {
      const sender = lockedAccounts.find(
        (acc) => acc.accountId === input.fromAccountId
      );
      if (!sender) {
        // Unreachable: fromAccountId is always one of the legs' accounts.
        throw new Error(
          `Missing locked state for sender account ${input.fromAccountId.toString()}`
        );
      }

      const availableMinorUnits = toMinorUnits(sender.currentBalance);
      if (availableMinorUnits < requestedMinorUnits) {
        throw new InsufficientFundsError(
          input.fromAccountId,
          sender.currentBalance,
          input.amount
        );
      }
    },
  });
}