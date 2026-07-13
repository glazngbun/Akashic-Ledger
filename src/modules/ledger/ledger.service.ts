import { sql } from 'kysely';
import { db } from '../../db/client.js';
import type { AccountType } from '../../db/schema.js';
import {
  computeEntryHash,
} from '../../shared/crypto/journal-entry-hash.js';
import { toMinorUnits, sumMinorUnits, fromMinorUnits } from '../../shared/utils/decimal.js';
import { normalBalanceSide, type NormalBalanceSide } from '../../shared/domain/normal-balance.js';
import {
  ImbalancedEntriesError,
  EmptyLegsError,
  InvalidLegAmountError,
} from '../../shared/errors/ledger-errors.js';

const UNIQUE_VIOLATION = '23505'; // Postgres error code

/**
 * A leg states business intent — does this account's real-world
 * balance go up or down, and by how much (a positive magnitude, never
 * signed). The engine derives the correct universal debit(+)/credit(-)
 * accounting representation internally, from the account's type, via
 * normalBalanceSide. Callers never compute debit/credit signs
 * themselves — same "derive it, don't make the caller compute it"
 * principle already used for normal_balance elsewhere in this system.
 */
export interface LedgerLeg {
  accountId: bigint;
  direction: 'increase' | 'decrease';
  amount: string; // positive decimal string, e.g. "50.00" — never signed
}

export interface LockedAccountState {
  accountId: bigint;
  accountType: AccountType;
  currentBalance: string;
  latestHash: string | null;
  latestSequence: bigint;
}

export interface PostLedgerEntriesInput {
  idempotencyKey: string;
  eventType: string;
  effectiveAt: Date;
  payload: Record<string, unknown>;
  transactionType: string;
  legs: LedgerLeg[];
  /**
   * Runs after all affected accounts are locked (FOR UPDATE) but
   * before any journal_entries are inserted. This is the only point
   * where a business-policy check (e.g. insufficient funds) is safe
   * from a TOCTOU race — the lock covering the check must be the same
   * lock covering the write. Throw to abort; the whole transaction
   * rolls back automatically.
   *
   * The generic ledger engine itself enforces no business policy
   * (only mechanical correctness — balance, locking, hashing); this
   * hook is how callers like transferFunds add their own policy
   * without the engine needing to know what "insufficient funds"
   * means.
   */
  validateBeforePosting?: (lockedAccounts: LockedAccountState[]) => void;
}

export interface PostLedgerEntriesResult {
  transactionId: bigint;
  eventId: bigint;
  idempotentReplay: boolean;
}

interface AccountChainState {
  accountType: AccountType;
  currentBalance: string;
  latestHash: string | null;
  latestSequence: bigint;
}

interface NormalizedLeg {
  accountId: bigint;
  direction: 'increase' | 'decrease';
  amountMinorUnits: bigint;
}

/**
 * Given a leg's business-intent direction and the account's
 * normal-balance side, derives the universal debit(+)/credit(-) signed
 * amount to actually store in journal_entries.
 *
 *   normal side = debit, increase -> debit  -> +amount
 *   normal side = debit, decrease -> credit -> -amount
 *   normal side = credit, increase -> credit -> -amount
 *   normal side = credit, decrease -> debit  -> +amount
 */
function toStoredSignedAmount(
  direction: 'increase' | 'decrease',
  normalSide: NormalBalanceSide,
  amountMinorUnits: bigint
): bigint {
  const isDebit =
    (direction === 'increase' && normalSide === 'debit') ||
    (direction === 'decrease' && normalSide === 'credit');
  return isDebit ? amountMinorUnits : -amountMinorUnits;
}

/**
 * Posts a balanced set of journal entries as one atomic business event.
 *
 * Responsibilities of this function, and *only* this function:
 * - derive each leg's universal debit/credit signed amount from its
 *   account's type (callers only state increase/decrease intent)
 * - enforce the zero-sum invariant (application-layer "looks balanced?"
 *   check — the deferred Postgres constraint trigger is the final
 *   "prove it" guarantee underneath this, enforced independently)
 * - lock affected accounts in sorted account_id order (deadlock avoidance)
 * - assign per-account sequence numbers and compute per-account hash
 *   chain entries
 * - update account_state (balance, chain tip) atomically with the entries
 * - handle idempotent replay via idempotency_keys
 *
 * This function does NOT enforce business rules like "can this account
 * go negative" (overdraft policy) — that's deliberately a caller
 * concern (e.g. a transferFunds command), not a ledger-engine concern.
 *
 * NOTE on ordering: computing the correct signed amount requires
 * knowing each account's type, which is only authoritative once the
 * account row is locked (account_type is immutable post-first-entry,
 * but reading it unlocked before that point would be a race). So,
 * unlike a pure string-arithmetic check, the zero-sum validation here
 * necessarily happens AFTER locking, inside the transaction — there is
 * no cheaper pre-transaction fast-fail available under this leg model.
 */
export async function postLedgerEntries(
  input: PostLedgerEntriesInput
): Promise<PostLedgerEntriesResult> {
  if (input.legs.length < 2) {
    throw new EmptyLegsError();
  }

  const normalizedLegs: NormalizedLeg[] = input.legs.map((leg) => {
    const amountMinorUnits = toMinorUnits(leg.amount);
    if (amountMinorUnits <= 0n) {
      throw new InvalidLegAmountError(leg.accountId, leg.amount);
    }
    return {
      accountId: leg.accountId,
      direction: leg.direction,
      amountMinorUnits,
    };
  });

  // Existing idempotency key check, outside the write transaction —
  // cheap short-circuit for the common "client retried a completed
  // request" case. The unique constraint on idempotency_keys is the
  // real guarantee against the race where two requests with the same
  // key arrive concurrently; this check is just an optimization.
  const existing = await db
    .selectFrom('idempotency_keys')
    .select(['transaction_id'])
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();

  if (existing) {
    const event = await db
      .selectFrom('events')
      .select(['id'])
      .where('transaction_id', '=', existing.transaction_id)
      .executeTakeFirstOrThrow();

    return {
      transactionId: BigInt(existing.transaction_id),
      eventId: BigInt(event.id),
      idempotentReplay: true,
    };
  }

  // Deterministic lock order: sort the *unique* set of affected
  // account IDs ascending. This must be applied before any FOR UPDATE
  // select, regardless of the order legs were supplied in, or
  // concurrent postings touching overlapping accounts can deadlock.
  const uniqueAccountIds = [...new Set(normalizedLegs.map((l) => l.accountId))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  );

  try {
    return await db.transaction().execute(async (trx) => {
      const transactionRow = await trx
        .insertInto('transactions')
        .values({
          status: 'completed',
          type: input.transactionType,
          metadata: JSON.stringify({}),
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      const transactionId = BigInt(transactionRow.id);

      const eventRow = await trx
        .insertInto('events')
        .values({
          event_type: input.eventType,
          transaction_id: transactionRow.id,
          effective_at: input.effectiveAt.toISOString(),
          payload: JSON.stringify(input.payload),
        })
        .returning(['id', 'recorded_at'])
        .executeTakeFirstOrThrow();

      const eventId = BigInt(eventRow.id);
      const recordedAt = new Date(eventRow.recorded_at as unknown as string);

      // Lock every affected account's state row, in sorted order, and
      // load its current chain-tip + type into an in-memory map. The
      // join with `accounts` is what makes account_type available here
      // — FOR UPDATE on a joined query locks rows from both tables,
      // which also incidentally protects against a concurrent
      // account_type change racing this transaction on a
      // brand-new account (before the immutability trigger would
      // otherwise apply).
      const chainState = new Map<string, AccountChainState>();

      for (const accountId of uniqueAccountIds) {
        const row = await trx
          .selectFrom('account_state')
          .innerJoin('accounts', 'accounts.id', 'account_state.account_id')
          .select([
            'account_state.current_balance',
            'account_state.latest_hash',
            'account_state.latest_sequence',
            'accounts.account_type',
          ])
          .where('account_state.account_id', '=', accountId.toString())
          .forUpdate()
          .executeTakeFirstOrThrow();

        chainState.set(accountId.toString(), {
          accountType: row.account_type,
          currentBalance: row.current_balance,
          latestHash: row.latest_hash,
          latestSequence: BigInt(row.latest_sequence),
        });
      }

      // Now that every account's type is known (locked, authoritative),
      // derive the universal debit(+)/credit(-) signed amount for each
      // leg, and validate the zero-sum invariant. This is the
      // application-layer "looks balanced?" check — necessarily placed
      // here rather than before the transaction opened, since it
      // depends on data only available post-lock (see function-level
      // note above).
      const storedSignedAmounts = new Map<number, bigint>(); // index into normalizedLegs -> signed minor units

      normalizedLegs.forEach((leg, index) => {
        const state = chainState.get(leg.accountId.toString());
        if (!state) {
          throw new Error(
            `Missing locked chain state for account ${leg.accountId.toString()}`
          );
        }
        const normalSide = normalBalanceSide(state.accountType);
        const signed = toStoredSignedAmount(
          leg.direction,
          normalSide,
          leg.amountMinorUnits
        );
        storedSignedAmounts.set(index, signed);
      });

      const balanceSum = sumMinorUnits(
        [...storedSignedAmounts.values()].map((v) => fromMinorUnits(v))
      );
      if (balanceSum !== 0n) {
        throw new ImbalancedEntriesError(balanceSum);
      }

      // Business-policy validation hook. Runs after every affected
      // account is locked (above) but before any journal_entries are
      // written. Reads the same locked, race-free balance the engine
      // itself just fetched — this is what makes it safe from TOCTOU:
      // there is no gap between "check the balance" and "the balance
      // this check saw is still true" because the row lock is already
      // held for the remainder of this transaction.
      if (input.validateBeforePosting) {
        const lockedAccounts: LockedAccountState[] = uniqueAccountIds.map(
          (accountId) => {
            const state = chainState.get(accountId.toString());
            if (!state) {
              throw new Error(
                `Missing locked chain state for account ${accountId.toString()}`
              );
            }
            return {
              accountId,
              accountType: state.accountType,
              currentBalance: state.currentBalance,
              latestHash: state.latestHash,
              latestSequence: state.latestSequence,
            };
          }
        );

        input.validateBeforePosting(lockedAccounts);
      }

      for (let index = 0; index < normalizedLegs.length; index++) {
        const leg = normalizedLegs[index];
        if (!leg) continue; // unreachable, satisfies noUncheckedIndexedAccess

        const key = leg.accountId.toString();
        const state = chainState.get(key);
        const signedMinorUnits = storedSignedAmounts.get(index);
        if (!state || signedMinorUnits === undefined) {
          // Unreachable: every leg's account_id was included when
          // building uniqueAccountIds/storedSignedAmounts above.
          throw new Error(`Missing locked chain state for account ${key}`);
        }

        const storedSignedAmount = fromMinorUnits(signedMinorUnits);
        const newSequence = state.latestSequence + 1n;
        const entryHash = computeEntryHash({
          previousHash: state.latestHash,
          sequenceNumber: newSequence,
          accountId: leg.accountId,
          eventId,
          signedAmount: storedSignedAmount,
          effectiveAt: input.effectiveAt,
          recordedAt,
        });

        await trx
          .insertInto('journal_entries')
          .values({
            event_id: eventRow.id,
            account_id: key,
            signed_amount: storedSignedAmount,
            sequence_number: newSequence.toString(),
            effective_at: input.effectiveAt.toISOString(),
            recorded_at: recordedAt.toISOString(),
            previous_hash: state.latestHash,
            entry_hash: entryHash,
          })
          .execute();

        // Advance in-memory state so a second leg on the same account
        // (if any) chains against this one, not the pre-posting tip.
        // currentBalance is intentionally NOT updated here — the
        // actual balance write happens once per account below, via a
        // single SQL-side addition, not accumulated in JS.
        chainState.set(key, {
          accountType: state.accountType,
          currentBalance: state.currentBalance,
          latestHash: entryHash,
          latestSequence: newSequence,
        });
      }

      // Write back final account_state per unique account. The
      // balance delta is driven directly by each leg's `direction` —
      // NOT by the stored debit/credit signed amount — since
      // account_state.current_balance always means "this account's
      // real-world balance," independent of accounting convention.
      // This is a deliberate separation: journal_entries.signed_amount
      // is the formal accounting representation; account_state.
      // current_balance is the plain business-meaningful number
      // (e.g. what Alice's wallet actually holds).
      for (const accountId of uniqueAccountIds) {
        const key = accountId.toString();
        const state = chainState.get(key);
        if (!state) {
          throw new Error(`Missing locked chain state for account ${key}`);
        }

        const accountLegs = normalizedLegs.filter(
          (leg) => leg.accountId.toString() === key
        );
        const deltaMinorUnits = accountLegs.reduce((total, leg) => {
          return (
            total +
            (leg.direction === 'increase'
              ? leg.amountMinorUnits
              : -leg.amountMinorUnits)
          );
        }, 0n);
        const deltaDecimalString = fromMinorUnits(deltaMinorUnits);

        await trx
          .updateTable('account_state')
          .set({
            current_balance: sql`current_balance + ${deltaDecimalString}::numeric`,
            latest_hash: state.latestHash,
            latest_sequence: state.latestSequence.toString(),
            updated_at: sql`now()`,
          })
          .where('account_id', '=', key)
          .execute();
      }

      // Final race guard: unique constraint on idempotency_key. If a
      // concurrent request with the same key won the race, this
      // insert throws a unique_violation and the whole transaction
      // rolls back — the caller (catch block below) then re-fetches
      // the winner's result instead of erroring out.
      await trx
        .insertInto('idempotency_keys')
        .values({
          idempotency_key: input.idempotencyKey,
          transaction_id: transactionRow.id,
        })
        .execute();

      return { transactionId, eventId, idempotentReplay: false };
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      const winner = await db
        .selectFrom('idempotency_keys')
        .select(['transaction_id'])
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow();

      const event = await db
        .selectFrom('events')
        .select(['id'])
        .where('transaction_id', '=', winner.transaction_id)
        .executeTakeFirstOrThrow();

      return {
        transactionId: BigInt(winner.transaction_id),
        eventId: BigInt(event.id),
        idempotentReplay: true,
      };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}