# FloFi UX 004

Base: `639912515e848f94ebd6b18438ae63c354b1db80`, branch `feat/flofi-ux-004`.
The worktree was clean at investigation; no additional worktree was created.

## Implementation map

- Dashboard: `components/dashboard/portfolio-widget.*` presents the existing
  `server/wallet-portfolio.ts` read model. Exact cents and existing verified
  token pricing remain authoritative. Network allocation/filtering live in
  `domain/wallet-portfolio.ts`; unavailable valuations remain null.
- Automations: `components/automations-workspace.tsx` presents real capabilities,
  guides the existing version-1 manifest through action, timing and review, and
  calls the existing owner-scoped `createAutomation` action. Scheduled DCA,
  price crossing and scheduled price watch use the existing worker/scheduler.
- Session continuity: `server/automation-operation.ts` uses the same verified
  account-held-wallet principals as history/library management. A connected
  address alone grants nothing. Membership, tenant and account-session validity
  are rechecked server-side. Approval claim/apply, delegation, simulation and
  transaction signing retain their existing proof and authorization boundaries.
- Chat: existing typed automation interpretation, deterministic grounding and
  `createAutomation` persistence are retained. Explicit EN/PT weekly weekdays
  now map to the existing weekly schedule; absent times and ambiguous schedules
  require clarification. Manual creation and chat review display proposal limits.
- Workflow records: existing library/history projections and disposition APIs
  remain the source. Rows disclose existing metadata on request. Ellipsis menus
  retain archive semantics, irreversible-delete confirmation and server checks.

No dependencies, database schema, migrations, production configuration or
transaction execution code are added. Test data exists only in isolated test
harnesses. Mainnet-only public scope remains enforced by the existing policy.

## Deployment findings and operator actions

`MAINNET_HANDOFF_DISABLED_BY_POLICY` is intentional: the default mainnet handoff
allowlist is empty. If the operator approves proposal handoff, configure
`FLOFI_AUTOMATION_HANDOFF_MAINNET_NETWORKS` on the actual automation runtime with
only the approved supported network identifiers (current automation route
catalog: `base`, `ethereum`, `solana`). This allows a proposal to be handed to its
owner; it grants no signing authority. Existing flow/runtime, owner-execution,
recording, wallet namespace, simulation and approval gates still apply. Other
mainnets supported elsewhere in FloFi are not automatically automation routes.

Prices default to off. To enable real observations, the operator configures:

- `FLOFI_AUTOMATION_PRICE_SOURCE=chainlink`.
- `FLOFI_AUTOMATION_CHAINLINK_FEEDS`: the intended `ETH=…`, `BTC=…`, `SOL=…`
  USD proxy addresses on Base. The existing source verifies feed identity,
  decimals, positive/fresh observations and round completeness on-chain.
  Stablecoin feeds used for portfolio valuations are not watch/trigger assets.
- `FLOFI_AUTOMATION_CHAINLINK_RPC_URL`: optional Base mainnet RPC; otherwise the
  existing `GRYLOO_BASE_RPC_URL` fallback, then `https://mainnet.base.org` applies.
- `FLOFI_AUTOMATION_PRICE_MAX_AGE_SECONDS`: optional, default `3600`, allowed
  `60`–`86400`; stale or failed observations never become assumed prices.

Apply source configuration consistently to the actual worker/runtime. Existing
runtime setup also requires `FLOFI_AUTOMATIONS`, `FLOFI_PUBLIC_ORIGIN`, dedicated
`FLOFI_AUTOMATION_SECRET`, durable storage and scheduler invocation. Dispatch
requires `FLOFI_AUTOMATION_DISPATCH_TOKEN_SHA256` (the digest of the scheduler's
bearer; `CRON_SECRET` where Vercel Cron provides that bearer). These are existing
operator requirements, not new variables introduced by this PR. Missing schema
continues to fail closed; install existing platform migrations through the
operator's established process if that deployment has not installed them.

No configuration was changed by this work. No secret values are recorded here.

## Execution capability limits

Public mainnet `Automatic within limits` remains unavailable:
`delegation/config.ts` refuses it under `MAINNET_ONLY_PRODUCT`, and hosted
signers have no implemented KMS/HSM path. There is no supported production
variable that makes that authority safe. The existing isolated delegated tests
prove only their loopback engineering behavior. The UI keeps the mode disabled;
this PR does not introduce delegated signing or claim automatic public execution.

Ask-every-time automation checks create proposals. A worker evaluation, proposal
loaded into a workflow or approval record is not evidence of a completed trade.
Every execution still requires the applicable fresh simulation, manifest review
and wallet authorization. Watches are regular read-only price reports; threshold
conditions use Price trigger with notify-only action. Telegram preferences use
existing link/unlink support when configured. No unsupported email/push settings,
inline edit or execution status is invented. Existing pause/resume/archive and
pending/history operations remain real backend actions.

Manual creation offers supported routes and notify-only conditions. Saved
workflows use the existing “Automate this workflow” path, which first resolves
the exact representable workflow; an unpreviewed arbitrary library selection is
not offered in the guided trade form. Portfolio refresh calls the existing
provider and preserves its bounded snapshot-cache behavior.

## Verification

Results are recorded in the PR and final delivery. Local replay, fixture prices,
injected wallets and loopback PostgreSQL/forks are isolated evidence, never
public-chain execution or release certification. CircleCI's existing ledger is
still authoritative. Specialist reviews are advisory.
