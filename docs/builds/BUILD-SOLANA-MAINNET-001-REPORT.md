# BUILD-SOLANA-MAINNET-001 — Report

**Status: READY_FOR_OWNER_REVIEW. Not merged, not deployed. No transaction was signed or sent by the agent.**
Evidence: `PUBLIC_READ_ONLY` on Solana mainnet-beta (reads, quotes and simulations only) and MOCKED loopback for everything else.
No Solana mainnet swap or liquidity position has been executed with real funds, so Mainnet execution is **not certified**.
[Plan](BUILD-SOLANA-MAINNET-001-PLAN.md) · [read-only evidence](BUILD-SOLANA-MAINNET-001-READONLY.json).

| PR | Branch | Base | Head |
| --- | --- | --- | --- |
| A — Solana Mainnet and Mainnet/Testnet consistency (requirements A, B) | `claude/build-solana-mainnet-001` | `main` `61447b3` | `970959e` |
| B — swap inversion, card deletion, empty Canvas on Launch App (C, D, E) | `claude/build-solana-mainnet-001-canvas-ux` | PR A | this commit |

PR B's head is the integrated result; the final gates below ran on it.

## Before and after

| # | Before (`main` `61447b3`) | After | Proof |
| --- | --- | --- | --- |
| A | Jupiter Solana mainnet swaps existed but could not be reached. A Solana wallet connected on Devnet, and the header Mainnet/Testnet control was disabled for Solana sessions. Solana liquidity was Devnet-only. | The header control asks the same owner-chosen wallet for a `solana:mainnet` or `solana:devnet` session (connect only). Orca Whirlpools liquidity runs on mainnet-beta on the verified SOL/USDC 0.30% pool, through the same engine as Devnet. | `solana-mainnet-network.spec.ts`; `orca-mainnet-liquidity.test.ts` (compiler, reconciler); `orca-mainnet-liquidity-service.test.ts`; `solana-cloud.pg.test.ts`; read-only evidence |
| B | A Mainnet↔Testnet change moved **every** card to the first network of the new environment, so a Solana Devnet card became a Base swap. This also re-ran when a saved workflow was opened. The EVM header switch always targeted Base or Base Sepolia. | A step moves only on an environment transition, and only to its own family's counterpart: Solana Devnet ↔ Solana (devUSDC ↔ USDC), Base Sepolia ↔ Base, Robinhood Chain Testnet ↔ Robinhood Chain. Steps without a counterpart stay where they are, blocked. Saved and handed-off workflows are never re-networked. The EVM switch follows the wallet chain's counterpart. | `network-certification.test.ts` (64); `solana-mainnet-network.spec.ts` |
| A3 | The token picker's network choice already rebuilt the action on that network. However, the environment effect (row B) could then move it to an unrelated network, and no test covered every action and network. | The chosen network carries the whole action, with that network's own assets, chain and wallet target. It persists through environment changes within its family and through save/reopen. | `network-certification.test.ts` "selecting a network moves the whole action" (every matrix cell) |
| C | The Swap card arrow was a decorative `aria-hidden` span. | On Swap cards, the same arrow (same element and look) is a button that switches From and To on the same network. The typed amount is now spent in the new From token and re-validated against that token's decimals. The old estimate is dropped and the new direction is re-quoted. It is a draft: nothing is applied until the owner applies it. Stocks and Bridge cards keep the decorative arrow. | `swap-inversion.test.ts` (7); `canvas-corrections.spec.ts` (SOL/USDC → USDC/SOL) |
| D | `PROTECTED_NODE` refused deletion of the first card, of ids not shaped `node-NNN` (saved, Copilot, lending and BUILD-009 workflows), of locked amounts, of any step with a dependant, and of the last step. | Any action card can be deleted. Bound consumers go back to their isolated form, and ordering links are dropped. A dependant that cannot run without the deleted step is removed with it, and the Canvas names it ("Also removed 1 linked step…"). Each deletion is one undo/redo step. Deleting the last card leaves an empty Canvas, and nothing replaces it. | `canvas-deletion.test.ts` (8); `canvas-corrections.spec.ts`; `canvas-keyboard.spec.ts`; editor, workflow-edits and copilot-eval updates |
| E | On every later visit, the public-swap and lending stores restored the last persisted run's workflow into the Canvas after an asynchronous status read. A Swap card appeared after the first render. | Launch App starts with an empty Canvas, and nothing adds a card later (not time, a wallet connection or a network change). A run is restored into the Canvas only if it still needs the owner (prepared, sent, pending, uncertain or confirmed without a settled outcome) or if it belongs to this tab (a reload). Finished runs stay in the Dashboard. Opening a saved workflow and the `/approve` handoff still restore explicitly. | `canvas-corrections.spec.ts`; `execution-continuity.spec.ts` (new-visit cases) |

## Mainnet/Testnet certification matrix

What this build certifies is that **network selection is consistent**. For every supported action, environment and network, the network
resolves to the right chain id, RPC/genesis, token addresses, program or contract identities and wallet target. Changing the environment
moves a step only within its own family, and save/reopen preserves every step. The proof is unit tests over the full matrix
(`network-certification.test.ts`) and browser specs on loopback harnesses. Execution evidence is a separate column, and only the Solana rows
changed in this build.

| Action | Testnet networks | Mainnet networks |
| --- | --- | --- |
| Swap | Base Sepolia, Ethereum Sepolia, Solana Devnet | Base, **Solana**, Robinhood Chain, Arbitrum One |
| Liquidity (pool) | Base Sepolia, Ethereum Sepolia, Solana Devnet | Base, **Solana** (new: Orca SOL/USDC 0.30%), Robinhood Chain, Arbitrum One |
| Transfer | Robinhood Chain Testnet, Ethereum Sepolia | Robinhood Chain, Base, Arbitrum One |
| Supply / Borrow / Repay / Withdraw | Base Sepolia, Ethereum Sepolia | Base, Arbitrum One |

| Family re-networking (environment change) | Result |
| --- | --- |
| Solana Devnet ↔ Solana | moves; devUSDC ↔ USDC, SOL ↔ SOL; Orca pool ↔ Orca pool |
| Base Sepolia ↔ Base | moves, same symbols |
| Robinhood Chain Testnet ↔ Robinhood Chain | moves (transfer) |
| Arbitrum One, Ethereum Sepolia, Solana USDT, Ethereum Sepolia WBTC supply, Base ETH transfer | **stays**, blocked with "Choose a network available for the connected wallet"; never moved to another chain |

| Network and action | Implemented | Verified here | Evidence level |
| --- | --- | --- | --- |
| Solana mainnet-beta: Jupiter swap | yes (BUILD-014), now reachable | real `/build` route for 1 USDC → SOL compiled into the exact FloFi message and simulated; the Review guard passes | `PUBLIC_READ_ONLY`; **no execution** |
| Solana mainnet-beta: Orca liquidity OPEN / DECREASE_PARTIAL / EXIT | yes (new) | pool, config, mints, vaults, fee, tick spacing and reward emission verified on-chain; the exact OPEN simulates a deposit equal to FloFi's math; open → increase → decrease → collect → close succeed in one simulation | `PUBLIC_READ_ONLY`; **no execution** |
| Solana Devnet: Orca swap and liquidity, Swap → position composition | unchanged | regression suites and browser profiles | MOCKED; no new public evidence |
| Base, Robinhood Chain, Arbitrum One (mainnet); Base Sepolia, Ethereum Sepolia, Robinhood Chain Testnet | unchanged | selection, identities and re-networking only | as recorded by their own builds; nothing new |

## Environment variables

None are set by this build. None are secrets except the optional provider keys.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GRYLOO_ORCA_MAINNET=live` | **new**: Orca mainnet liquidity Simulate/Review in the API (flow `orca-liquidity-mainnet`) | off |
| `GRYLOO_ORCA_MAINNET_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` | **new**: real-funds owner execution for Orca mainnet. **Only by explicit owner decision.** | off |
| `GRYLOO_ORCA_MAINNET_JOURNAL` | **new**: storage for embedded/in-process mode only | — |
| `GRYLOO_JUPITER=live`, `GRYLOO_JUPITER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` | existing: Jupiter mainnet Simulate/Review, and owner execution | off |
| `GRYLOO_SOLANA_RPC_URL` | existing, now shared by Jupiter and Orca mainnet; a keyed provider is recommended (the public endpoint rate-limits) | `https://api.mainnet-beta.solana.com` |
| `JUPITER_API_KEY` | existing, optional provider quota | — |

Test-only: `GRYLOO_ORCA_MAINNET_HARNESS` (loopback harness for browser specs).

## Intentional safety and test changes (owner review)

1. **Reward rule (Orca).** A pool is refused only if one of its reward slots *emits* (`emissions_per_second_x64 ≠ 0`). It used to be refused
   if any reward slot was merely initialized. The mainnet pool's ORCA slot emits zero, and this is re-read on every simulation. Positions with
   any reward owed still fail closed.
2. **Canvas-only Mainnet liquidity.** Copilot and MCP do not author Solana mainnet pools yet (`authoring-capabilities.test.ts`).
3. **Deletion.** `PROTECTED_NODE` authoring restrictions are removed. The only node that can't be deleted is the hidden starting template
   (`FIRST_STEP_PROTECTED`). It is not an action card, and it is what "empty Canvas" means. Execution integrity is unchanged: each store
   retires Review and authorization on a new revision, and an in-flight transaction stays recorded and observable. Copilot corpus cases R24,
   R25 and R37 now expect `REMOVE` proposals instead of refusals. The Copilot description of a composition-step removal no longer throws.
4. **Restoring a run on load.** Restore happens only for a run that is in progress or belongs to the same tab (see E). This narrows the
   plan's wording ("background recovery no longer writes a workflow into the Canvas") so that an owner who closes a tab mid-transaction can
   still continue. Recovery semantics are unchanged.
5. **Test updates.** `wallet-environment.spec.ts` now expects the Solana-session Environment control to be enabled. `canvas-keyboard.spec.ts`,
   `canvas-ux.spec.ts` and the shared fixture `openFirstActionSettings` select a card by its title, because the centre of a Swap card is now the
   arrow button. `execution-continuity.spec.ts` gained new-visit
   cases. Exhaustive lists were updated (flows, owner-execution switches, pool networks). No assertion was weakened, and no test was skipped.

## Validation (integrated head)

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | PASS: 366 test files, 4,215 tests; 2 opt-in skips (not counted as passes) |
| `pnpm test:postgres` (loopback PostgreSQL 18.6) | 345 of 346 pass. 1 failure is **date-triggered and unrelated**: `automations/remote.pg.test.ts` creates an occurrence at the fixed slot 2026-10-12T08:00:40Z (24 h TTL), but the API's claim policy (`automationClaimPolicy` in `approval.ts`) reads the wall clock. From 2026-10-13T08:00Z every branch, `main` included, fails with `AUTOMATION_OCCURRENCE_NOT_OPEN`. With the wall clock shifted to 07:00Z, the same file passes 5/5. This build does not touch the automations code, so the test is left unchanged and the fix is for the owner to schedule. PR A's run (before 08:00Z) passed in full. |
| `python3 scripts/governance_lite.py` and self-tests; `git diff --check` | PASS |
| Guarded product browser profiles (the 33 profiles of `scripts/guarded-release-browser.mjs product`) | PASS: 33/33 profiles, 269 tests, none skipped. In the first run, `default-product` failed 4 tests that clicked a Swap card's centre (now the arrow). Those specs were changed to click the title, and `default-product` (82) and `execution-continuity` (9) then passed on a fresh build. |
| CI browser steps after the profiles (`mcp-route-presentation`, `developer-journey`, `mcp-in-chat`, `channel-signing`, WhatsApp/Telegram approve) | PASS: 11, 1, 21, 6 and 2 tests |
| New CI browser profiles `solana-mainnet-network` (2), `canvas-corrections` (5) | PASS (included above) |
| Not run locally | the `composition` fork phase (BUILD-007 EVM composition; untouched) and dependency-pin verification (no dependency changed) |

The self-hosted CI runner was offline throughout this build, so no GitHub Actions job has run on either PR. The local gates above are the
evidence until it is restarted.

## Not verified — needs the owner

- **Mainnet execution.** No owner-signed Jupiter swap or Orca position exists on mainnet-beta. Certification as `PUBLIC_EXECUTED`
  (bundle `MAINNET_EXECUTED`) needs four things:
  1. an explicit owner decision and an agreed spending limit;
  2. the deployment gates;
  3. the owner signing in the reviewed wallet flow;
  4. an independently reconciled, separately documented result.
- **Wallet behaviour.** The Solana header switch was exercised with the MOCKED Wallet Standard wallet. Real wallets (Phantom, Solflare,
  Backpack) differ in how they grant a `solana:mainnet` session after a Devnet one. This needs a manual check with each wallet the owner
  supports.
- **RPC capacity.** The public mainnet-beta RPC rate-limited during read-only verification, so production needs a keyed `GRYLOO_SOLANA_RPC_URL`.

## Out of scope (unchanged)

- Other Solana pools, pairs or protocols, and a Mainnet Swap → position composition (it is reported as not executable).
- Ethereum Mainnet; MCP, Developer API and channel exposure of the new Mainnet operations.
- Deployment configuration.
- A pre-existing stale assertion in `wallet-environment.spec.ts` (the EVM Bridge source list predates BUILD-RH-002 and BUILD-BASE-001; the
  spec is in no CI profile).
