import { ColumnType, Generated } from 'kysely';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue';
export type AccountStatus = 'active' | 'frozen' | 'closed';

export interface AccountsTable {
  id: Generated<string>; // bigint -> string in JS to avoid precision loss
  account_uuid: Generated<string>;
  account_code: string;
  name: string;
  account_type: AccountType;
  status: ColumnType<AccountStatus, AccountStatus | undefined, AccountStatus>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface TransactionsTable {
  id: Generated<string>;
  transaction_uuid: Generated<string>;
  status: ColumnType<string, string | undefined, string>;
  type: string;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface EventsTable {
  id: Generated<string>;
  event_uuid: Generated<string>;
  event_type: string;
  transaction_id: string;
  reverses_event_id: string | null;
  effective_at: ColumnType<Date, string, never>;
  recorded_at: ColumnType<Date, string | undefined, never>;
  payload: ColumnType<Record<string, unknown>, string, never>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface JournalEntriesTable {
  id: Generated<string>;
  entry_uuid: Generated<string>;
  event_id: string;
  account_id: string;
  signed_amount: string; // numeric -> string to avoid float precision loss
  sequence_number: string;
  effective_at: ColumnType<Date, string, never>;
  recorded_at: ColumnType<Date, string, never>;
  previous_hash: string | null;
  entry_hash: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface AccountStateTable {
  account_id: string;
  current_balance: string;
  latest_hash: string | null;
  latest_sequence: string;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface IdempotencyKeysTable {
  idempotency_key: string;
  transaction_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface CheckpointsTable {
  id: Generated<string>;
  checkpoint_uuid: Generated<string>;
  sequence_number: string;
  checkpoint_hash: string;
  previous_checkpoint_hash: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface CheckpointMembersTable {
  checkpoint_id: string;
  account_id: string;
  latest_hash: string | null;
  latest_sequence: string;
}

export interface Database {
  accounts: AccountsTable;
  transactions: TransactionsTable;
  events: EventsTable;
  journal_entries: JournalEntriesTable;
  account_state: AccountStateTable;
  idempotency_keys: IdempotencyKeysTable;
  checkpoints: CheckpointsTable;
  checkpoint_members: CheckpointMembersTable;
}