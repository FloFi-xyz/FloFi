// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// The same explicit profiles run locally and in CI. Financial diagnostic specs
// remain available independently; none of their results are counted as passes.
const usage = 'Usage: node scripts/guarded-release-browser.mjs critical | extended [--shard <n>/<total>] | product | composition | profile <name> | list [--collect-failures]';
const [phase, ...args] = process.argv.slice(2);
// Cloud Build collects independent failures on its single worker. Other callers
// retain fail-fast behavior; neither mode can turn a failed profile into a pass.
const collectFailures = args.includes('--collect-failures');
if (args.filter(arg => arg === '--collect-failures').length > 1) throw new Error(usage);
const rest = args.filter(arg => arg !== '--collect-failures');
if (phase === 'list' && collectFailures) throw new Error(usage);
const boundary = 'release-financial-provenance.spec.ts';
const executionContinuity = { GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_SWAP_EXECUTION_E2E: 'MOCKED_LOOPBACK_ONLY',
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' };
const definitions = [
  // BUILD-FLOFI-CI-ARCHITECTURE-002: the default product suite (34 specs, ~530 s on CircleCI) runs as two parts of its spec list, in its
  // order, with the same (empty) settings: each part is its own profile with its own app server and synthetic fork, so CI can place them
  // in different browser jobs. Together they run exactly the former default-product list (scripts/test_ci_optimization.py checks it).
  ['default-product-1', ['brand-ux-001.spec.ts', 'base-observation.spec.ts', 'build-roundtrip.spec.ts', 'build009.spec.ts', 'across.spec.ts',
    'canvas-keyboard.spec.ts', 'canvas-ux.spec.ts', 'contextual-proposals.spec.ts', 'cross-chain-liquidity-recovery.spec.ts',
    'cross-chain-liquidity.spec.ts', 'execution-capabilities.spec.ts', 'interface-honesty.spec.ts', 'mock-artifact-chain.spec.ts',
    'network-isolation.spec.ts', 'public-testnet.spec.ts', 'robinhood-network.spec.ts', 'swap-authoring.spec.ts', 'visual-shell.spec.ts', 'credentials.spec.ts',
    'build-fix-ux.spec.ts', 'beta-ui.spec.ts'], {}],
  ['default-product-2', ['site.spec.ts', 'build-entry.spec.ts', 'privacy-notice.spec.ts', 'editor-redesign.spec.ts',
    'portfolio-ux004.spec.ts', 'dashboard-productization.spec.ts', 'dashboard-theme-states.spec.ts', 'dashboard-run-details.spec.ts',
    'simulate-canvas-controls.spec.ts', 'editor-layout-hotfix.spec.ts', 'editor-header-new-workflow.spec.ts', 'ux-polish-004.spec.ts',
    // BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (UX-01): the owner's chat bubbles keep short messages on one line at every zoom, width and theme.
    'chat-message-wrapping.spec.ts',
    // BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): 25% · 50% · 75% · Max under FloFi's amount question (real component, fixture balances).
    'amount-shortcuts.spec.ts'], {}],
  // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001: the Simulate panel's disclosure across its layouts (regression of the main 0ea35d5 post-merge red).
  ['review-execute-recovery-components', ['simulate-review-acceptance.spec.ts', 'execute-product-workspace.spec.ts', 'execute-workflow.spec.ts', 'chat-review-overflow.spec.ts',
    'simulate-panel-disclosure.spec.ts'], {}],
  // Direct chat signing and optional Canvas, with no application server, RPC, wallet or database; requests are intercepted by the spec.
  ['solana-transfer-ux', ['--config', 'playwright.transfer-ux.config.ts'], {}],
  ['workflow-acceptance', ['acceptance-workflows.spec.ts'], { GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', GRYLOO_ROUTER_TESTNET_E2E: 'MOCKED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['swap-read-acceptance', ['acceptance-swap-read.spec.ts'], { GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-EXECUTION-CONTINUITY-001: production UI/API/durable lifecycle, isolated synthetic RPC and scripted owner wallet confirmations.
  // BUILD-FLOFI-CONVERSATIONAL-001: the same harness drives the whole workflow from the FloFi chat (review, two confirmations, wallet, reconciliation).
  // BUILD-FLOFI-CHAT-E2E-FIX-002: a multi-action workflow run from the chat as a sequence of one-action steps (funded Swap → Swap reconciled step by
  // step, an unapplied Canvas amount, the wallet network switch, a missing quote and a balance too low), on the same loopback harness.
  // BUILD-FLOFI-CI-ARCHITECTURE-002: the six files (~740 s on CircleCI, mostly waiting on the loopback lifecycle) run as three parts with the
  // same harness settings, each on its own disposable database and servers; together they run exactly the former execution-continuity list.
  ['execution-continuity-1', ['chat-sequence.spec.ts'], executionContinuity],
  ['execution-continuity-2', ['workflow-ux-execution.spec.ts', 'chat-assistant.spec.ts'], executionContinuity],
  ['execution-continuity-3', ['execution-continuity.spec.ts', 'conversational-workflow.spec.ts', 'locale-journey.spec.ts'], executionContinuity],
  // BUILD-AUTOMATION-001: Automations (fixture price source, test clock) into the owner's /approve → Simulate → Review; never a transaction.
  ['automations', ['e2e/automations.spec.ts'], { GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', GRYLOO_AUTOMATION_E2E: 'FIXTURE_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['canvas-automation-ux', ['canvas-automation-ux.spec.ts', 'canvas-cta.spec.ts'], { GRYLOO_SUPPLY_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['chat-automations', ['copilot-automations.spec.ts'], { FLOFI_COPILOT: 'replay', GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', GRYLOO_AUTOMATION_E2E: 'FIXTURE_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-AUTOMATION-002: "Automatic within limits" — MOCKED loopback chain doubles, virtual passkey, disposable signers under /tmp; MOCKED evidence only.
  ['delegated-execution', ['e2e/delegated-execution.spec.ts'], { FLOFI_COPILOT: 'replay', GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', GRYLOO_AUTOMATION_E2E: 'FIXTURE_LOOPBACK_ONLY', GRYLOO_DELEGATION_E2E: 'MOCKED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['supply-provenance', ['release-provenance.spec.ts'], { GRYLOO_SUPPLY_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['unsafe-lending-simulations', ['borrow.spec.ts', 'repay.spec.ts', '--grep', 'read-only simulation blocks unsafe Borrow before Review|insufficient debt blocks read-only simulation'], { GRYLOO_SUPPLY_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['copilot', ['copilot.spec.ts', 'copilot-conversation.spec.ts'], { FLOFI_COPILOT: 'replay', GRYLOO_SUPPLY_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // BUILD-CHAT-LEARNING-001/002: invisible learning (in-conversation adaptation, consent in Privacy & memory, learned across sessions, no inheritance)
  // and the published glossary on a disposable loopback database (replay answers, injected sign-in wallet).
  ['copilot-learning', ['copilot-learning-memory.spec.ts'], { FLOFI_COPILOT: 'replay', FLOFI_LEARNING_E2E: 'LOOPBACK_ONLY',
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // PR B: context-aware Solana Devnet authoring (swap → position, "these tokens", yes/no, chat position management) on replay answers and the MOCKED Devnet loopback.
  ['copilot-solana', ['copilot-solana.spec.ts'], { FLOFI_COPILOT: 'replay', GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // BUILD-P1 pool conversational reliability: a liquidity range answered in separate messages in the public Mainnet-only product, on committed replay
  // answers and the MOCKED loopback copy of the mainnet Orca pool (its price is read by FloFi itself).
  ['copilot-pool-dialogue', ['copilot-pool-dialogue.spec.ts'], { FLOFI_COPILOT: 'replay', GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_E2E_NETWORK_SCOPE: 'PUBLIC_MAINNET' }],
  // BUILD-SOLANA-MAINNET-001: the Solana Mainnet/Testnet header switch, family-preserving re-networking and Orca mainnet liquidity authoring on the
  // MOCKED loopback (the Devnet harness also serves a MOCKED copy of the mainnet-beta pool); MOCKED cannot authorize, nothing is signed or sent.
  // BUILD-FLOFI-MAINNET-PRODUCT-001: the public Mainnet-only product exactly as deployed (no engineering opt-in); every other profile certifies the engines.
  ['solana-mainnet-network', ['solana-mainnet-network.spec.ts'], { GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_E2E_NETWORK_SCOPE: 'PUBLIC_MAINNET' }],
  // BUILD-SOLANA-MAINNET-001 PR B: empty Canvas on Launch App, unrestricted card deletion, and the Swap arrow's From/To inversion (MOCKED estimates).
  ['canvas-corrections', ['canvas-corrections.spec.ts'], {}],
  // P0: a wallet that changes the reviewed Solana Devnet swap is refused before broadcast, Execute says why, and Simulate again runs the swap
  // once and the position; a wallet behaving like the captured Phantom (adds a compute-unit price when none is set) signs the reviewed bytes
  // and completes both steps. MOCKED Devnet loopback; only these cases of the diagnostic spec.
  ['solana-wallet-refusal', ['solana-swap-liquidity-composition.spec.ts', '--grep', 'a wallet that changes the reviewed swap|a Phantom-like wallet signs the exact reviewed swap|a Phantom wallet with Lighthouse protections|a reconciled swap continues to its Orca position'], { GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['lending-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'lending', GRYLOO_LENDING_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['jupiter-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'jupiter', GRYLOO_JUPITER_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['devnet-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'solana-devnet', GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['orca-liquidity-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'solana-liquidity', GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['solana-composition-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'solana-composition', GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['transfer-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'transfer', GRYLOO_ROBINHOOD_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // BUILD-RH-002: Robinhood Chain authoring against the committed official registry capture on loopback (MOCKED; nothing is quoted or sent).
  ['robinhood-mainnet-authoring', ['robinhood-stocks.spec.ts'], { GRYLOO_ROBINHOOD_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_COPILOT: 'replay' }],
  // BUILD-BASE-001: Base as a catalog network in the existing cards (shortcuts, search, a non-featured token, provider logos through a closed
  // replay) and in the natural-language Copilot (committed replay answers), MOCKED list only.
  // BUILD-ARB-001 Phase 6: one authoring-only product profile, replay model and passive wallet; every financial gate stays off.
  ['ethereum-authoring-certification', ['--config', 'playwright.ethereum-authoring.config.ts'], {}],
  ['arbitrum-authoring-certification', ['--config', 'playwright.arbitrum-authoring.config.ts'], {}],
  // BUILD-ARB-001 Phase 7: owner-approved workflow UX (authoring only; replay Copilot, passive wallet, MOCKED registry harness).
  ['workflow-ux-authoring', ['--config', 'playwright.workflow-ux.config.ts'], {}],
  // Phase 7B: toolbar geometry, insertion viewport and canonical connections use the same passive-wallet profile.
  // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: the same passive-wallet profile also certifies the Batch Payment card (authoring only).
  ['canvas-workflow-ux', ['--config', 'playwright.canvas-workflow-ux.config.ts', 'canvas-workflow-ux.spec.ts', 'batch-payment-card.spec.ts'], {}],
  // BUILD AAVE-V3-CARD-CATALOG-FIX-001: the lending card's own Aave reserve catalog on the MOCKED Base Aave market of the same harness. It sorts
  // after base-mainnet-authoring.spec.ts on purpose (one worker, file order): that spec's unavailable-list case must be the server's first read.
  ['base-mainnet-authoring', ['base-mainnet-authoring.spec.ts', 'base-mainnet-lending-catalog.spec.ts'], { GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_COPILOT: 'replay' }],
  ['uniswap-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'uniswap', GRYLOO_UNISWAP_LIQUIDITY_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): a Review that expires between the two approvals of a Uniswap position is refreshed on the
  // same run and authorized again through the chat (MOCKED loopback chain and harness clock; the confirmed approval is never asked again).
  ['uniswap-continuation', ['uniswap-liquidity-continuation.spec.ts'], { GRYLOO_UNISWAP_LIQUIDITY_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: managing Uniswap v3 positions opened elsewhere on the MOCKED Base loopback harness (8562): Dashboard discovery
  // (facts, capability-driven actions that only prepare), the Editor stages (Simulate on the real server actions, Execute's MOCKED boundary: no
  // Authorize), the owner's one Position Manager request through the same runtime, reconciliation and recovery; a 50% withdrawal, a fees-only
  // collect, an exit that closes, a declined request and an expired Review, one path in Portuguese. MOCKED evidence only; nothing is broadcast.
  // The same harness serves the chat journey (chat-liquidity-positions.spec.ts, EN and PT): verified facts, a clarified choice committed to the
  // Canvas, the Simulate hand-off and a re-staged change, on the closed Copilot replay (committed answers; no model is called).
  ['liquidity-position-management', ['liquidity-position-management.spec.ts', 'chat-liquidity-positions.spec.ts'], { GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY',
    FLOFI_LIQUIDITY_POSITIONS_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_COPILOT: 'replay' }],
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: managing Orca Whirlpools positions opened elsewhere, in the public Mainnet-only product, on the MOCKED
  // loopback copy of the mainnet-beta pool (8552): the owner's Sign-In With Solana, Dashboard discovery (facts; capability-driven actions that only
  // prepare; a delegated position listed with its reason and no action), the Editor stages (each operation simulated as itself on the real server
  // actions; Execute's MOCKED boundary: no Authorize), the owner's one signed transaction through the same runtime, reconciliation and recovery:
  // a 50% withdrawal then an exit that closes, and a fees-only collect in Portuguese. MOCKED evidence only; nothing is broadcast.
  ['orca-position-management', ['orca-position-management.spec.ts'], { GRYLOO_SOLANA_DEVNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_E2E_NETWORK_SCOPE: 'PUBLIC_MAINNET',
    FLOFI_ORCA_POSITIONS_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['router-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'router', GRYLOO_ROUTER_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  ['journey-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'journey', GRYLOO_ROUTER_TESTNET_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // BUILD-ADMIN-001: the private Admin console (sign-in refusal and grant, dashboards, AI settings) on a disposable loopback database.
  ['admin-console', ['admin-console.spec.ts', 'admin-login-layout.spec.ts'], { FLOFI_ADMIN_E2E: 'LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['cloud-provenance', [boundary], { FLOFI_RELEASE_PROVENANCE_PROFILE: 'cloud', GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['synthetic-fork-provenance', ['release-fork-provenance.spec.ts'], { GRYLOO_MODE_A_E2E: 'synthetic' }],
  ['cow-loopback', ['cow-intent.spec.ts', 'cow-recovery.spec.ts'], { GRYLOO_COW: 'loopback' }],
  ['card-provider-loopback', ['card-provider.spec.ts'], { GRYLOO_CARD_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // MCP route presentation runs twice on purpose: here with OAuth disabled (no MCP harness), below with OAuth enabled on the embedded harness.
  ['mcp-routes-oauth-disabled', ['mcp-route-presentation.spec.ts'], {}],
  // BUILD-DEVELOPER-001: a third-party server integrates with the SDK alone (operator CLI key, strategy, approval, signed loopback
  // webhooks) and the end user reaches FloFi's Review, where MOCKED financial authority stays blocked (no wallet transaction), on the
  // same embedded loopback harness (no public network, no real transaction). The full lifecycle is proven by journey.pg.test.ts.
  ['developer-journey', ['developer-journey.spec.ts'], { FLOFI_E2E_DEVELOPER_CONSOLE: '1', GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-MCP-002: consumer OAuth and in-chat approval on disposable loopback infrastructure.
  ['mcp-in-chat', ['mcp-in-chat.spec.ts', 'mcp-route-presentation.spec.ts', '--grep-invert', 'embedded wallet proof'], { GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_MCP_OAUTH_ACCESS: 'open', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // Each invocation gets a fresh disposable database; keep the production OAuth registration rate limit intact.
  // Fresh database preserves the production OAuth registration limit while certifying the new in-chat wallet journeys.
  ['mcp-embedded-signing', ['mcp-in-chat.spec.ts', '--grep', 'embedded wallet proof'], { GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_MCP_OAUTH_ACCESS: 'open', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['channel-signing', ['channel-signing.spec.ts'], { GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-CHANNELS-001: the channels' /approve paths on the same embedded loopback harness — WhatsApp with the FIXTURE provider (nothing
  // is sent to Meta) and Telegram against the loopback Bot API double (nothing reaches Telegram): the real webhook routes, the
  // intended-wallet rule, the owner's Review where MOCKED authority stays blocked, the status ping and the scheduled dispatch.
  ['channel-approve', ['whatsapp-approve.spec.ts', 'telegram-approve.spec.ts'], { GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', GRYLOO_CHANNEL_E2E: 'FIXTURE_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-SOLANA-TRANSFER-UX-001: both /approve journeys (chat-first signing surface and optional Canvas) from an MCP request through one
  // Authorize in wallet, the wallet's confirmation, submission and reconciliation to the receipt in the chat: the MCP harness with the
  // synthetic loopback swap RPC and scripted owner confirmations on disposable PostgreSQL (no public network or broadcast).
  ['approve-authorize-journeys', ['approve-authorize-journeys.spec.ts'], { GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY',
    FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_SWAP_EXECUTION_E2E: 'MOCKED_LOOPBACK_ONLY', TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-CHAT-E2E-001: a two-step workflow from an MCP request, one approval, each step signed on /approve after the previous one reconciled,
  // on the same MCP harness and synthetic loopback swap RPC with workflow runs enabled (confirm each step; no delegated signer exists here).
  // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the same harness also certifies the Editor's "Run workflow" (a simulated multi-step Canvas
  // workflow of a signed-in account starts that same run on /approve; a passive wallet is never asked for anything).
  // P0 universal execution (case D): the Editor's whole-workflow Authorize asks the browser wallet for ONE EIP-5792 wallet_sendCalls batch (Swap →
  // Supply → Borrow on Base), executed on the MOCKED user-funded chain double (https://127.0.0.1:8567) and reconciled; never sent twice.
  ['editor-wallet-batch', ['editor-wallet-batch.spec.ts', 'editor-stages-review.spec.ts'], { GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY',
    GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_USER_FUNDED_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_WORKFLOW_RUNS: 'enabled',
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the same user-funded harness with FLOFI_E2E_SINGLE_CARD — its database migrated through the certified
  // forward migrations up to `single_step_runs` (0029–0032, as an operator release leaves it) and its server without the local-fork runtime, as a
  // deployment — so ONE Base swap card is authorized with exactly ONE wallet_sendCalls (counted at the wallet double), reconciled by itself and
  // never resent; a declined batch is never retried and a wallet without atomic batching keeps the card's own flow. editor-wallet-batch keeps the
  // shipped schema.
  ['editor-single-card', ['editor-single-card.spec.ts'], { GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY', FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY',
    GRYLOO_BASE_MAINNET_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_USER_FUNDED_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_WORKFLOW_RUNS: 'enabled', FLOFI_E2E_SINGLE_CARD: 'MOCKED_LOOPBACK_ONLY',
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  ['approve-workflow-run', ['approve-workflow-run.spec.ts', 'editor-workflow-run.spec.ts'], { GRYLOO_MCP_E2E: 'EMBEDDED_LOOPBACK_ONLY', GRYLOO_CLOUD_RUNTIME_E2E: 'EMBEDDED_LOOPBACK_ONLY',
    FLOFI_SWAP_READ_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_SWAP_EXECUTION_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_WORKFLOW_RUNS: 'enabled',
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router (Solana ⇄ EVM mainnets, Canvas card, chat, Review, one owner signature, verified
  // delivery and evidence) on its MOCKED loopback chains and Relay double; the wallets are the test's own disposable in-memory keys.
  ['universal-bridge', ['universal-bridge.spec.ts'], { GRYLOO_UNIVERSAL_E2E: 'MOCKED_LOOPBACK_ONLY', FLOFI_COPILOT: 'replay' }],
  ['owner-history', ['--config', 'playwright.owner-history.config.ts'], { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-FLOFI-AUTH-WALLETS-001: FloFi accounts and FloFi Wallet on its own origin (sign-in, encrypted email codes, unlock, create, import,
  // export) against the MOCKED loopback identity and wallet provider (e2e/account-harness.ts) on a disposable PostgreSQL database.
  ['auth-wallets', ['--config', 'playwright.auth-wallets.config.ts'], { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres' }],
  // BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS01): the same suite in the public product's scope, where the account wallet lifecycle runs: a Google
  // user who skips Add wallets gets both wallets in /app, connected and copyable, without Credentials (MOCKED loopback Privy and database).
  ['auth-wallets-public', ['--config', 'playwright.auth-wallets.config.ts', '--grep', 'BETA-UX-INTELLIGENCE'], { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres', FLOFI_E2E_NETWORK_SCOPE: 'PUBLIC_MAINNET' }],
  // BUILD-FLOFI-FLIGHT-001: /board end to end (beta list, five states, invites, Founding seats, a pass from a real simulation) on the embedded runtime.
  ['flight', ['--config', 'playwright.flight.config.ts'], { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres', FLOFI_BETA_ACCESS: 'open' }],
  ['flight-team-early-access', ['--config', 'playwright.flight.config.ts', '--grep', 'temporary team access'], { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres', FLOFI_BETA_ACCESS: 'beta', FLOFI_FLIGHT_TEAM_E2E: 'MOCKED_LOOPBACK_ONLY' }],
  // Closed beta: board.spec.ts's direct product requests and returning sign-in, and (P0 hotfix, Flight transition) flight-transition.spec.ts —
  // the branded checking state, the server redirect of an admitted arrival, the refused board's own styles in light and dark, "could not
  // check your access" and a lost-access re-render handed off as a full navigation. Both files' closed-beta tests are titled "closed beta protects".
  ['flight-closed-beta', ['--config', 'playwright.flight.config.ts', '--grep', 'closed beta protects'], { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://flofi@127.0.0.1:5432/postgres', FLOFI_BETA_ACCESS: 'beta' }],
];
const composition = [['composition-provenance', ['release-composition-provenance.spec.ts'], {}]];

// Critical tier, run before every other browser profile in all CI systems (GitHub Actions: right after the build, before the unit,
// PostgreSQL and fork suites; CircleCI: at the head of browser job 1): Copilot learning and wallet isolation, Canvas basics, the P0
// wallet refusal and the financial Review/Execute boundaries.
const critical = ['copilot-learning', 'canvas-corrections', 'solana-wallet-refusal', 'supply-provenance', 'review-execute-recovery-components', 'solana-transfer-ux'];
// BUILD-FLOFI-CI-ARCHITECTURE-002: the other product profiles are placed in BROWSER_SHARDS shards (CircleCI runs one per browser job,
// certification-browser-1 … -N) by a deterministic balancer over the measured profile seconds in scripts/ci-browser-timings.json
// (scripts/ci_timings.py refreshes it from CircleCI's guarded reports). Shard 1 also carries the critical tier (browser job 1 runs it
// first) and the last shard the composition step, so both count as fixed load there. A profile without a measurement counts as the
// median measured profile, so a new profile needs no manual placement. Every extended profile lands in exactly one shard, and each
// shard runs shortest first, so fast financial boundaries report before long suites. GitHub Actions and Cloud Build run every shard.
const BROWSER_SHARDS = 8;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timings = JSON.parse(readFileSync(join(root, 'scripts/ci-browser-timings.json'), 'utf8'));
if (timings.kind !== 'flofi-browser-profile-timings' || timings.version !== 1 || !timings.profiles || typeof timings.profiles !== 'object'
  || Array.isArray(timings.profiles) || !Object.keys(timings.profiles).length
  || !Object.values(timings.profiles).every(value => Number.isFinite(value) && value > 0)
  || !Number.isFinite(timings.fixedShardSeconds?.composition) || timings.fixedShardSeconds.composition < 0) {
  throw new Error('scripts/ci-browser-timings.json must hold positive measured seconds per profile');
}
const measured = Object.values(timings.profiles).sort((a, b) => a - b);
const typical = measured[Math.floor(measured.length / 2)];
const estimate = name => timings.profiles[name] ?? typical;
const byTime = (a, b) => estimate(a) - estimate(b) || (a < b ? -1 : a > b ? 1 : 0);
function balance(profiles, count, fixed) {
  const loads = fixed.slice(), bins = loads.map(() => []);
  for (const name of [...profiles].sort((a, b) => byTime(b, a))) {
    const target = loads.indexOf(Math.min(...loads));
    bins[target].push(name);
    loads[target] += estimate(name);
  }
  // Move or swap a profile off the most loaded shard while that strictly lowers its load and keeps the other shard below it.
  for (let round = 0; round < 10000; round++) {
    const top = loads.indexOf(Math.max(...loads)), limit = loads[top] - 1e-9;
    let change = null;
    search: for (const name of [...bins[top]].sort(byTime)) {
      for (let other = 0; other < count && !change; other++) {
        if (other === top) continue;
        if (loads[other] + estimate(name) < limit) { change = [name, other, null]; break search; }
        for (const swap of [...bins[other]].sort(byTime)) {
          const delta = estimate(name) - estimate(swap);
          if (delta > 0 && loads[other] + delta < limit) { change = [name, other, swap]; break search; }
        }
      }
    }
    if (!change) break;
    const [name, other, swap] = change, delta = estimate(name) - (swap ? estimate(swap) : 0);
    bins[top].splice(bins[top].indexOf(name), 1);
    bins[other].push(name);
    if (swap) { bins[other].splice(bins[other].indexOf(swap), 1); bins[top].push(swap); }
    loads[top] -= delta;
    loads[other] += delta;
  }
  return bins.map(bin => bin.sort(byTime));
}
const extendedProfiles = definitions.map(([name]) => name).filter(name => !critical.includes(name));
const fixedLoad = Array.from({ length: BROWSER_SHARDS }, (_, index) => (index === 0 ? critical.reduce((sum, name) => sum + estimate(name), 0) : 0)
  + (index === BROWSER_SHARDS - 1 ? timings.fixedShardSeconds.composition : 0));
const shards = balance(extendedProfiles, BROWSER_SHARDS, fixedLoad);
// Fail closed on any plan drift: every product profile runs in exactly one place, and every name in the plan exists.
const names = definitions.map(([name]) => name), planned = [...critical, ...shards.flat()];
if (new Set(names).size !== names.length || planned.length !== names.length || new Set(planned).size !== planned.length
  || !planned.every(name => names.includes(name))) throw new Error('Guarded browser plan must place every product profile exactly once');

const byName = new Map([...definitions, ...composition].map(entry => [entry[0], entry]));
const extended = shards.flat();
let selection, shard = null;
if (phase === 'critical' && !rest.length) selection = critical;
else if (phase === 'extended' && !rest.length) selection = extended;
else if (phase === 'extended' && rest.length === 2 && rest[0] === '--shard' && /^\d+\/\d+$/.test(rest[1])) {
  const [index, total] = rest[1].split('/').map(Number);
  if (total !== shards.length || index < 1 || index > total) throw new Error(`Guarded browser shard must be 1/${shards.length} … ${shards.length}/${shards.length}`);
  selection = shards[index - 1];
  shard = rest[1];
} else if (phase === 'product' && !rest.length) selection = [...critical, ...extended];
else if (phase === 'composition' && !rest.length) selection = composition.map(([name]) => name);
else if (phase === 'profile' && rest.length === 1 && byName.has(rest[0])) selection = rest;
else if (phase === 'list' && !rest.length) {
  // The plan only (no command runs); the database URL is shown as a placeholder.
  const profiles = Object.fromEntries([...byName.values()].map(([name, specs, settings]) => [name, { specs, settings: Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, key === 'TEST_DATABASE_URL' ? '<TEST_DATABASE_URL>' : value])) }]));
  const shardSeconds = shards.map((bin, index) => Math.round(fixedLoad[index] + bin.reduce((sum, name) => sum + estimate(name), 0)));
  console.log(JSON.stringify({ critical, shards, shardSeconds, extended, product: [...critical, ...extended], composition: composition.map(([name]) => name), profiles }, null, 2));
  process.exit(0);
} else throw new Error(usage);
const label = shard ? `${phase}-shard-${shard.replace('/', '-of-')}` : phase === 'profile' ? `profile-${rest[0]}` : phase;

const results = join(root, 'apps/reference-dapp/test-results');
// The ledger accepts only reports of the revision it certifies (scripts/ci-observe.py verify).
const revision = [process.env.FLOFI_CI_REVISION, process.env.CIRCLE_SHA1, process.env.GITHUB_SHA].find(value => /^[0-9a-f]{40}$/.test(value ?? ''))
  ?? (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim();
const report = { kind: 'guarded-browser', phase, shard, label, revision: /^[0-9a-f]{40}$/.test(revision) ? revision : 'UNKNOWN', status: 'RUNNING',
  profiles: selection.map(name => ({ name, specs: byName.get(name)[1], status: 'NOT_RUN', seconds: null, exitCode: null })) };
const reportFiles = [join(results, `guarded-${label}.json`), ...(process.env.RUNNER_TEMP ? [join(process.env.RUNNER_TEMP, 'flofi-ci-metrics', 'browser', `${label}.json`)] : [])];
function writeReport() {
  for (const file of reportFiles) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); }
}
function printTimings() {
  const ran = report.profiles.filter(row => row.seconds !== null);
  console.log(`Guarded release ${label} timings (slowest first; total ${ran.reduce((sum, row) => sum + row.seconds, 0).toFixed(2)}s):`);
  for (const row of [...ran].sort((a, b) => b.seconds - a.seconds)) console.log(`  ${row.seconds.toFixed(2).padStart(8)}s  ${row.status}  ${row.name}`);
}
const rel = path => relative(root, path);
let failureExitCode = 0;
writeReport();
console.log(`Guarded release ${label}: ${selection.length} profiles: ${selection.join(', ')}`);

for (const [index, name] of selection.entries()) {
  // BUILD-FLOFI-CI-ARCHITECTURE-002: on CircleCI (FLOFI_CI_SUPERSEDE_CHECK=1) a revision that a newer push of its pull-request branch
  // superseded stops between profiles (scripts/ci_supersede.py; never on main). The report stays SUPERSEDED with the remaining profiles
  // NOT_RUN, so the certification ledger can never count it.
  if (index && process.env.FLOFI_CI_SUPERSEDE_CHECK === '1'
    && spawnSync('python3', [join(root, 'scripts/ci_supersede.py')], { stdio: 'inherit' }).status === 75) {
    report.status = 'SUPERSEDED';
    writeReport();
    printTimings();
    console.error(`Guarded release ${label}: SUPERSEDED before profile ${name}; not run (never counted as passes): ${report.profiles.filter(other => other.status === 'NOT_RUN').map(other => other.name).join(', ')}`);
    process.exit(75);
  }
  const [, specs, settings] = byName.get(name), row = report.profiles[index];
  const env = { ...process.env, GRYLOO_MODE_A_E2E: 'synthetic' };
  for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_ADMIN_OPERATIONS_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_FINOPS_WORKER_URL',
    'FLOFI_COPILOT', 'FLOFI_RELEASE_PROVENANCE_PROFILE', 'GRYLOO_SUPPLY_E2E', 'GRYLOO_LENDING_E2E',
    'GRYLOO_JUPITER_E2E', 'GRYLOO_SOLANA_DEVNET_E2E', 'GRYLOO_ROBINHOOD_E2E', 'GRYLOO_ROBINHOOD_MAINNET_E2E', 'GRYLOO_BASE_MAINNET_E2E', 'GRYLOO_UNISWAP_LIQUIDITY_E2E',
    'GRYLOO_ROUTER_E2E', 'GRYLOO_ROUTER_TESTNET_E2E', 'GRYLOO_CLOUD_RUNTIME_E2E', 'FLOFI_SWAP_READ_E2E', 'FLOFI_SWAP_EXECUTION_E2E', 'GRYLOO_COW', 'GRYLOO_CARD_E2E', 'GRYLOO_AUTOMATION_E2E', 'GRYLOO_DELEGATION_E2E',
    'FLOFI_FLIGHT_TEAM_E2E', 'FLOFI_FLIGHT_TEAM_CLOCK', 'FLOFI_FLIGHT_TEAM_ACCOUNTS', 'FLOFI_ADMIN_E2E', 'FLOFI_LEARNING_E2E', 'GRYLOO_MCP_E2E', 'GRYLOO_CHANNEL_E2E', 'FLOFI_E2E_DATABASE_URL', 'FLOFI_WORKFLOW_RUNS', 'FLOFI_E2E_NETWORK_SCOPE', 'FLOFI_NETWORK_SCOPE',
    'FLOFI_USER_FUNDED_E2E', 'FLOFI_E2E_SINGLE_CARD', 'FLOFI_E2E_DEVELOPER_CONSOLE', 'FLOFI_CANDIDATE_BASELINES', 'FLOFI_LIQUIDITY_POSITIONS_E2E', 'GRYLOO_BASE_JOURNAL', 'FLOFI_ORCA_POSITIONS_E2E',
    'GRYLOO_ORCA_MAINNET_JOURNAL',
    // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001: local visual-evidence switches never reach a certifying profile.
    'FLOFI_UX_EVIDENCE_DIR', 'FLOFI_UX_EVIDENCE_LANG', 'FLOFI_UX_EVIDENCE_PREFIX']) delete env[key];
  Object.assign(env, settings);
  // Each profile keeps its own artifacts (a later profile never wipes them) and its own JUnit file for the CI test report.
  const output = join(results, name), junit = join(results, 'junit', `${name}.xml`);
  console.log(`Guarded release profile: ${name}`);
  const started = performance.now();
  const result = spawnSync('pnpm', ['--filter', '@defi-workflow-engine/reference-dapp', 'exec', 'playwright', 'test', ...specs, '--output', output, '--add-reporter', 'junit'],
    { env: { ...env, PLAYWRIGHT_JUNIT_OUTPUT_FILE: junit }, stdio: 'inherit' });
  Object.assign(row, { seconds: (performance.now() - started) / 1000, exitCode: result.status, status: result.error || result.status !== 0 ? 'FAIL' : 'PASS' });
  if (existsSync(junit)) writeFileSync(junit, ciTestReport(readFileSync(junit, 'utf8'), name));
  writeReport();
  console.log(`Guarded release profile duration: ${name}: ${row.seconds.toFixed(2)}s; ${row.status}`);
  if (row.status === 'FAIL') {
    report.status = 'FAIL';
    writeReport();
    const shown = Object.entries(settings).map(([key, value]) => `${key}=${key === 'TEST_DATABASE_URL' ? '<loopback>' : value}`).join(' ') || '(none)';
    console.error([`Guarded release FAIL: profile ${name} (${label}), ${result.error ? `could not start: ${result.error.message}` : `exit code ${result.status ?? `signal ${result.signal}`}`}.`,
      `  Specs: ${specs.join(' ')}`, `  Settings: ${shown}`, `  Artifacts: ${rel(output)} (failure screenshots, error context), JUnit ${rel(junit)}`,
      `  Reproduce: node scripts/guarded-release-browser.mjs profile ${name}`,
      `  Not run (never counted as passes): ${report.profiles.filter(other => other.status === 'NOT_RUN').map(other => other.name).join(', ') || 'none'}`].join('\n'));
    diagnose(name, specs, env, output);
    printTimings();
  }
  if (row.status === 'FAIL') {
    failureExitCode ||= result.status || 1;
    if (!collectFailures) {
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
report.status = failureExitCode ? 'FAIL' : 'PASS';
writeReport();
printTimings();
console.log(`Guarded release ${label}: ${report.status} (${selection.length} profiles)`);
process.exitCode = failureExitCode;

/**
 * The profile's JUnit for the CI test report. One spec can run in several profiles (the financial boundary runs in ten), so the profile
 * names each suite and class. A passing test's captured output (already in the step log) is dropped: CircleCI lists a passing test case
 * that carries output as "system-out" instead of a pass. Failing and skipped cases keep everything.
 */
function ciTestReport(xml, name) {
  return xml.replaceAll('<testsuite name="', `<testsuite name="${name} › `).replaceAll(' classname="', ` classname="${name} › `)
    .replace(/<testcase\b[^>]*[^/]>[\s\S]*?<\/testcase>/g, testcase => /<(failure|error|skipped)\b/.test(testcase) ? testcase
      : testcase.replace(/\s*<system-(out|err)>[\s\S]*?<\/system-\1>/g, ''));
}

/**
 * After a profile has already failed, re-runs only its failed tests once with a full trace, for diagnosis. Its outcome never changes the
 * profile's result or the exit code (a pass here only reports that the failure is intermittent). Tracing every run instead would cost
 * about a quarter more browser time (measured +26% on review-execute-recovery-components). FLOFI_BROWSER_FAILURE_TRACE=off skips it.
 */
function diagnose(name, specs, env, output) {
  if (process.env.FLOFI_BROWSER_FAILURE_TRACE === 'off') return;
  const lastRun = join(output, '.last-run.json');
  let failed = [];
  try { failed = JSON.parse(readFileSync(lastRun, 'utf8')).failedTests ?? []; } catch { /* no test recorded */ }
  if (!existsSync(lastRun) || !failed.length) {
    console.error('  Diagnostic trace: no failed test was recorded (the failure is outside a test: configuration, global setup or a server start); see the log above.');
    return;
  }
  const traces = `${output}-trace`;
  console.error(`  Diagnostic trace rerun of ${failed.length} failed test(s), never counted as a pass: ${rel(traces)}`);
  const rerun = spawnSync('pnpm', ['--filter', '@defi-workflow-engine/reference-dapp', 'exec', 'playwright', 'test', ...specs, '--last-failed', '--last-failed-file', lastRun,
    '--trace', 'on', '--output', traces, '--max-failures', '3', '--global-timeout', '300000'], { env, stdio: 'inherit' });
  console.error(`  Diagnostic trace rerun ${rerun.status === 0 ? 'passed: the failure is intermittent; the profile stays FAILED' : 'failed again'}; traces in ${rel(traces)} (open with \`pnpm exec playwright show-trace <trace.zip>\`).`);
  const diagnostic = report.profiles.find(row => row.name === name).diagnostic = { rerunExitCode: rerun.status, traces: rel(traces) };
  writeReport();
  // BUILD-FLOFI-CI-ARCHITECTURE-002: a screenshot difference stops its test, so the test's later screenshots only render after the first
  // one matches (one audited pull request needed seven certifications for that). After a difference, the failed tests run once more with
  // every snapshot redirected into an empty candidate directory (FLOFI_CANDIDATE_BASELINES, read only by playwright.config.ts): each
  // screenshot is written instead of compared, so one run stores CI's renders of all of them as artifacts. The committed baselines are
  // neither read nor written, the result is never a pass, and certifying runs never set the variable.
  if (!readdirSync(output, { recursive: true }).some(file => String(file).endsWith('-diff.png'))) return;
  const candidates = `${output}-candidate-baselines`;
  const render = spawnSync('pnpm', ['--filter', '@defi-workflow-engine/reference-dapp', 'exec', 'playwright', 'test', ...specs, '--last-failed', '--last-failed-file', lastRun,
    '--update-snapshots=all', '--output', `${output}-candidate-run`, '--max-failures', '3', '--global-timeout', '300000'],
    { env: { ...env, FLOFI_CANDIDATE_BASELINES: candidates }, stdio: 'inherit' });
  console.error(`  Candidate baselines: every screenshot of the failed tests as rendered here, in ${rel(candidates)} (same layout as e2e/; review and`
    + ` copy only intended changes; never compared, never a pass; render exit ${render.status}).`);
  Object.assign(diagnostic, { candidateBaselines: rel(candidates), candidateExitCode: render.status });
  writeReport();
}
