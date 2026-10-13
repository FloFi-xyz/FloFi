# BUILD-SOLANA-COMPOSITION-001 — Solana Devnet Swap → Orca liquidity composition (PR A)

Owner-approved on 2026-10-13 (PR A only), under [GOVERNANCE-LITE](../SCOPE_GUARD.md). Branch `claude/fix-solana-swap-orca` from main `2fd0ceb`.
One PR, never merged by the agent. PR B (context-aware Copilot authoring and position management) is approved for planning only and is not part of this build.

## Problem

The Canvas let users connect a Solana Devnet swap to an Orca Whirlpools position, but nothing executed it:

- a Canvas link between two financial steps wrote only an ordering dependency, with no typed asset binding;
- the linter routed any workflow with a Solana swap to the isolated swap validator (`SOLANA_SWAP_ISOLATED_ONLY`), and the compilers re-checked isolation;
- the canonical position reader had no room for a bound input;
- the capability resolver judged nodes one by one, so the Canvas presented the pair as executable while Simulate rejected it.

## Owner decisions

1. The swap-output liquidity cap defaults to 100% of the actual reconciled swap output; a pre-existing wallet balance of that token is never spent. The other pool token has an explicit maximum.
2. A 10% range means ±10% around the current verified pool price (PR B).
3. "Remaining tokens" resolve only from reconciled execution results (PR B).
4. Only FloFi-registered positions are managed.
5. Telegram, MCP, WhatsApp and Developer API integration are deferred.

## Design: existing engines, a thin coordinator

| Layer | Change |
| --- | --- |
| IR (`workflow-contracts`) | `bindConcentratedLiquidityNode` / `readConcentratedLiquiditySource`: one optional, last `amount{0,1}-source` `OUTPUT_REFERENCE` input plus one dependency. The strict reader is unchanged and rejects a bound node, so isolated runtimes never read one. Isolated nodes are byte-identical; no JSON schema change. |
| Registry (`action-registry`) | `COMPOSITION_BINDINGS` names each executable pair and its flow; registration grants no authority. `readBoundComposition` is the closed shape. Deterministic single-step projections: the producer unchanged; the consumer with the bound maximum set to `min(owner cap, reconciled output)`. The capability resolver reports any other multi-step Solana workflow as `COMPOSITION_UNSUPPORTED`. |
| Linter | A linked registered pair goes to `validateSolanaCompositionWorkflow`, which runs each projected step through the **unchanged** isolated validators. Unlinked or other Solana combinations keep `*_ISOLATED_ONLY`. Drafts may hold a valid bound pair beside other steps (authoring only). |
| Compiler | `simulateSolanaComposition`: the existing exact swap Review plus a read-only projection of the position at the swap's simulated post-trade price for the expected and minimum outputs, a preflight, and a frozen v1 chain (2-step plan with dependency, `propagatedOutputs`, `failurePaths`, cumulative spend limits, summed gas, `MODE_A`, `NOT_ENFORCED`). |
| Executor | `bound-composition.ts`: an append-only run on the frozen journal state machine; the phase is derived from the journal. |
| Reconciler | `buildSolanaCompositionEvidence` re-checks the binding from both reconciled step bundles and references them by hash; only a complete run has a composed bundle. |
| Server | `solana-composition-service.ts` composes the unchanged Orca swap and Orca liquidity services on their own storage (owner leases and the position registry stay shared with isolated runs); the cloud flow `solana-devnet-composition` declares `uses` and receives only those flows' storage in the same tenant. |
| App | The Canvas link creates the typed binding; unlink restores the isolated node; edits keep the binding. A `solana-composition` source drives the existing Simulate → Approve → Execute → Continue controls and the per-step execution timeline. |

## Owner actions, in order

1. Accept the composed Review (plan and exact swap Review).
2. Execute the swap (wallet signature).
3. Prepare the position with the received amount (read-only simulation with fresh pool state and a fresh position-mint key).
4. Accept the position Review.
5. Execute the position (wallet signature plus the browser-only position-mint key).

## Safety invariants

- The swap runs at most once per run; once it has an attempt it never starts again. A new run is refused while an earlier run's swap is done and its position is neither completed nor ended.
- The bound amount comes only from the swap run's reconciled observation; projected workflows are always derived on the server, never accepted from a client.
- After authorization, the position uses exactly the authorized workflow (range, caps, slippage). A changed workflow is refused, never re-centred; the owner may restore it or end the run keeping the swapped tokens.
- The preflight (no open FloFi position, initialized fixed-size tick arrays, non-zero position, SOL and devUSDC after the swap) is risk reduction only and blocks before the swap; it does not guarantee the position succeeds.
- Workers observe only steps with a signed transaction, never a prepared, unsigned one. Nothing in the coordinator signs, broadcasts or retries.
- MOCKED runs are never presented as authorizing simulations; MOCKED evidence is not DEVNET_EXECUTED.

## Out of scope

Copilot changes (PR B), MCP/Developer API/Telegram/WhatsApp exposure, mainnet, other protocols or pairs, positions not created by FloFi, tail re-authorization with changed parameters after the swap, automatic compensation or retries, and any public transaction by the agent.
