# BUILD-ARB-001 — Arbitrum One network integration report

Checkpoint: **Phase 6 COMPLETE**, 2026-10-12. **BUILD-ARB-001 is not final**.
Owner-defined UX work and final integration/full CI remain separately authorized phases.
Branch: `codex/build-arb-001-network-ux`; Phase 6 starts at `c82722ed5c57bd5fadf4d001ba81a89283233cef`.
The Phase 6 commit containing this report is the current checkpoint; see the [handoff](BUILD-ARB-001-HANDOFF.md).

## Architecture

Network Registry + chain-bound Asset Registry + Capability Registry / canonical examples
→ shared canonical authoring → SemanticWorkflow IR → existing Simulate / Review / owner-wallet lifecycle.

Canvas builders, deterministic Chat, V2 natural-language Copilot and actual MCP `compose_strategy` use this path.
The model interprets language; deterministic registry resolution decides support, identities, amounts and proposals.
The owner applies an authoring proposal separately from financial Review and wallet approval.
No Arbitrum-specific authoring product, financial engine or Copilot support list was created.

Phases 1–5 supplied the network/catalog profiles, Swap/Transfer, existing Router routes, Uniswap liquidity mint and Aave profile.
Phase 6 narrowly aligns whole-name/symbol resolution, generates engine network/route labels from registries, completes MCP asset
catalog discovery, tightens ARB/chain-name grounding and prevents full/max lending or explicit unsupported fees becoming defaults.
Existing support text additionally describes the existing partial-only Aave amount policy from shared registry metadata.

## Capability certification matrix

Each row independently covers the shared execution registry, Canvas reducer/builder, exact Chat, direct natural intent engine,
actual MCP gateway, stable identities/IR/hash and the normal product Copilot applied to Canvas. Tests are MOCKED.

| Capability | Registry | Canvas | Chat | Copilot EN/PT | MCP compose | Stable IR/hash |
| --- | --- | --- | --- | --- | --- | --- |
| Swap | PASS | PASS | PASS | PASS | PASS | PASS |
| Native ETH Transfer | PASS | PASS | PASS | PASS | PASS | PASS |
| ERC-20 Transfer | PASS | PASS | PASS | PASS | PASS | PASS |
| Bridge Base → Arbitrum | PASS | PASS | PASS | PASS | PASS | PASS |
| Bridge Arbitrum → Base | PASS | PASS | PASS | PASS | PASS | PASS |
| Pool / Liquidity | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Supply | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Borrow | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Repay | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Withdraw | PASS | PASS | PASS | PASS | PASS | PASS |

- Swap: catalog ERC-20s through the existing Uniswap path; quotes and real pool availability still require fresh reads.
- Transfer: native ETH or a validated catalog ERC-20; explicit recipient or connected owner, with no new recipient control.
- Both certified Router directions: native Circle USDC only. Other established Router routes are retained, without new certification claims.
- Liquidity: one existing initialized Uniswap v3 pool/mint at a registered fee tier; no pool creation or new liquidity operation.
- Aave: native USDC only, variable debt mode 2, ordinary one-reserve accounts; bounded partial Repay/Withdraw.
  Existing deterministic health-factor minimum 2.0, state freshness, allowances, fee bounds and recovery remain authoritative.
  Phase 6 adds no risk calculation, reserve, approval policy, execution path or signing authority.

## Network, assets and unsupported variants

Arbitrum / Arbitrum One / explicit “ARB network” or “ARB rede” → `eip155:42161`.
Arbitrum Sepolia and Sepolia wording never become mainnet, even when a model guesses ARBITRUM.
ARB in asset context supplies no network. A network alias cannot ground an ARB token the user did not request;
a token named “Arbitrum” needs asset context and an independently named network.

All four surfaces resolve case-insensitive symbols and unambiguous whole catalog names through the same chain-local resolver.
Tests include USDC / USD Coin, WETH / Wrapped Ether, ARB / Arbitrum and WBTC / Wrapped BTC, decimals and exact identities.
Chat and MCP accept bounded whole catalog references and normalize them before canonical authoring; structured network IDs stay closed.
Canvas uses its existing catalog search/selection. Ambiguous names ask in Copilot and refuse composition elsewhere.
Base USDC cannot become Arbitrum USDC. Foreign tokens, excluded FLUX and unavailable listed assets fail closed.
MCP asset discovery now reads the loaded catalog rather than a separate pinned-only support list; without a source, only pinned assets
remain. Native ETH has a null contract address and Transfer membership only. Catalog membership grants no bridge/lending eligibility.

Refusal certification: native ETH/WETH/ARB/USDC.e on the Base ⇄ Arbitrum bridge; additional Aave reserves; full/max/all
Repay/Withdraw; mainnet lending composition; unsupported tiers and duplicate references to one pool asset.
Incomplete EN/PT liquidity requests ask for deposit amounts. The model cannot drop an explicit unsupported fee and substitute the default.
A missing pool is refused by the existing read preflight before simulation/Review/wallet calls; a pure authored CREATE2 address
cannot prove live pool existence. No unsupported pool/tier is substituted.
Normal product refusals use existing deterministic explanatory copy, without internal error-code text.

## Semantic and historical hash continuity

With the same initial workflow identity, Canvas / Chat / direct Copilot / actual MCP produce equal complete IR and raw workflow hashes
for all ten capabilities. Authoring source, interpretation notes and logos enter no financial semantic field.

**Product workspace exception:** `/app` creates a durable workspace UUID; standalone MCP composition uses `workflow-local`.
`workflowId` participates in the canonical hash and Review identity. These raw hashes correctly differ.
Browser tests preserve the UUID read before the proposal, compare every financial node/edge/revision/schema field, and verify the
complete hash with that same workspace identity. No production hash algorithm or identity is normalized away for the test.
Dynamic quotes were not compared or manufactured: this phase certifies the authoring layer before live quoting.

The frozen [baseline vectors](../../apps/reference-dapp/src/domain/arbitrum-hash-baseline.fixture.json) were independently computed
from archived Base HEAD `4df974f6ae6ae1d22b86f220db6281294cd20035`, with its own archived workflow-contracts, action-registry,
reference-linter and reference-compiler rebuilt under `/tmp`; only installed locked third-party dependencies were reused.
**All 33 historical canonical examples and seven additional Robinhood Stock Token scenarios retain their hashes (40 vectors).**
The published Base reference swap hash remains `0x747634a76aa445ec993325bbb638f4d5b5103d59267314b54d30db1bc79e3d49`.
No previously registered example was removed or changed.

## Normal Copilot / Canvas acceptance

One scoped Chromium 1243 spec on normal `/app`, production compiled code, committed V2 replay and a passive wallet:
**18 passed / 0 failed / 0 skipped**. No server action was substituted.

- All ten English capability requests (“Please …”) produce a visible AI-labelled canonical proposal, preserve revision 0 until Apply,
  then put the exact financial meaning in Canvas. Asset badges show the existing Arbitrum identity.
- Portuguese: “Por favor, troca 10 USDC por WETH na Arbitrum”; “Por favor, mande 0.01 ETH na Arbitrum para 0x333…333”;
  “Por favor, quero colocar 100 USDC no Aave da Arbitrum”. Each reaches the same Canvas financial meaning.
- Unsupported Aave WETH, full Repay, incomplete liquidity and unsupported 0.02% fee leave no proposal and revision 0.
- The existing generic network picker offers Arbitrum One, its USDC/WETH shortcuts and reviewed local network mark.
- Wallet methods are account/chain reads only. Browser network guard is clean; provider logos use closed local replay.

Replay proves the normal product interpretation/proposal/apply boundary deterministically. No live-model quality or real-funds execution
is claimed. Existing cosmetic liquidity-provider preview buttons do not author a different protocol; no component/layout/control was edited.

## Evidence, fees and deployment gates

Financial certification/regressions: **MOCKED**. Existing public deployment proofs remain **PUBLIC_READ_ONLY**;
no new mainnet reads or MAINNET_EXECUTED evidence in Phase 6. Prior deployments/reserve observations are in the discovery/handoff
and Phase 4/5 read proofs; runtime still verifies current identity/state before Review.

Reuse the established Nitro fee abstraction from Phases 2–5. No Base OP Stack fee assumptions or new fee policy.
Durable owner-wallet execution, reconciliation, nonce reservation and observation-only ambiguous recovery are retained.
MCP composition is supported; MCP itself cannot execute. Transfer simulation requires the owner browser; cloud preview/deployment/policy
availability remains separate from authoring support and is reported as such.

| Gate | Required opt-in | Phase 6 state |
| --- | --- | --- |
| `GRYLOO_ARBITRUM_MAINNET` | `live` | OFF / not set by this build |
| `GRYLOO_ARBITRUM_OWNER_EXECUTION` | `MAINNET_OWNER_APPROVED` | OFF / not set by this build |
| `GRYLOO_ROUTER` | `live` | OFF / not set by this build |
| `GRYLOO_ROUTER_OWNER_EXECUTION` | `MAINNET_OWNER_APPROVED` | OFF / not set by this build |

No Production/service/secret configuration, push, PR, real-money transaction, operator signer or custody change.

## Focused validation and remaining work

**36 distinct Vitest files / 965 passed tests, no skips**, including the 105-test certification suite; 18 scoped browser cases;
strict pure authoring TypeScript including dependency declarations; strict broader source checking with the previously recorded
Next dependency declaration `--skipLibCheck` limit; lint on 30 changed/new code files; governance-lite / 19 self-tests; whitespace checks.
Exact file lists and commands are in the [handoff](BUILD-ARB-001-HANDOFF.md).
The app's compile-only bundle was built solely for the scoped browser prerequisite, not as final full-build/CI acceptance.
Sandbox font retrieval and loopback binding required local outside-sandbox reruns; fonts are read-only public downloads.
Final focused tests fail: **NONE**. No test was deleted, skipped or weakened; stale tables/corpus append the already implemented capabilities.

Remaining: explicitly owner-approved UX phases (**OWNER-APPROVED UX CHANGES: none yet**), then separately authorized final integration
and full CI (including wider browser/PostgreSQL/fork matrices and outstanding broader dependency declaration checks).
The scoped authoring profile is registered for that later browser gate, which was not run here.
Stop after the local Phase 6 commit. Do not automatically start UX, full CI, push or PR.
