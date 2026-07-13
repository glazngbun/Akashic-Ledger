import {
  InsufficientFundsError,
  InvalidAccountTypeError,
  ImbalancedEntriesError,
  EmptyLegsError,
  InvalidLegAmountError,
} from './ledger-errors.js';

/**
 * Maps a caught error to an HTTP status code. Falls back to 500 for
 * anything not explicitly recognized as a domain error — an unmapped
 * error should surface as a server error, not be guessed at.
 */
export function httpStatusForError(err: unknown): number {
  if (err instanceof InsufficientFundsError) return 409; // conflict with current state
  if (err instanceof InvalidAccountTypeError) return 400; // caller misuse
  if (err instanceof ImbalancedEntriesError) return 400;
  if (err instanceof EmptyLegsError) return 400;
  if (err instanceof InvalidLegAmountError) return 400;
  return 500;
}