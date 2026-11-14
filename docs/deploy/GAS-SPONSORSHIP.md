# Network-fee sponsorship: configuration, funding, verification and rollback

BUILD-FLOFI-MAINNET-EXEC-002 ([ADR-0009](../adr/ADR-0009-network-fee-sponsorship.md)). Off by default. This is the **FloFi-paid** feature; network fees the
**user** pays in tokens (Circle Paymaster, Pimlico Kora, 0x Gasless) are a separate feature: [GAS-ABSTRACTION.md](GAS-ABSTRACTION.md) ([ADR-0010](../adr/ADR-0010-token-paid-network-fees.md)). Steps marked **[OWNER]** create a paid
resource, move real funds or change production; none was performed during engineering, and no credential, contract address or balance below
was invented: each value comes from the operator's own provider account.

## 0. What it does

An owner wallet batch (EIP-5792, `EVM_WALLET_BATCH`) prepared on a configured chain carries a single-use grant for exactly its calls. A wallet
that reports `paymasterService` sends it as an ERC-4337 operation whose fee the operator's pinned paymaster pays, through FloFi's proxy
`POST /api/gas/paymaster/<chainId>`. Anything else stays owner-paid. Solana sponsorship exists as a verified module but is not wired into a flow.

## 1. Requirements per EVM chain

| What | Where it comes from |
| --- | --- |
| An ERC-7677 paymaster web service for EntryPoint v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`) on that chain | **[OWNER]** an account with a paymaster provider that implements `pm_getPaymasterStubData` / `pm_getPaymasterData` (e.g. Coinbase Developer Platform Paymaster on Base, Pimlico, Alchemy Gas Manager). The URL usually embeds the API key |
| The paymaster **contract address** the provider's answers name | the provider's dashboard/documentation for that chain (FloFi refuses any other: `GAS_SPONSOR_PAYMASTER_UNEXPECTED`) |
| A funded sponsorship balance | **[OWNER]** fund the provider account / paymaster deposit on that chain (provider-specific: prepaid credit, or an EntryPoint deposit for a self-hosted verifying paymaster) |
| A provider-side policy (recommended) | **[OWNER]** restrict the policy to EntryPoint v0.7 and a per-operation limit; pass its id with `FLOFI_PAYMASTER_CONTEXT_<chainId>` if the provider requires one |

Supported chain ids: `8453` (Base), `42161` (Arbitrum One), `1` (Ethereum), `4663` (Robinhood Chain) — mainnets only.

## 2. Environment (Vercel web tier; server-only)

| Variable | Value |
| --- | --- |
| `FLOFI_GAS_SPONSORSHIP` | `enabled` (master switch; absent ⇒ everything owner-paid) |
| `FLOFI_GAS_SPONSOR_PUBLIC_ORIGIN` | the deployment's https origin, e.g. `https://app.flofi.example` (wallets call `<origin>/api/gas/paymaster/<chainId>`) |
| `FLOFI_PAYMASTER_RPC_<chainId>` | the provider's ERC-7677 URL — **secret** (mark Sensitive in Vercel) |
| `FLOFI_PAYMASTER_ADDRESS_<chainId>` | the pinned paymaster contract |
| `FLOFI_PAYMASTER_CONTEXT_<chainId>` | optional JSON object forwarded as the provider's context, e.g. `{"sponsorshipPolicyId":"sp_…"}` |
| `FLOFI_SPONSOR_MAX_WEI_PER_OP_<chainId>` | worst-case cost cap of one operation (wei), e.g. `200000000000000` (0.0002 ETH) |
| `FLOFI_SPONSOR_DAILY_BUDGET_WEI_<chainId>` | sum of worst-case costs per UTC day (wei, ≥ the cap); size it as described in *Budget accounting* below |
| `FLOFI_SOLANA_SPONSOR_SECRET_KEY` | (future Solana wiring) sponsor keypair, base58 or Solana CLI JSON — **secret**; not used by any flow yet |
| `FLOFI_SOLANA_SPONSOR_MAX_LAMPORTS_PER_TX`, `FLOFI_SOLANA_SPONSOR_DAILY_BUDGET_LAMPORTS`, `FLOFI_SOLANA_SPONSOR_MIN_BALANCE_LAMPORTS` | Solana caps (future wiring) |

Also required (already present for user-funded execution): `FLOFI_USER_FUNDED_EXECUTION=enabled` with the chain's read RPC, and the
PostgreSQL platform state (`DATABASE_URL`): the ledger and grants live in `execution_logs` / `execution_leases` under namespace
`gas-sponsorship` — **no migration** is needed.

A chain with an incomplete or malformed configuration is disabled on its own (`GAS_SPONSOR_EVM_CONFIG_INVALID`); others keep working.
`FLOFI_GAS_SPONSOR_PUBLIC_ORIGIN` must be `https:` (plain `http:` only for `127.0.0.1` in local acceptance); any other scheme disables every
chain.

**Budget accounting (conservative).** When the proxy hands a wallet final paymaster data, the grant first records the operation's hash and
owner nonce (which pins the nonce), and then the operation's worst-case cost (all gas limits, paymaster gas included, × `maxFeePerGas`) is
reserved on the ledger of the UTC day the **grant was created**. Reconciliation replaces it with the fee actually paid (the EntryPoint's
`actualGasCost`). Until then the reservation counts **in full for that whole day**: nothing releases it and it does not expire after a
time. This is deliberate. A paymaster signature can stay valid after the owner stops answering, so returning the budget early would let
unreported operations spend beyond it. The trade-off is availability, not funds: a signature the owner refused, or a wallet that abandoned
the operation, keeps its worst case reserved until the day ends. A spent budget makes later batches fall back to owner-paid, or to "nothing
sent" when sponsorship is required. Size `FLOFI_SPONSOR_DAILY_BUDGET_WEI_<chainId>` as roughly (sponsored batches expected per day +
abandoned or refused signatures) × the per-operation cap. A new UTC day starts a new ledger.

Solana sponsor key, when wired later: **[OWNER]** generate it offline (`solana-keygen new --no-bip39-passphrase -o sponsor.json` on a trusted
machine), fund it with a small SOL float only, store it only as a Vercel Sensitive variable, never in Git or chat.

## 3. Verify (no real funds needed for 3.1–3.3)

1. `curl -sS -X OPTIONS https://<origin>/api/gas/paymaster/8453 -i` → `204` with `access-control-allow-origin: *`.
2. Disabled chain: `POST` to `/api/gas/paymaster/10` → `GAS_SPONSORSHIP_DISABLED` or `GAS_SPONSOR_CHAIN_UNEXPECTED`.
3. Without a grant: `POST {"jsonrpc":"2.0","id":1,"method":"pm_getPaymasterData","params":[{…},"0x0000000071727De22E5E9d8BAf0edAc6f37da032","0x2105",{}]}`
   → `GAS_SPONSOR_GRANT_REQUIRED` (nothing forwarded to the provider).
4. **[OWNER]** Live acceptance (real funds, explicit owner action): with a wallet that reports `paymasterService` on Base **for an EntryPoint v0.7 account**
   (note: Coinbase Smart Wallet uses EntryPoint v0.6, which this proxy refuses with `GAS_SPONSOR_ENTRY_POINT_UNEXPECTED`),
   run a 1-step Base swap from the Editor's Review whole workflow → the review shows "Network fee sponsored when your wallet
   supports it"; the wallet shows the fee as sponsored; after it lands the group shows "Gas paid by FloFi: …" and the explorer's
   `UserOperationEvent` names the pinned paymaster. Then repeat with a wallet without `paymasterService` → owner-paid, unchanged.

## 4. Monitoring

- `workflow_run.group_reconciled` with `gasSponsored: true`; sponsored spend per day in `execution_logs` names
  `gas-sponsor-eip155-<chainId>-<yyyymmdd>.jsonl` (RESERVE then SETTLE lines; a RESERVE without a SETTLE counts in full for its day. A
  RELEASE line written by an earlier build is still read but no longer frees anything).
- `GAS_SPONSOR_PAYMASTER_UNEXPECTED`, `GAS_SPONSOR_RECEIPT_MISMATCH`, `GAS_SPONSORSHIP_REFUSED` (a bundle paid by another paymaster) are
  security signals: investigate. `GAS_SPONSOR_BUDGET_EXHAUSTED` means the day's budget is spent (batches fall back to owner-paid).

## 5. Rollback

Unset `FLOFI_GAS_SPONSORSHIP` (or one chain's `FLOFI_PAYMASTER_RPC_<chainId>`) and redeploy: new preparations are owner-paid immediately. A
batch already prepared with a grant can still be sent sponsored until its 10-minute grant expires (the proxy then refuses it, and an optional
capability falls back to owner-paid in the wallet). Withdraw any remaining provider credit/deposit from the provider's dashboard **[OWNER]**.
