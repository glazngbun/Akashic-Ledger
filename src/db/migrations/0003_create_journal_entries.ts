import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('journal_entries')
    .addColumn('id', 'bigint', (col) =>
      col.primaryKey().generatedAlwaysAsIdentity()
    )
    .addColumn('entry_uuid', 'uuid', (col) =>
      col.notNull().unique().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_id', 'bigint', (col) =>
      col.notNull().references('events.id')
    )
    .addColumn('account_id', 'bigint', (col) =>
      col.notNull().references('accounts.id')
    )
    .addColumn('signed_amount', 'numeric(19, 4)', (col) => col.notNull())
    // Per-account chain position. Unique per account, assigned while
    // holding the account_state row lock (FOR UPDATE) to avoid races.
    .addColumn('sequence_number', 'bigint', (col) => col.notNull())
    // Denormalized from the parent event so hashing and audit reads
    // never require a join back to events.
    .addColumn('effective_at', 'timestamptz', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull())
    // Hash chain fields. previous_hash is null only for an account's
    // very first entry.
    .addColumn('previous_hash', 'text')
    .addColumn('entry_hash', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();

  // One sequence number per account, never reused, never skipped.
  await db.schema
    .createIndex('idx_journal_entries_account_sequence')
    .on('journal_entries')
    .columns(['account_id', 'sequence_number'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_journal_entries_event_id')
    .on('journal_entries')
    .column('event_id')
    .execute();

  await db.schema
    .createIndex('idx_journal_entries_account_id')
    .on('journal_entries')
    .column('account_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('journal_entries').execute();
}