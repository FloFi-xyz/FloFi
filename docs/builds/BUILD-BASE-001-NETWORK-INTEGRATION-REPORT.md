# BUILD-BASE-001: Base as a first-class FloFi network, report

Status: **implementation complete, ready for owner review.** Never merged by this build.

- Baseline `9ef339354ac2292281093609ad5ac3c6aaf73c0c` (`main` after PR #80); branch `claude/build-base-001-network-integration`.
- Inputs: [discovery](BUILD-BASE-001-NETWORK-INTEGRATION-DISCOVERY.md) and [plan](BUILD-BASE-001-NETWORK-INTEGRATION-PLAN.md), including the owner
  addendum (plan §8): generic network/token visual identity and generic natural-language Copilot parity.
- Evidence ceiling: discovery is **`PUBLIC_READ_ONLY`**; every test, unit or browser, is **`MOCKED`**.
- No transaction was signed, sent or broadcast. No production or deployment variable was set or changed. No key exists for this build.

## 1. What changed

| Commit | Scope |
| --- | --- |
| `8fd2428` | Read-only discovery and the integration plan |
| `5e19108` | Package layer: the Base network record, the Base asset catalog provider (pinned ETH/USDC/WETH + the Uniswap Labs Default Token List), Uniswap v3, Aave V3 and Router (Arbitrum One → Base) profiles, capability rows, the OP Stack L1 data fee in the transfer engine |
| `4c32054` | The catalog-network runtime registry (`server/catalog-networks.ts`), Base cloud flows and in-process server actions |
| `1d77869` | First pass of the owner addendum (network registry, generated marks, Copilot catalog vocabulary) and Base on every surface: Canvas, chat grammar, MCP, channels |
| `3e96967` | Base in the execution stores and wallet (4902 add), MOCKED service suites |
| `11cd64b` | The guarded `base-mainnet-authoring` browser profile |
| `1d2985d` | Shared liquidity, router and transfer panels and the Canvas message name Base, not Robinhood Chain |
| `f298255` | Owner addendum, visual identity: trusted provider logos (`CanonicalAsset.logoUrl`) through the shared asset icon |
| `11c02b1` | Owner addendum, Copilot parity: one shared asset-reference resolver and one generated capability truth |
| `81e0ead` | Browser evidence for provider logos and the natural-language Copilot |
| `273d8ae` | Found by the guarded browser gate: a Base Pool card starts at its default tier's full range (one `defaultPoolRange` for every network); the Base network badge golden |
| `6064045` | Found by the PostgreSQL suites: the Base swap's refusals now come from its deployment and policy gates |

The final commit adds this report and the deployment documentation; its SHA is the PR head.

## 2. Network proof

- **Identity.** Base mainnet `eip155:8453` (`0x2105`), real funds, from the official network table (`BASE_MAINNET`). Every Base read client is
  chain-bound: a provider answering any other `eth_chainId` is refused before any economic read.
- **Wallet.** Base was already switchable. It is added only from its official EIP-3085 parameters and only after the wallet answers 4902.
- **Capabilities.** `eip155:8453 / MAINNET` rows, each with `evidenceMaturity: null`, `INJECTED_WALLET` and authorization mode A:
  - `asset.swap.exact-input` / `uniswap.v3`;
  - `asset.liquidity.concentrated` / `uniswap.v3`;
  - `asset.transfer` / `evm.native-transfer` and `evm.token-transfer`;
  - `supply`, `borrow`, `repay`, `withdraw` / `aave-v3`;
  - `asset.bridge` / `flofi.router` (Arbitrum One → Base; Base → Arbitrum One and the Robinhood routes are unchanged).
  - The historical Base `MOCK` and `LOCAL_FORK` rows are unchanged.
- **Fees.** Base receipts carry the OP Stack `l1Fee`. Review binds an L1-fee upper bound from the GasPriceOracle predeploy, and
  reconciliation accounts `gasUsed × effectiveGasPrice + l1Fee`. A Base receipt without `l1Fee` is refused. Profiles without the L1 data
  fee are byte-identical.
- **Gates.** None is set by this build (see [ENVIRONMENT.md](../deploy/ENVIRONMENT.md) §3, §4, §7):

  | Variable | Effect |
  | --- | --- |
  | `GRYLOO_BASE_MAINNET=live` | Base catalog, quotes, Simulate and Review for swap, transfer, liquidity and Aave |
  | `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` | deployment-wide owner execution: any connected user signs with their own wallet; no allowlist |
  | `GRYLOO_ROUTER`, `GRYLOO_ROUTER_OWNER_EXECUTION` | the existing Router gates, now also for Arbitrum One → Base |
  | `GRYLOO_BASE_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY` | loopback MOCKED harness (127.0.0.1:8562); always wins over `live` |
  | `GRYLOO_BASE_JOURNAL`, `GRYLOO_BASE_RPC_URL` | local journals; the existing optional HTTPS override, now also for these flows |

## 3. Architecture

```
Network registry ─┐
Asset provider → validated catalog → asset registry ─┐
Capability truth (MCP canonical examples) ───────────┼→ Canvas / Chat / natural Copilot / MCP → canonical exact grammar → SemanticWorkflow IR
Profile registries (Uniswap, Aave, Router, transfer) ┘                         → the existing flow → recover / reconcile → evidence
```

- **No Base-specific engine, IR, page or MCP path.** Every Base capability is a profile of an engine that already existed. Robinhood Chain
  and Base share the same catalog-network code paths.
- **Server runtime registry** (`server/catalog-networks.ts`). It binds each catalog network's gates, read clients, catalog loader, run
  namespaces (`bas-`, `bat-`, `balp-`, `baave-`), journals and cloud flow names once. Flows and server actions look networks up there.
- **Network registry** (`domain/network-registry.ts`). It holds names, aliases, environment, local marks, the official-catalog flag, the
  catalog chat names, and the Copilot vocabulary (identifier, family, mention pattern).
- **Capability truth** (`domain/authoring-capabilities.ts`). MCP's canonical examples over the network registry, bound by tests to the Aave
  and Router registries and to the Canvas pickers (§7).

## 4. Base asset catalog

- **Pinned assets.** ETH (native), Circle USDC and the OP Stack WETH predeploy, bound exactly by the Router, Aave and the BUILD-002
  reference swap.
- **List entries.** Every Base entry of the live Uniswap Labs Default Token List that passes the discovery §2.3 policy.
  - A malformed record, a duplicate address, a case-insensitive duplicate symbol, or a list entry rebinding a pinned asset fails the
    whole catalog closed.
  - Out-of-grammar symbols are counted and excluded, never renamed.
- **No fallback.** When the list is unavailable, only the pinned assets resolve and anything else fails closed (`ASSET_CATALOG_UNAVAILABLE`).
  There is never a recorded copy.
- **License.** The list is GPL-3.0: FloFi reads it at runtime, server-side, and never commits it. The test fixture is FloFi-authored (chain
  reads), plus the live list's `logoURI` for four entries as URL references only.
- **Catalog membership is not trust.** Simulate re-reads code and `decimals()` on chain. FLUX and WMTX list the wrong decimals; both fail
  closed.

## 5. Capabilities (all MOCKED)

| Capability | Built on | Notes |
| --- | --- | --- |
| Swap | shared owner-wallet Uniswap swap service | Any two catalog ERC-20s; CREATE2 pools verified; QuoterV2 binds the best tier. Base USDC ⇄ WETH keeps its BUILD-002 declaration, IR and hash |
| Transfer | shared transfer engine | Native ETH or a catalog ERC-20, to the owner or an explicit recipient; L1-fee budget and reconciliation |
| Liquidity | shared Uniswap liquidity service | Any two catalog ERC-20s at a standard tier; pool order, tick spacing, exact approvals; the owner is the NFT recipient |
| Supply / Borrow / Repay / Withdraw | shared Aave engine | Aave V3.7 USDC reserve id 4; `PUBLIC_MAINNET` provenance; `MAINNET_EXECUTED` only for a real owner-signed run |
| Bridge Arbitrum One → Base | Cross-chain Router | Its own router network, flow and storage under the Router's gates |

- **Lifecycle.** Every capability uses the existing sequence:
  `PREPARED → approval → refresh → Review → owner wallet → receipt + reconciliation → Evidence`.
- **Recovery.** An uncertain wallet result is observation-only and never retried. The attempt is persisted before the wallet is called.

## 6. Authoring surfaces (no new page, card or layout)

- **Canvas.** Base joins the existing Swap, Pool, Transfer, lending and Bridge pickers. The Robinhood Stocks search was extracted into one
  shared asset-search component that every official-catalog network uses: bounded results, loading, empty, unavailable and retry states.
- **Chat (exact grammar).** For example:
  - `swap 100 USDC to cbBTC on Base`
  - `transfer 0.01 ETH on Base to 0x…`
  - `add liquidity 100 USDC and 0.04 WETH on Base fee 0.05%`
  - `supply 100 USDC to Aave on Base`
  - `bridge 100 USDC from Arbitrum to Base`
  
  Existing sentences keep their commands and IR.
- **MCP and channels.** `base` for swap (catalog symbols), transfer, `add_liquidity` and lending; `arbitrum-one → base` for bridges. Each Base
  example composes byte-identically to its chat sentence. Channels load the named catalogs through the read-only `authoring-catalogs`
  module.
- **Shared panels.** The liquidity, router and transfer panels and the Canvas amount message name the position's own network. Before this
  build, Base showed Robinhood or Base Sepolia wording.
- **Pool card range.** A new or re-networked Pool card starts at one shared `defaultPoolRange(network)`: a catalog network's default
  tier's full range. The guarded browser gate found that a Base card used Base Sepolia's 0.05% ticks, which the 0.3% tier cannot use, so
  Review failed.

## 7. Owner addendum

### 7.1 Network and token visual identity

- **Shared resolver.** One icon resolver (`domain/asset-identity.ts`) serves the existing Canvas cards, asset search and picker chips. It
  shows, in order:
  1. FloFi's reviewed local mark for a code-pinned asset (by chain + address);
  2. the asset's **`CanonicalAsset.logoUrl`** when its provider's logo rule accepts it for that exact asset;
  3. a deterministic monogram generated locally from chain + address + symbol.
- **Network icons** are local reviewed files.
- **Logo rules** (`packages/action-registry/src/asset-logos.ts`):
  - **Robinhood Stock Tokens:** the issuer's CDN image of the asset's own address.
  - **Base list tokens:** the `logoURI` under six reviewed image prefixes, in a strict normalized URL grammar (no credentials, port,
    fragment, dot segments or encoded separators; at most a numeric cache-buster).
  - Anything else is dropped at parse time and never fails the catalog.
  - `trustedAssetLogo` re-checks the rule at render, so an altered or transplanted URL is never shown.
- **Never from a symbol.** A logo is never inferred from a symbol; the same symbol on another chain never shares an image.
- **Rendering.** A provider logo is an `<img>` only (no SVG is inlined), sent without a referrer. A missing, broken or blocked image falls
  back to the monogram.
- **Owner note.** Showing a provider logo means the viewer's browser loads that image from the provider's host (§11).
- **Tests** (`asset-logos.test.ts`, `asset-identity.test.ts`, the Base and Robinhood browser profiles):
  - Robinhood AMZN, TSLA, AAPL and non-featured CRM/PLTR use their validated official logo.
  - A Base trusted logo renders (cbBTC, loaded through a closed local replay).
  - Untrusted, malformed and transplanted logos are refused.
  - A broken logo falls back (unit and browser: a 404'd AERO logo shows its monogram).
  - TSLA, cbBTC and AERO never cross networks.
  - The IR and its hash are identical with, without or with another logo.

### 7.2 Natural-language Copilot parity

Natural language → intent (model) → shared network resolver → shared asset resolver → shared capability truth → canonical exact-grammar
sentence → `parseLocalCommand` → SemanticWorkflow IR.

- **Asset resolver** (`resolveAssetReference`), within the named network's validated catalog only:
  - the symbol, in any case;
  - else the whole display or catalog name of exactly one asset, also after a trailing "stock", "shares" or "token".
  - Ambiguous names are asked about (options are the symbols). Unknown tokens are refused honestly. An unloaded catalog fails closed.
  - A name-resolved token gets a note naming the canonical asset ("“Tesla” is TSLA (Tesla) in the official Robinhood Chain catalog."), so
    nothing is substituted silently.
- **Root cause of the Robinhood USDG → Stock Token regression.**
  - The intent schema told the model to report `OTHER` for a token named without a symbol.
  - The prompt told it to copy names as written.
  - FloFi resolved symbols only, so "Tesla" was refused.
  - The V2 token field now carries a symbol or a whole name.
- **Capability truth, generated.** Nothing in this list is hand-written any more:
  - the planners' networks per action;
  - the in-app capability answer (EN/PT);
  - the lending, router and composition refusals;
  - the model instructions' network rule, transfer scope and "What Flofi supports" (`server/copilot-capabilities.ts`);
  - the Copilot network enum, from the network registry.
- **Frozen V1.** CopilotIntent V1 is a frozen protocol: on catalog networks it keeps only the BUILD-002 reference swap.
- **Acceptance** (`catalog-copilot-parity.test.ts`, `authoring-capabilities.test.ts`, browser):
  - "Buy Tesla with 50 USDG on Robinhood Chain", "Compre ações da Tesla com 50 USDG na Robinhood", "Swap 50 USDG for TSLA on Robinhood
    Chain" and "swap 50 usdg for tsla on robinhood" give one command, one node and one platform workflow hash.
  - In the browser, the two natural-language turns and Chat's exact sentence show the identical proposed change, and applying it puts
    TSLA's own contract in the IR.
  - Non-featured Stock Tokens by company name: Salesforce → CRM, Coinbase → COIN.
  - Chain context: "Tesla" on Base is refused. With no network named, the Copilot asks. "Coinbase" is only a fragment on Base and is
    refused.
  - An ambiguous name asks with the symbols as options. A name the user did not write is never trusted.
  - Base in normal language, unit and through the product Copilot UI:
    - a list token by name ("Coinbase Wrapped BTC" → cbBTC);
    - a Portuguese Uniswap pool with "Aerodrome" at 0,3%;
    - Aave supply, an ETH transfer and Arbitrum One → Base.
  - **Every one of the 33 canonical MCP examples**, said in normal language to the Copilot, yields the MCP platform workflow hash.
  - The capability truth agrees with the Aave and Router registries and with the Canvas pickers. The Canvas additionally keeps its two
    testnet native self-transfers (Robinhood Chain Testnet, Ethereum Sepolia), which MCP and the Copilot never offered.

## 8. Hash and Review continuity

- **Base USDC ⇄ WETH.** The reference swap keeps its BUILD-002 declaration and authoring path: `createSwapNode`, the reference registry and
  the editor are unchanged. Chat, the Copilot and MCP still produce `ADD_SWAP`.
- **Robinhood Chain.** The shared catalog pool builder gives Robinhood Chain byte-identical pools (tested).
- **Other transfer profiles.** Profiles without the L1 data fee compile and reconcile as before.
- **Presentation.** Logos and marks never enter the IR, a hash, a Manifest, a Review or execution (tested).

**Measured against the baseline.** The same probe ran in a throwaway worktree at `9ef3393` and at this branch: `composeStrategy` →
`semanticWorkflowHash`, with the official Stock Token capture registered. All **33** baseline entries are byte-identical:

- the 26 canonical MCP examples that existed at the baseline, including `swap-base` (`0x747634a76aa445ec993325bbb638f4d5b5103d59267314b54d30db1bc79e3d49`),
  every Robinhood Chain example and every testnet example;
- seven Robinhood Chain Stock Token strategies: USDG → TSLA, AAPL → USDG, PLTR → WETH, a TSLA transfer, an ETH transfer to a recipient,
  a USDG/TSLA full-range pool and a USDG/NVDA tick-range pool.

The only new entries are the seven Base examples.

## 9. Blocked or not built

- **Lending composition on mainnet:** UNSUPPORTED. It stays on Base Sepolia.
- **More Aave reserves** (WETH, cbBTC are verified active): the engine binds one reserve per network profile.
- **Native-ETH and WETH bridging:** BLOCKED by the router design (ERC-20 approve + deposit), and not built.
- **Ethereum mainnet:** BLOCKED (owner decision).
- **Fee-on-transfer or rebasing list tokens:** they reconcile as `DIVERGENT`, never as success. The catalog does not pre-screen them.
- **Local mark sources:** network icons stay the existing reviewed local files (Base is SVG; Arbitrum and Optimism are PNG; Robinhood is
  JPG). No new brand assets were sourced.

## 10. Evidence levels

| Source | Level |
| --- | --- |
| Discovery reads | `PUBLIC_READ_ONLY` |
| Unit, PostgreSQL-free service and browser tests | `MOCKED` |
| `MAINNET_EXECUTED` | Never by this build; only for a real owner-signed, reconciled run after the owner enables the gates |

Every Base capability row carries `evidenceMaturity: null`.

## 11. Owner decisions to review

1. **Third-party logo hosts.** Rendering a provider logo makes the viewer's browser request it from the provider's host
   (`cdn.robinhood.com` for Stock Tokens; the six Base list prefixes). It is sent without a referrer, and nothing is fetched server-side.
   - A same-origin image proxy, or an `img-src` CSP allowlist, is a possible follow-up. Neither is part of this build: the app sets no
     `img-src` today.
   - Browser tests answer these requests from a closed local replay (`e2e/asset-logo-replay.ts`). No logo host is reached.
2. **GPL token list.** Read at runtime only, never committed or redistributed (discovery §2.4).
3. **Deployment-wide owner execution.** `GRYLOO_BASE_OWNER_EXECUTION` enables any connected user to sign their own transactions; there is
   no wallet allowlist, as on Robinhood Chain.
4. **Base reference pair routing.** The BUILD-002 Base USDC ⇄ WETH swap uses the owner-wallet Base flow only when Base is enabled on the
   instance and the Mode A fork runtime is unavailable. Otherwise its observation and fork paths are unchanged.
5. **Copilot option order.** Clarification options follow the network registry order. One liquidity clarification now lists Base before
   Base Sepolia.
6. **Legacy fork-only Base pool.** The Canvas Base Pool card authors the canonical catalog position. A legacy BUILD-006 fork-only
   `asset.liquidity.uniswap-v3` node is never converted by the picker (`ACTION_SELECTION_LOCKED`) instead of being edited in place.
7. **Channel boundary.** Channel code may reach `server/authoring-catalogs.ts`, a read-only catalog loader whose closure is tested to
   reach no flow, cloud API, server action, handoff, approval or wallet session.

## 12. Tests and gates

All local, on the pinned toolchain (Node 24.21.0, pnpm 11.22.0, Anvil 1.8.3, Chromium headless shell 1243). Disposable loopback
PostgreSQL 18.6 (the CI-pinned image).

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, `schemas:check`, unit tests) at `6064045` | **pass**: 332 test files, 3,513 tests; 2 files skipped |
| `python3 scripts/governance_lite.py` and its unittest suite | **pass** (1,784 text files; 19 tests) |
| `pnpm test:postgres` at `6064045` | **pass**: 53 files, 337 tests |
| `pnpm test:anvil`, `pnpm test:fork` | **pass**: 4 and 31 tests; 10 and 29 skipped |
| `node scripts/guarded-release-browser.mjs product` at `273d8ae` | **pass**: all 26 profiles |
| CI's extra browser specs at `81e0ead` | **pass**: `mcp-route-presentation`, `developer-journey`, `mcp-in-chat`, `channel-signing`, `whatsapp-approve` / `telegram-approve` |
| `guarded-release-browser.mjs composition` | **not run locally**: needs the BUILD-007 pinned downloads; CI runs it |
| `bootstrap-ci.py --verify-dependencies` | **not needed**: no dependency or lockfile change |

- **Product profiles at `273d8ae`.** These include `default-product`, `copilot`, `robinhood-mainnet-authoring` and `base-mainnet-authoring`
  (4 tests each, including the Copilot journeys).
- **Extra browser specs at `81e0ead`.** The later commits change only the Pool card's default range, a golden screenshot and PostgreSQL
  test expectations.
- **Skips.** None is a pass, and none was added by this build:
  - the two unit files are owner-pinned fork rehearsals (`composition-service`, `mode-b-service`);
  - the Anvil and fork skips are the owner-secret, pinned-account cases CI also skips (DEC-0026, DEC-0027).
- **First browser run.** The product phase stopped at `default-product` with two real failures, both fixed in `273d8ae`:
  - the Base Pool card range (a product bug);
  - the badge golden (an intended visual change, regenerated for that one test).
- **First PostgreSQL run.** Two files still expected the pre-BASE refusal code for a Base swap (fixed in `6064045`, §13).
- **Pre-existing flake.** One `pnpm check` run failed `server/wallet-session.test.ts` ("refuses … a tampered … challenge"). The test
  "tampers" with a random token by replacing its last two characters with `AA`, which is a no-op about once in 4,096 runs. The file
  passed five isolated reruns and every later full run. Neither the test nor `wallet-session.ts` differs from the baseline; it is
  reported here, not changed.

New suites:

- `packages/action-registry`: `base-network` (18 tests) and `asset-logos` (6).
- `packages/workflow-contracts`: `catalog-swap` (4).
- `apps/reference-dapp` server: `base-mainnet` (10), `base-swap` (9), `base-liquidity` (7), `base-lending` (5), `router-arbitrum-base` (5).
- `apps/reference-dapp` domain:
  - `asset-identity` (10);
  - `catalog-copilot-parity` (15);
  - `authoring-capabilities` (38, including one natural-language case per canonical MCP example).
- Browser: `base-mainnet-authoring` (4); in `robinhood-stocks`, one new test (the Copilot journey) and a logo assertion.

## 13. Intentional test changes (owner review)

Each is marked in the test file with `BUILD-BASE-001`.

| Test | Change | Why |
| --- | --- | --- |
| `backend/entrypoint.test.ts`, `server/run-ownership.test.ts` | The flow lists add `base-swap`, `base-mainnet-transfer`, `base-liquidity`, `base-aave` and `crosschain-router-arbitrum-to-base` | New flows |
| `engine/capability-catalog.test.ts`, `engine/strategy-engine.test.ts`, `packages/action-registry/test/execution-capabilities.test.ts` | Base mainnet Uniswap is an owner-wallet capability (`MAINNET` row, `evidenceCeiling: null`, `UNQUOTED_EXECUTION_UNAVAILABLE` until quoted) instead of fork-only. Probes for an unsupported chain use Base Sepolia or Optimism | Base mainnet is an execution network now; nothing is demonstrated |
| `mcp/execution.test.ts`, `mcp/simulation.test.ts` | `swap-base` is the `base-swap` flow; not enabled in the test deployment (`FLOW_NOT_ENABLED_IN_DEPLOYMENT`, `BASE_MAINNET_NOT_ENABLED`) | The swap has a flow; enablement stays a deployment decision |
| `domain/router-authoring.test.ts`, `engine/robinhood-composition.test.ts` | Arbitrum One → Base is a mainnet USDC route | New route |
| `domain/crypto-action-picker.test.ts` | Aave adds Base mainnet USDC. The legacy fork-only Base pool is no longer edited by the Pool picker (locked); the "retains legacy pool minimums" case became "never converts the legacy position" | The Pool card authors the canonical catalog position (§11.6) |
| `domain/canvas-transfer.test.ts`, `packages/action-registry/test/ethereum-sepolia.test.ts` | Transfer and Aave profile lists append Base | New profiles; testnet entries keep order and identity |
| `domain/copilot-conversation.test.ts`, `channels/core/conversation.test.ts`, `domain/copilot-eval.corpus.ts` | Aave network options add `Base`; swap options add `Robinhood Chain`. U06: the router refusal names every route (it named two, which had become stale). U08: generated Aave wording. E12: Uniswap options in registry order | Real funds are offered, never chosen; capability text is generated |
| `domain/copilot-intent-v2.test.ts` | The undeclared step-kind probe uses `STAKE` | `TRANSFER` is a step kind now |
| `server/robinhood-swap.test.ts`, `packages/reference-linter/test/{uniswap,solana}-liquidity.test.ts` | The "unsupported network" probes use Arbitrum One or Optimism; Base liquidity is checked against Base's Position Manager | Base is a catalog network now |
| `wallet/evm-networks.test.ts` | The 4902 probe uses Arbitrum One; a new case adds Base from its official parameters after 4902 | Base is addable now |
| `packages/action-registry/test/base-network.test.ts` | Four fixture entries keep a reviewed-prefix `logoUrl` | Owner addendum (§7.1) |
| `state/public-testnet-store.test.tsx` | The mocked action is `catalogSwapAvailability` | Generic per-chain availability |
| `channels/boundaries.test.ts` | The allowlist adds `server/authoring-catalogs.ts`, with a closure check | §11.7 |
| `automations/scheduler.pg.test.ts`, `mcp/handoff/handoff.pg.test.ts` | A Base mainnet swap is refused with `MAINNET_HANDOFF_DISABLED_BY_POLICY` (automation) or `FLOW_NOT_ENABLED_IN_DEPLOYMENT` (MCP handoff with Base allowed) instead of `OWNER_EXECUTION_NOT_IMPLEMENTED`. The handoff test is renamed to "refuses a strategy whose owner-wallet flow this deployment has not enabled" | The Base swap has a flow now; it is still refused and nothing is created or handed off |
| `e2e/swap-authoring.spec.ts-snapshots/review-blocked-chromium-linux.png` | Regenerated for this one test. Only the two token-chip network badges changed (361 px in x 553–571, y 404–509): "Base (8453)" now shows the reviewed local Base mark instead of a grey "B" fallback. Two plain reruns pass | The shared network registry resolves the label alias (§7.1) |
| `e2e/base-mainnet-authoring.spec.ts`, `e2e/robinhood-stocks.spec.ts` | cbBTC shows its trusted logo instead of a monogram; logos are answered by a closed replay; Copilot journeys added | §7 |

No test was deleted or skipped to make a gate pass.

## 14. Confirmations

- The PR is not merged and automatic merging is not enabled.
- No production, Railway, Vercel or deployment variable was changed.
- No transaction, approval or signature was made. No faucet, real wallet or key was used; browser tests use injected test wallets.
- In the browser, every non-loopback request is answered by a closed replay (provider logos) or refused by the network guard.
- Server-side, the existing BUILD-009 spec in `default-product` reads a public LI.FI quote, as it does in CI; it signs and sends nothing.
- The only other public reads were read-only GETs:
  - the discovery reads;
  - one read of `https://tokens.uniswap.org` to survey the Base logo hosts (nothing committed but four URLs, §4);
  - npm registry downloads of already-locked packages (`--frozen-lockfile`, integrity-checked) for the throwaway baseline worktree used in
    §8, which was removed afterwards.
- No dependency, lockfile, toolchain or CI workflow changed.

## 15. Owner acceptance path (not done by this build)

1. Review this PR and the decisions in §11.
2. To try Base in a deployment, set `GRYLOO_BASE_MAINNET=live` (Simulate/Review only), then exercise Canvas, chat, Copilot and MCP.
3. `MAINNET_EXECUTED` evidence needs the owner's explicit `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` and a real owner-signed,
   reconciled run per capability, each recorded separately.
