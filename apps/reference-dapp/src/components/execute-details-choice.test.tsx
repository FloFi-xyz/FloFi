// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the owner's open/closed choice for Execution details belongs to one run. In a step-by-step
 * workflow the Canvas execution keeps one key across steps, but each step is a new run: a later step's failure opens its details by default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { HookHarness } from '../test-utils/hook-harness';
import { reviewFixture, reviewNow } from '../test-utils/review-fixture';
import { projectExecutionLifecycle, type ExecutionLifecycle, type ExecutionLifecycleSource } from '../domain/execution-lifecycle';
import type { CanvasExecution } from '../domain/canvas-execution';
import type { ExecuteWorkspaceProps } from './execute-workspace';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ language: 'EN', t: (value: string) => value }) }));
const { ExecuteWorkspace } = await import('./execute-workspace');

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value as Element, ...nodes((value as Element).props.children)];
}
const details = (tree: ReactNode) => nodes(tree).find(e => e.type === 'details' && String(e.props.className).includes('execution-details-disclosure'));

let host: HookHarness;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(reviewNow); host = new HookHarness();
  const events = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', { ...events, setTimeout, clearTimeout }); vi.stubGlobal('document', events);
});
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** One step's run of a step-by-step workflow: its own run key, the sequence's Canvas execution (one key for every step). */
function stepRun(runKey: string, attempt: string): ExecuteWorkspaceProps {
  const data = reviewFixture(); data.authorization.accepted = true;
  const run = 'run' in data.source.state ? data.source.state.run : {};
  const source = { ...data.source, state: { ...data.source.state, run: { ...run, attempts: [{ step: 'swap', state: attempt, txHash: '0x' + 'a'.repeat(64) }] } } } as unknown as typeof data.source;
  const progress = { ...projectExecutionLifecycle(data.workflow, data.context, source as unknown as ExecutionLifecycleSource), runKey } as ExecutionLifecycle;
  const canvasExecution: CanvasExecution = { key: `sequence:${data.workflow.workflowId}`, workflowId: data.workflow.workflowId, revision: data.workflow.revision,
    nodes: {}, started: true, settled: false, runKeys: [runKey] };
  return { ...data, source, progress, canvasExecution, workflowName: 'Two steps', backToBuild: vi.fn(), backToSimulate: vi.fn(),
    execution: { ready: true, started: true, start: vi.fn(), check: vi.fn(), prompt: '', expiresAt: null } } as unknown as ExecuteWorkspaceProps;
}

describe('Execution details choice', () => {
  it('a choice made for one step never hides a later step’s failure', () => {
    const first = stepRun('run-step-1', 'REVERTED');
    const opened = details(host.render(() => ExecuteWorkspace(first)));
    expect(opened?.props.open).toBe(true);
    // The owner closes the first step's details: that run keeps the choice.
    (opened!.props.onToggle as (event: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open: false } });
    expect(details(host.render(() => ExecuteWorkspace(first)))?.props.open).toBe(false);
    // The next step is a new run of the same sequence: its failure opens its details by default.
    expect(details(host.render(() => ExecuteWorkspace(stepRun('run-step-2', 'REVERTED'))))?.props.open).toBe(true);
  });
});
