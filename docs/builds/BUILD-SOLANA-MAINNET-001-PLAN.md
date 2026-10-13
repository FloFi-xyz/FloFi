# BUILD-SOLANA-MAINNET-001 — Solana Mainnet, network consistency and Canvas UX corrections

Owner-approved scope (2026-10-13), under [GOVERNANCE-LITE](../SCOPE_GUARD.md). Base: main `61447b3` (PR #88 merged).
Two stacked PRs, never merged or deployed by the agent:

- **PR A** — `claude/build-solana-mainnet-001` → `main`: Solana Mainnet and Mainnet/Testnet consistency (requirements A and B).
- **PR B** — `claude/build-solana-mainnet-001-canvas-ux` → PR A: swap inversion, card deletion, empty initial Canvas (C, D, E).

Final certification runs on PR B's head, which is the integrated result.

## Discovery (what the code does today)

| # | Finding | Where |
| --- | --- | --- |
| F1 | Solana Mainnet **swap** exists end to end (Jupiter Swap V2 `/build`, BUILD-014: exact-message simulation, Review, owner-signed bytes only, reconciliation, recovery, `PUBLIC_EXECUTED` evidence) but the Canvas cannot reach it. A Solana wallet connects on Devnet by default, the header Environment control is **disabled** for Solana sessions, and the Swap card lists only networks of the wallet's environment. | `wallet-connection.ts` `connectionSolanaChain`, `top-bar.tsx`, `crypto-action-picker.ts` `cryptoNetworks` |
| F2 | Solana Mainnet **liquidity** does not exist: the Orca Whirlpools engine (compiler, executor, reconciler, service, store, panel) is bound to one Devnet profile. Read-only Mainnet reads (2026-10-13) show the Orca SOL/USDC 0.30% Whirlpool `HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ` (config `2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ`, tick spacing 64, SOL = token A, USDC = token B) with fixed 9,988-byte tick arrays for full-range and ±10% ranges — the layout the engine supports. | `orca-liquidity-devnet.ts` and every `ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as profile` import |
| F3 | An environment change re-networks **every** card to the first network of the new environment: a Solana Devnet card becomes a Base swap draft. The effect also re-runs when a saved workflow is opened. | `workflow-canvas.tsx` environment effect |
| F4 | The header Mainnet/Testnet switch always targets Base or Base Sepolia, whatever chain the EVM wallet is on. | `top-bar.tsx` |
| F5 | The Swap card's middle arrow is a decorative `aria-hidden` span. | `composer-card.tsx` `ValuePair` |
| F6 | Deletion refuses `node-001`, any ID that is not `node-NNN` (saved, Copilot, lending, BUILD-009 workflows), locked amounts, any step with a dependant, and the last step: `PROTECTED_NODE`. | `canvas-keyboard.ts`, `editor.ts` |
| F7 | On load, the public-swap store restores the last persisted Base/catalog swap run into the untouched Canvas after an asynchronous status read, so a Swap card appears after the first render on every later visit. The lending store does the same for its composition. | `public-testnet-store.tsx`, `lending-store.tsx` |

## PR A — Solana Mainnet and network consistency

1. **Solana environment selection.** The header Environment control works for a Solana session: Mainnet/Testnet asks the same owner-chosen
   Wallet Standard wallet for a session on `solana:mainnet` / `solana:devnet` (connect only; nothing is signed). The existing cluster checks
   stay: a session on another cluster is not the flow's owner, and execution refuses `*_WRONG_CLUSTER`.
2. **Family-preserving re-networking.** One pure function maps a step to its own network family's counterpart in the new environment
   (Base Sepolia ↔ Base, Solana Devnet ↔ Solana, Robinhood Chain Testnet ↔ Robinhood Chain) with explicit token counterparts
   (`devUSDC` ↔ `USDC`). It runs only on an environment transition, per step; a step with no counterpart is left unchanged and blocked
   ("Choose a network available for the connected wallet") instead of being moved to another chain. Opening a saved workflow never re-networks it.
3. **EVM header switch** targets the wallet chain's own counterpart when it is a wallet switch target (Base ↔ Base Sepolia,
   Robinhood Chain ↔ Robinhood Chain Testnet), else Base / Base Sepolia as today.
4. **Orca Whirlpools on Solana Mainnet (SOL/USDC 0.30%).** A Mainnet profile verified on-chain; the engine is parameterized by profile
   instead of copied. OPEN, DECREASE_PARTIAL and EXIT of FloFi-registered positions, with the same exact-message simulation, Review,
   browser-only position-mint key, owner signature, recovery and reconciliation. Evidence `PUBLIC_EXECUTED` (bundle `MAINNET_EXECUTED`)
   only for an owner-initiated, reconciled run. Deployment gates follow Jupiter's pattern: `GRYLOO_ORCA_MAINNET=live` (read-only
   Simulate/Review in the API) and `GRYLOO_ORCA_MAINNET_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` (owner execution). The Devnet
   Swap → position composition stays Devnet-only; a Mainnet Jupiter swap linked to a Mainnet position is reported as not executable.
5. **Certification.** Matrix unit tests over every supported chain/environment/action (RPC, chain, token addresses, program IDs, wallet
   target, re-networking, invalidation, save/reopen), browser specs on MOCKED loopback harnesses, and a read-only public verification of
   Solana Mainnet (genesis, Jupiter `/build` quote, exact-message `simulateTransaction`, Orca pool and tick arrays, open-position simulation)
   recorded as `PUBLIC_READ_ONLY`. No transaction is signed or sent by the agent.

## PR B — approved Canvas UX fixes

1. **Swap inversion.** The existing arrow becomes a button (same element, same look) on Swap cards only. It exchanges From/To on the same
   network, as a draft like any token change; the typed amount is now denominated in the new From token and re-validated against its
   decimals and bounds; the old estimate is dropped and the draft is re-quoted. The previous estimated output is never used as an amount.
   Same-token pairs are impossible by construction.
2. **Deletion.** Any action card can be deleted. Bound composition consumers return to their isolated form; ordering links are dropped; a
   dependant whose required value comes only from the deleted step's output cannot stand alone and is removed with it, with a visible
   message. One history entry (undo/redo restore it as a new revision). Deleting the last card leaves an empty Canvas; nothing replaces it.
   Each store already retires Review/authorization on a new revision; an in-flight transaction stays recorded and observable.
3. **Empty Canvas on Launch App.** Background recovery no longer writes a workflow into the Canvas. A recovered run stays observable in
   Execute and Dashboard with unchanged recovery semantics. Opening a saved workflow and the `/approve` handoff still restore explicitly.

## Owner decisions needed (implementation proceeds with the stated default)

- Inversion keeps the typed number in the new From token (default) rather than clearing it.
- Cascade-removal of dependants that cannot stand alone (default) rather than refusing the deletion.
- Orca Mainnet liquidity is limited to the one verified SOL/USDC 0.30% pool.

## Out of scope

Any public transaction by the agent, other Solana protocols or pairs, a Mainnet Swap → position composition, Ethereum Mainnet, MCP/Developer
API/channel exposure of new Mainnet operations, deployment configuration changes, and UI changes beyond the items above.
