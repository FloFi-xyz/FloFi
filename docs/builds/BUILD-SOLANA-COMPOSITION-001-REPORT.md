# BUILD-SOLANA-COMPOSITION-001 — Report (PR A)

**Status: READY FOR OWNER REVIEW. Evidence: MOCKED (loopback) only. No public transaction was signed or sent.**
Branch `claude/fix-solana-swap-orca` from `origin/main` `2fd0ceb`. [Plan](BUILD-SOLANA-COMPOSITION-001-PLAN.md).

## What changed

A Canvas link from a Solana Devnet Orca swap to an Orca Whirlpools position is a typed binding that executes as two separately reviewed and signed transactions on the existing isolated engines. The swap runs at most once. The position is prepared after the swap reconciles, with the verified received amount (`min(owner cap, reconciled output)`) and fresh pool state, and the owner reviews it again before signing.

| Area | Files |
| --- | --- |
| IR binding | `packages/workflow-contracts/src/liquidity.ts` |
| Registry, projections, capability truth | `packages/action-registry/src/composition-bindings.ts`, `execution-capabilities.ts` |
| Linter | `packages/reference-linter/src/solana-composition.ts`, `validation.ts`, `workflow-draft.ts` |
| Composed Review and artifacts | `packages/reference-compiler/src/solana-composition.ts` |
| Durable run | `packages/reference-executor/src/bound-composition.ts` |
| Composed evidence | `packages/reference-reconciler/src/solana-composition.ts` |
| Coordinator, local action, cloud flow | `apps/reference-dapp/src/server/solana-composition-service.ts`, `src/app/solana-composition-action.ts`, `backend/flows.ts`, `backend/app.ts` |
| Canvas and product UI | `src/domain/editor.ts`, `canvas-keyboard.ts`, `solana-liquidity-authoring.ts`, `composer-presentation.ts`, `simulation-presentation.ts`, `execution-*.ts`; `src/state/solana-composition-store.tsx`, `review-authorization.ts`, `execution-start.ts`, `execution-lifecycle.ts`; `src/components/solana-composition-panel.tsx`, `app-shell.tsx` |

## Intentional behaviour changes (for owner review)

1. **Capability truth is stricter for Solana.** A workflow with more than one financial step that involves Solana is reported as `COMPOSITION_UNSUPPORTED` (not executable) unless it is exactly a registered bound composition. Previously the Canvas showed such pairs as executable and Simulate rejected them. EVM multi-step behaviour is unchanged.
2. **Canvas link semantics for one registered pair.** Linking a Solana Devnet Orca swap's output to an Orca position's input now creates the typed binding (`amount{0,1}-source` input plus resource edge) instead of a bare dependency. Unlinking restores the byte-identical isolated position. Every other link is unchanged.
3. **Draft validation.** A draft may hold a valid registered bound pair beside other steps (each still checked on its own). A typed link that is not a complete valid composition is still refused, as before.
4. **Linter routing.** A linked registered pair goes to the composition validator, whose errors use `COMPOSITION_*` codes. Unlinked or other Solana combinations keep `*_ISOLATED_ONLY`. The isolated swap and liquidity runtimes themselves still refuse the composed workflow.
5. **Cloud flow API.** `FlowDefinition` gains an optional `uses` list. The backend hands a composed flow only those flows' storage, in the same tenant. `create` takes an optional third argument; existing flows and callers are unchanged.
6. **Shared test fixtures.** The scripted Solana test wallet gained a `rejectAfter` option. Four state-hook suites gained an idle mock for the new store. The entrypoint test, the locale catalog and the MCP execution-switch list include the new flow and strings. No assertion was weakened.

## Safety properties and where they are proven

| Property | Proof |
| --- | --- |
| Isolated engines unchanged and still closed to composed workflows | `solana-composition-service.test.ts` (`keeps the isolated runtimes closed…`), linter tests, contract test (strict reader rejects bound node) |
| Isolated IR and hashes unchanged | `workflow-contracts/test/liquidity.test.ts` (byte-identical round trip, same hash), full unit suite |
| Swap never repeated; position failures keep the swap | service tests (declined and reverted positions), executor tests, browser spec (declined position, reload, end) |
| Bound amount = min(cap, actual reconciled output), never a pre-existing balance | service tests (100%, capped, on-chain output above quote), compiler tests, evidence checks |
| No silent re-centring or parameter change after authorization | service test (`never re-centres…`), store/server workflow equality check |
| Preflight blocks before the swap (risk reduction only) | compiler and service tests, browser spec |
| Restarts, lost relay responses, worker reconciliation, tenant isolation | service restart test; `solana-composition-cloud.pg.test.ts` |
| Workers never observe a prepared, unsigned step | executor predicate; cloud test (worker drains while the swap is PREPARED) |
| MOCKED never authorizes in the product Review | `release-financial-provenance.spec.ts` profile `solana-composition` |

## Validation

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | PASS: 357 test files, 4,075 tests; 2 pre-existing skips |
| `pnpm test:postgres` (loopback PostgreSQL 18.6, CI-pinned image) | PASS: 55 files, 345 tests (includes migration suites: no migration needed) |
| `python3 scripts/governance_lite.py` + self-tests + CI-optimization tests | PASS (19 + 22 tests); `git diff --check` clean |
| New CI browser profile `solana-composition-provenance` | PASS |
| New diagnostic browser spec `solana-swap-liquidity-composition.spec.ts` (3 tests, not a release gate, like the other financial diagnostic specs) | PASS |
| `node scripts/guarded-release-browser.mjs product` | See the PR description for the final local result |

Not run locally: the `composition` fork phase (BUILD-007 Mode B EVM composition; untouched by this build), the dependency-pin verification (no dependency changed), and any public Devnet step.

## Limitations and remaining risks

- **Evidence level.** Everything here is MOCKED (loopback). A public Devnet run needs the owner to execute both steps in their own wallet. Only then can the evidence be `DEVNET_EXECUTED`.
- **Same pool.** The swap moves the pool price before the position step. The fresh position Review shows the actual range state; nothing is re-centred.
- **Fixed parameters after authorization.** If the owner wants a different range after the swap, they end the run (keeping the tokens) and author a separate position. Tail re-authorization with changed parameters is not implemented.
- **Projection, not simulation.** Root-review position amounts are projected from the simulated swap. The exact position transaction is simulated only after the swap reconciles.
- **Spend limit display.** The composed Manifest's limit for the swapped token is the owner's cap (for "100%", the Devnet token maximum). The binding to the actual swap output is enforced by the runtime and re-checked in the evidence. The composed policy enforcement remains `NOT_ENFORCED`, as for every Mode A flow.
- **Run ownership in cloud.** Like the two Solana Devnet flows it composes, the composition flow relies on tenant-scoped storage and unguessable run IDs: wallet-session principals are EVM-only. Clients never address the step runs through the composition.
- **Canvas card inputs.** For "100% of the swap output", the inline pool-card input shows the raw cap (the Devnet token maximum). The card summary, the panel and the Review state the binding.
- **Dashboard detail.** Composition runs appear in run history. The detailed dashboard projection is not mapped for them yet.
- **Deferred integrations.** MCP, Developer API, Telegram and WhatsApp do not plan or expose the composition (owner decision 5). The MCP execution-switch list includes the flow only as a registry fact.
