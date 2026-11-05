# BUILD AAVE-V3-EXPANSION-001 — Full Market Catalog & Composable Lending

Status: **implemented, MOCKED/local evidence only.** No public transaction was sent by this build. Every mainnet
execution path below still requires the owner's explicit Review and wallet signature in the reviewed wallet flow, and
the deployment's existing owner-execution opt-in per network. Nothing here is a `MAINNET_EXECUTED` claim.

## 1. What changed

### Aave V3 market catalog (Ethereum 1, Base 8453, Arbitrum One 42161)

- `scripts/generate-aave-v3-reserves.mjs` regenerates `packages/action-registry/src/aave-v3-reserves.generated.ts` from the
  official Aave DAO address book (MIT) at one pinned commit (`b71495aeb9948348aac898787cc1de3ab4b408ae`). The files are parsed as
  text with strict patterns and never executed; `--check` (and `--from <dir>` for an offline copy) proves the committed module
  is exactly a fresh generation.
- `aave-v3-testnet.ts` builds one frozen profile per listed reserve: the market's verified market-level profile (Pool,
  PoolAddressesProvider, AaveOracle, pool implementation/revision pin where recorded, explorer, network-cost model) with that
  reserve's identity (reserve id, underlying, decimals, aToken, variable-debt token). The original verified native-USDC
  profiles are the **same objects** as before and stay first. Loading fails closed if the snapshot's Pool, provider, oracle,
  implementation or USDC identity differs from the verified profiles.
- Every non-USDC mainnet reserve is **owner-beneficiary only** and always checks its supply cap.
- A reserve is resolved by **chain + underlying address (+ decimals)** — `aaveReserveProfile(chain, asset, decimals)` and the
  compiler's `lendingProfile(chain, code, asset)`, which now requires the asset. A symbol is a display label and an authoring
  alias only: authoring resolves it within the named market, cross-checks it against the network's official catalog when
  loaded, and refuses any disagreement (e.g. Arbitrum `USDC` is native USDC, `USDC.e` is the bridged token).

| Market | Listed reserves | Supply | Borrow | Repay | Withdraw |
| --- | --- | --- | --- | --- | --- |
| Ethereum (Core) | 67 | 67 authorable | 67 authorable | 67 authorable | 67 authorable |
| Base | 15 | 15 authorable | 15 authorable | 15 authorable | 15 authorable |
| Arbitrum One | 20 | 20 authorable | 20 authorable | 20 authorable | 20 authorable |

"Authorable" means the reserve is registered and its calls compile. Whether it is **usable now** (active, not frozen or paused,
cap headroom, borrowing enabled, liquidity, oracle price, account state) is read live: by the reserve catalog for the pickers
and again, independently, at Simulate and before every wallet request. The live per-operation counts could not be measured
from this build environment (its network policy blocks the public mainnet RPC hosts), so none are claimed here.

### Lending engine (compiler, linter, reconcilers)

- Supply, Borrow, Repay and Withdraw compile, simulate, review and reconcile for any registered reserve (2–18 decimals).
- **Frozen reserves:** `readSupplyState` no longer rejects them; Supply and Borrow refuse a frozen reserve at Simulate, Review
  and every preflight, while Repay and Withdraw of it stay available (Aave semantics). Inactive or paused reserves accept nothing.
- **Approvals:** still the exact reviewed amount, never unlimited. A token whose `approve` returns no data (Ethereum USDT) is
  accepted only when the call does not revert; the exact allowance is then proven by the bounded override and again on chain.
- **Multi-reserve accounts:** a mainnet account that also uses other reserves of the market has each of them read at the same
  block (`getReserveAddressById`, `getReserveData`, oracle price, aToken and debt balances; at most 24), matched to its registered
  profile, and Aave's reported aggregates (collateral, debt, weighted LTV and liquidation threshold) must equal the independently
  recomputed ones. Single-reserve accounts keep the original exact checks unchanged.
- **Borrow** accepts any enabled collateral of the account (e.g. borrow WETH against USDC), refuses isolation-mode collateral,
  siloed-borrowing conflicts, E-Mode accounts, frozen/disabled reserves, borrow caps, missing liquidity, capacity overruns and a
  post-borrow health factor below FloFi's 2.0 minimum. The eth_call/estimateGas simulation on current state remains the final
  protocol check.
- **Repay/Withdraw** previews include the account's other debt and the collateral-weighted liquidation threshold of the
  remaining reserves; a reserve supplied without collateral can be withdrawn without changing the health factor. Amounts stay
  **partial only** (the existing engine policy); full/maximum Repay and Withdraw are not implemented.

### Live reserve discovery

`discoverAaveReserves(rpc, chain, account?)` reads the market's actual `Pool.getReservesList()` and, per reserve,
`getReserveData`, normalized income, supply/borrow usage, liquidity and oracle price (and, with an owner, wallet/aToken/debt
balances and account aggregates) at one block, batched through Multicall3 with a per-call fallback. Each listed reserve is
verified against its registered identity; reserves not in the registry are reported as `unlisted` and never offered. It is
exposed read-only as the `reserves` method of the Base/Arbitrum/Ethereum Aave flows (`supplyReserves` server action, 15 s cache
per owner) and powers the Supply/Borrow/Repay/Withdraw forms: options that cannot be used now are disabled with the reason;
balances, collateral eligibility, informational variable APY, borrowing capacity and health factor are shown when read.

### Swap USDC → WETH on Base → Supply WETH on Aave V3 Base

This is the existing sequence runtime, now reachable because WETH is a Base reserve:

1. Chat interprets both actions in one request (`ADD_SEQUENCE`, explicit composition or goal form).
2. The Editor links Supply after Swap (an ordering dependency; see auto-connect).
3. The Supply is **funded by** the swap: same chain + address + decimals; its amount at execution is
   `min(user cap, WETH the swap's reconciled record proves it delivered)` — never a quote, an estimate or other WETH already in
   the wallet. When the user gives no cap, FloFi asks once.
4. The Supply step is simulated only after the swap reconciled, re-authored with the bound amount and simulated/reviewed afresh
   as an ordinary one-action Supply (exact approval, then `supply`).
5. Completed steps are proven against the workflow (`validCompletions`); after a refresh or retry the runtime resumes at the
   first incomplete step and never re-executes the swap. If the Supply fails, the reconciled swap stays recorded and the Supply
   can be re-simulated; a changed swap ends that history instead of being reused.

Each step is its own owner-signed transaction (or approval + supply). No EOA signature is treated as authorizing a future
transaction.

### Auto-connect (Chat, Editor, MCP, channels)

All of these reach the one editor reducer, so they behave identically:

- A command that appends exactly one new financial step to a workflow that already has steps links it after the current last
  step in dependency order — an **ordering dependency**, the same persisted edge a Canvas connection creates. It never creates a
  resource edge or typed binding, never changes an existing link, and is skipped for fixed compositions or when the linked
  draft would not validate (the step is then added unlinked, as before).
- Deleting a middle step keeps the sequence ordered (A → B → C, delete B: A → C). Owners can still disconnect, reorder, branch
  and reconnect. Connecting an auto-linked registered composition pair (Solana Devnet swap → Orca position) upgrades the link to
  its typed binding exactly as before.
- New cards are placed after their producer by the existing layout (left to right, wrapping), so links are drawn immediately.
- Display readers decode a step's own declaration with pure ordering links set aside (`node-declaration.ts`); steps with typed
  output references are unchanged. The BUILD-003 swap linter accepts ordering-only dependencies (ports stay literal quantities).

### Chat / MCP / UI consistency

The capability truth (`lendingOffers`, `get_supported_assets`, the Copilot's "What FloFi supports" section) is derived from the
registry, so all surfaces list the same reserves. Copilot lending resolves the named reserve from the market itself (no longer
blocked when a token catalog is not loaded) and states no reserve counts it does not hold. EN and PT-BR strings were added.

## 2. Tests and evidence

- `packages/action-registry/test/aave-v3-markets.test.ts`: catalog counts, identity, uniqueness, exact-address resolution.
- `packages/reference-compiler/test/aave-multi-reserve.test.ts`: cross-asset borrow, decimals, isolation, siloed, E-Mode,
  aggregate mismatches, frozen/disabled/caps, repay with other debt, weighted-threshold withdraw, non-collateral withdraw.
- `packages/reference-compiler/test/aave-reserves.test.ts`: discovery with and without Multicall3, identity mismatch, unlisted
  reserves, caps, wrong chain.
- `apps/reference-dapp/src/server/aave-expansion-lending.test.ts`: MOCKED loopback Supply → Borrow → Repay → Withdraw of WETH
  and cbBTC on Base and WBTC on Arbitrum through the unchanged service, executor, reconcilers and evidence; frozen, paused,
  supply-cap and borrow-cap refusals.
- `apps/reference-dapp/src/domain/intelligence/swap-supply-composition.test.ts`: the Chat request, funding edge, binding to the
  reconciled swap output, revalidated Supply calls, preserved completed step, cap question, goal form.
- `apps/reference-dapp/src/domain/canvas-connections.test.ts`: auto-connect for 2–5 steps, persistence/hash, branch, edit,
  middle-step deletion, reorder.

Evidence level: **MOCKED / local** only. The loopback harness is not a public network and proves nothing about public
execution. Intentionally changed expectations of earlier tests (one reserve per network; steps added unlinked) are listed in the PR.

## 3. Known limitations

- No live mainnet read or execution was possible from this environment (public RPC hosts are blocked by its network policy).
- Repay and Withdraw remain partial-only; native ETH supply through the WETH gateway is not implemented (supply WETH instead).
- E-Mode accounts, isolation-mode collateral and siloed-borrowing combinations are refused rather than supported.
- Reserve ids/aTokens come from the pinned address book; a reserve the Pool later drops or re-lists fails closed until the
  snapshot is regenerated. Tokens whose allowance storage cannot be proven by the bounded override fail closed at Simulate.
- A funded Supply needs an explicit cap (FloFi asks); "all of the swap output" is not a separate mode.
- The Canvas card token list shows every registered reserve; live disabled states are shown in the lending forms.

## 4. Deployment

- **Neon migrations:** none (no schema change).
- **Vercel / Railway:** no new variables. The existing `GRYLOO_BASE_RPC_URL`, `GRYLOO_ARBITRUM_RPC_URL` and
  `GRYLOO_ETHEREUM_RPC_URL` overrides are recommended for the reserve catalog's batched reads; owner execution keeps each
  network's existing opt-in.

## 5. Mandatory manual mainnet acceptance (owner)

1. On the Vercel Preview, open the Base Supply form and confirm the reserve list and live status match the Aave app.
2. Supply a small amount of WETH on Base: Simulate, Review the exact approval and `supply` calls, sign in the wallet, and confirm
   the run reconciles (aToken delta) and the evidence bundle reads `MAINNET_EXECUTED / RECONCILED`.
3. Borrow a small non-USDC amount against existing collateral; confirm the health-factor preview and the reconciled debt delta.
4. Repay part of it and Withdraw part of the supplied WETH; confirm both reconcile.
5. In Chat: "Swap 5 USDC to WETH on Base and supply up to 0.01 of the resulting WETH on Aave". Execute the swap, confirm it
   reconciles, then confirm the Supply proposes exactly the delivered amount (capped), sign it, and confirm it reconciles.
6. Refresh between steps and confirm the swap is not offered again.
