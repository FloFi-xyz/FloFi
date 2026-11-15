// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the chat's view of the owner's SAVED automations, opened by an automation-management request ("quais automações eu
 * tenho?", "pausa essa", "por que não rodou?", "muda para sexta"). It reads only through the existing owner-verified server actions, writes every
 * line from FloFi's own records (`automations/explain.ts`), and changes nothing until the owner clicks Confirm on the exact change shown — a change
 * the server re-verifies (owner proof, version, state). A schedule change replaces the automation (the definition is immutable): a new one with the
 * new schedule and the old one archived, in one step. Nothing here signs, authorizes spending or executes anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { automationHistory, automationOverview, changeAutomationState, replaceAutomationSchedule } from '../app/automation-action';
import { explainRuleStatus, parseScheduleChange, ruleSummary, scheduleText } from '../automations/explain';
import type { RuleView } from '../automations/views';
import type { CopilotAutomationOperation } from '../domain/copilot-intent-v2';
import type { WorkflowOwner } from '../domain/saved-workflow';
import { useLocale } from '../i18n/locale';
import { WalletProof, type useWalletProof } from './wallet-proof';

type Load = { readonly owner: string; readonly rules: readonly RuleView[] } | null;
const LIVE = new Set(['ACTIVE', 'PAUSED']);
/** Which saved automations an operation can act on. */
const candidatesFor = (operation: CopilotAutomationOperation, rules: readonly RuleView[], request: string): readonly RuleView[] => {
  const live = rules.filter(rule => rule.state !== 'ARCHIVED');
  switch (operation) {
    case 'PAUSE': return live.filter(rule => rule.state === 'ACTIVE');
    case 'RESUME': return live.filter(rule => rule.state === 'PAUSED');
    case 'ARCHIVE': return live;
    case 'RESCHEDULE': return live.filter(rule => LIVE.has(rule.state) && rule.schedule !== null && rule.executionMode === 'CONFIRM_EACH_TIME');
    case 'LIST': return /\b(?:ativ|active)\w*/i.test(request) ? live.filter(rule => rule.state === 'ACTIVE') : live;
    default: return live;
  }
};
const WRITES = new Set<CopilotAutomationOperation>(['PAUSE', 'RESUME', 'ARCHIVE', 'RESCHEDULE']);

export function CopilotAutomationManager({ operation, request, owner, proof, dismiss }: { operation: CopilotAutomationOperation; request: string; owner: WorkflowOwner | null;
  proof?: ReturnType<typeof useWalletProof>; dismiss(): void }) {
  const { t, language } = useLocale();
  const [load, setLoad] = useState<Load>(null), [verification, setVerification] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [explained, setExplained] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [done, setDone] = useState<string | null>(null);
  const generation = useRef(0), lock = useRef(false);
  const ownerKey = owner ? `${owner.namespace}:${owner.address}` : null;
  const rules = load?.owner === ownerKey ? load.rules : null;
  const candidates = useMemo(() => rules ? candidatesFor(operation, rules, request) : [], [rules, operation, request]);
  const target = candidates.find(rule => rule.ruleId === selected) ?? (candidates.length === 1 ? candidates[0]! : null);
  const change = operation === 'RESCHEDULE' && target?.schedule ? parseScheduleChange(request, target.schedule) : null;

  useEffect(() => {
    const current = ++generation.current;
    setLoad(null); setVerification(null); setError(null); setSelected(null); setExplained(null); setDone(null);
    if (owner && ownerKey) void automationOverview(owner).then(result => {
      if (current !== generation.current) return;
      if (result.ok) setLoad({ owner: ownerKey, rules: result.value.rules });
      else if (result.code === 'WALLET_SESSION_REQUIRED') setVerification(ownerKey);
      else setError('Automations are unavailable on this deployment right now.');
    }).catch(() => { if (current === generation.current) setError('Automations are unavailable on this deployment right now.'); });
    return () => { generation.current++; };
  }, [ownerKey, operation, request, proof?.proven]);
  // STATUS / EXPLAIN / WHY_NOT_RUN read the chosen automation's own recorded history (owner-scoped on the server).
  useEffect(() => {
    if (!owner || !target || WRITES.has(operation) || operation === 'LIST') { setExplained(null); return; }
    const current = generation.current;
    void automationHistory(owner, target.ruleId).then(result => {
      if (current !== generation.current) return;
      setExplained(result.ok ? explainRuleStatus(result.value.rule, result.value.entries, result.value.occurrences, language).text
        : explainRuleStatus(target, null, null, language).text);
    }).catch(() => { if (current === generation.current) setExplained(explainRuleStatus(target, null, null, language).text); });
  }, [target?.ruleId, operation, language]);

  async function confirm() {
    if (lock.current || !owner || !target) return;
    lock.current = true; setBusy(true); setError(null);
    const current = generation.current;
    try {
      if (operation === 'RESCHEDULE') {
        if (!change) return;
        const result = await replaceAutomationSchedule(owner, target.ruleId, target.version, change);
        if (current !== generation.current) return;
        if (result.ok) setDone(t('Schedule changed. The new automation: {0}', ruleSummary(result.value.created, language)));
        else setError(t('FloFi could not complete this ({0}).', result.code));
      } else if (operation === 'PAUSE' || operation === 'RESUME' || operation === 'ARCHIVE') {
        const result = await changeAutomationState(owner, target.ruleId, target.version, operation);
        if (current !== generation.current) return;
        if (result.ok) setDone(ruleSummary(result.value, language));
        else setError(t('FloFi could not complete this ({0}).', result.code));
      }
    } catch { if (current === generation.current) setError('Automations are unavailable on this deployment right now.'); }
    finally { lock.current = false; if (current === generation.current) setBusy(false); }
  }

  const verb = operation === 'PAUSE' ? 'Pause' : operation === 'RESUME' ? 'Resume' : operation === 'ARCHIVE' ? 'Archive (delete)' : operation === 'RESCHEDULE' ? 'Change schedule' : null;
  return <section className="automation-card copilot-automation-manager" aria-label={t('Your automations')}>
    <h3>{t('Your automations')}</h3>
    {!owner ? <p>{t('Connect a wallet from the header to use automations.')}</p> : verification === ownerKey && proof
      ? <WalletProof namespace={owner.namespace} proof={{ ...proof, proven: null }}/>
      : !rules && !error ? <p role="status">{t('Loading automations…')}</p> : null}
    {rules && !candidates.length && <p>{t(WRITES.has(operation) ? 'None of your saved automations can take this change.' : 'You have no saved automations here yet.')}</p>}
    {rules && candidates.length > 0 && (operation === 'LIST' || candidates.length > 1) && <ul className="automation-rule-list">
      {candidates.map(rule => <li key={rule.ruleId}>
        {operation === 'LIST' ? ruleSummary(rule, language)
          : <label><input type="radio" name="copilot-automation-target" checked={target?.ruleId === rule.ruleId} disabled={busy || Boolean(done)}
            onChange={() => setSelected(rule.ruleId)}/> {ruleSummary(rule, language)}</label>}
      </li>)}
    </ul>}
    {target && operation !== 'LIST' && candidates.length === 1 && <p>{ruleSummary(target, language)}</p>}
    {explained && <p className="automation-explanation">{explained}</p>}
    {operation === 'RESCHEDULE' && target && (change
      ? <p>{t('From {0} to {1}. A saved automation cannot be edited in place: FloFi creates a new one with the new schedule and archives this one in the same step.',
        scheduleText(target, language), scheduleText({ schedule: change, timezone: target.timezone }, language))}</p>
      : <p>{t('Tell me the new day and time, for example “muda para sexta às 10h”.')}</p>)}
    {verb && target && !done && <p>{t('Nothing changes until you confirm. This never authorizes spending: each execution still asks for your wallet.')}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {done && <p role="status">{done}</p>}
    <div className="automation-row-actions">
      {verb && target && !done && <button type="button" className="primary" disabled={busy || (operation === 'RESCHEDULE' && !change)} onClick={() => void confirm()}>{t(verb)}</button>}
      <a href="/app/automations">{t('Open Automations')}</a>
      <button type="button" disabled={busy} onClick={dismiss}>{t('Close')}</button>
    </div>
  </section>;
}
