# BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: report

This build continues BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001 on branch `claude/focused-ptolemy-xr1cf2`. That build's three workstreams are kept:

- the Simulate controls never overlap;
- Enter applies Aave amounts directly;
- the delegated Swap → Supply → Borrow pipeline (see that report).

This report covers the universal single-authorization extension. It reports evidence levels honestly:

- **Implemented and tested** means unit tests, PostgreSQL tests, or loopback tests passed in this repository, with MOCKED chain doubles.
- **Mainnet evidence** means real transactions with hashes on public networks.
- **No mainnet transaction has been sent by this build.** §9 is empty until the owner-approved acceptance runs (`docs/deploy/SINGLE-AUTH-MAINNET-ACTIVATION.md` §7).

## 1. Network-by-network coverage

| Network | One-authorization (delegated) workflow runs | Why / mechanism |
|---|---|---|
| Ethereum (1) | **Implemented** (Uniswap v3 USDC⇄WETH 0.05%, Aave V3 Supply / variable Borrow on registered reserves) | MetaMask Delegation Framework v1.3.0 deployed (official deployment list); EIP-7702 live; registries verified |
| Base (8453) | **Implemented** (same actions; WETH and other expansion reserves; Base's L1 data fee is paid by the executor) | same |
| Arbitrum One (42161) | **Implemented** (same actions) | same |
| Robinhood Chain (4663) | **Not available**: `DELEGATION_FRAMEWORK_NOT_DEPLOYED` | Not in the framework's deployment list, and EIP-7702 support is not recorded in FloFi's registries. No Aave market. Enabling it needs an owner decision to deploy the framework's audited CREATE2 contracts there, plus verification. |
| Solana | **Not available**: `WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED` | See §4. "Confirm each step" is unchanged for Jupiter, Orca and transfers. |
| Cross-chain | **Not available** for delegated runs: `WORKFLOW_BINDING_NOT_EXACT`, bridge templates refused | A bridge's delivered amount cannot be fixed on-chain when the owner signs. "Confirm each step" covers the existing routes, with arrival reconciliation before the next step. |

## 2. Action-by-action delegation support (Ethereum, Base, Arbitrum One)

| Action | Delegated | On-chain form in the workflow grant |
|---|---|---|
| Swap (Uniswap v3 SwapRouter02 `exactInputSingle`, USDC⇄WETH) | Yes | `approve(router, exact amountIn)` and `exactInputSingle(tokenIn, tokenOut, 500, owner, exact amountIn, signed minimum out, 0)`, each exact and once |
| Aave V3 Supply | Yes (reserves whose supply cap FloFi verifies) | `approve(Pool, exact)` and `supply(asset, exact, owner, 0)` |
| Aave V3 Borrow | Yes | `borrow(asset, exact, 2, 0, owner)`, exact and once |
| Aave V3 Repay / Withdraw | Not yet delegated: owner-signed per step | The compiler already encodes them exactly (`AAVE_V3_REPAY` / `AAVE_V3_WITHDRAW`). Drivers and reconciliation are not built. |
| Token / native transfers | Not yet delegated: owner-signed per step | The compiler encodes them exactly (`ERC20_TRANSFER` / `NATIVE_TRANSFER`). Drivers are not built. |
| Add / remove liquidity | Not delegated | NonfungiblePositionManager calls need token-id-dependent calldata. Owner-signed per step. |
| Bridges (Across / LI.FI / Relay) | Not delegated | See §1 and §4. |
| Jupiter, Orca, Solana transfers | Not delegated | See §4. |
| Automations (recurring) | Reusable Credentials (unchanged mechanism, hardened) | Approvals pinned to the exact per-call cap; swaps pinned to the 0.05% tier and no price limit. Credential Aave scopes are not offered (Borrow exists only as an exact workflow grant). |

A dependent step uses the producer's **on-chain guarantee**: the swap's signed minimum output, or a borrow's exact amount, capped by its own amount. Anything received above that stays in the wallet. In "Confirm each step" a dependent step still spends the reconciled received amount.

## 3. Wallet-by-wallet authorization capability

| Wallet | One authorization per workflow | One-time setup |
|---|---|---|
| MetaMask (EVM) | Yes: one `eth_signTypedData_v4` per network in the workflow; the wallet is asked to switch network first | The wallet's own MetaMask smart-account (EIP-7702) upgrade, done in MetaMask. FloFi checks the designator and reports `EVM_ACCOUNT_NOT_UPGRADED` until it is done. The signature is kept for a retry. |
| Rabby / Coinbase Wallet / Phantom (EVM) / other injected | Only if the account carries the MetaMask v1.3 EIP-7702 designator (rare). Otherwise refused with `EVM_ACCOUNT_NOT_UPGRADED` | No wallet-specific code exists; verified only for MetaMask |
| FloFi Wallet (Privy, EVM) | **No**: its provider refuses `eth_signTypedData_v4` and EIP-7702 authorizations (`FLOFI_WALLET_METHOD_UNSUPPORTED`). "Confirm each step" works. | Enabling needs a reviewed Privy typed-data and 7702 signing flow bound to the exact grant. That is not built. |
| Phantom / Solflare / Backpack (Solana), FloFi Wallet (Solana) | **No**: §4 | — |

Every grant's wallet signature is verified on the server before anything runs:

- the signer recovers to the run's proven wallet;
- the delegation recompiles from the stored scope byte for byte;
- the account carries the EIP-7702 designator;
- the framework code is present on that chain;
- the delegation is not disabled.

## 4. Genuine protocol limitations

- **Solana.** An SPL token delegate can transfer up to its amount to **any** destination, through any program, with no on-chain expiry. That is unrestricted spending, so FloFi does not offer it as a single authorization.
  - Secure options need an owner decision: a policy program wallet (Squads v4 spending limits or Swig roles), which moves funds into a program wallet; or a pre-signed exact transaction set with durable nonces, which has no on-chain expiry and needs a nonce-account setup.
  - Neither is implemented. "Confirm each step" remains.
- **Cross-chain.** A bridge's output arrives later on another chain, so the dependent step's amount cannot be pinned when the owner signs.
  - It could be pinned only by bridging exactly a signed amount with an exact `outputAmount` (Across `depositV3`), and then consuming exactly that amount on the destination with a second grant.
  - That is designable with the same exact-call grants but not built. It would also be two wallet signatures (one per chain).
- **One signature per chain.** The EIP-712 domain of the DelegationManager includes the chain id, so a workflow touching N EVM chains needs N signatures, all requested together before anything runs.
- **Health-factor floor.** FloFi's 2.0 floor and the fresh Aave reads are checked by the executor. On-chain, Aave itself enforces health factor > 1. The Borrow amount is exact on-chain.
- **Order of calls.** The grant authorizes a set of exact calls, each once; it does not enforce their order on-chain. A compromised executor could run them out of order, but only the exact calls the owner signed. For example, the exact borrow before the supply succeeds only if the account already has collateral.
- **Gas.** The executor address pays gas on each chain (§6). The owner's account pays none for delegated steps.

## 5. Exact on-chain spending and borrowing protections

Workflow grant, per chain (`compileWorkflowGrant`, MetaMask v1.3.0 enforcers from the official deployment list):

- **Root caveats:**
  - `Redeemer(executor)`;
  - `Timestamp(validFrom − 1, validFrom + ≤ 1 h)`;
  - `LimitedCalls(number of calls)`;
  - `ValueLte(largest native value = 0 for these actions)`.
- **One group per call:** `AllowedTargets([target])`, `ExactCalldata(whole calldata)`, `ValueLte(exact value)` and `IdEnforcer(unique id)`.
- **Result:** authorizing a 1 USDC Borrow permits exactly `borrow(USDC, 1000000, 2, 0, owner)`, once. The previous Credential template's byte-aligned ceiling allowed up to about 16.77 USDC; that template is no longer offered for Borrow.
- **Adversarial tests** (`packages/reference-compiler/test/erc7710-workflow.test.ts`, enforcer model): a compromised executor cannot:
  - borrow 1 raw unit more or less, or up to the old ceiling;
  - borrow at the stable rate, for another account, or another asset;
  - swap with no minimum, more input, or to another recipient;
  - approve another spender, or an unlimited amount;
  - supply for another account;
  - transfer the owner's tokens or ETH;
  - target another contract, or append bytes;
  - replay any call after an interruption (IdEnforcer), while a reverted call spends nothing and can be retried once;
  - redeem from another key, before the window, after expiry, or after `disableDelegation`.
- **PostgreSQL end to end** (loopback chain double): after a completed run, every replay of every authorized call reverts.
- **Credential grants (automations):**
  - approvals are pinned to exactly the per-call cap (an unlimited or larger allowance reverts);
  - swaps are pinned to the 0.05% pool with `sqrtPriceLimitX96 = 0`.
  - A Credential swap's minimum output still cannot be pinned on-chain, because it depends on price at execution. Its loss bound is the per-call input cap, times its calls, inside its window.
- **Model fidelity:** `ERC20BalanceChangeEnforcer` decrease rules now model Solidity 0.8's `Panic(0x11)` when the cap exceeds the cached balance.
- **Real-bytecode evidence:** the in-repo enforcer model is MOCKED evidence. Bytecode published on npm does not reproduce the deployed CREATE2 addresses, and public RPCs are not reachable from this build environment. `scripts/workflow-grant-mainnet-probe.mjs` runs the same attacks against the real contracts through `eth_call` during acceptance.

## 6. Production signer deployment readiness

- **Signer** (`packages/reference-executor/src/kms-signer.ts`): an AWS KMS `ECC_SECG_P256K1` key, non-exportable.
  - Calls go through the KMS JSON API with Signature Version 4 (no SDK dependency). The implementation reproduces the AWS documentation test vector.
  - DER signatures are parsed strictly and normalized to low-s, with the recovery bit that recovers the key's own public key. Anything else is refused.
  - KMS errors map to stable codes; throttling and 5xx are retryable.
  - Each signature emits one audit line, alongside CloudTrail.
  - The application never creates, deletes, disables or rotates the key.
- **Configuration:** `FLOFI_DELEGATED_SIGNER=aws-kms` with `FLOFI_KMS_REGION` and `FLOFI_KMS_EVM_KEY_ARN`.
  - The setting is refused with a harness, with an ARN from another region, or without credentials.
  - Hosted deployments still refuse the disposable signers.
  - The web tier uses `remote-api`.
- **Role split:** the API needs `kms:GetPublicKey` only; the worker needs `kms:Sign` only.
- **One executor address, shared nonces:** all grants share the deployment's executor address, so nonces are allocated per (chain, executor) under an advisory lock.
- **Not done (owner approval required):** creating the key, the IAM principals, CloudTrail, the Railway secrets, and executor gas funding. See the runbook §2–§4.
- **Ed25519 (Solana):** no KMS signer is provided, because no production Solana delegated builder exists (§4).

## 7. Editor, Chat and channel integration

- **Chat, MCP, Telegram and other channels** create approval handoffs. All of them converge on the same run service, the same `/approve` authorization panel and the same executor. The panel now offers "Authorize the whole workflow once" as the wallet-signed exact grant. It lists every exact call (EN/PT) before the wallet is asked.
- **Production `/approve`** runs on the remote runtime. It now forwards run review, sign and revoke to the Railway API, which re-checks that:
  - the run is the owner's;
  - its EVM wallet was proven by this request;
  - it is still choosing its mode.
- **Editor → workflow run:** delegated to a tracked sub-workstream. Its status is in §8.

## 8. CI and end-to-end results

(To be completed at delivery with the exact commit, `pnpm check`, governance, `agent_guard` and CircleCI results.)

## 9. Real-mainnet evidence and transaction hashes

None. No real-money transaction has been sent. Acceptance requires the owner's approval and the owner's own wallet signature for each run (runbook §7).

## 10. Required production configuration and release procedure

See `docs/deploy/SINGLE-AUTH-MAINNET-ACTIVATION.md`.
