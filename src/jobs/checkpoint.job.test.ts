import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createCheckpointMock } = vi.hoisted(() => ({
  createCheckpointMock: vi.fn(),
}));

vi.mock('../modules/checkpoints/create-checkpoint.js', () => ({
  createCheckpoint: () => createCheckpointMock(),
}));

const { startCheckpointJob } = await import('./checkpoint.job.js');

beforeEach(() => {
  vi.useFakeTimers();
  createCheckpointMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCheckpointJob', () => {
  it('does not call createCheckpoint before the interval elapses', () => {
    createCheckpointMock.mockResolvedValue({
      checkpointId: 1n,
      checkpointUuid: 'uuid',
      sequenceNumber: 1n,
      checkpointHash: 'a'.repeat(64),
      memberCount: 3,
    });

    const job = startCheckpointJob(60_000);
    expect(createCheckpointMock).not.toHaveBeenCalled();
    job.stop();
  });

  it('calls createCheckpoint once per interval tick', async () => {
    createCheckpointMock.mockResolvedValue({
      checkpointId: 1n,
      checkpointUuid: 'uuid',
      sequenceNumber: 1n,
      checkpointHash: 'a'.repeat(64),
      memberCount: 3,
    });

    const job = startCheckpointJob(60_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(createCheckpointMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(createCheckpointMock).toHaveBeenCalledTimes(2);

    job.stop();
  });

  it('logs a success message including the checkpoint sequence and hash', async () => {
    createCheckpointMock.mockResolvedValue({
      checkpointId: 1n,
      checkpointUuid: 'uuid',
      sequenceNumber: 7n,
      checkpointHash: 'abcdef1234567890'.repeat(4),
      memberCount: 5,
    });

    const onLog = vi.fn();
    const job = startCheckpointJob(60_000, onLog);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onLog).toHaveBeenCalledTimes(1);
    const message = onLog.mock.calls[0]?.[0] as string;
    expect(message).toContain('#7');
    expect(message).toContain('5 accounts');
    expect(message).toContain('abcdef12');

    job.stop();
  });

  it('routes failures to onError without throwing or stopping the job', async () => {
    createCheckpointMock.mockRejectedValueOnce(new Error('DB unavailable'));
    createCheckpointMock.mockResolvedValueOnce({
      checkpointId: 1n,
      checkpointUuid: 'uuid',
      sequenceNumber: 1n,
      checkpointHash: 'a'.repeat(64),
      memberCount: 1,
    });

    const onLog = vi.fn();
    const onError = vi.fn();
    const job = startCheckpointJob(60_000, onLog, onError);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    // The job keeps running after a failure — next tick succeeds.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLog).toHaveBeenCalledTimes(1);

    job.stop();
  });

  it('stop() prevents further ticks', async () => {
    createCheckpointMock.mockResolvedValue({
      checkpointId: 1n,
      checkpointUuid: 'uuid',
      sequenceNumber: 1n,
      checkpointHash: 'a'.repeat(64),
      memberCount: 1,
    });

    const job = startCheckpointJob(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createCheckpointMock).toHaveBeenCalledTimes(1);

    job.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(createCheckpointMock).toHaveBeenCalledTimes(1); // unchanged
  });
});