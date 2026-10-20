// SPDX-License-Identifier: AGPL-3.0-only
// Browser component acceptance only. No production route imports this module; no wallet or RPC is available here.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SigningSurface } from '../components/signing-surface';
import { SimulateWorkspace } from '../components/simulate-workspace';
import { CanvasLifecycleAction } from '../components/canvas-lifecycle-action';
import { useExecutionControls, type ExecutionControlsState } from '../state/execution-controls';
import { ExecuteAcceptanceWorkflowProvider } from './execute-acceptance-workflow';
import { LocaleProvider, type Language } from '../i18n/locale';
import { networkIdentity } from '../domain/network-registry';

declare global { interface Window { flofiSigningAcceptance: { counts(): { reviews: number; walletRequests: number }; networkRequests(): string[]; changeWallet(): void; canvas(): void } } }
export function mount(element: HTMLElement, initial: ExecutionControlsState, language: Language = 'EN') {
  const counts = { reviews: 0, walletRequests: 0 };
  const networkRequests: string[] = [];
  function Harness() {
    const [accepted, setAccepted] = useState(false), [canvas, setCanvas] = useState(false), [wallet, setWallet] = useState(initial.wallet);
    const data: ExecutionControlsState = { ...initial, wallet, authorization: { ...initial.authorization, accepted, approve: async () => { counts.reviews++; setAccepted(true); } },
      execution: { ...initial.execution, ready: accepted, start: () => { counts.walletRequests++; return new Promise<void>(() => {}); } } };
    const controls = useExecutionControls(data);
    window.flofiSigningAcceptance = { counts: () => ({ ...counts }), networkRequests: () => [...networkRequests], canvas: () => setCanvas(true),
      changeWallet: () => setWallet(current => ({ ...current, changed: true, account: current.chain?.startsWith('solana:') ? 'ChangedSolanaAccount' : '0x' + '2'.repeat(40) })) };
    if (canvas) return <div className="app-shell"><main className="main workflow-workspace">
      <ExecuteAcceptanceWorkflowProvider workflow={data.workflow} context={data.context}><SimulateWorkspace workflowName="Requested operation" returnToBuild={() => setCanvas(false)} simulationSource={data.source}
        simulateAction={<CanvasLifecycleAction {...data} controls={controls} simulationDisabled={false} simulate={() => {}}/>}/></ExecuteAcceptanceWorkflowProvider>
    </main></div>;
    const required = networkIdentity(data.authorization.chain);
    const networkAction = required && wallet.chain !== required.chain ? { label: `Switch to ${required.name}`, disabled: false,
      request: () => { networkRequests.push(required.chain); setWallet(current => ({ ...current, chain: required.chain, changed: true,
        environment: required.environment === 'MAINNET' ? 'mainnet' : 'testnet' })); } } : undefined;
    return <div className="app-shell"><SigningSurface {...data} controls={controls} workflowName="Requested operation" gated={false} simulationDisabled={false} simulate={() => {}} onViewInFloFi={() => setCanvas(true)} networkAction={networkAction}/></div>;
  }
  createRoot(element).render(<LocaleProvider initialLanguage={language}><Harness/></LocaleProvider>);
}
