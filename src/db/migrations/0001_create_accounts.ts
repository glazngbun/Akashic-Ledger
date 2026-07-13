// src/db/migrations/0001_create_accounts.ts
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createType('account_type')
    .asEnum(['asset', 'liability', 'equity', 'revenue'])
    .execute();

  await db.schema
    .createType('account_status')
    .asEnum(['active', 'frozen', 'closed'])
    .execute();

  await db.schema
    .createTable('accounts')
    .addColumn('id', 'bigint', (col) =>
      col.primaryKey().generatedAlwaysAsIdentity()
    )
    .addColumn('account_uuid', 'uuid', (col) =>
      col.notNull().unique().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('account_code', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('account_type', sql`account_type`, (col) => col.notNull())
    .addColumn('status', sql`account_status`, (col) =>
      col.notNull().defaultTo('active')
    )
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`)
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('accounts').execute();
  await db.schema.dropType('account_status').execute();
  await db.schema.dropType('account_type').execute();
}