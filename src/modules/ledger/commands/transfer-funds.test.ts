import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostLedgerEntriesInput } from '../ledger.service.js';
import { InsufficientFundsError } from '../../../shared/errors/ledger-errors.js';

// vi.mock() calls are hoisted to the top of the file, above regular
// `const`/`import` statements. A factory that closes over a normal
// top-level `const` would reference it before it's initialized. This
// `vi.hoisted()` block runs before that hoisting, specifically so the
// mock fn exists in time for the factory below to reference it safely.
const { postLedgerEntriesMock } = vi.hoisted(() => ({
  postLedgerEntriesMock: vi.fn(),
}));

vi.mock('../ledger.service.js', () => ({
  postLedgerEntries: (input: PostLedgerEntriesInput) =>
    postLedgerEntriesMock(input),
}));

// Imported after the mock is registered, per vitest's hoisting rules.
const { transferFunds } = await import('./transfer-funds.js');

beforeEach(() => {
  postLedgerEntriesMock.mockReset();
  postLedgerEntriesMock.mockResolvedValue({
    transactionId: 1n,
    eventId: 1n,
    idempotentReplay: false,
  });
});

/**
 * postLedgerEntriesMock.mock.calls is a plain array, so under
 * noUncheckedIndexedAccess, indexing into it (calls[0][0]) is typed as
 * possibly undefined — same treatment as any other array access in
 * this codebase. This helper fails loudly with a clear message if the
 * mock genuinely wasn't called, rather than a bare "undefined" crash
 * or a silenced non-null assertion.
 */
function getCapturedInput(callIndex = 0): PostLedgerEntriesInput {
  const call = postLedgerEntriesMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(
      `Expected postLedgerEntries to have been called at index ${callIndex}, but it wasn't`
    );
  }
  const [input] = call;
  if (!input) {
    throw new Error(`Call at index ${callIndex} was made with no arguments`);
  }
  return input as PostLedgerEntriesInput;
}

describe('transferFunds — leg construction', () => {
  it('builds a decrease leg for the sender and an increase leg for the recipient', async () => {
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-1',
    });

    const input = getCapturedInput();

    expect(input.legs).toEqual([
      { accountId: 10n, direction: 'decrease', amount: '50.00' },
      { accountId: 20n, direction: 'increase', amount: '50.00' },
    ]);
  });

  it('uses "TransferExecuted" as the event type', async () => {
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-2',
    });

    const input = getCapturedInput();
    expect(input.eventType).toBe('TransferExecuted');
  });

  it('defaults effectiveAt to now when not provided', async () => {
    const before = Date.now();
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-3',
    });
    const after = Date.now();

    const input = getCapturedInput();
    expect(input.effectiveAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(input.effectiveAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('honors an explicit effectiveAt (e.g. a backdated/late transfer)', async () => {
    const backdated = new Date('2026-06-01T10:15:00.000Z');
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-4',
      effectiveAt: backdated,
    });

    const input = getCapturedInput();
    expect(input.effectiveAt).toEqual(backdated);
  });

  it('rejects a zero amount before ever calling the ledger engine', async () => {
    await expect(
      transferFunds({
        fromAccountId: 10n,
        toAccountId: 20n,
        amount: '0.00',
        idempotencyKey: 'key-5',
      })
    ).rejects.toThrow(/must be positive/);
    expect(postLedgerEntriesMock).not.toHaveBeenCalled();
  });

  it('rejects a negative amount before ever calling the ledger engine', async () => {
    await expect(
      transferFunds({
        fromAccountId: 10n,
        toAccountId: 20n,
        amount: '-50.00',
        idempotencyKey: 'key-6',
      })
    ).rejects.toThrow(/must be positive/);
    expect(postLedgerEntriesMock).not.toHaveBeenCalled();
  });
});

describe('transferFunds — overdraft validation hook', () => {
  /**
   * The hook itself isn't run by this mock — postLedgerEntries is
   * mocked out entirely. So we extract the hook from the captured
   * input and invoke it directly, simulating what the real ledger
   * engine would do after locking accounts. This tests the hard-block
   * overdraft LOGIC without needing a real Postgres lock.
   */
  it('allows a transfer when the sender has exactly enough balance', async () => {
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-7',
    });

    const input = getCapturedInput();
    expect(() =>
      input.validateBeforePosting?.([
        { accountId: 10n, accountType: 'liability', currentBalance: '50.0000', latestHash: null, latestSequence: 0n },
        { accountId: 20n, accountType: 'liability', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
      ])
    ).not.toThrow();
  });

  it('blocks a transfer when the sender has insufficient balance', async () => {
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-8',
    });

    const input = getCapturedInput();
    expect(() =>
      input.validateBeforePosting?.([
        { accountId: 10n, accountType: 'liability', currentBalance: '49.9999', latestHash: null, latestSequence: 0n },
        { accountId: 20n, accountType: 'liability', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
      ])
    ).toThrow(InsufficientFundsError);
  });

  it('does not check the recipient balance at all', async () => {
    await transferFunds({
      fromAccountId: 10n,
      toAccountId: 20n,
      amount: '50.00',
      idempotencyKey: 'key-9',
    });

    const input = getCapturedInput();
    // Recipient has a huge negative balance — irrelevant to this hook,
    // since only the sender can violate the overdraft policy.
    expect(() =>
      input.validateBeforePosting?.([
        { accountId: 10n, accountType: 'liability', currentBalance: '100.0000', latestHash: null, latestSequence: 0n },
        { accountId: 20n, accountType: 'liability', currentBalance: '-999999.0000', latestHash: null, latestSequence: 0n },
      ])
    ).not.toThrow();
  });
});