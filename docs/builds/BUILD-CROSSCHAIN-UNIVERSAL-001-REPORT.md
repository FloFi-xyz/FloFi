# BUILD-CROSSCHAIN-UNIVERSAL-001 — Report: Universal Cross-chain Router

Date: 2026-10-25. Branch `claude/build-crosschain-universal-001` from `main` `fbc683b` (PR #120). Plan:
[BUILD-CROSSCHAIN-UNIVERSAL-001-PLAN.md](BUILD-CROSSCHAIN-UNIVERSAL-001-PLAN.md). One build, one PR. No merge, deploy or
real-money transaction by the agent.

**Status: IMPLEMENTATION COMPLETE — READY FOR OWNER REVIEW.** Evidence: `MOCKED` (unit A–N, channel parity O, PostgreSQL
cloud flow, guarded browser profile `universal-bridge` 4/4). Read-only live 20-pair matrix script is available; it is not
counted as execution evidence. **No transaction was signed or sent by the agent on a public network.**

## What was built

Additive universal Cross-chain Router (`flofi.router.universal`) across Solana, Base, Arbitrum One, Ethereum and Robinhood
Chain. The certified per-pair Router (`flofi.router`) is unchanged.

| Layer | Change |
| --- | --- |
| Contracts | `universal-router-networks.ts`, `universal-router.ts` — five mainnets, assets, `flofi.universal-route.v1`, closed node construction |
| Relay codec | Dependency-free order hash, deposit encodings (EVM + Solana), Lighthouse-compatible signed-byte verification |
| Discovery | Relay / LI.FI / Mayan / Across asked together; each candidate classified honestly (`EXECUTABLE` · `LIVE_QUOTE` · …) |
| Service | Simulate → Review → Accept → begin (same-provider re-quote) → owner wallet → one broadcast (Solana) or wallet send (EVM) → observe → reconcile → MOCKED evidence |
| Surfaces | Chat grammar, Copilot, Canvas Bridge card (Solana in/out), MCP / Telegram / WhatsApp parity, engineering panel Accept/Execute |
| Browser | Guarded profile `universal-bridge` on loopback harness `127.0.0.1:8566` |

## Authorization and wallet security

- FloFi never signs. Source wallet signs every reviewed request; Solana: FloFi verifies signed bytes (exact message or verified Phantom Lighthouse guards) then broadcasts once.
- Canvas **Authorize in wallet** stays disabled for `MOCKED` provenance (same rule as other MOCKED profiles). Engineering Accept → Execute drives the diagnostic lifecycle.
- Per-attempt identity only (orderId / message / signature); no owner-wide lease. Duplicate clicks are observation-only.

## Fees (approved 0.1% workflow stance)

`main` has no FloFi fee ledger. This build does **not** invent one: Relay is called without `appFees`; order fees are refused;
Mayan referrer is unset; LI.FI's third-party fee is itemized as LI.FI's. UI copy: **FloFi fee: None on this bridge.** Provider
fees and the guaranteed minimum are shown at Review. Terminal outcomes (`RECONCILED` / `REFUNDED` / `FAILED` / `DIVERGENT`)
remain one-per-workflow for a future fee ledger. Owner decision on charging 0.1% remains open (plan §4).

## Browser profile evidence

Command: `node scripts/guarded-release-browser.mjs profile universal-bridge` with
`GRYLOO_UNIVERSAL_E2E=MOCKED_LOOPBACK_ONLY`, pinned Chromium headless-shell 1243 and Anvil 1.8.3.

| Journey | Result |
| --- | --- |
| Solana USDC → Base: routes, Review, one Solana signature, one FloFi broadcast, Base delivery, MOCKED evidence | PASS |
| Phantom + verified Lighthouse guards still signs once; FloFi broadcasts once | PASS |
| Canvas Bridge card offers Solana and applies a universal bridge | PASS |
| Chat Base → Solana receive SOL via Relay | PASS |

Artifact: `apps/reference-dapp/test-results/guarded-profile-universal-bridge.json` (`status: PASS`).

### Product rulings from browser debugging

1. **Disabled Canvas Authorize on MOCKED** — genuine product rule, not a bug. Tests use panel Accept → Execute.
2. **Provider label** — UI shows `Relay · relay-depository` (protocol), not the internal order kind `RELAY_V2`.
3. **`bridgePairLabel` with Solana** — genuine product bug: eager `routerNetworks()` threw and crashed the Canvas; fixed by resolving universal pairs first.
4. **MOCK_fill after Execute** — fill must target the *reviewed* `orderId`; begin re-quotes for revalidation so `quotes.at(-1)` is a different order.

## Scope honesty

- Executable: Relay Depository deposits on the five networks; certified Router USDC/USDG pairs remain on their own flow.
- Quoted only: LI.FI bridges FloFi cannot verify independently, Mayan (no verified builder), Across outside certified pairs — each with an explicit reason.
- Public mainnet execution requires explicit owner opt-in (`GRYLOO_UNIVERSAL_ROUTER=live` + `GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`) and the owner's own wallet.

## Validation run for this report

- `python3 scripts/governance_lite.py` + its unittest suite — pass
- Focused universal / canvas Vitest — 103 pass
- Guarded browser profile `universal-bridge` — 4/4 pass
- `pnpm check` — see PR checks / local run at delivery time
