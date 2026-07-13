import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('checkpoints')
    .addColumn('id', 'bigint', (col) =>
      col.primaryKey().generatedAlwaysAsIdentity()
    )
    .addColumn('checkpoint_uuid', 'uuid', (col) =>
      col.notNull().unique().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('sequence_number', 'bigint', (col) => col.notNull().unique())
    .addColumn('checkpoint_hash', 'text', (col) => col.notNull())
    // Null only for the very first checkpoint ever created.
    .addColumn('previous_checkpoint_hash', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();

  await db.schema
    .createTable('checkpoint_members')
    .addColumn('checkpoint_id', 'bigint', (col) =>
      col.notNull().references('checkpoints.id')
    )
    .addColumn('account_id', 'bigint', (col) =>
      col.notNull().references('accounts.id')
    )
    .addColumn('latest_hash', 'text')
    .addColumn('latest_sequence', 'bigint', (col) => col.notNull())
    .addPrimaryKeyConstraint('checkpoint_members_pkey', [
      'checkpoint_id',
      'account_id',
    ])
    .execute();

  await db.schema
    .createIndex('idx_checkpoint_members_account_id')
    .on('checkpoint_members')
    .column('account_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('checkpoint_members').execute();
  await db.schema.dropTable('checkpoints').execute();
}