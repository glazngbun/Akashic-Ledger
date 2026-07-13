import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('transactions')
    .addColumn('id', 'bigint', (col) =>
      col.primaryKey().generatedAlwaysAsIdentity()
    )
    .addColumn('transaction_uuid', 'uuid', (col) =>
      col.notNull().unique().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('status', 'text', (col) =>
      col.notNull().defaultTo('completed')
    )
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();

  await db.schema
    .createTable('events')
    .addColumn('id', 'bigint', (col) =>
      col.primaryKey().generatedAlwaysAsIdentity()
    )
    .addColumn('event_uuid', 'uuid', (col) =>
      col.notNull().unique().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('transaction_id', 'bigint', (col) =>
      col.notNull().references('transactions.id')
    )
    // reverses_event_id: self-referential FK for TransferReversed-style events.
    // Nullable because most events are not reversals.
    .addColumn('reverses_event_id', 'bigint', (col) =>
      col.references('events.id')
    )
    .addColumn('effective_at', 'timestamptz', (col) => col.notNull())
    .addColumn('recorded_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();

  await db.schema
    .createIndex('idx_events_transaction_id')
    .on('events')
    .column('transaction_id')
    .execute();

  await db.schema
    .createIndex('idx_events_reverses_event_id')
    .on('events')
    .column('reverses_event_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('events').execute();
  await db.schema.dropTable('transactions').execute();
}