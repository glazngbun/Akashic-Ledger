import { db } from '../../db/client.js';
import { sumMinorUnits } from '../../shared/utils/decimal.js';

export interface ZeroSumVerificationResult {
  valid: boolean;
  entriesChecked: number;
  eventsChecked: number;
  firstInvalidEventId: bigint | null;
}

/**
 * Groups every journal_entries row by event_id and confirms each
 * group sums to exactly zero. This duplicates what the deferred DB
 * trigger already enforces at write time — deliberately: an audit
 * tool that only trusts the same mechanism it's supposed to be
 * auditing isn't much of an audit. This is "trust but verify" against
 * the possibility that the trigger itself was ever disabled, altered,
 * or bypassed by someone with elevated privileges.
 */
export async function verifyZeroSumIndependent(): Promise<ZeroSumVerificationResult> {
  const rows = await db
    .selectFrom('journal_entries')
    .select(['event_id', 'signed_amount'])
    .execute();

  const byEvent = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(row.signed_amount);
    byEvent.set(row.event_id, list);
  }

  let eventsChecked = 0;
  for (const [eventId, amounts] of byEvent) {
    const sum = sumMinorUnits(amounts);
    if (sum !== 0n) {
      return {
        valid: false,
        entriesChecked: eventsChecked,
        eventsChecked,
        firstInvalidEventId: BigInt(eventId),
      };
    }
    eventsChecked++;
  }

  return {
    valid: true,
    entriesChecked: rows.length,
    eventsChecked,
    firstInvalidEventId: null,
  };
}