# BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001 — Report

Branch `claude/focused-ptolemy-xr1cf2`, from `main` `d4776c8`. Nothing was deployed, migrated, configured or activated. No transaction was
signed or sent, and no production environment variable was changed.

Three workstreams, kept in separate commits:

1. **Single authorization for Swap → Supply → Borrow on Arbitrum One.** The existing delegated mechanism is extended to Aave V3 and to an
   explicitly opted-in mainnet.
2. **Simulate controls.** The Canvas navigator and the Simulate/Execute actions can no longer overlap.
3. **Enter applies Aave amounts.** Ordinary Supply, Borrow, Repay and Withdraw amount edits apply on Enter, with no Review/Apply proposal.

## 1. Single authorization (workstream 1)

### What "one authorization" is here

FloFi already had a single-authorization mode for workflow runs (BUILD-CHAT-E2E-001 on top of BUILD-AUTOMATION-002):

- **Execution.** A delegated executor signs each step with a session key, as an ERC-7710 redemption, against an on-chain grant. The owner's
  MetaMask EIP-7702 smart account signed that grant once, at Credential enrollment.
- **Authorization.** The owner authorizes a whole workflow run with **one passkey assertion** over a one-shot Universal Workflow
  Authorization. Its limits:
  - the exact workflow hash;
  - per-asset caps equal to the workflow's own amounts;
  - the workflow's own slippage;
  - one execution;
  - at most 24 hours.

This build adds the actions and the network the requested workflow needs. It does not add a second mechanism.

| Owner action | When | What it is |
| --- | --- | --- |
| Upgrade the wallet to a MetaMask smart account (EIP-7702) | Once per wallet | MetaMask's own flow; FloFi never upgrades an account |
| Register a passkey | Once per owner | WebAuthn |
| Enroll a Credential for Arbitrum One | Once per chain until it expires (≤ 1 year) | **One wallet signature** (`eth_signTypedData_v4`) of an ERC-7710 grant: the swap pair, Aave Supply/Borrow assets, per-call limits, number of calls, expiry |
| Authorize the workflow | Per workflow | **One passkey assertion**. No wallet signature during execution |

One authorization is **not** one transaction. Each step submits its own redemptions and pays its own gas:

| Step | Transactions |
| --- | --- |
| Swap | 2 (exact approval, `exactInputSingle`) |
| Supply | 2 (exact approval, `supply`) |
| Borrow | 1 (`borrow`) |

### Enforcement: on chain vs in the executor

**On chain** (MetaMask Delegation Framework v1.3.0 caveats of the owner-signed grant, applied to every redemption):

- Grant-wide: the redeemer is this grant's session key; validity window; total number of calls; zero native value.
- Swap: router, `exactInputSingle`, the token pair, recipient = the owner's wallet, at most the per-call input leaving the wallet.
- Supply: the Aave V3 Pool, `supply`, the asset, `onBehalfOf` = the owner (their own position), no referral, at most the per-call cap
  leaving the wallet.
- Borrow: the Pool, `borrow`, the asset, **variable rate only**, no referral, `onBehalfOf` = the owner, the borrowed asset must arrive in
  the owner's wallet, and the amount must be below a **byte-aligned ceiling**. The ceiling pins the amount word's leading bytes to zero. For
  example, a 1 USDC cap gives a ceiling of 2²⁴ raw units, about 16.77 USDC.

**In the executor**, re-verified before every signature (the existing BUILD-AUTOMATION-002 pipeline):

- the exact workflow hash, the passkey assertion, and every grant re-read on chain (not disabled, not expired, still upgraded);
- each step's **exact** amount: a bound Supply spends `min(cap, the Swap's reconciled WETH)`, never an estimate;
- the **exact Borrow cap**;
- a fresh simulation from real chain state, with every Aave rule of the owner-signed lending flows:
  - reserve active, unpaused and unfrozen;
  - supply and borrow caps, and liquidity;
  - collateral enabled; isolation, siloed and E-Mode refused;
  - borrowing capacity;
  - **health factor ≥ 2.0 before and after the Borrow**. The one-shot manifest of a borrowing workflow carries this floor, and the policy
    re-checks it.

**Why the Borrow cap is not exact on chain.** Framework v1.3.0 has no "argument ≤ x" enforcer. A reusable grant therefore cannot pin a
per-workflow Borrow amount on chain. A compromised session key could at worst borrow below the ceiling for the owner's own account, at a
variable rate, with the USDC landing in the owner's wallet. Aave's own HF ≥ 1 check applies, within the grant's call count and expiry.

Pinning the exact amount on chain would need a workflow-scoped delegation (per-workflow wallet signature plus `IdEnforcer` single-use
groups). That is a new mechanism, needing a schema change and owner review, and it is not built here.

### Continuation, idempotency and halting (existing, now covering Aave)

- **Ordering.** A step starts only after the previous one reconciled.
- **Recording.** Signed bytes are persisted before broadcast and never re-signed. Recovery re-broadcasts the same bytes and reconciles. An
  Aave step is rebuilt from its own persisted Pool call (asset and amount from the calldata).
- **Reconciliation.**
  - Supply: exactly the authorized amount moved from the owner's wallet into the reserve's aToken.
  - Borrow: exactly the authorized amount moved from the aToken to the owner. The account's health factor after the Borrow is recorded as
    evidence.
- **Unsafe or unsupported state stops the run before signing.** Examples: HF below the floor, capacity, liquidity, caps, a frozen reserve,
  too little WETH, an account that is not the smart account, a call outside the grant.
- **Run states.** BLOCKED (nothing irreversible done), HALTED (after a reconciled step), or ATTENTION (outcome unknown, observed and never
  resubmitted). Revocation stops future steps.

### Deployment opt-in (closed by default)

`FLOFI_DELEGATION_MAINNET_CHAINS=eip155:42161` (web and worker, together with `FLOFI_DELEGATION=enabled`):

- **Default.** Without it, every mainnet step stays `MAINNET_DELEGATION_DISABLED`, exactly as before.
- **Fail closed.** Any other value disables delegation (`DELEGATION_CONFIGURATION_INVALID`).
- **Public product.** It is the only way delegation turns on in the public Mainnet-only product, and never with a test harness.
- **No signer.** It does not provide a signer.

### Capability matrix (code and deployment, today)

| Wallet / network | Swap → Supply → Borrow, single authorization | Owner authorizations |
| --- | --- | --- |
| MetaMask (EIP-7702 smart account), Arbitrum One, deployment opted in **and** with a production signer | Supported by code | Setup once: smart account, passkey, 1 Credential signature. Then **1 passkey assertion per workflow**, 0 wallet signatures during execution |
| Same, on today's hosted FloFi deployments | **Not available**: no production signer (`DELEGATED_SIGNER_UNAVAILABLE`) | Confirm each step instead (below) |
| MetaMask EOA (not upgraded) | Not available (`EVM_ACCOUNT_NOT_UPGRADED`) | Confirm each step |
| FloFi wallet (Privy embedded EOA) | **Not available**: no `eth_signTypedData_v4`, no EIP-7702 | Confirm each step |
| Other EVM wallets | Only if they are MetaMask Delegation Framework v1.3.0 EIP-7702 smart accounts | Otherwise confirm each step |
| Base, Ethereum mainnet | Not available (`MAINNET_DELEGATION_DISABLED`; only Arbitrum One is implemented) | Confirm each step |
| Solana | Not available (production builder not implemented) | Confirm each step |

**Confirm each step** stays the explicitly labelled alternative. Each step gets its own fresh simulation, Review and wallet confirmation:

| Step | Wallet confirmations |
| --- | --- |
| Swap | 2 (approval, swap) when an approval is needed |
| Supply | 2 (approval, supply) |
| Borrow | 1 |

So **3 at least and typically 5**. The authorization plan reports "at least 3".

### Product surfaces

- **`/approve` run panel** (existing). It shows:
  - the complete workflow, the two modes with their counts, and why "Authorize once" is unavailable;
  - the passkey limits before signing, now including the **Borrow health-factor floor**;
  - every step's state and transaction hashes, and revocation.
- **Credentials.** Where the deployment opted Arbitrum One in, an EVM Credential can add Aave Supply WETH / Borrow USDC per-call limits.
  The form shows a real-funds and smart-account notice. The grant card shows the Aave scope and the on-chain Borrow ceiling.
- **Editor.** The sequence note names its mode explicitly ("Confirm each step · Step k of n …"). It never claims single authorization.

### Gaps that remain (owner decisions or infrastructure)

1. **Production signer custody.** No hosted deployment can sign delegated steps: there is no KMS/HSM session-signer provider, and memory
   and disposable signers are refused when hosted. This blocks any real single-authorization execution. It needs an owner decision on the
   custody provider (for example Cloud KMS secp256k1 keys), key provisioning and IAM, and a reviewed provider implementation.
2. **Editor → workflow run.** Workflow runs are created only from approval handoffs (MCP, channels, Developer API, automations). Starting
   the delegated run directly from the Editor needs an Editor requester kind with its own handoff policy. That means a schema migration
   (requester-kind constraint) through the release-certificate process, and an owner decision on that policy. It is not built here. Today a
   Swap → Supply → Borrow composed in the chat or over MCP reaches `/approve` with both modes. The same workflow built on the Canvas runs
   step by step.
3. **Exact on-chain Borrow cap.** See the enforcement section above: it needs a workflow-scoped delegation.
4. **Public mainnet acceptance** has not been performed (see §4).

## 2. Simulate controls (workstream 2)

**Root cause.** The Canvas navigator was centred absolutely, and moved up by a fixed 44 px only when the pane was narrower than 1024 px. The
Simulate actions were positioned absolutely at the bottom right. In a multi-step workflow, the "Step k of n" note sat in a column above
Simulate workflow. That widened the action block and pushed **Back to the Canvas** left, under the centred navigator. Longer Portuguese labels
did the same.

**Fix.** The Simulate/Execute plan's bottom controls are now one React Flow panel laid out by normal flow. Nothing is offset against another
control:

- the navigator on its own centred line;
- then Back to the Canvas immediately left of the primary action, bottom-right;
- notes on their own right-aligned line above the buttons, never taking the pointer from a card.

The fitted viewport reserves the measured height of the controls, so no control or note covers a card at fit. Keyboard order follows the
visual order: navigator, Back, primary action. Light and dark themes share the navigator styling.

**Tests.** `e2e/simulate-canvas-controls.spec.ts` is added to the `default-product` profile:

- geometry at 12 widths from 1440 to 320 px, in light and dark;
- a multi-step workflow with its step note, in EN and PT;
- clickability: each control is the element under its centre;
- keyboard order, and the navigator still works;
- element screenshot baselines.

## 3. Enter applies Aave amounts (workstream 3)

**Root cause.** The Aave card's amount input carried `form="composer-supply-review-*"`. That bound it to the inspector's hidden review form,
so Enter submitted `reviewCanvasAmount` (a proposal), never the card's direct `commitCanvasAmount`. Aave cards also had no card-local form of
their own.

**Fix.** An ordinary amount edit of an existing Supply, Borrow, Repay or Withdraw card now behaves like Swap and Bridge. Its card has its own
form, so Enter (or leaving the card) applies the amount with one history-guarded command:

- the same step id, asset, network and links;
- a new workflow revision, which makes the previous Simulation, Review and authorization stale;
- no proposal, and no wallet request.

Invalid amounts (0, negative, malformed, too many decimals) are refused inline and change nothing.

**Review/Apply is kept** where the edit is more than an amount:

- a reserve or network picked on the card (never a silent re-denomination);
- a proposal already waiting (for example from the chat);
- a Send (its recipient);
- new cards still being configured;
- settings-form changes to network, asset or beneficiary. These now show their own Review button. Enter in the settings amount field
  applies directly.

**Tests.**

- `domain/lending-direct-amount.test.ts`: Arbitrum One Swap → Supply → Borrow authored through the Canvas; Supply 0.0013 → 0.0010 WETH
  and Borrow 1 → 0.5 USDC applied with links, funding and revision; invalid amounts refused; idempotent.
- `e2e/canvas-lending-amount-enter.spec.ts` (`arbitrum-authoring-certification` profile): chat-authored Supply, Borrow, Repay and Withdraw
  on Arbitrum One with Enter; WETH; pointer blur; invalid amounts.

**Intentional test changes, flagged for review.** These specs encoded the old Review/Apply flow for ordinary amount edits and now assert the
new contract:

- `build-correction.test.tsx`;
- `borrow`, `repay`, `withdraw`, `workflow-composer`, `composer-product-cleanup` and `global-product-polish` specs;
- `supply-fixtures.authorSupply`.

Most of these specs are not in a CI profile. None was deleted or skipped.

## 4. Evidence levels

| Level | What |
| --- | --- |
| Automated, MOCKED | Unit tests (compiler templates and the enforcer model; the capability-to-reconciliation chain, with the Aave readers stubbed at the module boundary). PostgreSQL integration suites for the delegation and workflow-run stores and executor (unchanged behavior, passing). Playwright on loopback (no public network) |
| Verified mainnet reads | **None in this build.** This environment's network policy blocks public Arbitrum RPC. Every address comes from the repository's existing verified registries (Uniswap v3 Arbitrum profile; Aave V3 Arbitrum market). The MetaMask Delegation Framework v1.3.0 deployment list (official repository, tag v1.3.0) names Arbitrum One. `IdEnforcer` was checked there but is not used |
| Public mainnet transactions | **None.** No real-money transaction was signed or sent. Single authorization on mainnet is not proven |
| Unsupported | See the capability matrix in §1 |

## 5. Required configuration and infrastructure

- `FLOFI_DELEGATION=enabled` and `FLOFI_DELEGATION_MAINNET_CHAINS=eip155:42161` on web and worker.
- `FLOFI_DELEGATION_RPC_42161`: an HTTPS Arbitrum One RPC for the executor and grant reads.
- `FLOFI_WORKFLOW_RUNS=enabled`.
- A **production session-signer provider**, which does not exist yet (§1, gap 1).
- No schema change, and no new dependency.

## 6. Validation

See the pull request for the exact commands and results of this build's gates.
