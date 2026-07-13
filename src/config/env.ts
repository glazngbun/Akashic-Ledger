import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const env = {
  databaseUrl: requireEnv('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  // pg defaults to 10 if unset — fine for light load, but an
  // unexamined default, not a deliberate choice. Made explicit and
  // configurable since it directly caps how much real concurrency the
  // app can sustain before requests start queueing for a connection.
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
};