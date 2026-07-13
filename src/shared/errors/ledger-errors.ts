export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown by the application-layer "looks balanced?" check — the fast
 * feedback layer. The deferred Postgres constraint trigger is the
 * final integrity guarantee underneath this; this error should always
 * fire first, in practice, since it runs before any INSERT.
 */
export class ImbalancedEntriesError extends LedgerError {
  constructor(sumMinorUnits: bigint) {
    super(
      `Journal entries do not sum to zero (off by ${sumMinorUnits.toString()} minor units)`
    );
  }
}

export class EmptyLegsError extends LedgerError {
  constructor() {
    super('A ledger posting requires at least two legs');
  }
}

/**
 * Thrown when a leg's amount is not a positive magnitude. Under the
 * direction-based leg model, `amount` is always a positive magnitude —
 * the sign is expressed via `direction`, not embedded in the amount
 * string.
 */
export class InvalidLegAmountError extends LedgerError {
  constructor(accountId: bigint, amount: string) {
    super(
      `Leg amount for account ${accountId.toString()} must be a positive magnitude, got: ${amount}`
    );
  }
}

/**
 * Thrown by transferFunds' validateBeforePosting hook when the sender's
 * locked balance is insufficient to cover the transfer. This is a
 * business-policy error, not a ledger-engine error — the generic
 * postLedgerEntries function has no concept of "insufficient funds",
 * only the transfer command does.
 */
export class InsufficientFundsError extends LedgerError {
  constructor(accountId: bigint, available: string, requested: string) {
    super(
      `Account ${accountId.toString()} has insufficient funds: available ${available}, requested ${requested}`
    );
  }
}

/**
 * Thrown by depositFunds' validateBeforePosting hook when the supplied
 * accounts don't match the expected roles for a deposit (funding
 * account must be an asset, destination must be a liability). Catches
 * misuse — e.g. accidentally calling depositFunds between two wallets,
 * which isn't a real deposit — rather than silently posting whatever
 * was passed in.
 */
export class InvalidAccountTypeError extends LedgerError {
  constructor(accountId: bigint, expected: string, actual: string) {
    super(
      `Account ${accountId.toString()} has type "${actual}", expected "${expected}" for this operation`
    );
  }
}