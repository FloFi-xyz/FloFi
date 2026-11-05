# One-authorization workflow runs on mainnet: activation, acceptance, rollback

BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001. This runbook covers turning on delegated ("authorize once") workflow runs for Ethereum (1), Base (8453) and Arbitrum One (42161), and running the real-mainnet acceptance.

It is a procedure to be approved and executed by the owner. Nothing in this repository provisions cloud resources, changes production variables, deploys, or sends a transaction. Every step marked **[OWNER APPROVAL]** spends money, changes production, or moves real funds.

## 0. What is being activated

A delegated workflow run is authorized by the owner's wallet. On each EVM chain the workflow touches, the wallet makes one EIP-712 signature (`eth_signTypedData_v4`) of an exact **workflow grant**: an ERC-7710 delegation of the MetaMask Delegation Framework v1.3.0. The grant contains exactly the run's calls on that chain:

- every amount, asset, recipient, Aave beneficiary, rate mode, fee tier and swap minimum output is fixed in the calldata (`ExactCalldataEnforcer`);
- each call is usable once, ever (`IdEnforcer`);
- the call count is capped and native value is zero (`LimitedCalls`, `ValueLte`);
- the grant is valid for at most one hour (`Timestamp`);
- only the deployment's executor address can use it (`Redeemer`).

FloFi's executor (an AWS KMS key) then submits those calls one step at a time. It reconciles each step on-chain before starting the next.

The one-time setup per wallet is the wallet's own MetaMask smart-account (EIP-7702) upgrade. FloFi never performs that upgrade.

It is **not** available for:

- **Solana:** there is no secure single-authorization mechanism, because an SPL delegate can send to any recipient.
- **Robinhood Chain:** the delegation framework is not deployed there.
- **Bridges and cross-chain dependent amounts:** a bridge's output cannot be fixed on-chain when the owner signs.
- **FloFi Wallet (Privy):** its provider does not offer `eth_signTypedData_v4` or EIP-7702.

Those cases keep "Confirm each step", which is unchanged.

## 1. Preconditions (code)

- [ ] The PR is merged by the owner. CircleCI must be green on the merge commit.
- [ ] Note one commit SHA `R`. Vercel, the Railway API and the Railway Worker must all run exactly `R` (see §6).

## 2. AWS KMS executor key **[OWNER APPROVAL — paid resource]**

1. In the AWS account and region the owner chooses, create one asymmetric key:
   - `KeySpec=ECC_SECG_P256K1`, `KeyUsage=SIGN_VERIFY`, origin `AWS_KMS` (non-exportable);
   - one alias per environment, e.g. `alias/flofi-executor-production`;
   - a separate key for every other environment, never shared.
2. Key policy: only the two principals below, nothing else. Account root keeps administration, with deletion protected by the 7-day minimum waiting period.
3. IAM principals:
   - **Railway API** (`flofi-api`): `kms:GetPublicKey` on that key ARN only. The API derives the executor address and compiles the grants. It never signs.
   - **Railway Worker** (`flofi-worker`): `kms:Sign` and `kms:GetPublicKey` on that key ARN only, with condition `kms:SigningAlgorithm = ECDSA_SHA_256`.
   - Railway has no workload identity federation for AWS, so each principal is an IAM user with access keys stored as Railway secrets. Rotate them at least every 90 days (§9).
   - If the owner's Railway plan has static egress IPs, add an `aws:SourceIp` condition.
4. Enable CloudTrail for KMS data events in that region. Every `Sign` call is recorded there. FloFi also logs one `flofi.kms.sign` line per signature (digest, executor address, key ARN, outcome; never a credential).
5. Read the executor address: run the worker once with the variables of §4 and look for `delegation.worker_enabled`. Or compute it from `GetPublicKey` (keccak of the uncompressed point). Record it as `EXECUTOR`.

## 3. Executor gas **[OWNER APPROVAL — real funds]**

The executor sends every redemption, so it pays the gas on each chain.

- Fund `EXECUTOR` with a small ETH balance on Ethereum, Base and Arbitrum One, in amounts the owner chooses.
- Monitor the balance (§8). A redemption that cannot pay gas fails before anything is sent (`SIMULATION_REVERTED` / estimate failure). It never sends a partial step.

## 4. Configuration (names only; values are the owner's)

### Railway API (`flofi-api`)

| Variable | Value |
|---|---|
| `FLOFI_AUTOMATIONS` | `enabled` (loads the delegation routes) |
| `FLOFI_DELEGATION` | `enabled` |
| `FLOFI_DELEGATION_MAINNET_CHAINS` | `eip155:1,eip155:8453,eip155:42161`, or a subset for a staged start |
| `FLOFI_DELEGATION_RPC_1`, `FLOFI_DELEGATION_RPC_8453`, `FLOFI_DELEGATION_RPC_42161` | keyed HTTPS RPC endpoints |
| `FLOFI_PUBLIC_ORIGIN` | `https://flofi.xyz` |
| `FLOFI_DELEGATED_SIGNER` | `aws-kms` |
| `FLOFI_KMS_REGION` | the key's region |
| `FLOFI_KMS_EVM_KEY_ARN` | the key ARN or alias ARN |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secrets of the API's GetPublicKey-only principal |
| `FLOFI_DELEGATED_EXECUTION` | unset (the API never executes) |
| existing | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `API_AUTH_TOKEN`, `TENANT_ID` |

### Railway Worker (`flofi-worker`)

| Variable | Value |
|---|---|
| `FLOFI_DELEGATION`, `FLOFI_DELEGATION_MAINNET_CHAINS`, `FLOFI_DELEGATION_RPC_<id>`, `FLOFI_PUBLIC_ORIGIN` | same as the API |
| `FLOFI_DELEGATED_SIGNER`, `FLOFI_KMS_REGION`, `FLOFI_KMS_EVM_KEY_ARN` | `aws-kms`, same region and key |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secrets of the worker's Sign principal |
| `FLOFI_DELEGATED_EXECUTION` | `enabled` |
| `FLOFI_WORKFLOW_RUNS` | `enabled` |
| existing | `DATABASE_URL`, `TENANT_ID`, the `OBJECT_STORE_*` variables, and the `GRYLOO_*` owner-flow gates and RPCs the run observer uses |

### Vercel (Production)

| Variable | Value |
|---|---|
| `FLOFI_WORKFLOW_RUNS` | `enabled` |
| `FLOFI_DELEGATION` | `enabled` |
| `FLOFI_DELEGATION_MAINNET_CHAINS` | same as the API |
| `FLOFI_DELEGATED_SIGNER` | `remote-api` (accepted only with `API_BASE_URL`): the web tier forwards run authorization to the API and never signs |

No KMS credentials are ever set on Vercel. `TENANT_ID` must be identical on all three services.

Every value is validated fail-closed at start-up. A malformed value disables delegation and logs `DELEGATION_CONFIGURATION_INVALID` with the variable name. FloFi never falls back to another signer, mode or chain.

## 5. Database (Neon)

This release adds migration `0020_workflow_grants`. It is additive:

- `credential_grants.passkey_id` becomes nullable for workflow grants only;
- one revision CHECK is replaced so that a wallet-signed workflow authorization is admitted.

The Editor handoff adds `0021_editor_requester` when it lands. Follow `docs/deploy/SCHEMA-COMPATIBILITY.md`: an application build refuses a database that is ahead of it unless it carries a forward-compatibility certificate for those exact migrations. So either:

- **Two releases (preferred, no downtime):** Release A adds only the certificate (`CERTIFIED_FORWARD_MIGRATIONS`) for the exact `0020`/`0021` identities. Deploy it to Vercel, API and worker. Then Release B (this PR) migrates through the API pre-deploy step.
- **Coordinated maintenance window:** deploy the API first (it migrates in pre-deploy), then the worker and Vercel immediately. The previous Vercel build refuses the newer schema until it is replaced.

Before the migration, record the production row counts of `credential_grants` and `delegated_authorization_revisions`. Verify them unchanged afterwards.

## 6. One release across all services

1. Deploy commit `R` to the Railway API. This runs the migration. Check `/readyz`.
2. Deploy `R` to the Railway Worker. Check `delegation.worker_enabled` and `workflow_runs` in the start-up logs.
3. Promote the Vercel Production deployment built from `R`. `/api/flofi/readiness` reports `VERCEL_GIT_COMMIT_SHA = R`.
4. Compare the three commit SHAs: Vercel readiness, and the Railway deployment metadata for API and worker. Any difference stops the activation.

## 7. Real-mainnet acceptance **[OWNER APPROVAL — real funds, one run at a time]**

Use a designated acceptance wallet (MetaMask, upgraded to a MetaMask smart account on each network) and small amounts. The owner signs every authorization in the browser. FloFi cannot and does not sign for the owner.

| # | Network | Workflow | Expected authorizations |
|---|---|---|---|
| A1 | Arbitrum One | Swap 3 USDC → WETH → Supply the swap's guaranteed WETH to Aave V3 → Borrow 1 USDC | 1 wallet signature |
| A2 | Base | Swap USDC → WETH → Supply → Borrow (small) | 1 wallet signature |
| A3 | Ethereum | Swap USDC → WETH → Supply (two-step; gas is significant on L1) | 1 wallet signature |
| A4 | Robinhood Chain | not delegable (framework not deployed): run "Confirm each step" for a multi-action workflow and record the refusal reason shown | n per step |
| A5 | Solana | not delegable: "Confirm each step" for a Jupiter + transfer workflow; record the refusal reason | n per step |
| A6 | Cross-chain | Base → Arbitrum bridge workflows: not delegable in this release (`WORKFLOW_BINDING_NOT_EXACT` / bridge template). Run "Confirm each step" and record | n per step |

For each delegated run (A1–A3):

1. Build the workflow in the Editor (or Chat). Simulate it, and open `/approve` from "Run workflow". Choose **Authorize the whole workflow once**.
2. Before signing, record the review's exact call list and the grant digest. Record the wallet's EIP-712 display.
3. Sign once. Record the run id, the authorization id and the workflow grant (from `credential_grants.grant_payload`).
4. Run the read-only adversarial probe against the real contracts:

   ```bash
   FLOFI_PROBE_RPC_URL=https://<rpc> node scripts/workflow-grant-mainnet-probe.mjs grant.json probe-evidence.json
   ```

   The verdict must be `ON_CHAIN_BOUNDS_HELD`: every attack variant reverts on the real enforcers. The probe uses `eth_call` only.
5. Let the run complete. Record:
   - every transaction hash with its receipt (status, block, logs);
   - wallet balances before and after;
   - the Aave position (`getUserAccountData`) before and after;
   - the run's reconciliation (`delegated_execution_steps.reconciliation`).

   Verify independently on the block explorer.
6. Confirm the wallet was not asked again after the single signature.
7. Failure path, without risking funds: authorize a run and revoke it before it starts. Nothing is submitted. Separately, let a grant expire unsigned: nothing happens.

Evidence goes in `docs/builds/BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001-REPORT.md` §9, with hashes. Mocked or local evidence is never listed there as mainnet evidence.

## 8. Monitoring

- **Logs:**
  - `flofi.kms.sign` (each signature);
  - `delegation.step_blocked`, `delegation.simulation_retry`, `delegation.signing_retry`;
  - `delegation.execution_transition` to `HALTED` / `UNCERTAIN`;
  - `delegation.workflow_wallet_authorization_signed`.
- **Attention query:** `SELECT * FROM delegated_executions WHERE attention AND state NOT IN ('SETTLED','FAILED')`.
- **Executor balance per chain:** alert below the owner's threshold.
- **CloudTrail:** alert on `kms:Sign` from any principal other than the worker, and on any `DisableKey`/`ScheduleKeyDeletion`.

## 9. Rollback and emergency revocation

- **Stop new delegated runs:** remove `FLOFI_DELEGATION_MAINNET_CHAINS` (or set a subset) on Vercel, API and worker. Plans report `MAINNET_DELEGATION_DISABLED`; "Confirm each step" stays available.
- **Stop all delegated execution now:** unset `FLOFI_DELEGATED_EXECUTION` on the worker and redeploy.
- **Kill switch — no FloFi signature at all:** `aws kms disable-key --key-id <arn>`. Every signing attempt fails closed with `SIGNER_KMS_KEY_UNAVAILABLE` and nothing is sent. Re-enable with `enable-key`. Disabling is immediate and reversible.
- **Owner revocation of one run:**
  - "Revoke workflow authorization" on `/approve` stops the executor from starting any further step.
  - For on-chain certainty, the owner can disable the grant from their wallet (`disableDelegation(delegation)` self-call).
  - Every grant also expires on-chain within one hour of signing.
- **Key rotation:**
  - create a new key, set `FLOFI_KMS_EVM_KEY_ARN` on the API and worker, redeploy;
  - fund the new executor address;
  - grants signed for the old executor stop working at once (the `Redeemer` caveat names the old address);
  - disable the old key and schedule its deletion after the 7-day minimum.
- **Credential rotation:** create new IAM access keys, update the Railway secrets, redeploy, then delete the old keys.
- **Application rollback:** redeploy the previous commit on all three services, following §5's certificate rules. Migration `0020` is additive and stays.
