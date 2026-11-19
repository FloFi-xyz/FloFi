// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';

/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX, references A2/B2/C2): the Create → Simulate → Execute indicator lives in the Editor's own
 * header — the header of the Canvas frame on every stage — never in the global top bar. The shell provides the one indicator it computed (the
 * same targets and refusals as before) and each surface that draws the Editor header renders it once. Presentation only: nothing here simulates,
 * accepts, signs or submits, and the stage shown never changes the financial lifecycle state.
 */
export type EditorChrome = { readonly stepper: ReactNode | null };
const EditorChromeContext = createContext<EditorChrome>({ stepper: null });
export const EditorChromeProvider = EditorChromeContext.Provider;
/** The Editor's stage indicator, or null outside the Editor (Chat entry, Dashboard, secondary pages, the /approve signing surface). */
export function useEditorStepper(): ReactNode | null { return useContext(EditorChromeContext).stepper; }

/**
 * The Editor header for a stage view that has no Canvas frame of its own (an execution followed on its timeline, a step continuing in place, a
 * workflow whose configuration must be completed first): the workflow's name, its step count and the stage indicator, in the same place and look
 * as the Canvas header, so the Editor keeps one recognizable structure on every stage.
 */
export function EditorStageHead({ workflowName, steps }: { workflowName: string; steps: number }) {
  const { t: tr } = useLocale();
  const stepper = useEditorStepper();
  if (!stepper) return null;
  return <div className="canvas-head editor-stage-head panel">
    <div className="canvas-head-main"><h2>{workflowName === 'Your Workflow' ? tr('Your Workflow') : workflowName}</h2>
      <span className="revision">{tr(steps === 1 ? '1 step' : '{0} steps', steps)}</span></div>
    {stepper}
  </div>;
}
