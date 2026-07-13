import { createHash } from 'node:crypto';

/**
 *
 *   entry_hash = SHA256(
 *     previous_hash + "|" +
 *     sequence_number + "|" +
 *     account_id + "|" +
 *     event_id + "|" +
 *     signed_amount + "|" +
 *     effective_at + "|" +
 *     recorded_at
 *   )
 */

export const GENESIS_HASH = 'GENESIS';

export interface JournalEntryHashInput {
  previousHash: string | null;
  sequenceNumber: bigint;
  accountId: bigint;
  eventId: bigint;
  signedAmount: string; 
  effectiveAt: Date;
  recordedAt: Date;
}


const DECIMAL_STRING_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

export function formatSignedAmount(amount: string): string {
  const match = DECIMAL_STRING_PATTERN.exec(amount.trim());
  if (!match) {
    throw new Error(`Invalid signed_amount for hashing: ${amount}`);
  }

  const [, sign, wholePart, fractionalPart] = match;

  if (sign === undefined || wholePart === undefined) {
    throw new Error(`Invalid signed_amount for hashing: ${amount}`);
  }

  const fractional = fractionalPart ?? '';

  if (fractional.length > 4) {
    throw new Error(
      `signed_amount has more than 4 decimal places, refusing to truncate: ${amount}`
    );
  }

  const paddedFractional = fractional.padEnd(4, '0');
  const normalizedWhole = wholePart.replace(/^0+(?=\d)/, ''); 
  
  const isZero = normalizedWhole === '0' && paddedFractional === '0000';
  const normalizedSign = isZero ? '' : sign;

  return `${normalizedSign}${normalizedWhole}.${paddedFractional}`;
}

function serializeForHash(input: JournalEntryHashInput): string {
  const previousHash = input.previousHash ?? GENESIS_HASH;

  const fields = [
    previousHash,
    input.sequenceNumber.toString(),
    input.accountId.toString(),
    input.eventId.toString(),
    input.signedAmount,
    input.effectiveAt.toISOString(),
    input.recordedAt.toISOString(),
  ];

  return fields.join('|');
}

export function computeEntryHash(input: JournalEntryHashInput): string {
  const serialized = serializeForHash(input);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}


export function verifyEntryHash(
  input: JournalEntryHashInput,
  expectedHash: string
): boolean {
  return computeEntryHash(input) === expectedHash;
}