import { db } from '../../db/client.js';
import { computeEntryHash } from '../../shared/crypto/journal-entry-hash.js';

export interface AccountChainVerificationResult {
  accountId: bigint;
  valid: boolean;
  entriesVerified: number;
  firstInvalidSequence: bigint | null;
}

/**
 * Walks one account's entire journal_entries history in sequence
 * order and independently recomputes every hash from stored fields —
 * this doesn't trust any previously-stored hash, it rebuilds the
 * chain from scratch and confirms it matches what's on disk.
 */
export async function verifyAccountChain(
  accountId: bigint
): Promise<AccountChainVerificationResult> {
  const entries = await db
    .selectFrom('journal_entries')
    .selectAll()
    .where('account_id', '=', accountId.toString())
    .orderBy('sequence_number', 'asc')
    .execute();

  let previousHash: string | null = null;
  let verifiedCount = 0;

  for (const entry of entries) {
    if (entry.previous_hash !== previousHash) {
      return {
        accountId,
        valid: false,
        entriesVerified: verifiedCount,
        firstInvalidSequence: BigInt(entry.sequence_number),
      };
    }

    const recomputedHash = computeEntryHash({
      previousHash: entry.previous_hash,
      sequenceNumber: BigInt(entry.sequence_number),
      accountId,
      eventId: BigInt(entry.event_id),
      signedAmount: entry.signed_amount,
      effectiveAt: new Date(entry.effective_at as unknown as string),
      recordedAt: new Date(entry.recorded_at as unknown as string),
    });

    if (recomputedHash !== entry.entry_hash) {
      return {
        accountId,
        valid: false,
        entriesVerified: verifiedCount,
        firstInvalidSequence: BigInt(entry.sequence_number),
      };
    }

    previousHash = entry.entry_hash;
    verifiedCount++;
  }

  return {
    accountId,
    valid: true,
    entriesVerified: verifiedCount,
    firstInvalidSequence: null,
  };
}