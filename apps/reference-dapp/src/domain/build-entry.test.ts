// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { BUILD_ENTRY_SUGGESTIONS, buildEntryFresh, buildEntryLanding, buildEntryOutcome, type BuildEntrySnapshot } from './build-entry';
import { parseLocalCommand } from './commands';
import { editorReducer } from './editor';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { introducedTestNetworks } from './network-scope';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
const owner = '0x' + '1'.repeat(40);
const fresh = initialEditorHistory();
const freshInput = { workflow: fresh.editor.workflow, restorationEpoch: 0, authoringIncomplete: false, executionSurface: false, execution: false, proposal: false };

describe('BUILD0-UX-001 Build 0 landing', () => {
  it('opens on Build 0 only in the public chat-first workspace at /app', () => {
    const app = { pathname: '/app', engineering: false, approval: false, surface: 'workspace' as const };
    expect(buildEntryLanding(app)).toBe(true);
    for (const pathname of ['/app/dashboard', '/app/workflows', '/approve', '/mcp/approve', '/__engineering', null, undefined])
      expect(buildEntryLanding({ ...app, pathname }), String(pathname)).toBe(false);
    expect(buildEntryLanding({ ...app, engineering: true })).toBe(false);
    expect(buildEntryLanding({ ...app, approval: true })).toBe(false);
    expect(buildEntryLanding({ ...app, surface: 'signing' })).toBe(false);
  });

  it('a fresh visit stays on the entry; a workflow, a restored document, a recovered run or a proposal moves past it', () => {
    expect(buildEntryFresh(freshInput)).toBe(true);
    const authored = editorReducer(fresh.editor, parseLocalCommand('Swap 50 USDC to SOL on Solana', fresh.editor.workflow, context), context);
    expect(authored.error).toBeNull();
    expect(buildEntryFresh({ ...freshInput, workflow: authored.workflow })).toBe(false);
    // A saved workflow reopened through the existing reducer keeps every byte and never lands behind the entry.
    const saved = JSON.parse(JSON.stringify(authored.workflow)) as SemanticWorkflow;
    const restored = editorHistoryReducer(fresh, { type: 'RESTORE_WORKFLOW', workflow: saved });
    expect(restored.editor.workflow).toEqual(authored.workflow);
    expect(buildEntryFresh({ ...freshInput, workflow: restored.editor.workflow, restorationEpoch: 1 })).toBe(false);
    expect(buildEntryFresh({ ...freshInput, restorationEpoch: 1 })).toBe(false);
    expect(buildEntryFresh({ ...freshInput, executionSurface: true })).toBe(false);
    expect(buildEntryFresh({ ...freshInput, execution: true })).toBe(false);
    expect(buildEntryFresh({ ...freshInput, proposal: true })).toBe(false);
    expect(buildEntryFresh({ ...freshInput, authoringIncomplete: true })).toBe(false);
  });
});

describe('BUILD0-UX-001 Build 0 outcome (read from the stored workflow and FloFi’s reply)', () => {
  const before: BuildEntrySnapshot = { workflowId: 'workflow-local', revision: 0, proposal: null, messages: 1, question: null, automation: null };
  const intro = { role: 'system' as const, text: 'Hi FloFier!' };
  const you = { role: 'you' as const, text: 'Swap 50 USDC to SOL on Solana' };
  it('a committed request continues in Build 1', () => {
    expect(buildEntryOutcome(before, { ...before, revision: 1, messages: 3, log: [intro, you, { role: 'flofi', text: 'Swap added to your workflow.' }] })).toEqual({ kind: 'BUILT' });
    expect(buildEntryOutcome(before, { ...before, workflowId: 'workflow-2', log: [intro, you] })).toEqual({ kind: 'BUILT' });
  });
  it('a proposal that needs its review continues in Build 1 without being applied', () => {
    const proposal = { command: {} };
    expect(buildEntryOutcome(before, { ...before, proposal, messages: 3, log: [intro, you, { role: 'flofi', text: 'This would remove a step.' }] })).toEqual({ kind: 'PROPOSED' });
    // The same proposal that was already open is not a new outcome.
    expect(buildEntryOutcome({ ...before, proposal }, { ...before, proposal, messages: 3, log: [intro, you, { role: 'system', text: 'Not understood.' }] }).kind).toBe('REFUSED');
  });
  it('a question or a Copilot reply continues the same conversation in the Build 1 chat', () => {
    expect(buildEntryOutcome(before, { ...before, question: 'CONFIRM_WORKFLOW', messages: 3, log: [intro, you, { role: 'flofi', text: 'Review ready.' }] }).kind).toBe('CONVERSATION');
    expect(buildEntryOutcome(before, { ...before, messages: 3, log: [intro, you, { role: 'ai', text: 'Which asset do you want to supply?' }] }).kind).toBe('CONVERSATION');
    expect(buildEntryOutcome(before, { ...before, messages: 3, log: [intro, you, { role: 'system', text: 'Which wallet should I send it to?', options: ['Connect wallet'] }] }).kind).toBe('CONVERSATION');
    expect(buildEntryOutcome(before, { ...before, automation: { rule: 1 }, messages: 3, log: [intro, you, { role: 'system', text: 'Automation proposed.' }] }).kind).toBe('CONVERSATION');
  });
  it('nothing changed: the entry shows FloFi’s own reason and keeps the request', () => {
    const reason = 'This request could not be understood. Check the action, amount, asset and chain, then try again.';
    expect(buildEntryOutcome(before, { ...before, messages: 3, log: [intro, you, { role: 'system', text: reason }] })).toEqual({ kind: 'REFUSED', message: reason, language: null });
    expect(buildEntryOutcome(before, { ...before, messages: 3, log: [intro, you, { role: 'flofi', text: 'Adicione uma ação primeiro.', language: 'PT' }] }))
      .toEqual({ kind: 'REFUSED', message: 'Adicione uma ação primeiro.', language: 'PT' });
    // Earlier conversation messages are never read as this request's answer.
    expect(buildEntryOutcome({ ...before, messages: 3 }, { ...before, messages: 4, log: [intro, you, { role: 'ai', text: 'Earlier reply' }, you] })).toEqual({ kind: 'REFUSED', message: null, language: null });
  });
});

describe('BUILD0-UX-001 suggestion chips', () => {
  it('fill editable examples that never name a test network, in English and Portuguese', () => {
    expect(BUILD_ENTRY_SUGGESTIONS.map(item => item.label)).toEqual(['Earn yield', 'Swap assets', 'Provide liquidity', 'Use collateral', 'Multi-step strategy']);
    for (const item of BUILD_ENTRY_SUGGESTIONS) for (const text of [item.example.EN, item.example.PT]) {
      expect(text).not.toMatch(/sepolia|devnet|testnet|\btest\b|dev(USDC|SOL)/i);
      expect(text.length).toBeGreaterThan(10);
    }
  });
  it('the exact-command examples author mainnet actions through the existing parser and editor', () => {
    const empty = fresh.editor;
    for (const [text, beneficiary] of [['Swap 50 USDC to SOL on Solana', null], ['Supply 100 USDC to Aave on Base', owner], ['Quero colocar 100 USDC no Aave na Base', owner]] as const) {
      const command = parseLocalCommand(text, empty.workflow, context, beneficiary);
      const next = editorReducer(empty, command, context);
      expect(next.error, text).toBeNull();
      expect(next.workflow.nodes.some(node => !node.actionType.startsWith('mock-')), text).toBe(true);
      expect(introducedTestNetworks(empty.workflow, next.workflow, 'PUBLIC_MAINNET'), text).toEqual([]);
    }
  });
});
