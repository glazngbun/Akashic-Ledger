import type { FastifyInstance, FastifyRequest } from 'fastify';
import { transferFunds } from './commands/transfer-funds.js';
import { depositFunds } from './commands/deposit-funds.js';

const ACCOUNT_ID_SCHEMA = { type: 'string', pattern: '^[0-9]+$' } as const;

/**
 * Idempotency-Key is a required header, not a body field — this
 * matches how real payment APIs (e.g. Stripe) expose idempotency, and
 * keeps it visibly separate from the business payload.
 */
function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    const err = Object.assign(new Error('Missing required Idempotency-Key header'), {
      statusCode: 400,
      name: 'MissingIdempotencyKeyError',
    });
    throw err;
  }
  return key;
}

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/transfers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fromAccountId', 'toAccountId', 'amount'],
          properties: {
            fromAccountId: ACCOUNT_ID_SCHEMA,
            toAccountId: ACCOUNT_ID_SCHEMA,
            amount: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(request);
      const { fromAccountId, toAccountId, amount } = request.body as {
        fromAccountId: string;
        toAccountId: string;
        amount: string;
      };

      const result = await transferFunds({
        fromAccountId: BigInt(fromAccountId),
        toAccountId: BigInt(toAccountId),
        amount,
        idempotencyKey,
      });

      // 200 on replay (nothing new was created), 201 on a genuine
      // first-time post — a small but deliberate REST correctness
      // detail, not just "always 201".
      reply.status(result.idempotentReplay ? 200 : 201).send({
        transactionId: result.transactionId.toString(),
        eventId: result.eventId.toString(),
        idempotentReplay: result.idempotentReplay,
      });
    }
  );

  app.post(
    '/deposits',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fundingAccountId', 'toAccountId', 'amount'],
          properties: {
            fundingAccountId: ACCOUNT_ID_SCHEMA,
            toAccountId: ACCOUNT_ID_SCHEMA,
            amount: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(request);
      const { fundingAccountId, toAccountId, amount } = request.body as {
        fundingAccountId: string;
        toAccountId: string;
        amount: string;
      };

      const result = await depositFunds({
        fundingAccountId: BigInt(fundingAccountId),
        toAccountId: BigInt(toAccountId),
        amount,
        idempotencyKey,
      });

      reply.status(result.idempotentReplay ? 200 : 201).send({
        transactionId: result.transactionId.toString(),
        eventId: result.eventId.toString(),
        idempotentReplay: result.idempotentReplay,
      });
    }
  );
}