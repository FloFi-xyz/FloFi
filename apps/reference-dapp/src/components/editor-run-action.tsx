// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: "Run workflow" on the Editor's Execute section — the multi-step workflow on the Canvas starts the
 * shared workflow run (`src/app/editor-run-action.ts`) and the browser opens its approval page, where the owner proves the wallet and chooses
 * "Confirm each step" or "Authorize once". This control never asks the wallet for anything, and never signs, submits or authorizes: the server
 * re-reads and re-gates the workflow, and every step keeps its own fresh simulation, Strategy Manifest Review and signature on `/approve`.
 */
import { useEffect, useRef, useState } from 'react';
import { editorWorkflowRunAvailability, startEditorWorkflowRun } from '../app/editor-run-action';
import type { EditorRunReadiness } from '../domain/editor-run';
import { useLocale } from '../i18n/locale';

/** Refusals the owner can act on, in plain words; any other code is shown with the generic sentence. */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  ACCOUNT_SESSION_REQUIRED: 'Sign in to FloFi to run this workflow from the Editor.',
  EDITOR_RUNS_NOT_ENABLED: 'Running a whole workflow is not enabled on this FloFi deployment.',
  WORKFLOW_RUNS_NOT_ENABLED: 'Running a whole workflow is not enabled on this FloFi deployment.',
  EDITOR_WORKFLOW_STEP_NOT_REPRESENTABLE: 'Step {0} cannot run as part of a workflow run yet. Execute this workflow step by step here instead.',
  EDITOR_WORKFLOW_PARITY_FAILED: 'Step {0} is not exactly what FloFi would run for it. Execute this workflow step by step here instead.',
  HANDOFF_RATE_LIMITED: 'Too many workflow runs were started recently. Try again later.',
  HANDOFF_PENDING_LIMIT: 'Too many workflow runs are waiting for you. Open or finish one of them first.',
  REVIEW_BLOCKED: 'FloFi\'s review blocks this workflow. Fix it on the Canvas first.',
  TEST_NETWORK_NOT_AVAILABLE: 'This workflow uses a test network. FloFi runs on mainnets only.',
};

export function EditorRunAction({ workflow, readiness, steps }: { workflow: unknown; readiness: EditorRunReadiness; steps: number }) {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [refusal, setRefusal] = useState<{ code: string; step?: number } | null>(null);
  const acting = useRef(false);
  useEffect(() => { void editorWorkflowRunAvailability().then(r => setEnabled(r.enabled)).catch(() => setEnabled(false)); }, []);
  // A refusal describes the workflow it was given; an edit or a new simulation makes it stale.
  useEffect(() => { setRefusal(null); }, [workflow]);
  if (!enabled || !readiness.offered) return null;
  async function run() {
    if (acting.current || !readiness.ready) return;
    acting.current = true; setBusy(true); setRefusal(null);
    try {
      const started = await startEditorWorkflowRun(workflow);
      if (!started.ok) { setRefusal({ code: started.code, ...started.step === undefined ? {} : { step: started.step } }); return; }
      // Same-origin only: the approval page of this FloFi, with the link's secret in the fragment (never sent to a server in a URL).
      const target = new URL(started.value.approvalUrl);
      window.location.assign(`${target.pathname}${target.hash}`);
    } catch { setRefusal({ code: 'EDITOR_RUN_FAILED' }); }
    finally { acting.current = false; setBusy(false); }
  }
  const refusalText = refusal ? REFUSAL_TEXT[refusal.code] ? t(REFUSAL_TEXT[refusal.code]!, String((refusal.step ?? 0) + 1))
    : t('FloFi could not start this workflow run ({0}). Nothing was authorized.', refusal.code) : null;
  return <section className="execute-next editor-run" aria-label={t('Run the whole workflow')}>
    <h3>{t('Run the whole workflow')}</h3>
    <p>{t('Runs all {0} steps in order on FloFi\'s approval page: confirm each step in your wallet, or authorize them in groups with your own wallet where it can batch them. Nothing is signed here.', steps)}</p>
    <button type="button" className="primary editor-run-action" data-editor-run={readiness.ready ? 'ready' : 'blocked'} disabled={!readiness.ready || busy}
      aria-busy={busy || undefined} aria-description={readiness.reason ? t(readiness.reason) : undefined} onClick={() => void run()}>{t(busy ? 'Starting workflow run…' : 'Run workflow')}</button>
    {!readiness.ready && readiness.reason && <p className="muted" role="status">{t(readiness.reason)}</p>}
    {refusalText && <p className="error-banner" role="alert">{refusalText}</p>}
    {refusal?.code === 'ACCOUNT_SESSION_REQUIRED' && <a className="secondary" href="/login?returnTo=%2Fapp">{t('Sign in')}</a>}
  </section>;
}
