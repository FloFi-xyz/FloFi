// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: plain-language explanations of the closed error codes FloFi records (run `error_code`, work item
 * `last_error`, workflow-run and delegated-execution `code`). Deterministic: exact codes first, then ordered name patterns, then an explicit
 * "unknown" entry. An explanation describes what a code means and what usually causes it; it never states what happened to a particular
 * execution — whether funds moved or a transaction landed is read from that execution's own durable facts, never from its code.
 */

export type IncidentCategory = 'AUTH_SESSION' | 'WALLET' | 'QUOTE_PROVIDER' | 'WORKFLOW_VALIDATION' | 'TRANSACTION_SUBMISSION' | 'CONFIRMATION'
  | 'CROSS_CHAIN' | 'BACKGROUND' | 'AUTOMATION' | 'AI_COPILOT' | 'PLATFORM' | 'UNKNOWN';
export const CATEGORY_LABELS: Readonly<Record<IncidentCategory, string>> = {
  AUTH_SESSION: 'Sign-in and session', WALLET: 'Wallet connection', QUOTE_PROVIDER: 'Quote and provider', WORKFLOW_VALIDATION: 'Workflow validation',
  TRANSACTION_SUBMISSION: 'Transaction submission', CONFIRMATION: 'Confirmation and reconciliation', CROSS_CHAIN: 'Cross-chain bridge',
  BACKGROUND: 'Background processing', AUTOMATION: 'Automation', AI_COPILOT: 'AI Copilot', PLATFORM: 'Platform availability', UNKNOWN: 'Unknown',
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS) as IncidentCategory[];

/** Who or what can resolve a code's cause: a temporary condition, the user, a deployment's configuration, a code change, or unknown. */
export type Remedy = 'TRANSIENT' | 'USER' | 'CONFIGURATION' | 'CODE' | 'UNKNOWN';
export type CodeExplanation = {
  readonly code: string;
  readonly label: string;
  readonly meaning: string;
  /** Only where the code itself establishes a likely cause; null otherwise (never guessed). */
  readonly likelyCause: string | null;
  readonly category: IncidentCategory;
  readonly remedy: Remedy;
  /** What the user can do, when the remedy is theirs. */
  readonly userAction: string | null;
  /** Whether a new deployment could be needed: NO (an operator or the user can act), CONFIG (environment change and redeploy), CODE (a fix), UNKNOWN. */
  readonly deployment: 'NO' | 'CONFIG' | 'CODE' | 'UNKNOWN';
  /** Whether the code is one this catalog knows; false for the fallback explanation. */
  readonly known: boolean;
};
type Entry = Omit<CodeExplanation, 'code' | 'known'>;

const EXACT: Readonly<Record<string, Entry>> = {
  OBSERVATION_BUDGET_EXHAUSTED: { label: 'Background check gave up', category: 'BACKGROUND', remedy: 'TRANSIENT', userAction: null, deployment: 'NO',
    meaning: 'A background task retried for its whole budget (up to 7 days or 500 attempts) without reaching a final answer, and stopped.',
    likelyCause: 'The answer it waits for did not arrive in time — for example a slow network, an unreachable RPC provider, or a network disabled on the worker.' },
  WORK_KIND_UNKNOWN: { label: 'No handler for this task', category: 'BACKGROUND', remedy: 'CONFIGURATION', userAction: null, deployment: 'CONFIG',
    meaning: 'The worker that claimed the task has no handler for its kind.', likelyCause: 'The feature that produces this task is not enabled on the worker.' },
  WORK_PAYLOAD_INVALID: { label: 'Task data invalid', category: 'BACKGROUND', remedy: 'CODE', userAction: null, deployment: 'CODE',
    meaning: 'The task did not name a valid flow and execution, so it was never acted on.', likelyCause: null },
  WORK_HANDLER_FAILED: { label: 'Background task failed', category: 'BACKGROUND', remedy: 'UNKNOWN', userAction: null, deployment: 'UNKNOWN',
    meaning: 'The task’s handler raised an unclassified error.', likelyCause: null },
  WORK_NOT_SETTLED: { label: 'Background task did not finish', category: 'BACKGROUND', remedy: 'TRANSIENT', userAction: null, deployment: 'NO',
    meaning: 'The task’s handler returned without recording a result, so it was rescheduled.', likelyCause: null },
  EXECUTION_LEASE_LOST: { label: 'Concurrent update', category: 'BACKGROUND', remedy: 'TRANSIENT', userAction: null, deployment: 'NO',
    meaning: 'Another process was updating the same execution at that moment; the work is retried.', likelyCause: null },
  // BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: not transient — nothing temporary failed. Re-inspection is still allowed (`retryableStopReason`).
  NONCE_CONFLICT_STABLE_OPERATOR_REVIEW: { label: 'Nonce conflict needs operator review', category: 'CONFIRMATION', remedy: 'UNKNOWN', userAction: null, deployment: 'NO',
    meaning: 'The automatic check stopped because repeated, complete investigations of the same nonce conflict returned exactly the same evidence: further identical '
      + 'checks could not change the verdict. The transaction outcome stays UNKNOWN — this is not success, failure or non-execution. The investigation '
      + '(conflicting transaction, comparison, delegation and alternate-nonce scan) is shown on the execution’s diagnostics.',
    likelyCause: 'Another transaction (possibly another FloFi workflow or the owner’s wallet) used the nonce reserved for the reviewed call.' },
  EVIDENCE_STORE_NOT_CONFIGURED: { label: 'Evidence storage not configured', category: 'BACKGROUND', remedy: 'CONFIGURATION', userAction: null, deployment: 'CONFIG',
    meaning: 'The worker has no evidence object store, so finished executions cannot be archived.', likelyCause: null },
  UNCLASSIFIED_ERROR: { label: 'Unclassified error', category: 'UNKNOWN', remedy: 'UNKNOWN', userAction: null, deployment: 'UNKNOWN',
    meaning: 'The service recorded an error without a closed code.', likelyCause: null },
};

/** Ordered: the first matching rule explains the code. */
const PATTERNS: readonly (readonly [RegExp, Entry])[] = [
  [/CORRUPT/, { label: 'Stored state failed validation', category: 'BACKGROUND', remedy: 'CODE', userAction: null, deployment: 'CODE',
    meaning: 'A stored execution record failed its integrity checks. FloFi never acts on such a record.', likelyCause: null }],
  // Observation verdicts that keep an outcome UNKNOWN: never "try again" (a second submission could duplicate one that landed).
  [/_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION$/, { label: 'Nonce used by a different transaction', category: 'CONFIRMATION', remedy: 'UNKNOWN', userAction: null, deployment: 'NO',
    meaning: 'The account nonce reserved for the reviewed transaction was used by a transaction that is not a direct send of the reviewed call (its target, data '
      + 'or value differ, or could not be read). It may still contain the reviewed call (for example through a delegated account), or be a different transaction; '
      + 'the wallet may also have sent the reviewed call with another nonce. The outcome stays unknown until those are excluded.',
    likelyCause: 'The owner’s wallet sent another, modified or delegated transaction with that nonce.' }],
  [/_(NONCE_COLLISION_PENDING|RECEIPT_NOT_CANONICAL|REJECTED_UNPROVEN|SUBMISSION_UNKNOWN)$/, { label: 'Outcome not established', category: 'CONFIRMATION',
    remedy: 'UNKNOWN', userAction: null, deployment: 'NO',
    meaning: 'The service could not establish whether the transaction landed (a pending nonce collision, a non-canonical receipt or an unproven rejection). '
      + 'The outcome stays unknown; starting again could duplicate a transaction that landed.', likelyCause: null }],
  [/_TRANSACTION_NOT_OBSERVED$/, { label: 'Transaction not observed', category: 'CONFIRMATION', remedy: 'UNKNOWN', userAction: null, deployment: 'NO',
    meaning: 'At the last check no matching transaction was found for this attempt (by its reported hash or signature, by nonce, or in the pending pool). This does '
      + 'not prove that nothing was submitted: a delayed wallet broadcast cannot be excluded, so the outcome stays unknown.', likelyCause: null }],
  // Display only: never TRANSIENT, so `retryableStopReason` (the registry's precondition) is exactly what it was before these entries.
  [/_TRANSACTION_PENDING$/, { label: 'Transaction pending', category: 'CONFIRMATION', remedy: 'UNKNOWN', userAction: null, deployment: 'NO',
    meaning: 'At the last check the attempt’s transaction had no receipt yet (or a reported hash was not found anywhere yet).', likelyCause: null }],
  [/_(SEMANTIC_EDIT_REQUIRES_REVIEW|WALLET_CHANGED_REVIEW_REQUIRED)$/, { label: 'Owner review required', category: 'WORKFLOW_VALIDATION', remedy: 'USER', deployment: 'NO',
    userAction: 'The owner reviews the edited workflow again before any further execution.',
    meaning: 'The owner edited the workflow (or changed wallet) after review, so FloFi cleared that authorization. It gates future execution only and changes nothing that '
      + 'already executed — it is not an operational incident.', likelyCause: null }],
  [/SUBMISSION_EXPIRED_NOT_EXECUTED$/, { label: 'Expired before execution', category: 'TRANSACTION_SUBMISSION', remedy: 'USER', deployment: 'NO',
    userAction: 'Start again with a fresh quote and approve it in the wallet.', meaning: 'The prepared transaction expired before it was executed.', likelyCause: null }],
  [/(USER_REJECTED|WALLET_REJECTED|REJECTED_BY_USER|SIGNATURE_REJECTED)/, { label: 'Declined in the wallet', category: 'WALLET', remedy: 'USER', deployment: 'NO',
    userAction: 'Open the workflow again and approve it in the wallet if it is still wanted.', meaning: 'The owner declined the request in their wallet.', likelyCause: null }],
  [/(INSUFFICIENT|BALANCE|ALLOWANCE)/, { label: 'Not enough funds or allowance', category: 'WORKFLOW_VALIDATION', remedy: 'USER', deployment: 'NO',
    userAction: 'Top up the wallet or reduce the amount, then review the workflow again.', meaning: 'A balance or allowance check failed.', likelyCause: null }],
  [/(REVERT)/, { label: 'Reverted on chain', category: 'TRANSACTION_SUBMISSION', remedy: 'USER', deployment: 'NO',
    userAction: 'Review the failed step and start again with a fresh quote.', meaning: 'The network rejected the transaction while executing it.', likelyCause: null }],
  [/(SIMULATION|VALIDATION|WORKFLOW_INVALID|POLICY)/, { label: 'Did not pass checks', category: 'WORKFLOW_VALIDATION', remedy: 'USER', deployment: 'NO',
    userAction: 'Change the workflow (amount, token or route) and review it again.', meaning: 'The workflow failed simulation, validation or a policy check before anything was signed.', likelyCause: null }],
  [/(BRIDGE|DESTINATION|ACROSS|RELAY|CROSSCHAIN|CROSS_CHAIN)/, { label: 'Cross-chain step', category: 'CROSS_CHAIN', remedy: 'UNKNOWN', userAction: null, deployment: 'UNKNOWN',
    meaning: 'A cross-chain route or its destination settlement reported a problem.', likelyCause: null }],
  [/(QUOTE|(?:^|_)ROUTE(?:_|$)|SLIPPAGE|PRICE|LIQUIDITY)/, { label: 'Quote or route problem', category: 'QUOTE_PROVIDER', remedy: 'USER', deployment: 'NO',
    userAction: 'Request a fresh quote.', meaning: 'A quote, route or price check failed or went stale.', likelyCause: null }],
  [/(RPC|TIMEOUT|UNREACHABLE|UPSTREAM|RATE_LIMIT|PROVIDER_UNAVAILABLE|_UNAVAILABLE$)/, { label: 'External service unavailable', category: 'QUOTE_PROVIDER', remedy: 'TRANSIENT',
    userAction: null, deployment: 'NO', meaning: 'An external service (RPC node or provider API) did not answer in time.', likelyCause: 'A temporary outage or rate limit at that provider.' }],
  [/(_NOT_ENABLED|_NOT_CONFIGURED|_DISABLED)$/, { label: 'Feature not enabled', category: 'PLATFORM', remedy: 'CONFIGURATION', userAction: null, deployment: 'CONFIG',
    meaning: 'The deployment that handled this has the feature or network switched off.', likelyCause: null }],
  [/_BUSY$/, { label: 'Busy, retried', category: 'BACKGROUND', remedy: 'TRANSIENT', userAction: null, deployment: 'NO',
    meaning: 'Another request was working on the same execution; the work is retried.', likelyCause: null }],
  [/(SESSION|SIGN_IN|AUTH|CSRF|ORIGIN)/, { label: 'Sign-in or session problem', category: 'AUTH_SESSION', remedy: 'USER', deployment: 'NO',
    userAction: 'Sign in again.', meaning: 'A session was missing, expired or rejected.', likelyCause: null }],
  [/(WALLET|SIGNATURE|NONCE|ACCOUNT)/, { label: 'Wallet problem', category: 'WALLET', remedy: 'USER', deployment: 'NO',
    userAction: 'Reconnect the wallet and try again.', meaning: 'The wallet connection, account or signature did not match what FloFi expected.', likelyCause: null }],
  [/COPILOT/, { label: 'AI Copilot problem', category: 'AI_COPILOT', remedy: 'UNKNOWN', userAction: null, deployment: 'UNKNOWN',
    meaning: 'The AI Copilot could not produce or validate a plan.', likelyCause: null }],
  [/(AUTOMATION|DELEGAT|OCCURRENCE|RULE)/, { label: 'Automation problem', category: 'AUTOMATION', remedy: 'UNKNOWN', userAction: null, deployment: 'UNKNOWN',
    meaning: 'An automation rule, its delegated authority or its execution reported a problem.', likelyCause: null }],
];

const FALLBACK: Entry = { label: 'Unrecognised code', category: 'UNKNOWN', remedy: 'UNKNOWN', userAction: null, deployment: 'UNKNOWN',
  meaning: 'This code is not in the support catalog yet. Its name is shown in the technical details.', likelyCause: null };
const CODE = /^[A-Z][A-Z0-9_]{1,80}$/;

export function explainCode(code: string | null | undefined): CodeExplanation | null {
  if (!code) return null;
  const safe = CODE.test(code) ? code : 'UNCLASSIFIED_ERROR';
  const exact = EXACT[safe];
  if (exact) return { code: safe, known: true, ...exact };
  const rule = PATTERNS.find(([pattern]) => pattern.test(safe));
  return rule ? { code: safe, known: true, ...rule[1] } : { code: safe, known: false, ...FALLBACK };
}

/** Work-item stop reasons after which re-running the same idempotent task can help (the cause may have been temporary). */
export function retryableStopReason(code: string | null): boolean {
  const explanation = explainCode(code);
  return explanation !== null && (explanation.remedy === 'TRANSIENT' || REINSPECTABLE.has(explanation.code));
}
/**
 * Stop reasons that are not transient but after which ONE read-only re-inspection may still help (new evidence can appear on chain). Exact
 * codes only; the registry's retry limit still bounds how often an operator can resume the check.
 */
const REINSPECTABLE: ReadonlySet<string> = new Set(['NONCE_CONFLICT_STABLE_OPERATOR_REVIEW']);
