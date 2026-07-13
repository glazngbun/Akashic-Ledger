import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Enforces "append-only" as a real DB-level guarantee, not just an
  // application-code convention. Until now, nothing actually stopped
  // a direct UPDATE or DELETE against journal_entries — the deferred
  // balance trigger only fires on INSERT. This closes that gap.
  //
  // TRUNCATE deliberately does NOT fire per-row DELETE triggers (this
  // is documented Postgres behavior, distinct from DELETE) — so bulk
  // resets (e.g. test fixtures) must use TRUNCATE, never DELETE,
  // against these tables from now on.
  await sql`
    CREATE OR REPLACE FUNCTION block_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only; % is not permitted on this table',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  const immutableTables = [
    'journal_entries',
    'events',
    'checkpoints',
    'checkpoint_members',
  ];

  for (const table of immutableTables) {
    await sql`
      CREATE TRIGGER trg_block_mutation
      BEFORE UPDATE OR DELETE ON ${sql.raw(table)}
      FOR EACH ROW
      EXECUTE FUNCTION block_mutation();
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  const immutableTables = [
    'journal_entries',
    'events',
    'checkpoints',
    'checkpoint_members',
  ];

  for (const table of immutableTables) {
    await sql`
      DROP TRIGGER IF EXISTS trg_block_mutation ON ${sql.raw(table)}
    `.execute(db);
  }

  await sql`DROP FUNCTION IF EXISTS block_mutation`.execute(db);
}