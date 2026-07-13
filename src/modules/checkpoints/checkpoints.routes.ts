import type { FastifyInstance } from 'fastify';
import { createCheckpoint } from './create-checkpoint.js';
import { verifyCheckpoint, verifyCheckpointChain } from './verify-checkpoint.js';

export async function checkpointsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/checkpoints', async (_request, reply) => {
    const result = await createCheckpoint();
    reply.status(201).send({
      checkpointId: result.checkpointId.toString(),
      checkpointUuid: result.checkpointUuid,
      sequenceNumber: result.sequenceNumber.toString(),
      checkpointHash: result.checkpointHash,
      memberCount: result.memberCount,
    });
  });

  app.get(
    '/checkpoints/:checkpointId/verify',
    {
      schema: {
        params: {
          type: 'object',
          required: ['checkpointId'],
          properties: {
            checkpointId: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const { checkpointId } = request.params as { checkpointId: string };
      const result = await verifyCheckpoint(BigInt(checkpointId));
      reply.status(200).send({
        checkpointId: result.checkpointId.toString(),
        valid: result.valid,
        recomputedHash: result.recomputedHash,
        storedHash: result.storedHash,
      });
    }
  );

  app.get('/checkpoints/verify-chain', async (_request, reply) => {
    const result = await verifyCheckpointChain();
    reply.status(200).send({
      valid: result.valid,
      checkpointsVerified: result.checkpointsVerified,
      firstInvalidCheckpointId:
        result.firstInvalidCheckpointId?.toString() ?? null,
    });
  });
}