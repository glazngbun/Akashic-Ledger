import { db } from '../../db/client.js';
import {
  computeCheckpointHash,
  type CheckpointMemberInput,
} from '../../shared/crypto/checkpoint-hash.js';

export interface CreateCheckpointResult {
  checkpointId: bigint;
  checkpointUuid: string;
  sequenceNumber: bigint;
  checkpointHash: string;
  memberCount: number;
}

/**
 * Creates a new checkpoint: a cryptographic commitment to every
 * account's chain-tip state at one consistent moment.
 *
 * Uses REPEATABLE READ, not row locking — the whole point of
 * per-account hash chains was to avoid a single global bottleneck on
 * every write; taking a lock on every account here would reintroduce
 * exactly that bottleneck, just on a timer instead of on every
 * transfer. REPEATABLE READ gives an MVCC snapshot consistent as of
 * transaction start, with zero blocking of concurrent writers.
 *
 * SERIALIZABLE was deliberately not used — this transaction is a
 * read-then-insert-new-rows operation, not a read-then-conditionally-
 * write-based-on-what-was-read cycle, so there's no write-skew hazard
 * for SERIALIZABLE to protect against here.
 */
export async function createCheckpoint(): Promise<CreateCheckpointResult> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const accountStates = await trx
        .selectFrom('account_state')
        .select(['account_id', 'latest_hash', 'latest_sequence'])
        .orderBy('account_id', 'asc')
        .execute();

      const members: CheckpointMemberInput[] = accountStates.map((row) => ({
        accountId: BigInt(row.account_id),
        latestHash: row.latest_hash,
        latestSequence: BigInt(row.latest_sequence),
      }));

      const previousCheckpoint = await trx
        .selectFrom('checkpoints')
        .select(['checkpoint_hash', 'sequence_number'])
        .orderBy('sequence_number', 'desc')
        .limit(1)
        .executeTakeFirst();

      const previousCheckpointHash = previousCheckpoint?.checkpoint_hash ?? null;
      const nextSequence = previousCheckpoint
        ? BigInt(previousCheckpoint.sequence_number) + 1n
        : 1n;

      const checkpointHash = computeCheckpointHash({
        previousCheckpointHash,
        members,
      });

      const checkpointRow = await trx
        .insertInto('checkpoints')
        .values({
          sequence_number: nextSequence.toString(),
          checkpoint_hash: checkpointHash,
          previous_checkpoint_hash: previousCheckpointHash,
        })
        .returning(['id', 'checkpoint_uuid'])
        .executeTakeFirstOrThrow();

      if (members.length > 0) {
        await trx
          .insertInto('checkpoint_members')
          .values(
            members.map((member) => ({
              checkpoint_id: checkpointRow.id,
              account_id: member.accountId.toString(),
              latest_hash: member.latestHash,
              latest_sequence: member.latestSequence.toString(),
            }))
          )
          .execute();
      }

      return {
        checkpointId: BigInt(checkpointRow.id),
        checkpointUuid: checkpointRow.checkpoint_uuid,
        sequenceNumber: nextSequence,
        checkpointHash,
        memberCount: members.length,
      };
    });
}