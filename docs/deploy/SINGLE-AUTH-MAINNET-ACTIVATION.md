# One-authorization workflow runs on mainnet: activation, team testing, rollback

BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001. This runbook turns on delegated ("authorize once") workflow runs for Ethereum (1), Base (8453) and Arbitrum One (42161) in the public product, for every eligible signed-in user.

The owner authorizes the steps marked **[OWNER]**: they create a paid resource, change production or move real funds. Once authorized, the procedure runs straight through. There is no pilot phase, wallet allowlist, amount cap or acceptance gate before enabling: real-mainnet testing by the team happens in the deployed product, after activation (§7). The protections that stay are the product's own: the exact on-chain grant, the owner's wallet signature, session and ownership checks, simulation and risk checks, reconciliation, replay protection and revocation.

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

## 1. Code release **[OWNER: merge]**

Release A (the 0021/0022 certificate), then Release B (PR 166), as in [RELEASE-SINGLE-AUTH-0021-0022.md](./RELEASE-SINGLE-AUTH-0021-0022.md). CircleCI green on each. All three services deploy `main` automatically; they must then run one commit `R` (§6).

## 2. AWS KMS executor key **[OWNER — paid resource, about $1 per month plus signing requests]**

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

## 3. Executor gas **[OWNER — real funds]**

The executor sends every redemption, so it pays the gas on each chain.

- Fund `EXECUTOR` with a small ETH balance on Ethereum, Base and Arbitrum One, in amounts the owner chooses.
- Monitor the balance (§8). A redemption that cannot pay gas fails before anything is sent (`SIMULATION_REVERTED` / estimate failure). It never sends a partial step.

## 4. Configuration (names only; values are the owner's)

### Railway API (`flofi-api`)

| Variable | Value |
|---|---|
| `FLOFI_AUTOMATIONS` | `enabled` (loads the delegation routes) |
| `FLOFI_DELEGATION` | `enabled` |
| `FLOFI_DELEGATION_MAINNET_CHAINS` | `eip155:1,eip155:8453,eip155:42161` |
| `FLOFI_DELEGATION_RPC_1`, `FLOFI_DELEGATION_RPC_8453`, `FLOFI_DELEGATION_RPC_42161` | keyed HTTPS RPC endpoints. On Railway they can reference the service's existing `GRYLOO_ALCHEMY_API_KEY` without copying it, e.g. `https://arb-mainnet.g.alchemy.com/v2/${{GRYLOO_ALCHEMY_API_KEY}}` (`eth-mainnet`, `base-mainnet` for the others) |
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

Migrations `0021_workflow_grants` and `0022_editor_requester` are additive (SCHEMA-COMPATIBILITY.md §15–16). They are certified first (Release A) and applied by the Railway API pre-deploy of Release B. The order, checks and rollback targets are in [RELEASE-SINGLE-AUTH-0021-0022.md](./RELEASE-SINGLE-AUTH-0021-0022.md).

## 6. One release across all services

1. Deploy commit `R` to the Railway API. This runs the migration. Check `/readyz`.
2. Deploy `R` to the Railway Worker. Check `delegation.worker_enabled` and `workflow_runs` in the start-up logs.
3. Promote the Vercel Production deployment built from `R`. `/api/flofi/readiness` reports `VERCEL_GIT_COMMIT_SHA = R`.
4. Compare the three commit SHAs: Vercel readiness, and the Railway deployment metadata for API and worker. Any difference is fixed by redeploying the lagging service before setting the variables of §4.
5. Check that `flofi.xyz` and `wallet.flofi.xyz` alias the Production deployment built from `R` (Vercel → Domains).
6. Set the variables of §4 on the three services and redeploy each (a variable change needs a new deployment). The worker logs `delegation.worker_enabled` with the executor address; `/approve` offers "Authorize the whole workflow once" for an eligible run.

## 7. Team testing on mainnet (after activation, in the deployed product)

The team uses `https://flofi.xyz` like any user: their own wallets, their own amounts, any supported workflow. It is not a gate: the feature is already on for everyone eligible. Each user signs their own authorization in their wallet; FloFi never signs for a user. The supported and unsupported cases below are what each user should see:

| Network | Workflow | What the product offers |
|---|---|---|
| Arbitrum One, Base, Ethereum | Swap USDC → WETH → Supply the swap's guaranteed WETH to Aave V3 → Borrow USDC (or any prefix of it) | "Authorize the whole workflow once": one wallet signature per network, after the wallet's one-time MetaMask smart-account upgrade |
| Robinhood Chain | any multi-action workflow | "Confirm each step", with the reason "framework not deployed" |
| Solana | Jupiter, Orca, transfers | "Confirm each step", with the reason shown |
| Cross-chain | a bridge followed by a dependent step | "Confirm each step" (`WORKFLOW_BINDING_NOT_EXACT`) |
| Any | FloFi Wallet (Privy) | "Confirm each step" (no typed-data / EIP-7702 support) |

What to record for each delegated run, so findings can be fixed:

- the run id and authorization id (shown on `/approve`), and the number of wallet prompts (one per network is expected);
- every transaction hash with its explorer link, and the reconciliation shown per step;
- anything unexpected: a refusal code, a halted or uncertain step (`delegated_executions` with `attention`), a wrong amount.

Optional diagnostic for a grant that looks wrong: `FLOFI_PROBE_RPC_URL=https://<rpc> node scripts/workflow-grant-mainnet-probe.mjs grant.json probe-evidence.json` replays the attack variants against the real enforcers with `eth_call` only; the verdict must be `ON_CHAIN_BOUNDS_HELD`.

Transaction hashes from real runs go in `docs/builds/BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001-REPORT.md` §9. Mocked or local evidence is never listed there as mainnet evidence.

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

- **Stop new delegated runs:** remove `FLOFI_DELEGATION_MAINNET_CHAINS` (or drop one chain from it) on Vercel, API and worker. Plans report `MAINNET_DELEGATION_DISABLED`; "Confirm each step" stays available.
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
- **Application rollback:** redeploy the previous commit on all three services, following §5's certificate rules. This works only after Release A: without its certificate, a previous commit refuses schema 22. Migrations `0021` and `0022` are additive and stay.
