// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';
import { NetworkBrandIcon } from './brand-icon';
import { WorkflowName } from './workflow-name';

/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX, references A2/B2/C2): the Create → Simulate → Execute indicator lives in the Editor's own
 * header — the header of the Canvas frame on every stage — never in the global top bar. The shell provides the one indicator it computed (the
 * same targets and refusals as before) and each surface that draws the Editor header renders it once. Presentation only: nothing here simulates,
 * accepts, signs or submits, and the stage shown never changes the financial lifecycle state.
 *
 * UX-02 (owner guidelines of 21-11-2026, references D/E/G): one Editor header on every stage — the workflow's identity (name with its rename
 * control, step count, networks) on the left, the stage indicator centred, the stage's existing controls on the right — laid out by the same
 * three-column row (`editor-head-row`) so the indicator keeps its place and the header its height when the stage changes. `networks` and
 * `rename` are the shell's own values (the Canvas overview's networks; the session-only workflow name), never a new source.
 */
export type EditorChrome = { readonly stepper: ReactNode | null; readonly networks?: readonly string[] | undefined;
  /** Renaming is session identity only (`WorkflowName`): it never edits the canonical workflow or its revision. */
  readonly rename?: ((name: string) => void) | undefined };
const EditorChromeContext = createContext<EditorChrome>({ stepper: null });
export const EditorChromeProvider = EditorChromeContext.Provider;
/** The Editor's stage indicator, or null outside the Editor (Chat entry, Dashboard, secondary pages, the /approve signing surface). */
export function useEditorStepper(): ReactNode | null { return useContext(EditorChromeContext).stepper; }
export function useEditorChrome(): EditorChrome { return useContext(EditorChromeContext); }

/** The networks the workflow's steps use, as the Create header shows them (one chip each, read-only). */
export function EditorNetworkChips({ networks }: { networks: readonly string[] }) {
  const { t: tr } = useLocale();
  if (!networks.length) return null;
  return <ul className="editor-network-chips" aria-label={tr('Workflow networks')}>{networks.map(network => <li key={network}>
    <span className="editor-network-icon" aria-hidden="true"><NetworkBrandIcon network={network}/></span>{tr(network)}</li>)}</ul>;
}

/**
 * UX-02: the identity block of the Simulate and Execute headers — the same name control, step count and network chips as Create, so only the
 * stage's selected step and its contextual content change between stages. Creating a new workflow stays a Create control.
 */
export function EditorHeadIdentity({ workflowName, steps }: { workflowName: string; steps: number }) {
  const { t: tr } = useLocale();
  const { networks = [], rename } = useEditorChrome();
  const shownName = workflowName === 'Your Workflow' ? tr('Your Workflow') : workflowName;
  return <div className="editor-head-identity">
    {rename ? <WorkflowName name={workflowName} shownName={shownName} rename={rename}/> : <h2>{shownName}</h2>}
    <EditorNetworkChips networks={networks}/>
    <span className="revision">{tr(steps === 1 ? '1 step' : '{0} steps', steps)}</span>
  </div>;
}

/** UX-02: the Simulate / Execute header row — identity, the centred stage indicator, and the (empty) end column that keeps it centred. */
export function EditorHeadRow({ workflowName, steps, stepper }: { workflowName: string; steps: number; stepper: ReactNode }) {
  return <div className="canvas-head-main editor-head-row">
    <EditorHeadIdentity workflowName={workflowName} steps={steps}/>
    <div className="canvas-head-stages">{stepper}</div>
    <div className="canvas-head-actions editor-head-end"/>
  </div>;
}

/**
 * The Editor header for a stage view that has no Canvas frame of its own (an execution followed on its timeline, a step continuing in place, a
 * workflow whose configuration must be completed first): the workflow's name, its step count and the stage indicator, in the same place and look
 * as the Canvas header, so the Editor keeps one recognizable structure on every stage.
 */
export function EditorStageHead({ workflowName, steps }: { workflowName: string; steps: number }) {
  const stepper = useEditorStepper();
  if (!stepper) return null;
  return <div className="canvas-head editor-stage-head editor-head panel"><EditorHeadRow workflowName={workflowName} steps={steps} stepper={stepper}/></div>;
}
