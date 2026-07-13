import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('account_state')
    .addColumn('account_id', 'bigint', (col) =>
      col.primaryKey().references('accounts.id')
    )
    .addColumn('current_balance', 'numeric(19, 4)', (col) =>
      col.notNull().defaultTo(0)
    )
    .addColumn('latest_hash', 'text')
    .addColumn('latest_sequence', 'bigint', (col) =>
      col.notNull().defaultTo(0)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('account_state').execute();
}