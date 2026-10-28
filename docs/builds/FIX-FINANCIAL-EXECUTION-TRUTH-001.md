# FIX-FINANCIAL-EXECUTION-TRUTH-001

Implementation base: `ff3160abf887668250cd5d14d0f783370419d337`, verified against origin/main. Audit reference: `01dbce43bfa4ab7279a95cc0ae24e5f1a94fa8e1`. No merge or deployment is authorized by this report.

## Production incident: read-only findings

Run `xuni-379461c2e3f1807a0dc0455342a51d21`; workflow `workflow-cd78e264-e8fe-43f3-9904-406504f3c83d`; wallet `0x4b212af0a923256961487ae72499ca79f920b3ce`. Reviewed intent: 1 Base USDC to Arbitrum One USDT.

Production queries used `BEGIN READ ONLY`, a session-local statement timeout, SELECTs restricted to this run, and COMMIT. Credentials were passed inside the local querying process and were not printed or saved. No observation API, wallet request, queue delivery, database change, permission change or infrastructure change was initiated in production.

Seven durable log segments establish this sequence on 2026-10-27 (UTC):

| Time | Durable fact |
| --- | --- |
| 23:07:46.852959 | PREPARED, no attempts. |
| 23:07:50.839515 | AUTHORIZED. |
| 23:07:55.436158 | Approval PREPARED, nonce 60, prepared source block 53,176,562. |
| 23:07:57.957791 | Approval SUBMITTING; durable wallet handoff. |
| 23:08:07.149482 | SUBMISSION_RESULT_UNKNOWN; no hash or receipt. |
| 23:08:20.580889 | UNIVERSAL_TRANSACTION_NOT_OBSERVED; attempt remains unknown. |
| 23:24:11.917812 | Worker changes approval to NOT_FOUND with UNIVERSAL_SUBMISSION_EXPIRED_NOT_EXECUTED; run returns to PREPARED. |

The last inspected projection has log version 7, no confirmed deposit, no final evidence, and `needs_observation=false`. Work item 3341 is DONE after **nine** deliveries, completed at 23:24:12.198811 UTC. This supersedes the owner's earlier six-delivery snapshot. `journal_entries` has no entries for this run; the universal engine's immutable snapshot segments carry its transitions. A filtered Railway log read returned no additional incident entries; it supplies no evidence of the underlying wallet exception.

The prepared call is USDC `approve(0x4cd00e387622c35bddb9b4c962c136462338bc310, 1000000)`, value zero. Its recorded transaction object omitted the reserved nonce. The wallet was allowed to assign its own nonce even though the server fenced nonce 60. This is a demonstrated identity gap, not proof that the production wallet chose a different nonce.

Independent read-only JSON-RPC samples from `https://mainnet.base.org` and `https://base-rpc.publicnode.com` returned chain 8453, heads **53,177,393** and **53,177,394**, confirmed nonce **60**, pending nonce **60**, and nonce **60** at prepared block 53,176,562. Both pending-block samples exposed no transaction for this wallet/nonce. The exact USDC allowance to the reviewed spender was **0** at each sampled head. Python clients received HTTP 403; the successful samples used Node's fetch transport. Failed HTTP requests were not treated as chain observations.

**Conclusion:** no nonce-60 inclusion was observed through those sampled heads, and neither sampled node exposed a pending candidate. Neither an explicit wallet rejection nor non-submission is established. A delayed wallet request, private submission or a transaction absent from these nodes' local pending views remains possible. The original wallet result is **unable to determine**. No gas cost or token debit is proven for this run. Zero observed allowance is a timestamped state observation, not proof that no approval ever existed. The worker's 15-minute inference is not evidence that a transaction cannot still be submitted.

The implementation quarantines this exact legacy inference, retains its original snapshots, restores observation under the run lease, and prevents its nonce from being claimed for another financial attempt. This behavior has only been exercised against isolated test storage; this build has not changed the production run.

## Audit package and findings

Read: owner's `FloFi_Pacote_Completo_Alrimar_23_Ocorrencias.zip`, the complete handoff text, `FloFi_Backlog_23_Ocorrencias.csv`, and screenshots E05–E12. Screenshots remain private source material and are not republished. The handoff distinguishes observed symptoms from hypotheses; this report does the same.

| Finding | Re-evaluation and root cause |
| --- | --- |
| BUG-001 | Durable rejection/cancellation notes and approval receipts already existed. Generic lifecycle presentation did not consistently explain those notes. Missing adapters for universal and directed Router history could fall back to a phase-only summary. Preserve the specific cause and earlier approval costs/allowance independently of deposit outcome. |
| BUG-011 | Backend summaries selected an open attempt or the overall phase, ignoring the last canceled attempt. PREPARED was also mapped generically to In progress. Use canonical attempt-aware summaries and the same lifecycle/evidence projectors for current and saved records. |
| BUG-015 | A definite 4001 diagnostic already had a cancellation path on main; it must not be replaced with a guessed timeout. Unresolved wallet promises retained busy/inert UI state indefinitely. Wallet-result delivery could fail after a real hash was returned. Keep submission fencing on the server; keep navigation/observation available; retain attempt-bound wallet results for later delivery. |
| BUG-017 | Approval abandonment after 15 minutes is unsafe. Binary nonce discovery considered mined transactions only, overlooking a positively visible identical pending transaction. The real worker followed that implemented abandonment rule. Shared discovery now uses positive pending evidence without treating absence as proof. Legacy timed-out approvals stay fenced and observable. |
| BUG-018 | Existing evidence already supported actual receipt costs and reconciled output. Universal Solana fee evidence, current allowance observations, partial source debit and refund amounts were missing or withheld until full reconciliation. Reuse existing value, fee, note and technical-detail slots; unknown costs remain unknown. |
| BUG-020 | A PREPARED phase with zero attempts was labeled In progress. PREPARED without evidence of a financial handoff is Not started; a legacy unproven timeout remains Unresolved. |

The reload browser regression also demonstrated a shared presentation failure: a terminal result restored successfully from the server was then hidden because the visit's empty recovery draft differed from the saved workflow. The lifecycle now attaches restored terminal results to the untouched recovery draft, using the same rule as runtime selection. Editing or creating another workflow still detaches unrelated final results.

The shared owner-wallet Swap store also needed an explicit live wallet-request identity once its operation latch was released. It now distinguishes that interaction from a restored PREPARED attempt, uses the shared account/chain/disconnect watcher, preserves late responses, and prevents an earlier run's completion from replacing a newly selected run. Its source file retains the historical `public-testnet` name; the same store serves catalog mainnet swaps.

Already corrected by current main: #127 supplies shared real Swap/Bridge estimates, provider refusals, quote identity/expiry checks and approval-preserving quote refresh. #128 supplies financial-history retention, transactional deletion of provably disposable runs, archive, tenant/wallet isolation and rollback history read-only mode. #129 supplies conversational draft and source/destination asset continuity. None is reimplemented here. Existing wallet-rejection and on-chain destination verification are reused rather than weakened.

## Shared implementation and financial invariants

- Shared EVM nonce discovery requires wallet, chain, nonce, target, calldata and value identity. A missing pending view is a limitation, not a negative proof. Historical binary search stays bounded logarithmically; unavailable historical reads retain uncertainty.
- New EVM Bridge and liquidity requests carry their reserved nonce. Existing persisted transactions remain readable. Wallet reports are bound to their original attempt; a late approval report cannot attach its hash to a deposit.
- Wallet-result outbox entries contain only run/attempt/owner, hash or structured refusal. Restoring or delivering them never invokes a wallet send. Browser storage is delivery evidence, never authorization.
- Known costs are deduplicated by chain/transaction and derived from verified receipts. Quoted gas, provider fees and provider status hints are not relabeled as paid costs or final delivery.
- Allowance reads identify owner, token, spender, chain, block hash/number and observation time. Failed reads explicitly expose unavailable values. Unchanged observations retain their original timestamps to keep polling idempotent and prevent append-only log exhaustion.
- Approval, source debit, destination observation/finality and full reconciliation remain distinct. Existing result components render those facts without a Canvas, Dashboard, simulation or timeline redesign.
- Mainnet product gates, unrestricted valid transaction amounts, explicit wallet authorization, per-attempt nonce claims, execution journals, trusted origins, tenant isolation, slippage defaults, the 0.1% workflow fee and #128 retention/deletion protections remain required.

The provider error meanings follow [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193): 4001 is rejection; 4100 is missing authorization; 4200 is unsupported method; disconnection is not proof of non-submission.

## Regression and certification evidence

The first failing-before run against the unchanged implementation reproduced **4 failures / 82 passes** across the universal service and dashboard mapping suites: unsafe 15-minute abandonment, omitted wallet nonce, missing identical pending discovery, and PREPARED summary mapping. After the initial implementation, focused execution, evidence, dashboard, recovery and Canvas suites passed **197/197**. An additional focused run including legacy recovery, attempt binding, actual allowance/cost and saved-history parity passed **84/84**. These are separate overlapping profiles, not additive test totals.

The reload attachment regression subsequently failed for both a rejected and a completed restored run (**2 failures / 42 passes**); the corrected lifecycle/result suites passed **56/56**. The browser profiles retain their duplicate-request and broadcast counters while replacing old expectations of blanket wallet blocking with navigation and repeated read-only observation. The Universal Bridge picker uses the existing closed provider-logo replay; its network guard is unchanged. Dynamic financial messages are checked through the active English and Portuguese catalog, including unknown versus rejected outcomes.

Two additional financial-evidence regressions were run with the current real service harness and the unchanged main evidence projector: both failed because partial source debit/Solana cost and verified refund values were omitted. Both pass with the corrected projector. These fixtures also verify that a destination amount observed before finality is visible without being called reconciled or actual final receipt. Test amounts and costs come from isolated chain fixtures.

Full unit/security, PostgreSQL, build, browser, governance and exact-head CircleCI results are recorded in the PR after the final implementation. An interrupted or failed validation attempt is not certification. Unit and PostgreSQL fixtures remain isolated engineering infrastructure, never product execution fallbacks.

## Caio T01–T14 coverage disposition

| Test | Scope |
| --- | --- |
| T01 | Definite EIP-1193 rejection; preserve attempt and earlier receipts; no automatic retry. |
| T02 | Promise never settles; navigation and observation remain available; no guessed failure. |
| T03 | Lost response / lost hash report; exact nonce discovery and attempt-bound result delivery; no send from recovery. |
| T04 | Approval confirmed, deposit rejected; receipt costs and timestamped allowance remain visible. |
| T05 | Source confirmed, destination pending; no full completion. |
| T06 | Destination observed without final reconciliation; separate observed/finality labels. |
| T07 | Reconciled result; actual delivered amounts and known receipt costs. |
| T08 | PREPARED without attempts; Not started; history preserved. |
| T09 | Refresh/new session; restore the same owned run and deliver retained results without broadcasting. |
| T10 | Account/chain/provider change; invalidate unused authority, preserve uncertain submitted attempts and read-only recovery. |
| T11 | Existing quote/semantic invalidation is retained and covered by existing regression suites. The requested route-inversion interaction (UX-002) is deferred; no new interaction is approved. |
| T12 | Status correctness is included. The separate 50+ run pagination/performance project (BUG-010) is deferred; no loading-performance claim is made. |
| T13 | Existing accessibility/mobile profiles remain gates. Wheel/zoom/pan redesign (UX-008) and new visual layouts are deferred. |
| T14 | Critical wallet, uncertainty, recovery, financial-outcome and simulation-blocker messages are translated in EN/PT-BR; no translation may imply stronger proof. |

Deferred visual work: UX-003, UX-005, UX-009, UX-012 and UX-021 redesigns; unrelated UX-002/007/008/014/022 interaction/copy projects. Existing layouts and financial detail disclosures are reused for authorized UX-016/019/023. No layout approval is requested because this implementation does not require a redesign.

## Provider limitations, release and rollback

Public pending blocks and transaction counts are node-local and may omit private, queued or delayed submissions. Archive/history reads may be unavailable or inconsistent during reorganization. A provider hint locates a candidate; existing independent chain verification and finality policy establish its financial meaning. When evidence is insufficient, a nonce stays fenced. This can require a later wallet result or inclusion before another request can safely use that nonce; independent workflows and simulations remain possible.

Release only after the exact PR head passes the full required CircleCI certification ledger and owner review. No production data repair, manual requeue, migration, deploy or financial send is part of this build. The existing run-history schema and #128 tombstones must be preserved.

Rollback must retain the safety fix and compatible readers for a legacy approval reclassified as unknown. An old binary that assumes every historical NOT_FOUND inference is irreversible cannot safely read the appended recovery transition or release its nonce. Backport the narrow reader/fencing changes before any application rollback; never erase the old snapshots, downmigrate retained history, clear nonce claims or restore the 15-minute inference. Disable history mutations through the existing read-only rollback setting when required by #128; deployment/configuration changes require a separate owner release decision.
