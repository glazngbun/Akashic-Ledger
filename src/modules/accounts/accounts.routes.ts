import type { FastifyInstance } from 'fastify';
import { createAccount } from './create-account.js';
import { db } from '../../db/client.js';
import type { AccountType } from '../../db/schema.js';

const VALID_ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue'];

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accountCode', 'name', 'accountType'],
          properties: {
            accountCode: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            accountType: { type: 'string', enum: VALID_ACCOUNT_TYPES },
          },
        },
      },
    },
    async (request, reply) => {
      const { accountCode, name, accountType } = request.body as {
        accountCode: string;
        name: string;
        accountType: AccountType;
      };

      const result = await createAccount({ accountCode, name, accountType });

      reply.status(201).send({
        accountId: result.accountId.toString(),
        accountUuid: result.accountUuid,
      });
    }
  );

  // Thin, direct read of account_state — not routed through a
  // dedicated "projections" module, since this is a plain synchronous
  // read of an already-current row, not a computed/replayed read
  // model. If async projections are added later, this would be the
  // seam to redirect through them instead.
  app.get(
    '/accounts/:accountId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['accountId'],
          properties: { accountId: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params as { accountId: string };

      const row = await db
        .selectFrom('account_state')
        .select(['current_balance'])
        .where('account_id', '=', accountId)
        .executeTakeFirst();

      if (!row) {
        reply.status(404).send({
          error: {
            name: 'NotFoundError',
            message: `Account ${accountId} not found`,
          },
        });
        return;
      }

      reply.status(200).send({
        accountId,
        currentBalance: row.current_balance,
      });
    }
  );
}