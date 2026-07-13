import Fastify, { type FastifyError } from 'fastify';
import { accountsRoutes } from '../modules/accounts/accounts.routes.js';
import { ledgerRoutes } from '../modules/ledger/ledger.routes.js';
import { checkpointsRoutes } from '../modules/checkpoints/checkpoints.routes.js';
import { httpStatusForError } from '../shared/errors/http-status.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(accountsRoutes);
  app.register(ledgerRoutes);
  app.register(checkpointsRoutes);

  // Central error handler: domain errors (InsufficientFundsError,
  // InvalidAccountTypeError, etc.) map to specific HTTP status codes
  // via httpStatusForError. Fastify/ajv schema-validation errors
  // already carry their own statusCode (400) — respected as-is rather
  // than remapped. Anything else falls through to 500.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? httpStatusForError(error);
    reply.status(statusCode).send({
      error: {
        name: error.name,
        message: error.message,
      },
    });
  });

  return app;
}