import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Database } from './schema.js';
import { env } from '../config/env.js';

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: env.databaseUrl,
    max: env.dbPoolMax,
  }),
});

export const db = new Kysely<Database>({ dialect });