/**
 * Decimal-string arithmetic for money values.
 *
 * NUMERIC(19,4) columns arrive from Postgres as strings. Money must
 * never be round-tripped through JS `Number`/floating point — this
 * module works entirely in scaled BigInt (fixed-point, 4 decimal
 * places) internally, and only ever takes/returns strings at its
 * boundary.
 */

const SCALE = 10_000n; // 4 decimal places
const DECIMAL_STRING_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Converts a decimal string (e.g. "100.5000", "-50", "0.0001") to its
 * scaled BigInt representation (e.g. 1005000n, -500000n, 1n).
 */
export function toMinorUnits(amount: string): bigint {
  const match = DECIMAL_STRING_PATTERN.exec(amount.trim());
  if (!match) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }

  const [, sign, wholePart, fractionalPart] = match;
  if (sign === undefined || wholePart === undefined) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }

  const fractional = (fractionalPart ?? '').padEnd(4, '0');
  if (fractional.length > 4) {
    throw new Error(
      `Decimal amount has more than 4 decimal places, refusing to truncate: ${amount}`
    );
  }

  const magnitude = BigInt(wholePart) * SCALE + BigInt(fractional);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Sums a list of decimal strings without ever touching floating point.
 * Returns the result as scaled BigInt (minor units) for zero-sum
 * comparison — callers checking "does this equal zero" should compare
 * the BigInt directly (=== 0n) rather than converting back to string.
 */
export function sumMinorUnits(amounts: string[]): bigint {
  return amounts.reduce((total, amount) => total + toMinorUnits(amount), 0n);
}

/**
 * Converts a scaled BigInt (minor units, 4 decimal places) back to its
 * canonical decimal string form, e.g. 1005000n -> "100.5000",
 * -500000n -> "-50.0000", 0n -> "0.0000".
 *
 * This is the inverse of toMinorUnits, and is deliberately the only
 * place this conversion happens — it was previously duplicated inline
 * in the ledger service, which is exactly the kind of money-math logic
 * that should exist in one tested place, not two.
 */
export function fromMinorUnits(minorUnits: bigint): string {
  const isNegative = minorUnits < 0n;
  const magnitude = isNegative ? -minorUnits : minorUnits;

  const whole = magnitude / SCALE;
  const fractional = magnitude % SCALE;

  const sign = isNegative && magnitude !== 0n ? '-' : '';
  return `${sign}${whole.toString()}.${fractional.toString().padStart(4, '0')}`;
}