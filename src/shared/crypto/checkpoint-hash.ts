import { createHash } from 'node:crypto';

/**
 * Canonical serialization + hashing for checkpoints.
 *
 * A checkpoint commits to the current chain-tip state of every account
 * at one consistent moment (read under REPEATABLE READ, see checkpoint
 * job). Checkpoints themselves chain to each other, so tampering with
 * or deleting a past checkpoint breaks the chain from that point
 * forward — same principle as the per-account journal entry chain, one
 * level up.
 *
 * SPEC (do not change without a migration plan):
 *
 *   checkpoint_hash = SHA256(
 *     previous_checkpoint_hash + "|" + member_1 + "," + member_2 + "," + ...
 *   )
 *
 *   where members are sorted ascending by account_id, and each member
 *   is serialized as:
 *
 *   member = account_id + ":" + latest_hash + ":" + latest_sequence
 *
 * Field format rules:
 * - previous_checkpoint_hash: literal "GENESIS_CHECKPOINT" for the
 *   first checkpoint ever created. Never null/empty in the hash input.
 * - account_id: decimal string (internal BIGINT), no padding.
 * - latest_hash: the account's journal_entries chain tip hash (64
 *   lowercase hex chars), OR literal "GENESIS" if the account has no
 *   journal entries yet — same genesis convention as the entry chain,
 *   reused deliberately for consistency rather than inventing a second
 *   sentinel value.
 * - latest_sequence: decimal string, no padding.
 * - Members are joined with "," ; the previous_checkpoint_hash and the
 *   joined member list are joined with "|".
 */

export const GENESIS_CHECKPOINT_HASH = 'GENESIS_CHECKPOINT';

// Reused from the journal entry chain's genesis sentinel — see
// journal-entry-hash.ts. Kept as a separate constant here rather than
// importing it, since the two chains are conceptually independent even
// though they currently share the same literal value.
const ACCOUNT_GENESIS_HASH = 'GENESIS';

export interface CheckpointMemberInput {
  accountId: bigint;
  latestHash: string | null;
  latestSequence: bigint;
}

export interface CheckpointHashInput {
  previousCheckpointHash: string | null;
  members: CheckpointMemberInput[];
}

function serializeMember(member: CheckpointMemberInput): string {
  const latestHash = member.latestHash ?? ACCOUNT_GENESIS_HASH;
  return `${member.accountId.toString()}:${latestHash}:${member.latestSequence.toString()}`;
}

function serializeForHash(input: CheckpointHashInput): string {
  const previousHash = input.previousCheckpointHash ?? GENESIS_CHECKPOINT_HASH;

  // Sort defensively by account_id even if the caller already queried
  // in order — the hash's correctness must never depend on the caller
  // remembering to sort; it must be guaranteed here.
  const sortedMembers = [...input.members].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0
  );

  const memberList = sortedMembers.map(serializeMember).join(',');

  return `${previousHash}|${memberList}`;
}

export function computeCheckpointHash(input: CheckpointHashInput): string {
  const serialized = serializeForHash(input);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function verifyCheckpointHash(
  input: CheckpointHashInput,
  expectedHash: string
): boolean {
  return computeCheckpointHash(input) === expectedHash;
}