# BUILD-ARB-001 — incremental plan

Baseline: `4df974f6ae6ae1d22b86f220db6281294cd20035` (BASE-001 / PR #81).
Branch: `codex/build-arb-001-network-ux`.
Inputs: [discovery and capability matrix](BUILD-ARB-001-DISCOVERY.md), [read verification](BUILD-ARB-001-READ-VERIFICATION.json),
[persistent handoff](BUILD-ARB-001-HANDOFF.md), BASE-001 shared architecture and existing Router.

The owner authorized and completed **Phase 1**, **Phase 2: Swap + Transfer runtime only**, **Phase 3: existing Router Bridge certification only**,
and **Phase 4: Arbitrum Pool / Liquidity runtime only**.
Phase 2 starts at `87f4a7a575ff10f5b8e7c05e56af4fa0bc335bce`. Every phase requires focused checks, an updated handoff and a commit.
Do not start later phases automatically. Full CI belongs at the end of BUILD-ARB-001; no PR or push in this checkpoint.

## Phase 1 — core architecture

- Register canonical `ARBITRUM_ONE` metadata and consume it in existing Router, pinned catalog, wallet table and network registry.
  Keep wallet switching behavior and existing routes unchanged.
- Extract Base's pure curated token-list parser into one chain-bound provider factory. Base preserves its interface and behavior.
  Register Arbitrum's profile over the same curated source, existing ETH/USDC/WETH pins and logo model; exclude the verified FLUX
  decimals mismatch by address. No testnet catalog changes and no arbitrary endpoint/token acceptance.
- Register verified protocol capability discovery with explicit runtime availability. Do not add executable capability rows,
  runtime profiles, canonical financial examples or Copilot capability lists for unbuilt actions.
- Reuse shared catalog registration, resolvers, name ambiguity, loader seams, vocabulary and presentation. Revalidate the actual
  canonical assets at registration; catalog discovery alone must not imply financial action support.
- Prove identity/chain binding, validation/exclusions, ambiguity, logos/fallback, metadata-free IR/hash, registry-derived capability
  wording, runtime refusals and Base/Robinhood continuity with focused unit tests and scoped typechecks.
- Persist evidence and exact resumption instructions; commit `BUILD-ARB-001 phase 1: register Arbitrum core architecture`.

Phase 1 deliberately leaves Arbitrum's live catalog loader unwired. Pure providers and loader seams are callable with server-validated
bytes, and tests use the FloFi-authored fixture. Existing pins/Router continue working without enabling other actions.

## Phase 2 — swap and transfer runtime (implemented, gates remain off)

- Extract Base's catalog runtime wiring into `createEvmCatalogRuntime`; Base keeps the same loader, URL, TTL, parser, gates, harness
  and public exports. The Arbitrum wrapper supplies canonical profile/parser metadata, without a new engine or harness gate.
- Register Arbitrum in the existing catalog runtime registry, shared loader entry points and backend flow factory. The normal shared
  authoring surfaces can load the curated catalog when the network deployment is enabled. No downloaded list is committed.
- Catalog trust remains Phase 1's model: the pinned Uniswap Labs Default Token List endpoint, chainId 42161 only, validated address/
  decimals, deterministic duplicate/ambiguous-symbol rejection, exact chain/address identity and validated HTTPS logo metadata.
  Native ETH retains FloFi's canonical native identity. Runtime token code and decimals must also match before financial use.
  Fresh source v22.26.0 has 204 Arbitrum entries: FLUX (listed 18, onchain 8) and 1INCH (existing symbol grammar) are excluded;
  the resulting catalog has **203 assets including native ETH**. Base's parser and testnet catalogs are unchanged.
- Add a **swap-only** Uniswap v3 deployment profile to the shared catalog swap engine. Fresh official deployment feed and public
  reads verify factory `0x1f98431c8ad98523631ae4a59f267346ea31f984`, SwapRouter02
  `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45`, QuoterV2 `0x61ffe014ba17989e743c5f6cb21bf9697530b21e`,
  runtime SHA-256 pins, factory/WETH relationships and standard fee tiers. Canonical CREATE2 pools, live liquidity and quotes determine
  the route; no usable route fails honestly. USDC/WETH and USDC/ARB authoring do not promise liquidity for every amount/pair.
- A generic profile option enables owner-bound swap Review: exact canonical assets, amount, minimum output/slippage, pool/tier/router,
  chain, owner, nonce, allowance/current approval step, exact calldata/value, gas ceiling, max fee, budget, deadline, quote state and
  workflow revision are committed to the Review hash. Owner Simulation is required before Review. Economic or authorization changes
  clear Review. Approval is exact-input only; after reconciliation, refresh and a new Review precede the swap. Router02's existing
  `multicall(uint256,bytes[])` enforces the reviewed swap deadline on chain. Direct ERC-20 approval itself has no onchain expiry.
- Reuse the native/token transfer compiler, manifests, executor, coordinator and reconciler. Arbitrum native ETH sends use empty
  calldata, recipient as target and value only. ERC-20 sends call the exact catalog contract's `transfer(recipient, amount)` with zero
  value and no approval. Existing deterministic amount conversion and recipient validation apply. Valid contract native recipients
  are supported through a profile option: recipient code hash is bound into Review, rechecked before handoff/inclusion, and the exact
  value-only call and owner debit are verified. Contract receive/fallback effects may occur; no recipient-retained-balance claim is made.
- Generalize the two remaining authoring maps from swap/transfer profiles and fix the picker builder's Base/Robinhood-only branch.
  Channels/MCP select the shared catalog network by registry identity. Capabilities/examples derive support wording from shared
  registries. No independent Copilot capability list, Arbitrum picker, Canvas or workflow engine is added.

### Nitro transaction fees

[Arbitrum's gas documentation](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees) and
[estimation guide](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas) describe parent posting cost as part of Nitro gas.
The existing standard EVM `eth_estimateGas`/`eth_gasPrice` path applies; **no Base OP Stack GasPriceOracle or separate `l1Fee` is used**.
Owner Simulation estimates the exact transaction, with 150% gas margin and 2× gas-price ceiling; Review binds the resulting budget.
Transfers and swaps re-estimate before submission/handoff and refuse any estimate above that ceiling. Swap quoter gas is not used
as the transaction fee estimate. Receipts reconcile `gasUsed × effectiveGasPrice`, checking offered and paid fee bounds.
Public read-only block **513943961** confirmed nonzero `gasUsedForL1`, no `l1Fee`, and an existing third-party receipt fee of
**1882584000000 wei**. This is an observation, not a FloFi execution. Facts, source URLs and hashes are in
[Phase 2 read verification](BUILD-ARB-001-PHASE-2-READ-VERIFICATION.json).

### Owner execution, durability and deployment

- Reuse Base's gate shape: `GRYLOO_ARBITRUM_MAINNET=live` for catalog/read simulation/Review, and additionally
  `GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` for owner execution. **Neither is set by this phase.** Router gates
  remain Router-specific. No Arbitrum harness bypass is added. Optional later configuration uses `GRYLOO_ARBITRUM_RPC_URL` (HTTPS)
  and `GRYLOO_ARBITRUM_JOURNAL` in local development; hosted deployments use the established cloud execution storage.
  These names are recorded here for later ENVIRONMENT.md work; no deployment configuration changes now.
- Existing connected-wallet controls sign and submit; server RPC methods are read-only. No custody, operator wallet, AI signing,
  delegated authority or new wallet allowlist. Catalog metadata/registration never grants execution permission.
- Swaps persist PREPARED before the wallet boundary, then HASH/PENDING/CONFIRMED or UNKNOWN/REJECTED/REVERTED and final
  reconciliation/divergence. Permanent owner/chain/nonce intents prevent another swap run from using an ambiguous nonce.
  Existing durable log/storage/lease APIs serve the backend workers. PREPARED/UNKNOWN without a returned hash recover by the
  shared nonce-discovery reader; a different transaction consuming the nonce is divergent. Workers never resend.
  Recovery audit also covered a receipt saved before balance reads finish: the worker continues observation until reconciliation,
  and refresh cannot advance an incomplete approval. Proven mismatches persist as divergence and cannot revive authority.
  A proven wallet rejection can reuse only the same run's identical reviewed transaction/nonce after fresh preflight; another run
  remains blocked by the permanent intent. The existing browser status-check handler reaches nonce discovery without a hash.
- Transfers retain PREPARED → SUBMITTING → PENDING or SUBMISSION_RESULT_UNKNOWN → RECONCILED/DIVERGENT, with the established
  permanent nonce lease and observation-only recovery. A restarted service can reconcile from durable state.
- Unit lifecycles produce **MOCKED** evidence only. No owner public execution, public certification or MAINNET_EXECUTED evidence is
  demonstrated. Swap receipt canonical inclusion and transfers' two-confirmation L2 inclusion follow the existing engines;
  L1 finality is not claimed. Fee estimates and 60-second Reviews are bounded observations, not future fee guarantees.
- All financial runtimes remain isolated actions under existing composition restrictions. No Bridge, Pool or Aave runtime is added.

### Focused authoring acceptance

Canvas builders, deterministic Chat, English/Portuguese Copilot intent handling and the actual MCP gateway compose identical IR.
Copilot tests use deterministic intent-provider responses; they do not claim a live model or browser acceptance run.
For workflow-local's standard authored graph (mock read node-001 plus node-002, revision 1), canonical hashes are:

| Request | Canonical identity / amount | Shared workflow hash |
| --- | --- | --- |
| Swap 10 USDC for WETH on Arbitrum / troca 10 USDC por WETH na Arbitrum | eip155:42161; USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831` (6), WETH `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` (18); 10000000 input units | `0xc99e88d5b6482d670b37468f84f2873df9d14aeb71c333947d2dba265423a9f4` |
| Send 5 USDC on Arbitrum to 0x3333333333333333333333333333333333333333 | Same chain/USDC contract; 5000000 units, explicit recipient | `0xed288b9e22d82e3a9d6dee559aa219ff4066804c78f9dae41c9d471fd7b792c9` |
| mande 0.01 ETH na Arbitrum para 0x3333333333333333333333333333333333333333 | Same chain; nativeId ETH (18); 10000000000000000 wei, explicit recipient | `0xb62adb7214d1abaa1d6bdae9779c9f505c78814ebedade05c2c6cc7c6db4ef49` |

Exact final focused commands/results and the resumption checkpoint are in the handoff. No full CI or browser/fork/PostgreSQL matrix
is run, and no PR, push, real-money transaction, UX or Production change is part of this phase.

## Phase 3 — existing Router Bridge certification (completed, gates remain off)

Continuation started at exact Phase 2 HEAD `861bb606dd073b3d83720cc8b1ee9cd254b9d063`; another session's seven modified files and two
new tests were preserved and audited. The handoff records that exact recovery state before further edits and the final commands/results.
BUILD-ROUTER-001 already supplied Base USDC → Arbitrum USDC; BUILD-BASE-001 supplied the reverse. No route, provider, bridge engine,
authoring channel, operator signer, wallet custody or deployment gate was added.

- Both chain/address/decimal-bound native USDC directions pass the shared quote → exact approval/deposit simulation → owner Review /
  Strategy Manifest → scripted owner-wallet submission → independent source/destination observation → reconciliation / Evidence lifecycle,
  with direct Across and LI.FI routing through Across. AUTO remains preference-order LI.FI then direct Across during discovery only;
  an explicit provider has no fallback. Review revalidation never switches provider/spender. Source submission is never delivery proof.
- Shared fixes bind gas-price ceilings, exact-call gas re-estimates and per-call OP Stack posting-fee bounds at preparation and handoff.
  Manifest/Policy/Quote gas budgets include the whole source fee bound. Direct receipt offered/paid gas, price, priority and nonce are
  verified. Bridge/provider USDC fees remain separate from source native ETH gas.
- Arbitrum One adds a narrow Nitro fee branch to the existing service: sequence simulation plus
  [NodeInterface posting-gas estimate](https://raw.githubusercontent.com/OffchainLabs/nitro-contracts/main/src/node-interface/NodeInterface.sol)
  builds a 150% gas ceiling even before approval exists. Standard exact-call `eth_estimateGas` rechecks total gas before preparation and
  handoff; the gas-price ceiling is 2× `eth_gasPrice`, with zero priority. Receipt cost stays `gasUsed × effectiveGasPrice` as in Phase 2.
  No OP Stack oracle or additional `l1Fee` applies to Arbitrum. Malformed/unavailable posting estimates fail closed.
- Durable source log discovery uses source timestamps and bounded, persisted scans of safe blocks, without Base's block interval or a
  4,000-block lifetime cap. Ambiguous submission remains reserved and cannot resend; expiry requires complete eligible-range scanning
  and a source safe head past the deadline. Destination scans advance through safe blocks; refund recovery keeps checking delayed fill
  proofs, with a durable `DESTINATION_OBSERVED` snapshot before final evidence reads. Wrong asset/recipient, duplicate fill or output
  outside reviewed bounds freezes the run as DIVERGENT; unrelated origin-chain proof remains pending. Reconciliation is idempotent.
- Four owner-supplied EN/PT requests pass Canvas builder, exact-original-text deterministic Chat, deterministic intent-provider Copilot
  and actual MCP gateway parity for 100 USDC. Shared Move and manda/traga grammar aliases retain existing canonical route checks and
  defaults. Copilot's natural-language engine is also exercised directly; existing model corpus checks retain their assertions using
  “Please move” text to avoid the new shortcut. Existing registries/examples/prompt paths are reused; no Arbitrum prompt/list is added.
- Final focused validation: **28 files / 610 Vitest tests**, changed-file lint, strict Router/core/authoring TypeScript, broader
  server-action source checking with `--skipLibCheck`, governance-lite + **19** self-tests and whitespace check pass. The broader
  unfiltered TypeScript graph retains the existing Next bundled declaration errors recorded in Phase 2; no repository configuration
  or dependency was changed to hide them. No full CI/browser/fork/PostgreSQL/live-model/mainnet execution is claimed.
- Existing `GRYLOO_ROUTER=live` and `GRYLOO_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` gates serve both directions and were not
  enabled/configured. Evidence is MOCKED only. UX changes, Production changes, real-money transactions, push, PR and Phase 4 work: none.

## Phase 4 — existing Uniswap v3 Pool / Liquidity runtime (completed, gates remain off)

Started from clean `ead7575819db7d5f1904db766cd093c10c68451e`; no other session's Phase 4 edits were present. The starting handoff
records the complete existing path before implementation. Reused `asset.liquidity.concentrated`, catalog CREATE2 resolution,
shared linter/compiler, sequential simulation, exact approvals, Review/Manifest commitments, owner-wallet submission, append-only
execution storage, nonce discovery, workers, NFT/receipt/amount reconciliation and Evidence. The canonical operation remains one
mint; no increase/withdraw engine, pool creation, native ETH wrapping, testnet expansion or Aave implementation was added.

### Verified deployment and pool policy

Fresh [official Uniswap Arbitrum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments)
and public read-only verification at Arbitrum block **513952674** bind the following to `eip155:42161`:

| Contract | Verified address |
| --- | --- |
| Factory | `0x1f98431c8ad98523631ae4a59f267346ea31f984` |
| Nonfungible Position Manager | `0xc36442b4a4522e871399cd717abdd847ab11fe88` |
| SwapRouter02 (existing Phase 2 swap profile) | `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45` |
| QuoterV2 (existing Phase 2 swap profile) | `0x61ffe014ba17989e743c5f6cb21bf9697530b21e` |

The liquidity runtime uses Factory, Position Manager and the pool; it does not route the mint through SwapRouter or Quoter.
Factory/NPM code hashes and factory/WETH relationships are pinned; wrong-chain responses fail closed. Full observations, deployment
feed hash, token identities, pool state and a successful zero-value `eth_simulateV1` **view-only** probe are in
[Phase 4 read verification](BUILD-ARB-001-PHASE-4-READ-VERIFICATION.json). This proves read-method availability, not a public owner mint.

- Only two verified catalog ERC-20 assets and an existing initialized pool of the verified factory are accepted. Pool code,
  factory `getPool`, pool factory/order/fee/spacing and token identity/decimals are checked before price reads or simulation.
  Missing pools and disabled/mismatched tiers are refused; no fallback pool or tier is authored/substituted.
- USDC/WETH, USDC/ARB and WETH/ARB existed at all four standard tiers in that observation. This is historical read evidence;
  each runtime request must establish existence again. Canonical asset identity is chain plus address, never symbol alone.
- Factory reads confirmed **100 → 1, 500 → 10, 3000 → 60, 10000 → 200** (fee units → tick spacing). Every selected tier is
  rechecked. Lower < upper, alignment and protocol bounds follow shared integer math; full ranges use the selected tier's
  usable endpoints, avoiding the inherited incompatible-range bug found during BUILD-BASE-001.
- Assets and amounts map by address to token0/token1 in either authored order. Arbitrum USDC/WETH has WETH as token0,
  so the compiler's canonical token0-per-token1 quote is WETH per USDC. Existing deterministic price/band conversion is tested
  in that orientation. Existing catalog authoring remains full/aligned tick ranges; no price/band UX or implicit native wrapping.

### Review, fees and durable owner execution

- Review binds chain, owner/NFT recipient, canonical tokens/amount bounds, verified pool/Factory/NPM/code, enabled fee/spacing,
  aligned ticks, pool state, minimum usage/liquidity, slippage, exact approvals/calls, zero value, expiry/deadline and fee ceilings.
  Exact approval amounts go only to the verified NPM. Changed identity, approval requirements, material range/amount state or
  over-bound fees clear authorization; neither pool nor fee tier can silently change after Review.
- Shared liquidity now preserves the reviewed gas/price envelope and rechecks exact-call estimates before PREPARED and wallet
  handoff. The browser also checks chain, owner, target, calldata, value, gas and price against Review. No operator signer,
  AI financial authority, new allowlist or cloud submission path exists.
- Extracted Phase 2's 150% gas margin and 2× price ceiling plus Phase 3's NodeInterface posting-gas reader into a shared helper.
  Swap and Router reuse it without policy changes. Liquidity combines sequence simulation and posting gas into a conservative
  Nitro ceiling before approvals exist, then rechecks total `eth_estimateGas`; zero priority, no Base OP Stack oracle or extra
  `l1Fee`. Reconciliation records receipt `gasUsed × effectiveGasPrice` and checks offered/paid bounds. Base retains its OP
  Stack oracle and now binds each call's separate L1 fee allowance instead of silently repricing at submission.
- Durable `arlp-` runs reuse PREPARED → SUBMITTING → PENDING/CONFIRMED, SUBMISSION_RESULT_UNKNOWN, CANCELLED/NOT_FOUND,
  REVERTED and RECONCILIATION_REQUIRED/DIVERGENT branches, then RECONCILED. Nonce discovery and permanent owner nonce leases
  prevent blind repeat mints after ambiguity. Restart, delayed receipts, RPC/evidence outages, position readback and repeated
  reconciliation are tested. Wrong chain/NPM/owner/pair/tier/range/amount/cost/spender freezes execution without success evidence.
  A MOCKED journal cannot be reloaded as PUBLIC_MAINNET. Workers remain observation-only.
- Register the existing `liquidityFlow`, server actions, browser run recovery and MCP mappings through the shared catalog profile.
  Canvas, deterministic Chat, EN/PT deterministic intent-provider Copilot and the actual MCP gateway converge on equal IR/hashes.
  The owner's incomplete representative sentences use existing clarification for deposit amounts/range; no Arbitrum prompt/list.
- Reuse **GRYLOO_ARBITRUM_MAINNET=live** and **GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED**. Both remain off;
  no variable was set and no liquidity-specific gate was introduced. All financial lifecycle tests/evidence are **MOCKED**.

Focused commands and results are recorded in the handoff. Scoped strict TypeScript, changed-file lint, governance-lite and
whitespace checks pass; the broader server-action graph retains the documented dependency declaration limitation and uses
`--skipLibCheck` for source checking. No full CI/browser/fork/PostgreSQL matrix, live model or public owner execution was run.
UX changes, Production changes, real-money transactions, push and PR: **NONE**. Phase 5 has not started.

## Recommended later phases — proposals only

1. **Phase 5: Aave native USDC reserve.** Add a one-reserve Arbitrum profile for id 12 after fresh deployment, reserve, cap, liquidity
   and ABI verification; test supply/borrow/repay/withdraw lifecycle. Do not infer multi-reserve or composition support.
2. **Final phase: end-to-end integration and full CI.** Confirm registry parity across all surfaces, existing Base/Robinhood behavior,
   execution gates, recovery/reconciliation and hash continuity; run the full required CI only here. Delivery/PR remains owner-directed.

The owner may reorder or narrow these phases and will supply any future UX changes explicitly.

## Invariants for every later phase

- A network/profile/catalog registration is not execution permission. The connected user signs their own transactions; no project
  wallet, private-key custody, autonomous AI signing, new allowlist or automated real-money transaction.
- No Production, Railway, Vercel, Neon or secret changes without a separate owner instruction.
- Reuse the existing Router. Do not create an Arbitrum Canvas/Copilot/asset picker/workflow path or another bridge engine.
- No UI redesign or new interaction model; only inherited generic presentation until the owner supplies UX instructions.
- Symbols and names are metadata. Validate chain/address/decimals and never infer a token or logo from a symbol across networks.
- Discovery evidence is PUBLIC_READ_ONLY; local tests are MOCKED. Neither proves owner execution or public certification.
- Update the handoff before each phase-ending commit. Do not repeat finished discovery/refactors without a concrete new reason.
