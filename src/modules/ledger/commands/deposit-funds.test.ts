import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostLedgerEntriesInput } from '../ledger.service.js';
import { InvalidAccountTypeError } from '../../../shared/errors/ledger-errors.js';

const { postLedgerEntriesMock } = vi.hoisted(() => ({
  postLedgerEntriesMock: vi.fn(),
}));

vi.mock('../ledger.service.js', () => ({
  postLedgerEntries: (input: PostLedgerEntriesInput) =>
    postLedgerEntriesMock(input),
}));

const { depositFunds } = await import('./deposit-funds.js');

beforeEach(() => {
  postLedgerEntriesMock.mockReset();
  postLedgerEntriesMock.mockResolvedValue({
    transactionId: 1n,
    eventId: 1n,
    idempotentReplay: false,
  });
});

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

describe('depositFunds — leg construction', () => {
  it('builds an increase leg for BOTH the funding account and the destination', async () => {
    await depositFunds({
      fundingAccountId: 10n,
      toAccountId: 20n,
      amount: '100.00',
      idempotencyKey: 'key-1',
    });

    const input = getCapturedInput();
    expect(input.legs).toEqual([
      { accountId: 10n, direction: 'increase', amount: '100.00' },
      { accountId: 20n, direction: 'increase', amount: '100.00' },
    ]);
  });

  it('uses "DepositExecuted" as the event type', async () => {
    await depositFunds({
      fundingAccountId: 10n,
      toAccountId: 20n,
      amount: '100.00',
      idempotencyKey: 'key-2',
    });

    const input = getCapturedInput();
    expect(input.eventType).toBe('DepositExecuted');
  });

  it('rejects a zero amount before ever calling the ledger engine', async () => {
    await expect(
      depositFunds({
        fundingAccountId: 10n,
        toAccountId: 20n,
        amount: '0.00',
        idempotencyKey: 'key-3',
      })
    ).rejects.toThrow(/must be positive/);
    expect(postLedgerEntriesMock).not.toHaveBeenCalled();
  });

  it('rejects a negative amount before ever calling the ledger engine', async () => {
    await expect(
      depositFunds({
        fundingAccountId: 10n,
        toAccountId: 20n,
        amount: '-100.00',
        idempotencyKey: 'key-4',
      })
    ).rejects.toThrow(/must be positive/);
    expect(postLedgerEntriesMock).not.toHaveBeenCalled();
  });
});

describe('depositFunds — account-type validation hook', () => {
  it('allows a deposit when funding is asset and destination is liability', async () => {
    await depositFunds({
      fundingAccountId: 10n,
      toAccountId: 20n,
      amount: '100.00',
      idempotencyKey: 'key-5',
    });

    const input = getCapturedInput();
    expect(() =>
      input.validateBeforePosting?.([
        { accountId: 10n, accountType: 'asset', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
        { accountId: 20n, accountType: 'liability', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
      ])
    ).not.toThrow();
  });

  it('rejects when the funding account is not an asset', async () => {
    await depositFunds({
      fundingAccountId: 10n,
      toAccountId: 20n,
      amount: '100.00',
      idempotencyKey: 'key-6',
    });

    const input = getCapturedInput();
    expect(() =>
      input.validateBeforePosting?.([
        { accountId: 10n, accountType: 'liability', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
        { accountId: 20n, accountType: 'liability', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
      ])
    ).toThrow(InvalidAccountTypeError);
  });

  it('rejects when the destination account is not a liability', async () => {
    await depositFunds({
      fundingAccountId: 10n,
      toAccountId: 20n,
      amount: '100.00',
      idempotencyKey: 'key-7',
    });

    const input = getCapturedInput();
    expect(() =>
      input.validateBeforePosting?.([
        { accountId: 10n, accountType: 'asset', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
        { accountId: 20n, accountType: 'asset', currentBalance: '0.0000', latestHash: null, latestSequence: 0n },
      ])
    ).toThrow(InvalidAccountTypeError);
  });
});