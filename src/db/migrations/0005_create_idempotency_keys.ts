import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('idempotency_keys')
    .addColumn('idempotency_key', 'text', (col) => col.primaryKey())
    .addColumn('transaction_id', 'bigint', (col) =>
      col.notNull().references('transactions.id')
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute();
}