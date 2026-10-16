// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

/**
 * BUILD-MCP-002 → BUILD-FLOFI-UX-UI-002: the FloFi side of an external proposal (`/approve#<secret>`). A valid link opens FloFi's normal
 * Canvas with the proposal's action cards already on it (the server's re-composed canonical workflow; seeing it grants nothing) and a
 * compact notice inside the workspace: where the proposal came from, that nothing is authorized yet, the real-funds and AI/third-party
 * disclosures, the owner's status-sharing choice and the wallet connection. As soon as a wallet of the workflow's namespace is proven —
 * an existing FloFi sign-in session or one sign-in message — the existing claim runs: the server re-verifies the proposal, the requester's
 * claim rule (e.g. a channel's intended wallet) and policy, the canonical workflow is restored through the validated path and the server
 * marks it applied only if it hashes exactly to the proposal. Until then Simulate and Execute stay closed. From there it is FloFi's own
 * flow: fresh simulation, Strategy Manifest Review, explicit approval, wallet signatures. An already applied proposal (a reload, another
 * tab) is restored only on the owner's explicit choice, so an interrupted run's recovery is never replaced silently. This component
 * never builds, signs or sends a transaction.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { approvalHandoffPreview, approvalHandoffView, claimApprovalHandoff, markApprovalApplied, openBrowserApprovalHandoff, resumeApprovalHandoff, setApprovalSharing } from '../app/approve-action';
import { DEVELOPER_LINK_PREFIX } from '../developer/link-format';
import { AUTOMATION_LINK_PREFIX } from '../automations/link-format';
import type { ApprovalView } from '../mcp/handoff/service';
import type { ApprovalPreview } from '../platform/approve';
import { APPROVAL_SECRET_FORMAT } from '../platform/approval-link-format';
import { walletDeepLinks } from '../platform/wallet-links';
import type { ClaimedProposal } from '../platform/approvals';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { useWorkflow } from '../state/workflow-store';
import type { SolanaWalletChain } from '../wallet/solana-wallet';
import { useWalletProof, WalletProof } from './wallet-proof';
import { McpRouteState } from './mcp-route-state';

// BUILD-DEVELOPER-001: any FloFi approval link (MCP's `flofi_hs_…` and later surfaces' own tags); the server resolves which one.
const SECRET = APPROVAL_SECRET_FORMAT;
const STORAGE_KEY = 'flofi.approval.secret';
const RECOVERY_KEY = 'flofi.approval.id';
const REFERENCE = /^apr_[a-z2-7]{26}$/;
const TERMINAL = ['EXPIRED', 'SUPERSEDED', 'REVOKED', 'STALE'];
const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Waiting for you', CLAIMED: 'Loaded for your wallet', APPLIED: 'In your FloFi workflow', EXPIRED: 'Expired', SUPERSEDED: 'Replaced by a newer request',
  REVOKED: 'Withdrawn', STALE: 'No longer reproducible',
};
/** Claim refusals the owner can act on, in plain words; any other code is shown as is. */
const CLAIM_TEXT: Record<string, string> = {
  CHANNEL_INTENDED_WALLET_MISMATCH: 'This proposal was prepared for another wallet. Connect the wallet it names to load it.',
  HANDOFF_ALREADY_CLAIMED: 'Another wallet already opened this proposal. Ask for a new proposal.',
  AUTOMATION_OWNER_MISMATCH: 'This automation belongs to another wallet. Connect the wallet that owns it.',
};
function unwrap<T>(result: { ok: true; value: T } | { ok: false; code: string }): T { if (!result.ok) throw new Error(result.code); return result.value; }
/** The handoff secret travels only in the URL fragment; it is moved to this tab's session storage and removed from the address bar. */
function takeSecret(): string | null {
  let fromHash: string;
  try { fromHash = typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1)); } catch { return null; }
  if (SECRET.test(fromHash) || REFERENCE.test(fromHash)) {
    try {
      // History restoration may present the same consumed fragment again. Keep its owner-only recovery hint;
      // a different presented link must never inherit the previous proposal's hint.
      if (sessionStorage.getItem(STORAGE_KEY) !== fromHash) sessionStorage.removeItem(RECOVERY_KEY);
      sessionStorage.setItem(STORAGE_KEY, fromHash);
    } catch { /* storage may be unavailable; the page still works until reload */ }
    window.history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  if (fromHash) return null;
  try { const stored = sessionStorage.getItem(STORAGE_KEY); return stored && (SECRET.test(stored) || REFERENCE.test(stored)) ? stored : null; } catch { return null; }
}

/**
 * `slot`: the workspace element the notice is rendered into (AppShell's notice slot). `onAvailabilityChange`: the workspace may show
 * (a usable proposal was resolved). `onGateChange`: Simulate and Execute must stay closed (the proposal is not yet loaded for the proven
 * wallet).
 */
export function ApprovalHandoff({ slot = null, onAvailabilityChange, onGateChange }: { slot?: HTMLElement | null; onAvailabilityChange?: (available: boolean) => void;
  onGateChange?: (blocked: boolean) => void }) {
  const { t: tr } = useLocale();
  const { state, restoreWorkflow } = useWorkflow();
  const [secret, setSecret] = useState<string | null>(null);
  const [view, setView] = useState<ApprovalView | null>(null);
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<boolean | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [recovery, setRecovery] = useState<ClaimedProposal | null>(null);
  const [closed, setClosed] = useState(false);
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  const applying = useRef<number | null>(null);
  const acting = useRef(false);
  const generation = useRef(0);
  const previewed = useRef<number | null>(null);
  const autoClaimed = useRef<string | null>(null);
  const chain: SolanaWalletChain = view?.steps.some(s => s.network === 'solana') ? 'solana:mainnet' : 'solana:devnet';
  const proof = useWalletProof(view?.walletNamespace ?? null, chain), proven = proof.proven;
  const internal = view?.requesterKind === 'AUTOMATION_RULE';
  const available = resolved && view !== null && !TERMINAL.includes(view.status) && !view.refusal;

  useEffect(() => {
    let request = 0;
    const load = async () => {
      const current = ++request, found = takeSecret();
      generation.current++;
      onAvailabilityChange?.(false);
      setSecret(found); setView(null); setPreview(null); setResolved(false); setError(null); setClaimed(false); setShare(null); setRecovery(null); setClosed(false);
      if (!found) { setResolved(true); return; }
      try {
        let capability = found;
        if (REFERENCE.test(found)) {
          const resumed = await resumeApprovalHandoff(found);
          if (current !== request) return;
          if (resumed.ok) { setRecovery(resumed.value); setView(resumed.value.view); setShare(resumed.value.view.statusShared); return; }
          capability = decodeURIComponent(new URL(unwrap(await openBrowserApprovalHandoff(found)).approvalUrl).hash.slice(1));
        }
        if (current !== request) return;
        setSecret(capability);
        try { sessionStorage.setItem(STORAGE_KEY, capability); } catch { /* tab memory still works */ }
        const result = await approvalHandoffView(capability);
        if (current !== request) return;
        if (result.ok) {
          setView(result.value); setShare(result.value.claimedByYou ? result.value.statusShared : result.value.sameAccount);
          try { sessionStorage.setItem(RECOVERY_KEY, result.value.approvalId); } catch { /* optional recovery hint */ }
          // BUILD-FLOFI-UX-UI-002: an open proposal's cards go straight onto the Canvas; only the exact proposal behind this link is accepted.
          if (result.value.status === 'PENDING' && !result.value.refusal) {
            const shown = await approvalHandoffPreview(capability).catch(() => null);
            if (current !== request) return;
            if (shown?.ok && shown.value.approvalId === result.value.approvalId && shown.value.workflowHash === result.value.workflowHash) setPreview(shown.value);
          }
        } else {
          let id: string | null = null;
          try { id = sessionStorage.getItem(RECOVERY_KEY); } catch { /* no recovery hint */ }
          const resumed = id && REFERENCE.test(id) ? await resumeApprovalHandoff(id) : null;
          if (current !== request) return;
          if (resumed?.ok) { setRecovery(resumed.value); setView(resumed.value.view); setShare(resumed.value.view.statusShared); }
          else setError(result.code);
        }
      } catch (cause) { if (current === request) setError(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'APPROVAL_UNAVAILABLE'); }
      finally { if (current === request) setResolved(true); }
    };
    // The product's skip link is a local anchor, not a new approval handoff.
    const hashChanged = () => { if (window.location.hash !== '#workspace') void load(); };
    void load();
    window.addEventListener('hashchange', hashChanged);
    window.addEventListener('popstate', hashChanged);
    return () => { request++; generation.current++; window.removeEventListener('hashchange', hashChanged); window.removeEventListener('popstate', hashChanged); };
  }, [onAvailabilityChange, reload]);
  useEffect(() => {
    onAvailabilityChange?.(available);
    return () => onAvailabilityChange?.(false);
  }, [available, onAvailabilityChange]);
  useEffect(() => {
    if (!secret || !SECRET.test(secret) || claimed || !view || !['PENDING', 'CLAIMED'].includes(view.status)) return;
    let stopped = false;
    const current = generation.current;
    const timer = setInterval(() => {
      void approvalHandoffView(secret).then(result => {
        if (stopped || current !== generation.current) return;
        if (result.ok) setView(result.value); else setError(result.code);
      }).catch(() => { if (!stopped && current === generation.current) setError('APPROVAL_UNAVAILABLE'); });
    }, 30_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [secret, claimed, view?.status]);
  // The previewed proposal enters the Canvas once per presented link, through the same validated restoration path as a claim.
  useEffect(() => {
    if (!preview || !available || claimed || previewed.current === generation.current) return;
    previewed.current = generation.current;
    restoreWorkflow(preview.workflow as SemanticWorkflow);
  }, [preview, available, claimed, restoreWorkflow]);
  // Once the proposal is applied, the server checks that the FloFi workflow hashes to exactly the proposal.
  useEffect(() => {
    const current = generation.current;
    if (!secret || !claimed || applying.current === current || view?.status === 'APPLIED' || state.workflow.revision === 0) return;
    applying.current = current;
    void markApprovalApplied(secret, state.workflow).then(result => {
      if (current !== generation.current) return;
      if (result.ok) setView(result.value); else setError(result.code);
    }).catch(() => { if (current === generation.current) setError('APPROVAL_UNAVAILABLE'); })
      .finally(() => { if (applying.current === current) applying.current = null; });
  }, [state.workflow, claimed, secret, view?.status]);

  async function run(action: () => Promise<void>) {
    if (acting.current) return; acting.current = true; setBusy(true); setError(null);
    const current = generation.current;
    try { await action(); } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'WALLET_REQUEST_FAILED');
    }
    finally { acting.current = false; setBusy(false); }
  }
  const claim = () => run(async () => {
    const current = generation.current;
    const result = recovery ?? unwrap(await claimApprovalHandoff(secret!, share === true));
    if (current !== generation.current) return;
    setView(result.view); setClaimed(true);
    // Reuse the existing validated workflow restoration path, which invalidates prior Review authority even if the hash is unchanged.
    // Simulation, Manifest Review and transaction signatures remain separate actions.
    restoreWorkflow(result.workflow as SemanticWorkflow);
  });
  // A proven wallet loads an open proposal (or finishes an interrupted claim) without a further click: the proof was the owner's action and
  // the server still re-verifies the owner, the claim rule and the exact canonical workflow. Each wallet is tried once per link.
  const reloadable = view !== null && (view.status === 'PENDING' || view.status === 'CLAIMED' && view.claimedByYou);
  const autoLoad = available && !claimed && !view!.claimedByAnotherWallet && (internal || !recovery && reloadable);
  useEffect(() => {
    if (!autoLoad || !proven || busy) return;
    const key = `${generation.current}:${proven}`;
    if (autoClaimed.current === key) return;
    autoClaimed.current = key;
    void claim();
  }, [autoLoad, proven, busy, reload]);
  // The product ends a sign-in session whose wallet no longer matches the connected account (router store). When the server finds no
  // proven wallet, the session read here is stale: read it again, so the owner is asked to connect instead of seeing the old account.
  const { refresh: refreshProof } = proof;
  useEffect(() => {
    if (!error || !/^(EVM|SOLANA)_WALLET_PROOF_REQUIRED$/.test(error)) return;
    setError(null);
    void refreshProof();
  }, [error, refreshProof]);
  // Another wallet's claim is relative to the wallets proven when the proposal was read: after a new proof, read it again.
  const recheckFor = view?.claimedByAnotherWallet && proven ? proven : null;
  useEffect(() => {
    if (!recheckFor || !secret || !SECRET.test(secret)) return;
    const current = generation.current;
    void approvalHandoffView(secret).then(result => { if (current === generation.current && result.ok) setView(result.value); }).catch(() => undefined);
  }, [recheckFor, secret]);
  // A proposal already applied for this wallet is restored only when its owner chooses to.
  const recoverable = !internal && !claimed && (recovery !== null || view?.status === 'APPLIED' && view.claimedByYou);
  const loaded = claimed && view?.status === 'APPLIED';
  const blocked = available && !loaded && !recoverable;
  useEffect(() => {
    onGateChange?.(blocked);
    return () => onGateChange?.(false);
  }, [blocked, onGateChange]);
  const toggleShare = (next: boolean) => {
    setShare(next);
    const current = generation.current;
    if (claimed && secret && !recovery) void setApprovalSharing(secret, next).then(r => {
      if (current !== generation.current) return;
      if (r.ok) setView(v => v && { ...v, statusShared: r.value.statusShared }); else setError(r.code);
    }).catch(() => { if (current === generation.current) setError('APPROVAL_UNAVAILABLE'); });
  };
  const close = () => {
    generation.current++;
    try { sessionStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem(RECOVERY_KEY); } catch { /* tab only */ }
    setClosed(true); setSecret(null); setView(null); setPreview(null); setClaimed(false);
  };

  // BUILD-DEVELOPER-001: who sent the link, where the page knows it (the resolved proposal, else the link's own tag). Only the wording
  // follows it; the route states, their headings and every check are the same for every requester.
  const fromApp = view ? view.requesterKind === 'DEVELOPER_PROJECT' : secret?.startsWith(DEVELOPER_LINK_PREFIX) === true;
  // BUILD-AUTOMATION-001: a proposal the owner's own automation prepared, opened from FloFi → Automations.
  const fromAutomation = view ? view.requesterKind === 'AUTOMATION_RULE' : secret?.startsWith(AUTOMATION_LINK_PREFIX) === true;
  if (closed) return <McpRouteState label="Approval" title="Approval closed" description={fromAutomation
    ? 'Closing this page grants no transaction authority. While the proposal is still waiting for you, open it again from FloFi → Automations.'
    : 'Return to the conversation that sent you here. Closing this page grants no transaction authority. You can reopen an unused link; ask for a new link if it has expired.'}/>;
  if (!resolved) return <McpRouteState label="Approval" title={tr("Opening your approval")} loading
    description={fromAutomation ? 'Getting the proposal your automation prepared…' : fromApp ? 'Getting the proposal from the app that sent you this link…' : 'Getting the proposal from your connected assistant…'}/>;
  if (!view && error && /^APPROVAL_(EXPIRED|REVOKED|SUPERSEDED|STALE)$/.test(error)) return <McpRouteState label="Approval"
    title="This approval is no longer available" description={fromAutomation ? 'Open the proposal again from FloFi → Automations if it is still waiting for you.'
      : 'Return to the conversation that sent this link and ask for a new proposal.'}/>;
  if (!secret || !view) return <><McpRouteState label="Approval" title={tr(fromAutomation ? 'Open this proposal from FloFi Automations' : 'Open this link from your assistant')}
    description={fromAutomation ? 'Open the proposal again from FloFi → Automations: FloFi prepares a fresh approval each time you open it.'
      : fromApp ? 'Open the FloFi approval link again from the app that sent it. If the link has expired, ask that app for a new one.'
      : error === 'APPROVAL_ACCOUNT_REQUIRED' ? 'Open this link in the browser used to connect FloFi to ChatGPT or Claude. For another browser or a mobile wallet, use the FloFi panel’s wallet action.'
      : 'Open the FloFi approval link from ChatGPT, Claude, WhatsApp or Telegram. If the link has expired, ask for a new one.'}/>
      {error && <div className="approval-page"><p role="alert">{tr(error)}</p><button type="button" onClick={() => setReload(n => n + 1)}>Try again</button></div>}</>;
  if (!available) return <McpRouteState label="Approval" title={tr("This approval is no longer available")}
    description={fromAutomation ? 'Open the proposal again from FloFi → Automations if it is still waiting for you.'
      : fromApp ? 'Ask the app that sent this link to prepare a new FloFi approval link.' : 'Ask your connected assistant to prepare a new FloFi approval link.'}/>;
  if (!slot) return null;
  const real = view.fundsClass === 'REAL_FUNDS', shown = error ?? proof.error;
  const errorText = shown === 'APPROVALS_NOT_ENABLED' || shown === 'MCP_OAUTH_NOT_ENABLED'
    ? fromApp ? 'Approvals are unavailable right now. Return to the app that sent this link and try again later.' : 'Approvals are unavailable right now. Return to your assistant and try again later.'
    : shown ? CLAIM_TEXT[shown] ?? shown : null;
  const prove = () => void (view.walletNamespace === 'solana' ? proof.proveSolana() : proof.proveEvm());
  const facts = <dl className="approval-facts">
    <div><dt>{tr("Network")}</dt><dd>{tr(view.networkEnvironment === 'MAINNET' ? 'Mainnet' : 'Public testnet')} · {tr([...new Set(view.steps.flatMap(s => [s.network, s.destinationNetwork].filter(Boolean)))].join(' → '))}</dd></div>
    <div><dt>{tr("Funds")}</dt><dd>{tr(real ? 'Real funds' : 'Test funds')}</dd></div>
    <div><dt>{tr("Approval status")}</dt><dd>{tr(STATUS_TEXT[view.status] ?? view.status)}</dd></div>
    <div><dt>{tr("Workflow hash")}</dt><dd><code>{view.workflowHash}</code></dd></div>
  </dl>;
  if (internal) return createPortal(<section className="approval-notice automation-workflow-entry" aria-label={tr('Automation workflow')} data-approval-state={loaded ? 'loaded' : 'waiting'}>
    <p>{tr('Prepared by your FloFi automation. Simulate and review before executing.')}</p>
    {!claimed && <WalletProof namespace={view.walletNamespace} proof={proof}/>}
    {busy && <p role="status">{tr('Loading your exact automation workflow…')}</p>}
    {errorText && <p role="alert">{tr(errorText)}</p>}
    {error && <button type="button" disabled={busy || !proven} onClick={() => void claim()}>{tr('Retry loading proposal')}</button>}
    <details><summary>{tr('Automation provenance')}</summary>{facts}</details>
  </section>, slot);
  const fullLink = secret && SECRET.test(secret) ? `${window.location.origin}/approve#${secret}` : null;
  const links = fullLink ? walletDeepLinks(fullLink, window.location.origin) : null;
  const wrongWallet = Boolean(proven && error && CLAIM_TEXT[error] && !claimed);
  let message: ReactNode;
  if (loaded) message = <p role="status">{recovery ? tr('Proposal restored for its proven owner. Run a fresh simulation before approval. Existing runs remain available in Your runs; reconcile an interrupted run before starting again.')
    : <><strong>{tr("Ready for your review.")}</strong>{tr(" Simulate the workflow, review the Strategy Manifest, then sign each transaction in your wallet.")}</>}</p>;
  else if (claimed || busy) message = <p role="status"><strong>{tr("Nothing is authorized yet.")}</strong> {tr('Loading your exact proposal…')}</p>;
  else if (recoverable) message = <p><strong>{tr("Nothing is authorized yet.")}</strong>{tr(" This proposal is already in a FloFi workflow for your wallet. Restore it to the Canvas to continue. An interrupted run stays in Your runs: reconcile it before starting again.")}</p>;
  else if (view.claimedByAnotherWallet) message = <p><strong>{tr("Nothing is authorized yet.")}</strong>{tr(" Another wallet already opened this proposal. If it was yours, connect that wallet; otherwise ask for a new proposal.")}</p>;
  else message = <p><strong>{tr("Nothing is authorized yet.")}</strong>{tr(preview
    ? " The proposal is on your Canvas. Connect your wallet to load it for a fresh simulation, your review and your signature."
    : " Connect your wallet to load this proposal into your Canvas for a fresh simulation, your review and your signature.")}</p>;
  return createPortal(<section className="approval-notice" aria-label={tr('Proposal from {0}', view.clientName)} data-approval-state={loaded ? 'loaded' : recoverable ? 'recoverable' : 'waiting'}>
    <div className="approval-notice-row">
      <p className="approval-notice-source"><span className="eyebrow">{tr('From {0}', view.clientName)}</span>
        <span className="status-badge info" aria-label={tr("Approval status")}>{tr(STATUS_TEXT[view.status] ?? view.status)}</span></p>
      {message}
      <div className="approval-actions">
        {!loaded && !claimed && <WalletProof namespace={view.walletNamespace} proof={proof}/>}
        {wrongWallet && <button type="button" className="secondary" disabled={proof.busy} onClick={prove}>{tr('Use another wallet')}</button>}
        {recoverable && proven && <button type="button" className="primary" disabled={busy} onClick={() => void claim()}>{tr('Restore proposal')}</button>}
        {error && !wrongWallet && !loaded && proven && !recoverable && <button type="button" className="secondary" disabled={busy} onClick={() => void (claimed
          ? run(async () => { const current = generation.current, result = unwrap(await markApprovalApplied(secret!, state.workflow)); if (current === generation.current) setView(result); })
          : claim())}>{tr('Retry loading proposal')}</button>}
        {!claimed && <button type="button" className="secondary" disabled={busy} onClick={close}>{tr('Close approval')}</button>}
      </div>
    </div>
    {real && <p className="approval-real" role="alert"><strong>{tr("Real funds.")}</strong>{tr(" This strategy uses a mainnet. Every transaction spends real assets once you sign it.")}</p>}
    {!fromAutomation && <label className="approval-share"><input type="checkbox" disabled={busy || Boolean(recovery)} checked={claimed ? view.statusShared : share === true}
      onChange={e => toggleShare(e.target.checked)}/>{tr("Share the status and evidence of runs started from this proposal with ")}{tr(view.clientName)}</label>}
    <p className="muted approval-ai">{view.requesterKind === 'DEVELOPER_PROJECT'
      ? tr("Created by {0}, a third-party app registered with FloFi, not by FloFi. It is not financial advice; you decide, and only your wallet can sign.", view.clientName)
      : tr("Proposed with an AI assistant from your conversation. It is not financial advice; you decide, and only your wallet can sign.")}</p>
    {errorText && <p className="error-banner" role="alert">{tr(errorText)}</p>}
    <details className="approval-details"><summary>{tr('Proposal details')}</summary>
      {facts}
      {view.summary && <p className="approval-summary">{tr(view.summary)}</p>}
      {view.explanation.length > 0 && <ul className="approval-explanation">{view.explanation.map((line, i) => <li key={i}>{tr(line)}</li>)}</ul>}
    </details>
    {!claimed && !recovery && links && <details className="approval-mobile"><summary>Open with a mobile wallet</summary>
      <p>Use the browser inside your wallet app. A sign-in message proves ownership; it never approves spending.</p>
      <div className="approval-actions">{view.walletNamespace === 'eip155' && <a className="primary" href={links.metamask} rel="noreferrer">Open in MetaMask</a>}
        {view.walletNamespace === 'solana' && <a href={links.phantom} rel="noreferrer" target="_blank">Open Phantom browser</a>}
        <button type="button" onClick={() => void run(async () => { await navigator.clipboard.writeText(fullLink!); setCopied(true); })}>Copy approval link</button></div>
      <p>{copied ? 'Link copied. ' : ''}In Phantom, paste the copied link into its browser. If your app does not preserve the link, paste it into the wallet browser. Keep this link private.</p>
      <input aria-label="Private approval link" readOnly value={fullLink!}/>
    </details>}
  </section>, slot);
}
