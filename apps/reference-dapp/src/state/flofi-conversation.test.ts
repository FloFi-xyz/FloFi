// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { HookHarness } from '../test-utils/hook-harness';
import { reviewFixture, reviewNow, reviewOwner } from '../test-utils/review-fixture';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Command } from '../domain/commands';
import type { SimulationSource } from '../domain/simulation-presentation';
import type { ConversationBridge, FlofiConversation } from './flofi-conversation';
import { setActiveNetworkScope } from '../domain/network-scope';

/**
 * BUILD-FLOFI-CONVERSATIONAL-001: the chat's lifecycle over the real editor reducer, the real Review projections and the real Canvas lifecycle
 * projection. The workflow store, wallet, Copilot transport and execution controls are test doubles: nothing is simulated, signed or sent.
 */
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({ store: null as unknown as Record<string, unknown>, propose: [] as unknown[], respond: null as null | ((text: string) => Promise<unknown>),
  floFi: false, canSign: true }));
// BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the person's FloFi wallet (Privy) readiness, as the Canvas Authorize reads it.
vi.mock('../wallet/flofi-wallet-channel', () => ({ usesFloFiWallet: () => f.floFi }));
vi.mock('../accounts/privy-context', () => ({ useFloFiPrivy: () => ({ ready: true, authenticated: true, embedded: [], canSign: () => f.canSign }),
  floFiPrivyWalletIssue: () => 'FLOFI_WALLET_NOT_READY' }));
vi.mock('./workflow-store', () => ({ useWorkflow: () => f.store }));
vi.mock('./build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('./asset-catalog-store', () => ({ ensureNetworkCatalog: async () => undefined }));
vi.mock('../app/solana-asset-catalog-action', () => ({ loadSolanaAuthoringAssetCatalog: async () => ({ ok: false }) }));
vi.mock('../components/copilot-ai', () => ({ copilotHelp: () => null,
  useCopilotInterpreter: () => ({ mode: f.respond ? 'replay' : 'off', enabled: Boolean(f.respond), busy: false, mayInterpret: Boolean(f.respond), reset: () => undefined, clear: () => undefined,
    committed: () => undefined, language: () => 'EN', drafting: () => false, respond: (text: string) => f.respond!(text) }) }));
const { useFlofiConversation } = await import('./flofi-conversation');

const fixture = reviewFixture(), context = fixture.context;
let editor: EditorState, past: EditorState[];
function store() {
  f.store = { state: editor, context, pending: null,
    propose: (command: Command) => f.propose.push(command), dismissProposal: () => undefined,
    commitChatCommand: (command: Command) => {
      const before = editor.workflow, next = editorReducer(editor, command, context);
      if (next.error) return { ok: false, error: next.error };
      past.push(editor); editor = next; store();
      return { ok: true, before, expected: next.workflow };
    },
    undoChatCommit: () => false };
}
/** A fresh, approvable public-swap Review bound to the current workflow (the shape the real runtime records). */
function reviewed(): Pick<ConversationBridge, 'source' | 'authorization'> {
  const workflow = editor.workflow, digest = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)));
  const policy = { ...fixture.policy, semanticWorkflowHash: digest };
  const manifest = { ...fixture.manifest, semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: digest,
    policyHash: hashArtifactBytes('authorization-policy', new TextEncoder().encode(JSON.stringify(policy))) };
  const quote = { ...(fixture.authorization.technical as Record<string, unknown>), revision: workflow.revision, workflowHash: digest, nodeId: workflow.nodes.at(-1)!.nodeId };
  return { source: { kind: 'public', state: { busy: false, error: null, retired: false, recoveryOnly: false, available: true, run: { workflow, quote, attempts: [], outcome: null, reviewedManifestHash: null } } } as unknown as SimulationSource,
    authorization: { ...fixture.authorization, key: `review-${workflow.revision}`, manifest, policy } };
}
let bridge: ConversationBridge, controls: { authorize: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; checkStatus: ReturnType<typeof vi.fn>; authorizing?: boolean; startIssue?: string | null };
function lifecycle(patch: Partial<ConversationBridge> = {}) {
  const base = { workflow: editor.workflow, context, source: { kind: 'public', state: { busy: false, error: null, retired: false, recoveryOnly: false, available: true, run: null } } as unknown as SimulationSource,
    authorization: { ...fixture.authorization, key: null, manifest: null, policy: null }, wallet: fixture.wallet, progress: null, invalidWorkflow: false, ...patch };
  const current = { ...base, execution: { ready: true, started: false, start: () => undefined, prompt: '', expiresAt: null } };
  bridge = { ...base, simulate: simulate, simulationBlocked: null, connectWallet: () => undefined,
    controls: { current, requesting: false, verifying: false, canContinue: false, canCheck: false, authorizing: false, requestFailed: false, live: null, ...controls } as unknown as ConversationBridge['controls'] };
}
/** The runtime's simulation starts (busy) and stays so until the test hands it a result. */
const simulate = vi.fn(() => { reviewedPatch = { ...reviewedPatch, source: { ...bridge.source, state: { ...bridge.source.state, busy: true } } as SimulationSource }; lifecycle(reviewedPatch); });
const harness = new HookHarness();
let direct = true;
const render = () => harness.render(() => useFlofiConversation({ owner: { namespace: 'eip155', address: reviewOwner }, epoch: 0, bridge, direct, interfaceLanguage: 'EN' }));
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
async function say(text: string): Promise<FlofiConversation> {
  render().send(text); await flush(); store(); lifecycle(reviewedPatch); return render();
}
/** What the runtime currently records (persisting across messages, as the stores do). */
let reviewedPatch: Partial<ConversationBridge> = {};
const last = (chat: FlofiConversation) => chat.messages.at(-1)!;

beforeEach(() => {
  // The engines are certified on test networks (as the unit suites run); the public Mainnet-only refusal has its own case below.
  setActiveNetworkScope('ENGINEERING');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(reviewNow);
  editor = initialEditor(); past = []; f.propose = []; f.respond = null; direct = true; reviewedPatch = {};
  // Like the real controls, authorizing starts at the click (a start that never becomes active is reported by the chat).
  controls = { authorize: vi.fn(() => { controls.authorizing = true; return { started: true, issue: null }; }), request: vi.fn(), checkStatus: vi.fn() };
  harness.slots = []; store(); lifecycle(); simulate.mockClear();
});
afterEach(() => { harness.unmount(); vi.useRealTimers(); setActiveNetworkScope(null); });

describe('BUILD-FLOFI-CONVERSATIONAL-001 conversational workflow', () => {
  it('commits a valid chat request at once (no proposal), keeps earlier steps, reviews, and asks for workflow and execution confirmation separately', async () => {
    let chat = await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(f.propose).toEqual([]);
    expect(editor.workflow.revision).toBe(1);
    expect(last(chat).text).toMatch(/^Swap added to your workflow: 10 USDC/);
    expect(last(chat).question).toBe('Would you like to add another action or review your workflow?');
    expect(last(chat).options).toEqual(['Add another action', 'Review workflow', 'Undo this change']);
    const first = JSON.stringify(editor.workflow.nodes[0]);
    chat = await say('Add another action');
    expect(last(chat).text).toMatch(/Describe the next action/);
    await say('swap 2 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(editor.workflow.nodes).toHaveLength(2);
    expect(JSON.stringify(editor.workflow.nodes[0])).toBe(first);
    // "Review workflow" runs the runtime's existing simulation; nothing is approved or requested.
    chat = await say('Review workflow');
    expect(simulate).toHaveBeenCalledTimes(1); expect(chat.phase).toBe('SIMULATING');
    expect(last(chat).text).toMatch(/Simulating your workflow/);
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); chat = render();
    expect(last(chat).review?.canConfirm).toBe(true);
    expect(last(chat).question).toBe('Do you confirm this workflow?');
    expect(chat.phase).toBe('AWAITING_WORKFLOW_CONFIRMATION');
    chat = await say('Yes, I confirm');
    expect(last(chat).text).toMatch(/^Workflow confirmed \(revision 2, wallet 0x1111…1111\)\. Nothing has been signed or sent\./);
    expect(last(chat).question).toBe('Would you like to execute this workflow now?');
    expect(controls.authorize).not.toHaveBeenCalled();
    chat = await say('Yes, execute');
    expect(controls.authorize).toHaveBeenCalledTimes(1);
    expect(last(chat).text).toMatch(/^Preparing your reviewed wallet request: FloFi re-checks the quote, your wallet and its network first. Then confirm or reject it in your wallet; FloFi never signs for you/);
    expect(controls.request).not.toHaveBeenCalled();
  });
  it('BUILD-FLOFI-EXECUTION-PERFORMANCE-001: a FloFi wallet that cannot sign in this page stops the chat before any Review is accepted', async () => {
    f.floFi = true; f.canSign = false;
    try {
      let chat = await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
      chat = await say('Review workflow');
      reviewedPatch = reviewed(); lifecycle(reviewedPatch); chat = render();
      chat = await say('Yes, I confirm');
      chat = await say('Yes, execute');
      expect(controls.authorize).not.toHaveBeenCalled();
      expect(last(chat).text).toMatch(/still loading in this page/);
      // The chat has no Authorize control: it points to the option it offers (Review workflow), never "choose Authorize".
      expect(last(chat).text).toMatch(/choose Review workflow and confirm again\. Nothing was signed\.$/);
      expect(last(chat).text).not.toMatch(/Authorize/);
      expect(controls.request).not.toHaveBeenCalled();
    } finally { f.floFi = false; f.canSign = true; }
  });
  it('an unclear or negative answer changes nothing; a changed workflow, wallet or expired quote retires the confirmation', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    let chat = await say('yes but make it 5 USDC');
    expect(last(chat).text).toMatch(/^Please answer yes or no/); expect(editor.workflow.revision).toBe(1);
    await say('Yes, I confirm');
    // The wallet changes before the execution answer: the confirmation is retired at once and "yes" no longer executes anything.
    reviewedPatch = { ...reviewedPatch, wallet: { ...fixture.wallet, account: '0x3333333333333333333333333333333333333333' } }; lifecycle(reviewedPatch); chat = render();
    expect(last(chat).text).toMatch(/connected wallet changed/); expect(chat.question).toBeNull();
    await say('Yes, execute');
    expect(controls.authorize).not.toHaveBeenCalled();
    // A fresh Review, then the quote expires between the two answers.
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); await say('Review workflow');
    chat = await say('Yes, I confirm');
    expect(last(chat).question).toBe('Would you like to execute this workflow now?');
    vi.setSystemTime(reviewNow + 120_000); chat = render();
    expect(last(chat).text).toMatch(/quote expired/);
    await say('Yes, execute');
    expect(controls.authorize).not.toHaveBeenCalled();
    vi.setSystemTime(reviewNow);
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); await say('Review workflow');
    chat = await say('No');
    expect(last(chat).text).toMatch(/Nothing was signed or sent/); expect(chat.question).toBeNull();
    expect(controls.authorize).not.toHaveBeenCalled();
  });
  it('correcting a reviewed step through chat changes the revision and retires the Review confirmation', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    await say('No');
    const chat = await say(`set ${editor.workflow.nodes[0]!.nodeId} amount 5`);
    expect(editor.workflow.revision).toBe(2);
    expect(last(chat).text).toMatch(/^Swap updated: 5 USDC/);
    expect(last(chat).notes).toContain('Any earlier simulation or review of this workflow no longer applies.');
    // The Review of revision 1 does not bind revision 2: "review" simulates again instead of presenting it.
    await say('Review workflow');
    expect(simulate).toHaveBeenCalledTimes(2);
  });
  it('a request the editor rejects is explained and never committed; an unsupported network is refused', async () => {
    const chat = await say('swap 0 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(editor.workflow.revision).toBe(0); expect(f.propose).toEqual([]);
    expect(chat.messages.some(message => message.role !== 'you' && /added to your workflow/.test(message.text))).toBe(false);
  });
  it('the public Mainnet-only product refuses a test-network request in chat and commits nothing', async () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    const chat = await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(editor.workflow.revision).toBe(0); expect(f.propose).toEqual([]);
    expect(last(chat).text).toBe('Base Sepolia is a test network. FloFi runs on mainnets only, with real funds: rebuild this on Base.');
  });
  it('Copilot interpretations commit only through the validated command and say how FloFi read the words', async () => {
    f.respond = async () => ({ kind: 'PROPOSAL', text: 'Interpreted as “swap 3 USDC to WETH on Base Sepolia slippage 100 bps”. Review the proposal below: nothing changes until you apply it.',
      notes: ['Flofi swaps the ERC-20 WETH (wrapped ETH), not native ETH.'], options: [], sentence: 'swap 3 USDC to WETH on Base Sepolia slippage 100 bps',
      command: { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '3', slippage: '100', source: 'CHAT', baseRevision: 0 } });
    const chat = await say('Swap 3 USDC to WETH on Base Sepolia.');
    expect(editor.workflow.revision).toBe(1); expect(f.propose).toEqual([]);
    expect(last(chat).role).toBe('ai');
    expect(last(chat).text).toMatch(/^Swap added to your workflow: 3 USDC/);
    expect(last(chat).notes).toEqual(['Interpreted as “swap 3 USDC to WETH on Base Sepolia slippage 100 bps”.', 'Flofi swaps the ERC-20 WETH (wrapped ETH), not native ETH.']);
    // BUILD-FLOFI-CHAT-E2E-FIX-002: native ETH named in a swap where no native path exists (a test network) is refused deterministically,
    // whatever an interpretation would say; nothing is committed. (BUILD-FLOFI-BRIDGE-LIVE-FIX-003: catalog mainnets have native ETH swaps.)
    const native = await say('swap 3 USDC to ETH on Base Sepolia slippage 100 bps');
    expect(last(native).text).toMatch(/^On this network FloFi has no native ETH swap/); expect(editor.workflow.revision).toBe(1);
  });
  it('in an approval context the chat keeps its proposal behaviour and has no lifecycle controls', async () => {
    direct = false;
    const chat = await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(f.propose).toHaveLength(1); expect(editor.workflow.revision).toBe(0);
    expect(chat.phase).toBeNull();
    await say('Review workflow');
    expect(simulate).not.toHaveBeenCalled();
  });
});

/**
 * BUILD-FLOFI-CHAT-E2E-FIX-002: "Review workflow" resolves what blocks a real simulation inside the chat (an unapplied Canvas amount, the wallet on
 * another network) and continues by itself; a sequence's completed step hands over to the next step's own fresh Review. Test doubles only.
 */
const SEQUENCE_STEPS = [
  { number: 1, action: 'Swap', amount: '10 USDC', detail: 'USDC → WETH', network: 'Base Sepolia', state: 'CURRENT' as const, funding: null, delivered: null },
  { number: 2, action: 'Bridge', amount: '0.001 WETH', detail: null, network: 'Base Sepolia', state: 'NEXT' as const, funding: { from: 1, cap: '0.001 WETH', bound: null }, delivered: null }];
const completedRun = { started: true, restored: false, local: false, matchesWorkflow: true, completed: 1, active: null, label: 'Execution confirmed', state: 'complete' as const,
  message: 'All workflow actions are confirmed in the current execution record.', runKey: 'pub-1', fingerprint: 'done', busy: false,
  steps: [{ id: 'swap', number: 1, action: 'Swap', operations: [{ id: 'swap', title: 'Swap', label: 'Confirmed', state: 'confirmed', hash: `0x${'a'.repeat(64)}`, explorer: null, chain: 'eip155:84532', approval: false }] }] };
describe('BUILD-FLOFI-CHAT-E2E-FIX-002 chat-first review and sequences', () => {
  it('names an unapplied Canvas amount, applies it only on an explicit answer, then runs the real simulation without a tab switch', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const nodeId = editor.workflow.nodes[0]!.nodeId;
    const resolveEdit = vi.fn((nodeId: string, apply: boolean) => { void nodeId; void apply; reviewedPatch = { ...reviewedPatch, pendingEdits: [] }; return null; });
    reviewedPatch = { pendingEdits: [{ nodeId, step: 1, action: 'Swap', value: '25 USDC' }], resolveEdit }; lifecycle(reviewedPatch);
    let chat = await say('Review workflow');
    expect(simulate).not.toHaveBeenCalled();
    expect(last(chat).text).toBe('Step 1 (Swap) has an amount you typed but did not apply: 25 USDC.');
    expect(last(chat).question).toBe('Should I apply it before reviewing the workflow?');
    expect(last(chat).options).toEqual(['Apply it', 'Discard it']);
    chat = await say('maybe later');
    expect(last(chat).text).toMatch(/^Please answer yes or no/); expect(resolveEdit).not.toHaveBeenCalled();
    await say('Apply it');
    expect(resolveEdit).toHaveBeenCalledWith(nodeId, true);
    render(); await flush(); chat = render();
    expect(chat.messages.some(message => message.text.startsWith('Applied.'))).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(last(chat).text).toMatch(/Simulating your workflow/);
  });
  it('a discarded edit keeps the step and continues the review; a refused apply changes nothing and says why', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const nodeId = editor.workflow.nodes[0]!.nodeId;
    reviewedPatch = { pendingEdits: [{ nodeId, step: 1, action: 'Swap', value: '0 USDC' }], resolveEdit: () => 'Enter a valid amount greater than 0.' }; lifecycle(reviewedPatch);
    await say('Review workflow');
    // The answer is read in the language of FloFi's question (English here), whatever words it uses.
    let chat = await say('Aplicar');
    expect(last(chat).text).toBe('That amount cannot be applied: Enter a valid amount greater than 0.');
    expect(simulate).not.toHaveBeenCalled();
    const resolveEdit = vi.fn(() => { reviewedPatch = { ...reviewedPatch, pendingEdits: [] }; return null; });
    reviewedPatch = { ...reviewedPatch, resolveEdit }; lifecycle(reviewedPatch);
    await say('Review workflow');
    await say('Discard it');
    expect(resolveEdit).toHaveBeenCalledWith(nodeId, false);
    render(); await flush(); chat = render();
    expect(chat.messages.some(message => message.text === 'Discarded. The step keeps its previous amount.')).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
  });
  it('the wallet on Arbitrum for a Base step: the chat offers the existing network switch and continues the review once the wallet switched', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const request = vi.fn(() => { reviewedPatch = { ...reviewedPatch, networkAction: undefined, walletNetwork: 'Base Sepolia' }; });
    reviewedPatch = { networkAction: { label: 'Switch to Base Sepolia', network: 'Base Sepolia', disabled: false, request }, walletNetwork: 'Arbitrum One' }; lifecycle(reviewedPatch);
    let chat = await say('Review workflow');
    expect(simulate).not.toHaveBeenCalled();
    expect(last(chat).text).toBe('Your wallet is on Arbitrum One, but this step runs on Base Sepolia. Switch your wallet to Base Sepolia; I will continue the review once it is done.');
    expect(last(chat).options).toEqual(['Switch to Base Sepolia']);
    await say('Switch to Base Sepolia');
    expect(request).toHaveBeenCalledTimes(1);
    render(); await flush(); chat = render();
    expect(chat.messages.some(message => message.text === 'Your wallet is now on Base Sepolia. Continuing the review.')).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
  });
  it('a rejected network switch is reported and nothing is simulated', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const request = vi.fn(() => { reviewedPatch = { ...reviewedPatch, networkError: 'The wallet declined the network switch.' }; });
    reviewedPatch = { networkAction: { label: 'Switch to Base Sepolia', network: 'Base Sepolia', disabled: false, request }, walletNetwork: 'Arbitrum One', networkError: null }; lifecycle(reviewedPatch);
    await say('Review workflow');
    await say('Switch to Base Sepolia');
    render(); await flush(); const chat = render();
    expect(last(chat).text).toBe('The network switch did not complete: The wallet declined the network switch. Nothing was simulated or sent.');
    expect(simulate).not.toHaveBeenCalled();
  });
  it('reviews a sequence step by step: step 1 confirmed and executed, then its reconciled completion hands over to step 2\'s own simulation', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const sequence = { total: 2, current: 1, finished: false, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: false };
    reviewedPatch = { sequence }; lifecycle(reviewedPatch);
    let chat = await say('Review workflow');
    expect(last(chat).text).toBe('Simulating step 1 with current provider data. Nothing is signed or sent.');
    reviewedPatch = { ...reviewed(), sequence }; lifecycle(reviewedPatch); chat = render();
    expect(last(chat).text).toMatch(/^Here is the review of step 1 of 2\./);
    expect(last(chat).review?.sequence?.steps.map(step => step.state)).toEqual(['CURRENT', 'NEXT']);
    expect(last(chat).review?.totals.excludes.some(item => item.text === 'Step {0} (simulated after the steps before it)')).toBe(true);
    expect(last(chat).question).toBe('Do you confirm this workflow?');
    chat = await say('Yes, I confirm');
    expect(last(chat).question).toBe('Would you like to execute step 1 of 2 now?');
    await say('Yes, execute');
    expect(controls.authorize).toHaveBeenCalledTimes(1);
    // The run of step 1 completes; the workflow is not finished, so FloFi does not call it the workflow's result.
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: completedRun as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(chat.messages.some(message => /All 2 steps|Execution completed/.test(message.text))).toBe(false);
    // The shell records step 1's reconciled delivery and the runtime now serves step 2: FloFi says what step 1 delivered and simulates step 2.
    const next = { ...sequence, current: 2, steps: [{ ...SEQUENCE_STEPS[0]!, state: 'COMPLETED' as const, delivered: '0.0042 WETH' },
      { ...SEQUENCE_STEPS[1]!, state: 'CURRENT' as const, funding: { from: 1, cap: '0.001 WETH', bound: '0.001 WETH' } }] };
    reviewedPatch = { sequence: next }; lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(chat.messages.some(message => message.text === 'Step 1 of 2 is completed and reconciled: it delivered 0.0042 WETH.')).toBe(true);
    expect(last(chat).text).toBe('Simulating step 2 with current provider data. Nothing is signed or sent.');
    expect(simulate).toHaveBeenCalledTimes(2);
    reviewedPatch = { ...reviewed(), sequence: next }; lifecycle(reviewedPatch); chat = render();
    expect(last(chat).question).toBe('Do you confirm step 2 of 2?');
  });
  it('a completed step whose delivery is not reconciled yet waits (nothing resent); a finished sequence says every step completed', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    let chat = (reviewedPatch = { sequence: { total: 2, current: 1, finished: false, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: true } }, lifecycle(reviewedPatch), await say('Review workflow'));
    expect(last(chat).text).toBe('Step 1 is confirmed. FloFi is waiting for its reconciled delivery before the next step can be simulated. Nothing is resent.');
    expect(simulate).not.toHaveBeenCalled();
    reviewedPatch = { sequence: { total: 2, current: 2, finished: true, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: false } }; lifecycle(reviewedPatch);
    chat = await say('Review workflow');
    expect(last(chat).text).toBe('All 2 steps of this workflow are completed and reconciled. Their records stay in your history.');
    expect(simulate).not.toHaveBeenCalled();
  });
  it('a step that cannot run in a sequence is named before anything is simulated', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const issue = 'Step 2 (Supply on Base) cannot run as part of a multi-action workflow yet: FloFi executes this action only as its own workflow. Nothing was simulated or sent.';
    reviewedPatch = { sequence: { total: 2, current: 1, finished: false, steps: SEQUENCE_STEPS, issue, awaitingDelivery: false }, simulationBlocked: issue } as Partial<ConversationBridge>; lifecycle(reviewedPatch);
    bridge = { ...bridge, simulationBlocked: issue };
    const chat = render(); chat.send('Review workflow'); await flush();
    expect(last(render()).text).toBe(`I can’t start the review yet: ${issue}`);
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe('BUILD-FLOFI-CHAT-E2E-FIX-002 a wallet request that cannot start', () => {
  it('reports the runtime\'s own reason when the start ends without any execution record (nothing was sent)', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    await say('Yes, I confirm');
    let chat = await say('Yes, execute');
    expect(controls.authorize).toHaveBeenCalledTimes(1);
    expect(last(chat).text).toMatch(/confirm or reject it in your wallet/);
    // The runtime refuses the request (its own error) and the controls settle: no run exists, so nothing was sent.
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, state: { ...reviewedPatch.source!.state, error: 'Insufficient test token balance.' } } as SimulationSource };
    lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).text).toBe('The wallet request could not start, and nothing was sent. Your available balance is too low for this workflow.');
    expect(last(chat).options).toEqual(['Review workflow']);
  });
});

/** The reviewed record with the provider's quote moved (as a fresh quote after a refused start returns it). */
function requoted(expectedOut: string, minimumOut: string): Partial<ConversationBridge> {
  const base = reviewed(), run = (base.source.state as { run: { quote: Record<string, unknown> } }).run;
  return { ...base, source: { ...base.source, state: { ...base.source.state, run: { ...run, quote: { ...run.quote, expectedOut, minimumOut } } } } as unknown as SimulationSource,
    authorization: { ...base.authorization, key: `${base.authorization.key}:requoted` } };
}
describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 the live Bridge start failure and its recovery in chat', () => {
  async function confirmedAndExecuting() {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    await say('Yes, I confirm');
    return say('Yes, execute');
  }
  it('a quote the execution boundary found changed is re-quoted at once; the fresh Review names every change and needs its own confirmation (nothing resent)', async () => {
    // Production: begin re-quoted Across, found the route fee 1–3 base units higher (ROUTE_CHANGED), deauthorized the run and sent nothing;
    // the chat then said only "could not start" with the generic simulation text, and every later "Review workflow" re-showed the dead Review.
    await confirmedAndExecuting();
    let chat: FlofiConversation;
    expect(controls.authorize).toHaveBeenCalledTimes(1);
    simulate.mockClear();
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, state: { ...reviewedPatch.source!.state, error: 'ROUTE_CHANGED' } } as SimulationSource };
    lifecycle(reviewedPatch); render(); await flush(); chat = render();
    const said = chat.messages.slice(-2).map(message => message.text);
    expect(said[0]).toBe('Nothing was sent. The provider quote or the on-chain state changed after your Review, so nothing was sent. Get a fresh quote and review it again. '
      + 'I am getting a fresh quote now; you review and confirm it again before anything is signed.');
    expect(said[1]).toMatch(/Simulating your workflow/);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(chat.messages)).not.toMatch(/FloFi could not complete this simulation/);
    // The fresh quote lands: the chat lists exactly what changed and asks to confirm the updated workflow — never reusing the old confirmation.
    reviewedPatch = requoted('24990000000000000', '24865050000000000'); lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).notes).toEqual(['The quote changed since your last Review: Expected receipt 0.025 WETH → 0.02499 WETH; Minimum receipt 0.024875 WETH → 0.02486505 WETH.']);
    expect(last(chat).question).toBe('Do you confirm the updated workflow?');
    expect(controls.authorize).toHaveBeenCalledTimes(1);
    chat = await say('Yes, I confirm');
    expect(last(chat).question).toBe('Would you like to execute this workflow now?');
    await say('Yes, execute');
    expect(controls.authorize).toHaveBeenCalledTimes(2);
  });
  it('a start the controls refuse at once never says it is preparing a wallet request, and says why', async () => {
    controls.authorize = vi.fn(() => ({ started: false, issue: 'Execution is unavailable for this route.' }));
    const chat = await confirmedAndExecuting();
    expect(last(chat).text).toBe('Nothing was sent and no wallet request was opened. Execution is unavailable for this route.');
    expect(JSON.stringify(chat.messages)).not.toMatch(/Preparing your reviewed wallet request/);
    expect(last(chat).options).toEqual(['Review workflow']);
  });
  it('an accepted Review that cannot start reports the projected reason instead of a bare failure', async () => {
    await confirmedAndExecuting();
    controls.authorizing = false; controls.startIssue = 'Execution is unavailable for this route.';
    lifecycle(reviewedPatch); render(); await flush(); const chat = render();
    expect(last(chat).text).toBe('The wallet request could not start, and nothing was sent. Execution is unavailable for this route.');
  });
  it('"Refresh quote" re-simulates even an approvable Review; "try another route" says FloFi never switches providers by itself', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render(); await flush();
    simulate.mockClear();
    let chat = await say('Refresh quote');
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(last(chat).text).toBe('Getting a fresh quote and simulation. Nothing is signed or sent.');
    reviewedPatch = requoted('25000000000000000', '24875000000000000'); lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).notes).toEqual(['The fresh quote has the same amounts as your last Review.']);
    simulate.mockClear();
    chat = await say('try another route');
    expect(chat.messages.some(message => /never switches providers by itself/.test(message.text))).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
  });
});
