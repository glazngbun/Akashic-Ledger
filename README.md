# Akashic

A production-grade, event-sourced, double-entry ledger for wallet and payments systems — built around cryptographic hash chains, periodic checkpointing, bitemporal record-keeping, and an independent audit tool that verifies system integrity from first principles.

[![CI](https://github.com/glazngbun/Akashic-Ledger.git/actions/workflows/ci.yml/badge.svg)](https://github.com/glazngbun/Akashic-Ledger.git/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Tests](https://img.shields.io/badge/tests-100%20passing-brightgreen)

**[Watch the demo video](REPLACE_WITH_DEMO_VIDEO_LINK)** · **[Read the full architecture writeup](REPLACE_WITH_ARCHITECTURE_POST_LINK)**

---

## Table of contents

- [Overview](#overview)
- [Core features](#core-features)
- [Screenshots](#screenshots)
- [Benchmarks](#benchmarks)
- [Design rationale](#design-rationale)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [API](#api)
- [Testing](#testing)
- [Project structure](#project-structure)
- [License](#license)

---

## Overview

Every balance change in Akashic is recorded as an immutable, cryptographically-chained journal entry, derived from real double-entry accounting rules — not a `balance` column mutated in place, but an append-only log that a balance is *computed from*, the same way a payments platform's core ledger works under the hood.

Correctness here isn't optional: concurrent writes to the same balance, cryptographic tamper-evidence, and invariants that hold even against direct database access are treated as first-class requirements, not afterthoughts. Every transaction's entries sum to exactly zero, every write is idempotent, and every table is append-only — each of these is enforced at the database level, not just assumed by application code.

## Core features

- **Double-entry, always balanced.** Every transaction's entries sum to exactly zero — enforced in application code for fast feedback, and separately by a deferred Postgres trigger that doesn't trust the application at all.
- **Append-only, enforced at the database level.** `UPDATE` and `DELETE` are blocked outright on every event-sourced table — an actual guarantee, not a convention.
- **Tamper-evident in layers.** Per-account SHA-256 hash chains, checkpoints that snapshot every account at once, and checkpoints that chain to each other. An independent audit tool re-verifies all of it from scratch on demand.
- **Bitemporal.** Every entry carries both `effective_at` (when it happened) and `recorded_at` (when the system learned about it), so the ledger can answer "what did we believe was true as of last Tuesday" even after a late-arriving correction changes today's picture.
- **Idempotent by construction.** Every write accepts an idempotency key; retried requests return the original result instead of double-posting.
- **Deadlock-safe under concurrency.** Multi-account operations lock accounts in sorted ID order — proven under real concurrent load, not just asserted.
- **Independently auditable.** `npm run audit` walks the entire database from scratch — every hash chain, every checkpoint, every balance reconciled against the raw journal log, and the zero-sum invariant re-checked independently of the database trigger. It exits with a nonzero status on any failure, so it can run in CI or as a scheduled integrity check, not just as a manual sanity test. See `DEMO_SCRIPT.md` for a full walkthrough, including a simulated tampering scenario.

## Screenshots

*(Capture these while running through `DEMO_SCRIPT.md`, drop them into `docs/screenshots/`, and swap the table cells below for `![](path)` image tags.)*

| | |
|---|---|
| Test suite, fully green | `docs/screenshots/tests-passing1.png` `docs/screenshots/tests-passing1.png`|
| CI passing on GitHub | `docs/screenshots/ci-passing.png` |
| `npm run audit` — clean pass | `docs/screenshots/audit-clean.png` |
| `npm run audit` — catching tampering | `docs/screenshots/audit-tampered.png` |
| Benchmark output | `docs/screenshots/benchmark-output.png` |

## Benchmarks

Full methodology and raw numbers live in `BENCHMARKS.md`.

Headline result: on real multi-core hardware, transfers between independent account pairs achieve **5.7x the throughput** of repeated concurrent access to the same two accounts (256.8 vs 44.6 transfers/sec) — direct confirmation that sorted account-ID lock ordering does what it's supposed to: unrelated transactions don't wait on each other, only genuinely contended ones do.

## Design rationale

**Direction-based leg model.** Commands (`transferFunds`, `depositFunds`) state business intent — "this account increases," "that account decreases" — never raw signed amounts. The ledger engine derives the correct debit(+)/credit(-) accounting representation internally, from each account's type. This matters because a signed-amount model, where callers compute their own debit/credit values, breaks for any transaction where two accounts of different types both increase in the same operation — a deposit being the clearest example. The full reasoning is in the architecture writeup linked at the top.

Other decisions worth knowing about:

- **Hard-block overdraft policy.** A wallet processes valid transactions; it doesn't model credit. This is layered on top of the ledger engine via a validation hook, not baked into it, so the engine itself stays business-agnostic.
- **Sorted account-ID lock ordering.** Any operation touching multiple accounts locks them in ascending ID order, regardless of which account is conceptually the "sender" — the standard fix for the classic opposite-direction deadlock, verified under real concurrent load.
- **Checkpoints use `REPEATABLE READ`, not row locks.** Locking every account to build a checkpoint would reintroduce the exact global bottleneck per-account hash chains exist to avoid. Postgres's MVCC snapshot isolation gives a consistent point-in-time view with zero blocking of concurrent writers.
- **A Merkle tree was considered and rejected for checkpoints.** Nothing in this system's threat model requires selective per-account inclusion proofs for a third party, so a simpler sorted-concatenation hash was chosen — complexity should be justified by a concrete need.

## Tech stack

TypeScript (strict mode), Fastify, Kysely, PostgreSQL 16, Vitest, Docker Compose, GitHub Actions.

Kysely was chosen over an ORM deliberately: an append-only, immutable ledger fights ORM abstractions built around mutable CRUD. A typed query builder gets type safety without fighting the append-only model.

## Getting started

```bash
# 1. Start Postgres
docker compose -f docker/docker-compose.yml up -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env

# 4. Run migrations
npm run migrate

# 5. Start the server
npm run dev
```

Server starts on `http://localhost:3000`. Health check: `GET /health`.

For a guided, narrated walkthrough of every feature, follow `DEMO_SCRIPT.md`.

## API

All monetary amounts are decimal strings (e.g. `"100.00"`), never numbers — this avoids floating-point precision loss on money, end to end.

| Method | Path | Description |
|---|---|---|
| `POST` | `/accounts` | Create an account (`asset`, `liability`, `equity`, or `revenue`) |
| `GET` | `/accounts/:accountId` | Get an account's current balance |
| `POST` | `/deposits` | Fund a wallet from an external/house account (requires `Idempotency-Key` header) |
| `POST` | `/transfers` | Move funds between two wallets (requires `Idempotency-Key` header) |
| `POST` | `/checkpoints` | Snapshot every account's current chain state into a new checkpoint |
| `GET` | `/checkpoints/:checkpointId/verify` | Recompute and verify a single checkpoint's hash |
| `GET` | `/checkpoints/verify-chain` | Walk and verify the entire checkpoint chain |

```bash
curl -X POST localhost:3000/accounts -H "Content-Type: application/json" \
  -d '{"accountCode":"BANK:CASH:1","name":"House","accountType":"asset"}'

curl -X POST localhost:3000/deposits \
  -H "Content-Type: application/json" -H "Idempotency-Key: dep-1" \
  -d '{"fundingAccountId":"1","toAccountId":"2","amount":"100.00"}'
```

## Testing

Two suites, deliberately separate:

```bash
npm test                     # unit tests — fast, no DB dependency (78 tests)
npm run test:integration     # integration tests — requires live Postgres (22 tests)
```

Unit tests cover pure logic in isolation: decimal arithmetic (no floating point, ever, for money), hash chain computation, business commands with the ledger engine mocked out.

Integration tests run against real Postgres and prove claims that can't be verified any other way: the cross-account-type zero-sum invariant, the deferred DB trigger catching corruption that bypasses application code, `account_type` and full row immutability enforcement, checkpoint and audit tamper detection, and — the one that matters most — 20 concurrent opposite-direction transfers between the same two accounts with zero deadlocks.

CI runs both suites, plus a full type-check, on every push.

## Project structure

```
src/
├── app/              Fastify app builder, central error handling
├── config/           Environment configuration
├── db/                Kysely client, migrations, schema types
├── jobs/               Scheduled checkpoint job
├── modules/
│   ├── accounts/       Account creation and reads
│   ├── ledger/         Core ledger engine + business commands (transfer, deposit)
│   ├── checkpoints/     Checkpoint creation and verification
│   └── audit/           Independent whole-system verification
├── shared/
│   ├── crypto/          Hash chain modules (journal entries, checkpoints)
│   ├── domain/          Pure accounting rules (normal-balance derivation)
│   ├── errors/           Domain error types + HTTP status mapping
│   └── utils/            Decimal-safe arithmetic
└── index.ts             Entry point

tests/integration/     Tests requiring a real Postgres instance
benchmarks/              Real latency/throughput benchmark script
docker/                  docker-compose.yml for local Postgres
```

## License

MIT — see `LICENSE`.
