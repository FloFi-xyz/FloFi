# BUILD-SOLANA-TRANSFER-UX-001 — release (2026-10-20)

Owner instruction of 2026-10-20: finish the build, certify it once more on the existing Google Cloud Build setup, isolate the Vercel
Preview from the production database, open the PR, obtain the required GitHub checks and merge. This record supersedes the HOLD
statements in the [handoff](BUILD-SOLANA-TRANSFER-UX-001-HANDOFF.md) and [audit](BUILD-SOLANA-TRANSFER-UX-001-AUDIT.md).

## 1. Last failure: `canvas-automation-ux` lending parity

Cloud Build `bb114c46-593a-4d9e-92ec-c686427c1b9a` failed only `canvas-automation-ux.spec.ts` "Canvas parity without Advanced
action setup: lending": 30-second test deadline, `openProposalReview` waiting for `Review proposed change:` that never appeared.
Every other stage and the other 44 browser profiles passed.

**Cause: a test race, not a product defect.** The test clicked "Add Supply → Borrow → Swap" immediately after `goto('/app')`.
Supply/Borrow/Repay and the lending composition bind the connected owner as beneficiary (`canvasAddCommand` →
`AUTHOR_LENDING { owner }`). The injected wallet is recognized by the store's passive reconnect (`eth_accounts`/`eth_chainId`
after hydration). On a slow 2-vCPU worker the click can land first; the Canvas then refuses honestly ("Connect your wallet to set
the beneficiary before adding this action.") and creates no proposal, so the Review button never exists.

A throwaway diagnostic spec (not committed) proved it deterministically: with `eth_accounts` delayed 4 s, the click shows exactly
that refusal and no Review button; waiting for the connected wallet first yields the proposal. `lending-composition.spec.ts`
already waits for the wallet before the same click.

**Fix (tests only, no assertion weakened):** `canvas-automation-ux.spec.ts` parity tests and the `canvas-cta.spec.ts` Supply
lifecycle test (same latent race) wait for `.build009-wallet-info` to carry the connected owner before adding an owner-bound action.
Product code is unchanged; the refusal remains the correct fail-closed behavior.

Verification: the complete guarded profile `canvas-automation-ux` passed **5/5 fresh invocations, 18/18 tests each** with CPU
affinity `0,1` inherited by browser, app and harnesses (32.2–33.5 s each).

## 2. A9 agent rollout stays gated

The audit's A9 scope (Orca liquidity on Solana mainnet-beta and native ETH self-transfers on Ethereum Sepolia / Robinhood Chain
Testnet, newly reachable through the Copilot, MCP, channels and the Developer API) had no owner approval. A read-only check of the
deployed configuration (keys and non-secret mode flags only) showed the existing runtime flags those flows use are already on in
production (`GRYLOO_ORCA_MAINNET=live`, `GRYLOO_ORCA_MAINNET_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`,
`GRYLOO_ETHEREUM_SEPOLIA_TRANSFER=live`, `GRYLOO_ROBINHOOD_TESTNET=live` on Railway; the Canvas uses them under earlier approvals).
Runtime and policy opt-ins therefore did **not** gate A9; merging would have released it.

`src/domain/agent-rollout.ts` now gates it in code:

- `policyGate` refuses any handoff whose plan contains a pending capability with `AGENT_ROLLOUT_NOT_APPROVED`. All agent surfaces
  (MCP `request_user_approval`, Telegram/WhatsApp channels, Developer API sandbox) reach execution only through this gate.
- The Copilot's networks per action, its in-app capability answer and its model instructions exclude pending rollouts, so it
  proposes none of them ("Orca" alone again means Solana Devnet, as on `main`).
- `AGENT_ROLLOUT_APPROVED` is empty. No environment variable can release it; approval is a reviewed change to that constant. Tests
  pass the approval explicitly to keep the preserved implementation covered, and assert the default refusal.
- The Canvas keeps its own, separately approved controls for the same actions.

New Solana transfers (this build's scope) remain gated by their own runtime flag (`GRYLOO_SOLANA_TRANSFER`, unset in production),
owner-execution switch and policy.

## 3. Vercel Preview isolation

Read-only project metadata (`flofi`, root `apps/reference-dapp`, no Ignored Build Step, no deploy hooks) still shows one
`DATABASE_URL` targeting Production **and** Preview, with no branch override. `apps/reference-dapp/vercel.json` now adds
`git.deploymentEnabled: { "claude/build-solana-transfer-ux-001": false }`: Git pushes of this exact branch create no deployment,
so no Preview of this branch can reach the production database. Every other branch, including `main`, keeps its current
behavior (validated against Vercel's published schema). No project setting, environment variable or production configuration
was changed.

## 4. Certification, CI and merge

Recorded after the run in section 5.

## 5. Results

Pending.
