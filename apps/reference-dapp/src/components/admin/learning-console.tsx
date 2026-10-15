// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-CHAT-LEARNING-001: the AI Learning operator controls — candidate decisions, the operator's own entries, the reviewed starter set, dry-run
 * evaluation, publication, rollback, disable and retention. Every action is one CSRF-protected POST to `/admin/api/learning`; the server
 * re-validates, evaluates and audits everything. Viewers see the buttons disabled.
 */
import { useState } from 'react';
import { adminPost } from './admin-client';

type Evaluation = { passed: boolean; entries: number; regressions: string[]; safetyViolations: string[]; cases: { total: number; candidate: number; failed: string[] };
  probes: { total: number; passed: number; effective: number; hintOnly: number; failed: string[] }; document: { code: string | null } };
const MESSAGES: Record<string, string> = {
  LEARNING_EVALUATION_FAILED: 'The evaluation did not pass: nothing was published.',
  LEARNING_KNOWLEDGE_VERSION_CONFLICT: 'Another administrator changed the glossary first. Reload to see the latest version.',
  LEARNING_KNOWLEDGE_EMPTY: 'Nothing is approved. Approve candidates first, or use Disable to serve no glossary.',
  LEARNING_KNOWLEDGE_UNCHANGED: 'The approved entries are exactly the active version.',
  LEARNING_CANDIDATE_EXISTS: 'That meaning is already a candidate.',
  LEARNING_CANDIDATE_TRANSITION_INVALID: 'That decision is not possible from the candidate’s current state.',
  LEARNING_TERM_RESERVED: 'That word already has a fixed meaning in FloFi (a network, token, protocol or command name).',
  LEARNING_ENVIRONMENT_CONFLICT: 'Test-network words may only name test networks or tokens, and the reverse.',
  LEARNING_TERM_INVALID: 'Use a short word or phrase (2–32 lower-case letters or digits, up to 3 words).',
  LEARNING_TARGET_INVALID: 'Choose a supported network, token or operation.',
  ADMIN_LEARNING_REASON_REQUIRED: 'A rejection needs a short reason.',
  ADMIN_LEARNING_EVALUATION_RATE_LIMITED: 'At most 30 evaluations run per 10 minutes. Try again later.',
  ADMIN_ROLE_INSUFFICIENT: 'Your role is read-only.', ADMIN_CSRF_INVALID: 'Your session token is stale. Reload the page.',
  ADMIN_SESSION_REQUIRED: 'Your admin session ended. Sign in again.',
};
const message = (code: string) => MESSAGES[code] ?? `Refused (${code}).`;

export function useLearningAction(csrf: string) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  async function run(body: Record<string, unknown>, reload = true) {
    if (busy) return false;
    setBusy(true); setError(null);
    const result = await adminPost<{ evaluation?: Evaluation }>('/admin/api/learning', body, csrf);
    setBusy(false);
    if ('evaluation' in result && result.evaluation) setEvaluation(result.evaluation);
    else if (!result.ok && 'evaluation' in result) setEvaluation((result as { evaluation?: Evaluation }).evaluation ?? null);
    if (!result.ok) { setError(message(result.code)); return false; }
    if (reload) window.location.reload();
    return true;
  }
  return { busy, error, evaluation, run };
}

export function CandidateActions({ csrf, canWrite, candidateId, state }: { csrf: string; canWrite: boolean; candidateId: string; state: 'PENDING' | 'APPROVED' | 'REJECTED' }) {
  const action = useLearningAction(csrf), [reason, setReason] = useState('');
  const disabled = !canWrite || action.busy;
  return <div className="admin-actions">
    {state === 'PENDING' && <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'approve', candidateId, reason: reason || null })}>Approve</button>}
    {state !== 'REJECTED' && <>
      <input type="text" aria-label="Reason" placeholder="Reason" value={reason} maxLength={200} disabled={disabled} onChange={event => setReason(event.target.value)}/>
      <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'reject', candidateId, reason })}>{state === 'APPROVED' ? 'Retract' : 'Reject'}</button></>}
    {state === 'REJECTED' && <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'reopen', candidateId, reason: reason || null })}>Reopen</button>}
    {action.error && <span className="admin-alert" data-tone="bad" role="alert">{action.error}</span>}
  </div>;
}

const TARGETS = ['network:ARBITRUM_SEPOLIA', 'network:BASE_SEPOLIA', 'network:ETHEREUM_SEPOLIA', 'network:SOLANA_DEVNET', 'network:ARBITRUM', 'network:BASE', 'network:SOLANA',
  'network:ROBINHOOD', 'asset:USDC', 'asset:WETH', 'asset:ETH', 'asset:SOL', 'asset:USDT', 'asset:WBTC', 'asset:DEVUSDC', 'operation:SWAP', 'operation:BRIDGE', 'operation:SUPPLY',
  'operation:BORROW', 'operation:REPAY', 'operation:WITHDRAW', 'operation:LIQUIDITY', 'operation:TRANSFER'];
function EvaluationResult({ evaluation }: { evaluation: Evaluation }) {
  return <div className="admin-alert" data-tone={evaluation.passed ? 'ok' : 'bad'} role="status">
    <strong>{evaluation.passed ? 'Evaluation passed' : 'Evaluation failed'}</strong> · {evaluation.entries} entries · corpus {evaluation.cases.candidate}/{evaluation.cases.total}
    {' '}· probes {evaluation.probes.passed}/{evaluation.probes.total} ({evaluation.probes.effective} effective, {evaluation.probes.hintOnly} interpreter hints only)
    {' '}· regressions {evaluation.regressions.length} · safety violations {evaluation.safetyViolations.length}
    {evaluation.document.code ? <> · document <code>{evaluation.document.code}</code></> : null}
    {[...evaluation.regressions, ...evaluation.safetyViolations, ...evaluation.cases.failed, ...evaluation.probes.failed].slice(0, 8).map(line =>
      <div key={line} className="admin-diff"><code>{line}</code></div>)}
  </div>;
}

export function KnowledgeControls({ csrf, canWrite, activeVersion, approved, history }: { csrf: string; canWrite: boolean; activeVersion: number; approved: number;
  history: readonly { version: number; disabled: boolean }[] }) {
  const action = useLearningAction(csrf), [reason, setReason] = useState(''), [target, setTarget] = useState<number | ''>('');
  const disabled = !canWrite || action.busy;
  return <div className="admin-form">
    <p>Publishing builds a document from every approved candidate ({approved}), evaluates it against the active version (v{activeVersion}) and appends v{activeVersion + 1}
      {' '}only if the evaluation passes: zero safety violations, zero regressions, every probe passing.</p>
    <label className="admin-field">Reason (recorded)<input type="text" value={reason} maxLength={200} disabled={disabled} onChange={event => setReason(event.target.value)}/></label>
    <div className="admin-actions">
      <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'evaluate' }, false)}>Evaluate approved (dry run)</button>
      <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'publish', expectedVersion: activeVersion, reason: reason || null })}>Evaluate and publish</button>
      <button type="button" disabled={disabled || activeVersion === 0} onClick={() => void action.run({ action: 'disable', expectedVersion: activeVersion, reason: reason || null })}>
        Disable glossary</button>
      <select aria-label="Version to restore" value={target} disabled={disabled} onChange={event => setTarget(event.target.value === '' ? '' : Number(event.target.value))}>
        <option value="">Restore version…</option>
        {history.filter(row => row.version < activeVersion).map(row => <option key={row.version} value={row.version}>v{row.version}{row.disabled ? ' (disabled)' : ''}</option>)}
      </select>
      <button type="button" disabled={disabled || target === ''} onClick={() => void action.run({ action: 'rollback', expectedVersion: activeVersion, toVersion: target, reason: reason || null })}>
        Re-evaluate and roll back</button>
    </div>
    {action.error && <p className="admin-alert" data-tone="bad" role="alert">{action.error}</p>}
    {action.evaluation && <EvaluationResult evaluation={action.evaluation}/>}
  </div>;
}

export function OperatorTools({ csrf, canWrite }: { csrf: string; canWrite: boolean }) {
  const action = useLearningAction(csrf), [term, setTerm] = useState(''), [target, setTarget] = useState(TARGETS[0]!), [language, setLanguage] = useState('PT');
  const disabled = !canWrite || action.busy;
  return <div className="admin-form">
    <div className="admin-form-row">
      <label className="admin-field">Term<input type="text" value={term} maxLength={32} disabled={disabled} spellCheck={false} onChange={event => setTerm(event.target.value)}/></label>
      <label className="admin-field">Means<select value={target} disabled={disabled} onChange={event => setTarget(event.target.value)}>
        {TARGETS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="admin-field">Language<select value={language} disabled={disabled} onChange={event => setLanguage(event.target.value)}>
        <option value="PT">PT</option><option value="EN">EN</option><option value="ANY">Any</option></select></label>
    </div>
    <div className="admin-actions">
      <button type="button" disabled={disabled || !term.trim()} onClick={() => void action.run({ action: 'add', term: term.trim().toLowerCase(), target, language })}>Add candidate</button>
      <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'starter' })}>Load reviewed PT-BR/EN starter set</button>
      <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'retention' })}>Run retention now</button>
      <button type="button" disabled={disabled} onClick={() => void action.run({ action: 'purge-automatic' })}>Erase automatic-learning data the current basis does not cover</button>
    </div>
    {action.error && <p className="admin-alert" data-tone="bad" role="alert">{action.error}</p>}
  </div>;
}
