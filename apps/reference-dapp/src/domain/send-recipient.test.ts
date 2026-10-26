// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ARB-001 Phase 7, UX-001 / UX-005: the Send card's "To" field, Copilot destination slot filling and the Send presentation name. */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARBITRUM_ONE, parseArbitrumTokenList, toChecksumAddress } from '@defi-workflow-engine/action-registry';
import { TRANSFER_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { checkRecipient, recipientPolicy, RECIPIENT_FORMATS } from './recipient-address';
import { completeSendDestination, sendDestinationIssue, SEND_DESTINATION_QUESTION } from './send-destination';
import { canvasAmountCommand, canvasAmountMessage, setupSummary, actionReviewValue } from './canvas-action-setup';
import { editorHistoryReducer, templateEditorHistory, type EditorHistory } from './editor-history';
import { parseLocalCommand } from './commands';
import { transferDetails } from './robinhood-transfer-authoring';
import { composerActions, composerSummary } from './composer-presentation';
import { registerNetworkCatalog } from './asset-catalogs';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { stepSummary } from './copilot-answers';
import { workflowSteps } from './workflow-steps';
import { projectDashboardRun } from '../lib/dashboard/run-mapping';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

const RECIPIENT = '0x3333333333333333333333333333333333333333';
// EIP-55 reference vector with mixed case; BAD flips one letter's case so its checksum no longer matches.
const MIXED = toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
const BAD = MIXED.replace('aAeb', 'aaeb');
const context = new CopilotSession().context;
beforeAll(() => {
  const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
  registerNetworkCatalog(parseArbitrumTokenList(bytes, '2026-10-11T22:06:20.000Z'));
});
/** A Canvas Send setup on Arbitrum One with the given amount (and optionally a typed destination). */
function canvasSend(amount: string, recipient?: string): EditorHistory {
  let history = editorHistoryReducer(templateEditorHistory(), { type: 'START_ACTION_SETUP', action: 'transfer', position: { x: 0, y: 0 } });
  const id = history.actionSetup!.id;
  history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id, selection: { action: 'transfer', network: 'Arbitrum One', from: 'USDC' }, context });
  history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id, amount, context });
  return recipient === undefined ? history : editorHistoryReducer(history, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient, context });
}
function applySetup(history: EditorHistory): EditorHistory {
  const id = history.actionSetup!.id;
  const command = canvasAmountCommand(history.editor, history.actionSetup, history.amountInputs, id, context, history.bridgeNetworkInputs, history.cryptoSelections, history.recipientInputs);
  return editorHistoryReducer(history, { type: 'COMMAND', command, context, authoringId: id, authoringAmount: actionReviewValue(history.actionSetup, id, undefined)! });
}
const recipientOf = (workflow: SemanticWorkflow | EditorHistory['editor']['workflow']) =>
  transferDetails(workflow.nodes.find(node => node.actionType === TRANSFER_ACTION)! as SemanticWorkflow['nodes'][number])?.recipient;

describe('UX-001 network-aware destination validation', () => {
  it('accepts EVM addresses in single case or exact EIP-55 and normalizes them to the canonical lower-case recipient', () => {
    for (const value of [RECIPIENT, RECIPIENT.toUpperCase().replace('0X', '0x'), MIXED, `  ${MIXED}\n`])
      expect(checkRecipient('Arbitrum One', value)).toEqual({ ok: true, recipient: value.trim().toLowerCase() });
  });
  it.each(['0x123', '0x' + 'g'.repeat(40), '3333333333333333333333333333333333333333', BAD, 'vitalik.eth'])(
    'rejects the malformed or mis-checksummed destination %s', value => {
      expect(checkRecipient('Arbitrum One', value)).toEqual({ ok: false, code: 'TRANSFER_RECIPIENT_INVALID' });
    });
  it('treats an empty destination as missing, and owner-only networks as the connected owner', () => {
    expect(checkRecipient('Base', '')).toEqual({ ok: false, code: 'TRANSFER_RECIPIENT_REQUIRED' });
    expect(checkRecipient('Robinhood Chain', '   ')).toEqual({ ok: false, code: 'TRANSFER_RECIPIENT_REQUIRED' });
    for (const network of ['Robinhood Chain Testnet', 'Ethereum Sepolia']) {
      expect(recipientPolicy(network).kind).toBe('OWNER_ONLY');
      expect(checkRecipient(network, RECIPIENT)).toEqual({ ok: true, recipient: 'CONNECTED_OWNER' });
    }
    // BUILD-SOLANA-TRANSFER-UX-001: Solana is its own transfer family; an EVM address is never a Solana recipient, and a destination is required.
    expect(checkRecipient('Solana', RECIPIENT)).toEqual({ ok: false, code: 'TRANSFER_RECIPIENT_INVALID' });
    expect(checkRecipient('Solana Devnet', ' ')).toEqual({ ok: false, code: 'TRANSFER_RECIPIENT_REQUIRED' });
  });
  it('selects the address family from the CAIP-2 namespace of the transfer network, so a new family is one format entry', () => {
    expect(Object.keys(RECIPIENT_FORMATS)).toEqual(['eip155', 'solana']);
    for (const network of ['Base', 'Arbitrum One', 'Robinhood Chain']) expect(recipientPolicy(network)).toMatchObject({ kind: 'ADDRESS', format: RECIPIENT_FORMATS.eip155 });
    for (const network of ['Solana', 'Solana Devnet']) expect(recipientPolicy(network)).toMatchObject({ kind: 'ADDRESS', format: RECIPIENT_FORMATS.solana });
    // A Solana wallet key is kept exactly as typed on Solana and refused on an EVM network.
    const wallet = createMockedSolanaWallet().owner;
    expect(checkRecipient('Solana', wallet)).toEqual({ ok: true, recipient: wallet });
    expect(checkRecipient('Base', wallet)).toEqual({ ok: false, code: 'TRANSFER_RECIPIENT_INVALID' });
  });
});

describe('UX-001 Canvas "To" field drafts the one canonical recipient', () => {
  it('an empty or malformed destination never becomes a reviewable command', () => {
    for (const [typed, code] of [[undefined, 'TRANSFER_RECIPIENT_REQUIRED'], ['', 'TRANSFER_RECIPIENT_REQUIRED'], ['0x1234', 'TRANSFER_RECIPIENT_INVALID']] as const) {
      const history = canvasSend('5', typed);
      expect(() => canvasAmountCommand(history.editor, history.actionSetup, history.amountInputs, history.actionSetup!.id, context, {}, {}, history.recipientInputs)).toThrow(code);
    }
    expect(canvasAmountMessage(Error('TRANSFER_RECIPIENT_REQUIRED'))).toBe('Enter the recipient address.');
    expect(canvasAmountMessage(Error('TRANSFER_RECIPIENT_INVALID'))).toBe('Enter a valid recipient address for this network.');
  });
  it('applies the typed destination into the canonical transfer recipient, equal to Chat, Copilot and MCP', () => {
    const applied = applySetup(canvasSend('5', MIXED));
    expect(applied.actionSetup).toBeNull(); expect(applied.recipientInputs).toEqual({});
    expect(recipientOf(applied.editor.workflow)).toBe(MIXED.toLowerCase());
    const canonical = composeStrategy({ version: 1, action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '5', recipient: MIXED.toLowerCase() } as never);
    expect(canonical.ok).toBe(true); if (!canonical.ok) return;
    const canvasNode = composerActions(applied.editor.workflow)[0]!, mcpNode = composerActions(canonical.workflow as never)[0]!;
    expect({ ...canvasNode, nodeId: 'x' }).toEqual({ ...mcpNode, nodeId: 'x' });
    const chat = parseLocalCommand(`send 5 USDC on Arbitrum to ${MIXED.toLowerCase()}`, templateEditorHistory().editor.workflow, context);
    expect(chat).toMatchObject({ type: 'ADD_RH_TRANSFER', input: { network: 'Arbitrum One', recipient: MIXED.toLowerCase() } });
  });
  it('edits an authored Send destination through the same review; a later edit makes the earlier review stale; Cancel restores it', () => {
    let history = applySetup(canvasSend('5', RECIPIENT));
    const id = composerActions(history.editor.workflow)[0]!.nodeId;
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: MIXED, context });
    expect(history.amountInputs[id]).toBe('5'); expect(history.recipientInputs[id]).toBe(MIXED);
    const command = canvasAmountCommand(history.editor, null, history.amountInputs, id, context, {}, history.cryptoSelections, history.recipientInputs);
    const reviewed = actionReviewValue(null, id, history.amountInputs[id], undefined, history.cryptoSelections[id], history.recipientInputs[id])!;
    const changed = editorHistoryReducer(history, { type: 'EDIT_CANVAS_RECIPIENT', id, recipient: RECIPIENT, context });
    expect(editorHistoryReducer(changed, { type: 'COMMAND', command, context, authoringId: id, authoringAmount: reviewed }).editor.workflow).toBe(changed.editor.workflow);
    const applied = editorHistoryReducer(history, { type: 'COMMAND', command, context, authoringId: id, authoringAmount: reviewed });
    expect(recipientOf(applied.editor.workflow)).toBe(MIXED.toLowerCase()); expect(applied.recipientInputs).toEqual({});
    const cancelled = editorHistoryReducer(history, { type: 'CANCEL_CANVAS_AMOUNT', id });
    expect(cancelled.recipientInputs).toEqual({}); expect(recipientOf(cancelled.editor.workflow)).toBe(RECIPIENT);
  });
  it('a typed destination on an owner-only network is never a draft', () => {
    let history = editorHistoryReducer(templateEditorHistory(), { type: 'START_ACTION_SETUP', action: 'transfer', position: { x: 0, y: 0 } });
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_RECIPIENT', id: history.actionSetup!.id, recipient: RECIPIENT, context });
    expect(history.actionSetup!.cryptoRecipient).toBeUndefined();
  });
});

describe('UX-001 Copilot destination slot filling (same canonical recipient)', () => {
  it('asks which wallet when a natural Send names none, and the answer authors the same Canvas recipient', () => {
    // Natural language (the exact grammar is covered below): the model reports no recipient.
    const s = new CopilotSession();
    const ask = s.say('Please send 5 USDC on Arbitrum', intent.action(act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5' })))!;
    expect(ask).toMatchObject({ kind: 'CLARIFICATION', text: SEND_DESTINATION_QUESTION }); expect(ask.command).toBeUndefined();
    const reply = s.say(MIXED, intent.action(act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5', recipient: MIXED })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: `transfer 5 USDC on Arbitrum One to ${MIXED.toLowerCase()}`, command: { type: 'ADD_RH_TRANSFER', input: { recipient: MIXED.toLowerCase() } } });
    s.apply();
    expect(recipientOf(s.workflow)).toBe(recipientOf(applySetup(canvasSend('5', MIXED)).editor.workflow));
  });
  it('a provided destination proposes directly; a mis-checksummed one is asked again; "to my own wallet" is the connected owner', () => {
    const direct = new CopilotSession().say(`Please send 5 USDC on Arbitrum to ${RECIPIENT}`, intent.action(act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5', recipient: RECIPIENT })))!;
    expect(direct).toMatchObject({ kind: 'PROPOSAL', command: { input: { recipient: RECIPIENT } } });
    const invalid = new CopilotSession().say(`Please send 5 USDC on Arbitrum to ${BAD}`, intent.action(act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5', recipient: BAD })))!;
    expect(invalid).toMatchObject({ kind: 'CLARIFICATION' }); expect(invalid.text).toContain('not a valid Arbitrum One address');
    const self = new CopilotSession().say('Please send 5 USDC on Arbitrum to my own wallet', intent.action(act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5' })))!;
    expect(self).toMatchObject({ kind: 'PROPOSAL', command: { input: { recipient: 'CONNECTED_OWNER' } } });
    const pt = new CopilotSession().say('Manda 5 USDC na Arbitrum', intent.action(act.transfer({ network: 'ARBITRUM', asset: 'USDC', amount: '5' }), 'PT'))!;
    expect(pt).toMatchObject({ kind: 'CLARIFICATION', text: 'Para qual carteira devo enviar?' });
  });
  it('the Copilot box completes an exact Send that names no destination instead of defaulting to the connected wallet', () => {
    const workflow = templateEditorHistory().editor.workflow;
    const bare = parseLocalCommand('send 5 USDC on Arbitrum', workflow, context);
    expect(bare).toMatchObject({ type: 'ADD_RH_TRANSFER', input: { recipient: 'CONNECTED_OWNER' } });
    expect(sendDestinationIssue(bare, 'send 5 USDC on Arbitrum')).toEqual({ kind: 'MISSING', network: 'Arbitrum One' });
    expect(completeSendDestination('send 5 USDC on Arbitrum', 'Arbitrum One', 'not-an-address')).toBeNull();
    const completed = completeSendDestination('send 5 USDC on Arbitrum ', 'Arbitrum One', ` ${MIXED} `)!;
    expect(completed).toBe(`send 5 USDC on Arbitrum to ${MIXED.toLowerCase()}`);
    const command = parseLocalCommand(completed, workflow, context);
    expect(sendDestinationIssue(command, completed)).toBeNull();
    expect(command).toEqual(parseLocalCommand(`send 5 USDC on Arbitrum to ${MIXED}`, workflow, context));
    expect(sendDestinationIssue(parseLocalCommand(`send 5 USDC on Arbitrum to ${BAD}`, workflow, context), `send 5 USDC on Arbitrum to ${BAD}`))
      .toEqual({ kind: 'INVALID', network: 'Arbitrum One' });
    // Owner-only self-transfer networks and non-transfer commands are unaffected.
    expect(sendDestinationIssue(parseLocalCommand('swap 2 USDC to WETH on Base slippage 50 bps', workflow, context), 'swap 2 USDC to WETH on Base slippage 50 bps')).toBeNull();
  });
});

describe('UX-005 Send is presentation only; canonical Transfer identities and hashes are unchanged', () => {
  it('names the action Send on the card, setup, Copilot and Dashboard while the IR stays asset.transfer', () => {
    const applied = applySetup(canvasSend('5', RECIPIENT));
    const node = composerActions(applied.editor.workflow)[0]!;
    expect(node.actionType).toBe('asset.transfer'); expect(TRANSFER_ACTION).toBe('asset.transfer');
    expect(composerSummary(applied.editor.workflow, node, context).action).toBe('Send');
    expect(setupSummary(canvasSend('5').actionSetup!, context).action).toBe('Send');
    const step = workflowSteps(applied.editor.workflow, context).find(item => item.kind === 'TRANSFER')!;
    expect(stepSummary(step, 'EN')).toMatch(/^Send 5 USDC/); expect(stepSummary(step, 'PT')).toMatch(/^Envio 5 USDC/);
    // The Dashboard names the run Send; its internal flow identity stays robinhood-transfer.
    expect(projectDashboardRun({ runId: 'art-' + 'a'.repeat(32), workflowId: 'workflow-local', flow: 'robinhood-transfer', status: 'RECONCILED', provenance: 'MOCKED',
      ownerAccount: RECIPIENT, errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: true, createdAt: null, updatedAt: null }).title).toBe('Send');
  });
  it('keeps the Phase 2 canonical Send hashes (workflow-local standard graph) byte-for-byte', () => {
    const vectors = [[{ version: 1, action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '5', recipient: RECIPIENT }, '0x1c2b8a5c93584b8d895c9ea50ff37e1585f3fa7ec3348ab548a251c7f9609f0d'],
      [{ version: 1, action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.01', recipient: RECIPIENT }, '0x656acf5d477b87edce04ecff2b8e1582a43a9f747c186181c4770109f15d5f4e']] as const;
    for (const [strategy, hash] of vectors) {
      const composed = composeStrategy(strategy as never); expect(composed.ok).toBe(true);
      if (composed.ok) { expect(composed.workflowHash).toBe(hash); expect(semanticWorkflowHash(composed.workflow)).toBe(hash); }
    }
    expect(ARBITRUM_ONE.chain).toBe('eip155:42161');
  });
});
