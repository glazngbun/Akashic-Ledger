# run-demo.ps1
#
# Runs the full Akashic demo sequence end to end, in order, with a
# clear heading before each section. Pauses before every screenshot-
# worthy moment so you can manually snip it (Win+Shift+S) and continue
# whenever you're ready — no automated screen capture, since that
# turned out to be unreliable.
#
# PREREQUISITES:
#   1. Postgres running:      docker compose -f docker/docker-compose.yml up -d
#   2. Dev server running IN A SEPARATE TERMINAL:      npm run dev
#      (check first with: Get-NetTCPConnection -LocalPort 3000 -State Listen)
#   3. Run this script from the project root.
#
# Usage:
#   .\run-demo.ps1

$ErrorActionPreference = "Stop"

function Section {
    param([Parameter(Mandatory)][string]$Title)
    Write-Host ""
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "===========================================================" -ForegroundColor Cyan
}

function Pause-ForScreenshot {
    param([string]$Hint = "Take your screenshot now (Win+Shift+S), then press Enter to continue...")
    Write-Host ""
    Write-Host $Hint -ForegroundColor Yellow
    Read-Host | Out-Null
}

function Invoke-AkashicApi {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [string]$Body,
        [hashtable]$Headers = @{}
    )

    $curlArgs = @("-s", "-X", $Method, $Uri, "-H", "Content-Type: application/json")
    foreach ($key in $Headers.Keys) {
        $curlArgs += @("-H", "$key`: $($Headers[$key])")
    }
    if ($Body) {
        $curlArgs += @("-d", $Body)
    }

    $rawResponse = & curl.exe @curlArgs
    $parsed = $rawResponse | ConvertFrom-Json -ErrorAction SilentlyContinue

    if ($null -eq $parsed) {
        Write-Host "FAILED: $Method $Uri returned unparseable response: $rawResponse" -ForegroundColor Red
        exit 1
    }
    if ($parsed.error) {
        Write-Host "FAILED: $Method $Uri returned an error: $($parsed.error.name) - $($parsed.error.message)" -ForegroundColor Red
        exit 1
    }

    return $parsed
}

# ===========================================================================
Section "0. Pre-flight checks"
# ===========================================================================

Write-Host "Checking the dev server is up..." -ForegroundColor Yellow
try {
    Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 3 | Out-Null
    Write-Host "Server is up." -ForegroundColor Green
} catch {
    Write-Host "Server is NOT responding on localhost:3000." -ForegroundColor Red
    Write-Host "Start it in ANOTHER terminal first: npm run dev" -ForegroundColor Red
    exit 1
}

# ===========================================================================
Section "1. Reset the database"
# ===========================================================================

docker compose -f docker/docker-compose.yml exec postgres psql -U akashic -d akashic -c "TRUNCATE accounts, account_state, journal_entries, events, transactions, idempotency_keys, checkpoints, checkpoint_members RESTART IDENTITY CASCADE;"

$accountCountAfterReset = (docker compose -f docker/docker-compose.yml exec postgres psql -U akashic -d akashic -t -c "SELECT COUNT(*) FROM accounts;").Trim()
if ($accountCountAfterReset -ne "0") {
    Write-Host "Reset did not actually clear the accounts table (found $accountCountAfterReset rows). Aborting rather than continuing against stale state." -ForegroundColor Red
    exit 1
}
Write-Host "Confirmed: database is clean." -ForegroundColor Green

# ===========================================================================
Section "2. Unit tests"
# ===========================================================================

npm test
Pause-ForScreenshot

# ===========================================================================
Section "3. Integration tests"
# ===========================================================================

npm run test:integration
Pause-ForScreenshot

# ===========================================================================
Section "4. Seed accounts and a transfer via the live API"
# ===========================================================================

$house = Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/accounts" `
    -Body '{"accountCode":"BANK:CASH:1","name":"House","accountType":"asset"}'
$alice = Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/accounts" `
    -Body '{"accountCode":"WALLET:USER:alice","name":"Alice","accountType":"liability"}'
$bob = Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/accounts" `
    -Body '{"accountCode":"WALLET:USER:bob","name":"Bob","accountType":"liability"}'

Write-Host "  House=$($house.accountId)  Alice=$($alice.accountId)  Bob=$($bob.accountId)" -ForegroundColor DarkGray

Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/deposits" `
    -Headers @{ "Idempotency-Key" = "dep-1" } `
    -Body "{`"fundingAccountId`":`"$($house.accountId)`",`"toAccountId`":`"$($alice.accountId)`",`"amount`":`"100.00`"}" | Out-Null
Write-Host "Deposited 100.00 into Alice's wallet." -ForegroundColor Green

Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/transfers" `
    -Headers @{ "Idempotency-Key" = "t-1" } `
    -Body "{`"fromAccountId`":`"$($alice.accountId)`",`"toAccountId`":`"$($bob.accountId)`",`"amount`":`"40.00`"}" | Out-Null
Write-Host "Transferred 40.00 from Alice to Bob." -ForegroundColor Green

$aliceBalance = Invoke-AkashicApi -Method GET -Uri "http://localhost:3000/accounts/$($alice.accountId)"
$bobBalance = Invoke-AkashicApi -Method GET -Uri "http://localhost:3000/accounts/$($bob.accountId)"
Write-Host "  Alice balance: $($aliceBalance.currentBalance)   Bob balance: $($bobBalance.currentBalance)" -ForegroundColor DarkGray

$entryCount = (docker compose -f docker/docker-compose.yml exec postgres psql -U akashic -d akashic -t -c "SELECT COUNT(*) FROM journal_entries;").Trim()
if ($entryCount -ne "4") {
    Write-Host "Expected 4 journal entries after seeding, found $entryCount. Aborting." -ForegroundColor Red
    exit 1
}
Write-Host "Confirmed: 4 journal entries created." -ForegroundColor Green
Pause-ForScreenshot

# ===========================================================================
Section "5. Idempotent replay (same request, same key, twice)"
# ===========================================================================

Write-Host "First call already happened above. Replaying with the SAME Idempotency-Key..." -ForegroundColor Yellow
$replay = Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/transfers" `
    -Headers @{ "Idempotency-Key" = "t-1" } `
    -Body "{`"fromAccountId`":`"$($alice.accountId)`",`"toAccountId`":`"$($bob.accountId)`",`"amount`":`"40.00`"}"
Write-Host "  idempotentReplay = $($replay.idempotentReplay)  (should be true)" -ForegroundColor DarkGray

$aliceBalanceAfterReplay = Invoke-AkashicApi -Method GET -Uri "http://localhost:3000/accounts/$($alice.accountId)"
Write-Host "  Alice balance after replay: $($aliceBalanceAfterReplay.currentBalance)  (should be unchanged)" -ForegroundColor DarkGray
Pause-ForScreenshot

# ===========================================================================
Section "6. Insufficient funds - hard block"
# ===========================================================================

curl.exe -s -w "`nHTTP %{http_code}`n" -X POST http://localhost:3000/transfers `
    -H "Content-Type: application/json" -H "Idempotency-Key: t-overdraft" `
    -d "{`"fromAccountId`":`"$($alice.accountId)`",`"toAccountId`":`"$($bob.accountId)`",`"amount`":`"999.00`"}"
Pause-ForScreenshot

# ===========================================================================
Section "7. Checkpoint creation and verification"
# ===========================================================================

$checkpoint = Invoke-AkashicApi -Method POST -Uri "http://localhost:3000/checkpoints"
Write-Host "  Created checkpoint id=$($checkpoint.checkpointId)" -ForegroundColor DarkGray

$verify = Invoke-AkashicApi -Method GET -Uri "http://localhost:3000/checkpoints/$($checkpoint.checkpointId)/verify"
Write-Host "  valid = $($verify.valid)" -ForegroundColor DarkGray
Pause-ForScreenshot

# ===========================================================================
Section "8. Audit tool - clean pass"
# ===========================================================================

npm run audit
Pause-ForScreenshot "This is a good one to screenshot as 'audit-clean'. Take it now, then press Enter..."

# ===========================================================================
Section "9. Tamper with a journal entry directly (bypassing the app)"
# ===========================================================================

$targetEntryId = (docker compose -f docker/docker-compose.yml exec postgres psql -U akashic -d akashic -t -c "SELECT id FROM journal_entries WHERE account_id = '$($alice.accountId)' ORDER BY sequence_number ASC LIMIT 1;").Trim()
if (-not $targetEntryId) {
    Write-Host "Could not find a journal_entries row for Alice to tamper with. Aborting." -ForegroundColor Red
    exit 1
}
Write-Host "Targeting journal_entries.id=$targetEntryId (Alice's first entry)" -ForegroundColor DarkGray

$tamperResult = docker compose -f docker/docker-compose.yml exec postgres psql -U akashic -d akashic -c "ALTER TABLE journal_entries DISABLE TRIGGER trg_block_mutation; UPDATE journal_entries SET signed_amount = '999.0000' WHERE id = $targetEntryId; ALTER TABLE journal_entries ENABLE TRIGGER trg_block_mutation;"

if ($tamperResult -notmatch "UPDATE 1") {
    Write-Host "Tamper UPDATE did not affect exactly 1 row (got: $tamperResult). Aborting rather than continuing with a meaningless next step." -ForegroundColor Red
    exit 1
}
Write-Host "Confirmed: exactly 1 row was tampered with." -ForegroundColor Green

# ===========================================================================
Section "10. Audit tool - catching the tampering"
# ===========================================================================

npm run audit
Write-Host ""
Write-Host "Exit code: $LASTEXITCODE  (should be 1 - a real failure code, not just red text)" -ForegroundColor DarkGray
Pause-ForScreenshot "This is the money shot - screenshot it as 'audit-tampered'. Take it now, then press Enter..."

# ===========================================================================
Section "11. Reset again, then run the benchmark"
# ===========================================================================

docker compose -f docker/docker-compose.yml exec postgres psql -U akashic -d akashic -c "TRUNCATE accounts, account_state, journal_entries, events, transactions, idempotency_keys, checkpoints, checkpoint_members RESTART IDENTITY CASCADE;"

Write-Host "Running the benchmark (takes under a minute)..." -ForegroundColor Yellow
npx tsx benchmarks/run-benchmark.ts
Pause-ForScreenshot

# ===========================================================================
Section "Done"
# ===========================================================================

Write-Host "Full demo sequence complete." -ForegroundColor Green
Write-Host ""
Write-Host "One more screenshot isn't scriptable at all: push your latest commit," -ForegroundColor Yellow
Write-Host "open the GitHub Actions tab, wait for the green checkmark, and" -ForegroundColor Yellow
Write-Host "screenshot that manually." -ForegroundColor Yellow
