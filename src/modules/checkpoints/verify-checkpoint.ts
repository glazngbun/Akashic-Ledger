import { db } from '../../db/client.js';
import {
  computeCheckpointHash,
  type CheckpointMemberInput,
} from '../../shared/crypto/checkpoint-hash.js';

export interface CheckpointVerificationResult {
  checkpointId: bigint;
  valid: boolean;
  recomputedHash: string;
  storedHash: string;
}

/**
 * Recomputes a single checkpoint's hash from its stored
 * checkpoint_members and previous_checkpoint_hash, and compares it
 * against the stored checkpoint_hash. A mismatch means either the
 * members or the chain link were tampered with after the checkpoint
 * was created.
 */
export async function verifyCheckpoint(
  checkpointId: bigint
): Promise<CheckpointVerificationResult> {
  const checkpoint = await db
    .selectFrom('checkpoints')
    .selectAll()
    .where('id', '=', checkpointId.toString())
    .executeTakeFirstOrThrow();

  const memberRows = await db
    .selectFrom('checkpoint_members')
    .select(['account_id', 'latest_hash', 'latest_sequence'])
    .where('checkpoint_id', '=', checkpointId.toString())
    .execute();

  const members: CheckpointMemberInput[] = memberRows.map((row) => ({
    accountId: BigInt(row.account_id),
    latestHash: row.latest_hash,
    latestSequence: BigInt(row.latest_sequence),
  }));

  const recomputedHash = computeCheckpointHash({
    previousCheckpointHash: checkpoint.previous_checkpoint_hash,
    members,
  });

  return {
    checkpointId,
    valid: recomputedHash === checkpoint.checkpoint_hash,
    recomputedHash,
    storedHash: checkpoint.checkpoint_hash,
  };
}

export interface ChainVerificationResult {
  valid: boolean;
  checkpointsVerified: number;
  firstInvalidCheckpointId: bigint | null;
}

/**
 * Walks every checkpoint in sequence order and verifies two things
 * per checkpoint: (1) its stored previous_checkpoint_hash actually
 * matches the previous checkpoint's real hash — catches a deleted or
 * substituted checkpoint even if the deleted one's own row is gone
 * entirely — and (2) its own hash recomputes correctly from its
 * stored members. Stops at the first failure and reports which
 * checkpoint broke the chain.
 */
export async function verifyCheckpointChain(): Promise<ChainVerificationResult> {
  const checkpoints = await db
    .selectFrom('checkpoints')
    .select(['id', 'sequence_number', 'previous_checkpoint_hash'])
    .orderBy('sequence_number', 'asc')
    .execute();

  let previousHash: string | null = null;
  let verifiedCount = 0;

  for (const checkpoint of checkpoints) {
    if (checkpoint.previous_checkpoint_hash !== previousHash) {
      return {
        valid: false,
        checkpointsVerified: verifiedCount,
        firstInvalidCheckpointId: BigInt(checkpoint.id),
      };
    }

    const result = await verifyCheckpoint(BigInt(checkpoint.id));
    if (!result.valid) {
      return {
        valid: false,
        checkpointsVerified: verifiedCount,
        firstInvalidCheckpointId: BigInt(checkpoint.id),
      };
    }

    previousHash = result.storedHash;
    verifiedCount++;
  }

  return {
    valid: true,
    checkpointsVerified: verifiedCount,
    firstInvalidCheckpointId: null,
  };
}