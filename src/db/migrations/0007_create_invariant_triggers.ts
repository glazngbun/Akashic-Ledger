import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // --- "Prove it" layer: deferred constraint trigger enforcing that
  // every event's journal_entries sum to exactly zero. This is the
  // final guarantee underneath the application-layer "looks balanced?"
  // check in ledger.service.ts — it runs even if application code has
  // a bug, or if a row is ever inserted by something other than that
  // service.
  //
  // INITIALLY DEFERRED is essential: entries for one event are
  // inserted one row at a time within the same transaction, so a
  // non-deferred (immediate) check would fail after the very first
  // row, before the balancing row(s) exist. Deferred means Postgres
  // waits until COMMIT to actually run the check.
  await sql`
    CREATE OR REPLACE FUNCTION check_journal_entries_balance()
    RETURNS TRIGGER AS $$
    DECLARE
      entry_sum NUMERIC(19, 4);
    BEGIN
      SELECT SUM(signed_amount) INTO entry_sum
      FROM journal_entries
      WHERE event_id = NEW.event_id;

      IF entry_sum <> 0 THEN
        RAISE EXCEPTION
          'journal_entries for event_id % do not sum to zero (got %)',
          NEW.event_id, entry_sum;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE CONSTRAINT TRIGGER trg_check_journal_entries_balance
    AFTER INSERT ON journal_entries
    INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_journal_entries_balance();
  `.execute(db);

  // --- Identity field immutability: once an account has at least one
  // journal_entries row, account_type, account_code, and account_uuid
  // are all locked. This matches the earlier design decision that
  // these are identity fields, not operational ones — only name,
  // status, and metadata remain mutable post-creation.
  //
  // account_type specifically also protects the hash chain's meaning:
  // changing it after the fact would silently flip the debit/credit
  // interpretation of every historical entry against that account.
  await sql`
    CREATE OR REPLACE FUNCTION check_account_identity_immutable()
    RETURNS TRIGGER AS $$
    BEGIN
      IF (NEW.account_type <> OLD.account_type
          OR NEW.account_code <> OLD.account_code
          OR NEW.account_uuid <> OLD.account_uuid) THEN
        IF EXISTS (
          SELECT 1 FROM journal_entries WHERE account_id = OLD.id LIMIT 1
        ) THEN
          RAISE EXCEPTION
            'Cannot change account_type, account_code, or account_uuid for account % — it already has journal entries',
            OLD.id;
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_check_account_identity_immutable
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION check_account_identity_immutable();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_check_account_identity_immutable ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS check_account_identity_immutable`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_check_journal_entries_balance ON journal_entries`.execute(db);
  await sql`DROP FUNCTION IF EXISTS check_journal_entries_balance`.execute(db);
}