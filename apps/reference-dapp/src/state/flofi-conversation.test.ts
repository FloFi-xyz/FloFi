// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { reviewFixture, reviewNow, reviewOwner } from '../test-utils/review-fixture';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Command } from '../domain/commands';
import type { SimulationSource } from '../domain/simulation-presentation';
import type { ConversationBridge, FlofiConversation } from './flofi-conversation';
import { shownMessage } from '../domain/chat-message';
import { setActiveNetworkScope } from '../domain/network-scope';
import { translate } from '../i18n/translate';
import { portuguese } from '../i18n/pt';
import { conversationCopy } from '../domain/conversation-copy';

/**
 * BUILD-FLOFI-CONVERSATIONAL-001: the chat's lifecycle over the real editor reducer, the real Review projections and the real Canvas lifecycle
 * projection. The workflow store, wallet, Copilot transport and execution controls are test doubles: nothing is simulated, signed or sent.
 */
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({ store: null as unknown as Record<string, unknown>, propose: [] as unknown[], respond: null as null | ((text: string) => Promise<unknown>),
  floFi: false, canSign: true, clears: 0, recipients: [] as unknown[] }));
// BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the person's FloFi wallet (Privy) readiness, as the Canvas Authorize reads it.
vi.mock('../wallet/flofi-wallet-channel', () => ({ usesFloFiWallet: () => f.floFi }));
vi.mock('../accounts/privy-context', () => ({ useFloFiPrivy: () => ({ ready: true, authenticated: true, embedded: [], canSign: () => f.canSign }),
  floFiPrivyWalletIssue: () => 'FLOFI_WALLET_NOT_READY' }));
vi.mock('./workflow-store', () => ({ useWorkflow: () => f.store }));
vi.mock('./build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('./asset-catalog-store', () => ({ ensureNetworkCatalog: async () => undefined }));
vi.mock('../app/solana-asset-catalog-action', () => ({ loadSolanaAuthoringAssetCatalog: async () => ({ ok: false }) }));
vi.mock('../components/copilot-ai', () => ({ copilotHelp: () => null,
  useCopilotInterpreter: () => ({ mode: f.respond ? 'replay' : 'off', enabled: Boolean(f.respond), busy: false, mayInterpret: Boolean(f.respond), reset: () => undefined, clear: () => { f.clears += 1; },
    committed: () => undefined, language: () => 'EN', drafting: () => false, respond: (text: string) => f.respond!(text), savedRecipients: () => f.recipients }) }));
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
  editor = initialEditor(); past = []; f.propose = []; f.respond = null; f.recipients = []; direct = true; reviewedPatch = {};
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
  // P0 hotfix (locale contract): every deterministic FloFi message of the lifecycle is written from its copy key and values in both languages,
  // so the chat shows it in the CURRENT interface language after a switch (never "Review workflow" or "Workflow confirmed" in a Portuguese chat).
  it('writes every lifecycle message in both languages from the same copy and values', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    const chat = await say('Yes, I confirm');
    const flofi = chat.messages.filter(message => message.role === 'flofi');
    expect(flofi.length).toBeGreaterThanOrEqual(3);
    for (const message of flofi) {
      expect(message.variants, message.text).toBeDefined();
      expect(message.variants!.EN.text, message.text).toBe(message.text);
      const pt = shownMessage(message, 'PT');
      expect(pt.language).toBe('PT');
      expect(pt.text).not.toBe(message.text);
      for (const english of ['Review workflow', 'Add another action', 'Workflow confirmed', 'Do you confirm this workflow?', 'Would you like to'])
        expect([pt.text, pt.question ?? '', ...pt.options ?? []].join(' | '), english).not.toContain(english);
    }
    const confirmed = shownMessage(last(chat), 'PT');
    expect(confirmed.text).toMatch(/0x1111…1111/); expect(confirmed.options).toEqual([...shownMessage(last(chat), 'PT').options!]);
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
    // P1-03: before → after, and the edited card is the message's "View in plan" target.
    expect(last(chat).text).toBe('Swap: 10 → 5 USDC.');
    expect(last(chat).focus).toBe(editor.workflow.nodes[0]!.nodeId);
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
    // P0 hotfix (locale contract): the refusal is a catalog message with its values (it used to be the English sentence with the names spliced
    // in, which a Portuguese screen could not translate); it renders the same English sentence, and Portuguese on a Portuguese screen.
    const refusal = last(chat);
    expect(translate('EN', refusal.text, ...refusal.params ?? [])).toBe('Base Sepolia is a test network. FloFi runs on mainnets only, with real funds: rebuild this on Base.');
    expect(refusal.params).toEqual(['Base Sepolia', 'Base']);
    expect(Object.hasOwn(portuguese, refusal.text)).toBe(true);
    expect(translate('PT', refusal.text, ...refusal.params ?? [])).toBe(portuguese[refusal.text]!.replace('{0}', 'Base Sepolia').replace('{1}', 'Base'));
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
  it('P0 FIX 1 (production 2026-11-13): "swap 1 usdc to eth on base and then bridge to arbitrum" reaches the Copilot, never the native-ETH refusal', async () => {
    const asked: string[] = [];
    f.respond = async text => { asked.push(text); return { kind: 'QUESTION', text: 'How much should the bridge send?', notes: [], options: [], sentence: null, command: null }; };
    for (const request of ['swap 1 usdc to eth on base and then bridge to arbitrum', 'swap 1 USDC to ETH on Base, then bridge it to Arbitrum One',
      'swap 1 usdc to eth on base then bridge to arbitrum'])
      expect(last(await say(request)).text, request).not.toMatch(/native ETH swap/);
    expect(asked).toEqual(['swap 1 usdc to eth on base and then bridge to arbitrum', 'swap 1 USDC to ETH on Base, then bridge it to Arbitrum One',
      'swap 1 usdc to eth on base then bridge to arbitrum']);
    expect(editor.workflow.revision).toBe(0);
    // One network that has no native ETH swap is still refused deterministically (ETH is never authored as WETH).
    expect(last(await say('swap 3 USDC to ETH on Base Sepolia slippage 100 bps')).text).toMatch(/^On this network FloFi has no native ETH swap/);
    expect(asked).toHaveLength(3);
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
  it('asks about the new draft if the pending swap direction changes before Apply', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const nodeId = editor.workflow.nodes[0]!.nodeId;
    const resolveEdit = vi.fn(() => null);
    reviewedPatch = { pendingEdits: [{ nodeId, step: 1, action: 'Stocks', value: '25 USDG', draft: 'buy' }], resolveEdit };
    lifecycle(reviewedPatch);
    expect(last(await say('Review workflow')).text).toContain('25 USDG');
    reviewedPatch = { ...reviewedPatch, pendingEdits: [{ nodeId, step: 1, action: 'Stocks', value: '0.125 AAPL', draft: 'sell' }] };
    lifecycle(reviewedPatch);
    const chat = await say('Apply it');
    expect(last(chat).text).toContain('0.125 AAPL');
    expect(last(chat).options).toEqual(['Apply it', 'Discard it']);
    expect(resolveEdit).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
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
  // BUILD-FLOFI-BETA-REGRESSION-FIX-001 (FIX-07, production 2026-11-18: swap RECONCILED, bridge stuck on "Simulando o fluxo…"): a next step whose
  // simulation may open a wallet request (the universal bridge's SIWE sign-in) is never started by FloFi itself — the owner's own answer starts it.
  it('FIX-07: a manual-simulation next step is announced and waits for the owner; Review starts it as the owner\'s own action', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const sequence = { total: 2, current: 1, finished: false, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: false };
    reviewedPatch = { sequence }; lifecycle(reviewedPatch);
    await say('Review workflow');
    reviewedPatch = { ...reviewed(), sequence }; lifecycle(reviewedPatch); render();
    await say('Yes, I confirm'); await say('Yes, execute');
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: completedRun as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush();
    const simulated = simulate.mock.calls.length;
    const next = { ...sequence, current: 2, steps: [{ ...SEQUENCE_STEPS[0]!, state: 'COMPLETED' as const, delivered: '0.0042 WETH' },
      { ...SEQUENCE_STEPS[1]!, state: 'CURRENT' as const, funding: { from: 1, cap: '0.001 WETH', bound: '0.001 WETH' } }] };
    reviewedPatch = { sequence: next, manualSimulation: true }; lifecycle(reviewedPatch); render(); await flush();
    const chat = render();
    // The completed step stays completed and is never repeated; nothing was auto-simulated.
    expect(chat.messages.some(message => message.text === 'Step 1 of 2 is completed and reconciled: it delivered 0.0042 WETH.')).toBe(true);
    expect(last(chat).text).toBe('Step 2 is ready to simulate. Its simulation may ask your wallet to sign in (no funds move), so it starts only when you choose Review.');
    expect(last(chat).options).toEqual(['Review workflow']);
    expect(simulate.mock.calls.length).toBe(simulated);
    // The owner's own answer starts step 2's Review (a user-initiated wallet request, never FloFi's own).
    await say('Review workflow');
    expect(simulate.mock.calls.length).toBe(simulated + 1);
  });
  it('BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: after a final completed result the side chat offers to keep building, modify or start anew; nothing is simulated', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = { ...reviewed(), startNewWorkflow: vi.fn(), continuable: true }; lifecycle(reviewedPatch); render();
    await say('Yes, I confirm'); await say('Yes, execute');
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: completedRun as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush();
    let chat = render();
    expect(last(chat).text).toMatch(/^Execution completed\. /);
    expect(last(chat).notes).toContain('This run has a final result. Its record stays in your history.');
    expect(last(chat).question).toBe('What would you like to do next? Add another action to keep building this workflow (what already executed is not sent again), change it, or create a new workflow.');
    expect(last(chat).options).toEqual(['Add another action', 'Modify this workflow', 'Create new workflow']);
    const simulated = simulate.mock.calls.length;
    // A bare answer does not choose: the same next steps are offered again.
    chat = await say('yes');
    expect(last(chat).text).toMatch(/^What would you like to do next\?/); expect(last(chat).options).toEqual(['Add another action', 'Modify this workflow', 'Create new workflow']);
    chat = await say('Modify this workflow');
    // Without the Copilot the chat points to the step's Canvas card (the local parser has no free-form edit grammar).
    expect(last(chat).text).toMatch(/^To change a step, open its card on the Canvas/);
    chat = await say('Add another action');
    expect(last(chat).text).toMatch(/Describe the next action/);
    expect(simulate.mock.calls.length).toBe(simulated); expect(controls.authorize).toHaveBeenCalledTimes(1);
  });
  it('BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: "no" after a completed run closes the question without any claim about funds', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = { ...reviewed(), startNewWorkflow: vi.fn(), continuable: true }; lifecycle(reviewedPatch); render();
    await say('Yes, I confirm'); await say('Yes, execute');
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: completedRun as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush();
    const chat = await say('no');
    expect(last(chat).text).toBe('Okay. The completed run stays in your history; add an action or create a new workflow whenever you like.');
    expect(last(chat).text).not.toMatch(/Nothing was signed or sent/);
  });
  it('BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: a workflow that runs as a whole is never promised that what executed stays executed', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = { ...reviewed(), startNewWorkflow: vi.fn(), continuable: false }; lifecycle(reviewedPatch); render();
    await say('Yes, I confirm'); await say('Yes, execute');
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: completedRun as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush();
    let chat = render();
    expect(last(chat).question).toMatch(/^What would you like to do next\? You can change this workflow, add an action or create a new workflow\. This workflow runs as a whole/);
    expect(last(chat).question).not.toMatch(/not sent again/);
    // A change to it says the next review covers the executed actions again (nothing was recorded as a carried step).
    reviewedPatch = { ...reviewedPatch, progress: null }; lifecycle(reviewedPatch);
    chat = await say('swap 2 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(last(chat).notes).toContain('This workflow still holds an action you already executed, and as it is now the next review covers it again: confirming would send it again. Undo this change if that is not what you want.');
  });
  it('BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: a change after an execution says whether what executed stays completed or would be reviewed again', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    reviewedPatch = { executedActions: { executed: 1, carried: 1 } }; lifecycle(reviewedPatch);
    let chat = await say('swap 2 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(last(chat).notes).toContain('The action you already executed stays completed and is not sent again: reviews cover only the steps not executed yet.');
    reviewedPatch = { executedActions: { executed: 1, carried: 0 } }; lifecycle(reviewedPatch);
    chat = await say('swap 3 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(last(chat).notes).toContain('This workflow still holds an action you already executed, and as it is now the next review covers it again: confirming would send it again. Undo this change if that is not what you want.');
    reviewedPatch = {}; lifecycle(reviewedPatch);
    chat = await say('swap 4 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(last(chat).notes?.some(note => /already executed/.test(note))).toBe(false);
  });
  it('a completed step whose delivery is not reconciled yet waits (nothing resent); a finished sequence says every step completed', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    let chat = (reviewedPatch = { sequence: { total: 2, current: 1, finished: false, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: true } }, lifecycle(reviewedPatch), await say('Review workflow'));
    expect(last(chat).text).toBe('Step 1 is confirmed. FloFi is waiting for its reconciled delivery before the next step can be simulated. Nothing is resent.');
    expect(simulate).not.toHaveBeenCalled();
    reviewedPatch = { sequence: { total: 2, current: 2, finished: true, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: false } }; lifecycle(reviewedPatch);
    chat = await say('Review workflow');
    expect(last(chat).text).toBe('All 2 steps of this workflow are completed and reconciled. Their records stay in your history.');
    expect(last(chat).options).toEqual(['Add another action', 'Modify this workflow']);
    // A sequence's steps stay completed: the owner is told they are not sent again (never "runs as a whole").
    expect(last(chat).question).toMatch(/what already executed is not sent again/);
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
    reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, state: { ...reviewedPatch.source!.state, error: 'INSUFFICIENT_INPUT' } } as SimulationSource };
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
  it('BUILD-FLOFI-MAINNET-EXEC-002 (review round 2): a run the runtime already re-quoted in place is presented at once — one sentence, its changes, no second simulation', async () => {
    // Production 2026-11-13: an L1 fee move refused the bridge; the store re-quoted the same run in place and keeps no blocking error, only
    // `requoted` with the original reason. The chat must not simulate over that fresh Review, nor repeat "nothing was sent" twice.
    await confirmedAndExecuting();
    simulate.mockClear();
    controls.authorizing = false;
    const fresh = requoted('24990000000000000', '24865050000000000');
    reviewedPatch = { ...fresh, source: { ...fresh.source!, state: { ...fresh.source!.state, error: null,
      requoted: { code: 'ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED', runId: 'run-1', changes: [] } } } as unknown as SimulationSource };
    lifecycle(reviewedPatch); render(); await flush(); render(); await flush(); const chat = render();
    const texts = chat.messages.map(message => message.text);
    expect(texts).toContain('The network fee moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.');
    expect(texts.filter(text => /nothing was sent/i.test(text ?? ''))).toHaveLength(1);
    expect(simulate).not.toHaveBeenCalled();
    expect(last(chat).notes).toEqual(['The quote changed since your last Review: Expected receipt 0.025 WETH → 0.02499 WETH; Minimum receipt 0.024875 WETH → 0.02486505 WETH.']);
    expect(last(chat).question).toBe('Do you confirm the updated workflow?');
    expect(controls.authorize).toHaveBeenCalledTimes(1);
  });
  it('BUILD-FLOFI-MAINNET-EXEC-002 (review round 3): a re-quote in place after a refusal at the wallet hand-off is presented as the fresh Review, never as an execution needing attention', async () => {
    // The 13/11 class of refusal, one step later: begin recorded the attempt (the run is live), then the hand-off refused it (L1 fee beyond the
    // authorized bound), nothing was sent, and the runtime re-quoted the same run in place.
    await confirmedAndExecuting();
    simulate.mockClear();
    controls.authorizing = false;
    const began = { started: true, restored: false, local: false, matchesWorkflow: true, completed: 0, label: 'Execution in progress', state: 'active', message: '', runKey: 'run-1',
      fingerprint: 'prepared', busy: false, steps: [{ id: 'swap', number: 1, action: 'Bridge', operations: [op('approval', 'Approve USDC', 'preparing', true), op('deposit', 'Bridge deposit', 'waiting', false)] }] };
    (began as unknown as { active: unknown }).active = began.steps[0];
    reviewedPatch = { ...reviewedPatch, progress: began as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); render(); await flush();
    // The superseded, never-sent attempt no longer holds the run (no live execution); the fresh Review waits for the owner's authorization.
    // As in the stores, the re-quote lands in the render where the wallet request lock is still held: nothing is said until it is released.
    (controls as Record<string, unknown>).requesting = true;
    const fresh = requoted('24990000000000000', '24865050000000000');
    reviewedPatch = { ...fresh, progress: null, source: { ...fresh.source!, state: { ...fresh.source!.state, error: null,
      requoted: { code: 'ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED', runId: 'run-1', changes: [] } } } as unknown as SimulationSource };
    lifecycle(reviewedPatch); render(); await flush(); render(); await flush(); let chat = render();
    const texts = () => chat.messages.map(message => message.text);
    const notice = 'The network fee moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.';
    expect(texts()).not.toContain(notice);
    expect(texts().some(text => /still working|needs attention/i.test(text ?? ''))).toBe(false);
    (controls as Record<string, unknown>).requesting = false;
    lifecycle(reviewedPatch); render(); await flush(); render(); await flush(); chat = render();
    expect(texts().filter(text => text === notice)).toHaveLength(1);
    expect(texts().some(text => /needs attention|could not complete/i.test(text ?? ''))).toBe(false);
    expect(simulate).not.toHaveBeenCalled();
    expect(last(chat).notes).toEqual(['The quote changed since your last Review: Expected receipt 0.025 WETH → 0.02499 WETH; Minimum receipt 0.024875 WETH → 0.02486505 WETH.']);
    expect(last(chat).question).toBe('Do you confirm the updated workflow?');
    // Presented once: later renders of the same re-quote add nothing, and nothing is authorized by itself.
    const count = chat.messages.length;
    render(); await flush(); render(); await flush(); chat = render();
    expect(chat.messages).toHaveLength(count);
    expect(controls.authorize).toHaveBeenCalledTimes(1);
  });
  /** A 0x Gasless swap's run while the owner signs: its attempt is recorded first, so the run is live (one request waiting in the wallet). */
  const signing = { started: true, restored: false, local: false, matchesWorkflow: true, completed: 0, label: 'Execution in progress', state: 'active', message: '', runKey: 'rhs-1',
    fingerprint: 'signing', busy: false, steps: [{ id: 'swap', number: 1, action: 'Swap', operations: [op('swap', 'Swap', 'wallet', false)] }] };
  (signing as unknown as { active: unknown }).active = signing.steps[0];
  async function gaslessSigning() {
    await confirmedAndExecuting();
    simulate.mockClear();
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: signing as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); render(); await flush();
  }
  /** At submit the attempt is abandoned: the lifecycle filters it out (no live run), and the runtime keeps the refusal as its error. */
  const abandoned = (error: string) => {
    reviewedPatch = { ...reviewedPatch, progress: null, source: { ...reviewedPatch.source!, state: { ...reviewedPatch.source!.state, error } } as SimulationSource };
    lifecycle(reviewedPatch);
  };
  it('review CH3: a 0x Gasless Review lists its two signatures (approval, then trade) from the reviewed fee payment, never one "Swap"', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    const base = reviewed(), run = (base.source.state as { run: { quote: Record<string, unknown> } }).run;
    const zeroEx = (approval: object | null) => ({ taker: reviewOwner, settler: '0x' + '5c'.repeat(20), permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3', sources: ['0x_RFQ'],
      gasFee: { token: '0x' + '1'.repeat(40), amount: '420000' }, zeroExFee: null, trade: { hash: '0x' + 'ab'.repeat(32), deadline: Math.floor(reviewNow / 1000) + 300 },
      buyAmount: '25000000000000000', minBuyAmount: '24875000000000000', approval });
    const notStarted = { started: false, restored: false, local: false, matchesWorkflow: true, completed: 0, label: 'Not started', state: 'idle', message: '', runKey: 'rhs-1',
      fingerprint: '', busy: false, steps: [{ id: 'swap', number: 1, action: 'Swap', operations: [op('swap', 'Swap', 'waiting', false)] }] };
    const gasless = (approval: object | null): Partial<ConversationBridge> => ({ ...base, progress: notStarted as unknown as ConversationBridge['progress'],
      source: { ...base.source, state: { ...base.source.state, run: { ...run, quote: { ...run.quote, gas: { owner: reviewOwner, mechanism: 'ZEROX_GASLESS_SWAP', nativeShort: true,
        unavailable: [], native: { balanceWei: '0', worstCaseWei: null }, payment: { mechanism: 'ZEROX_GASLESS_SWAP' }, zeroEx: zeroEx(approval) } } } } } as unknown as SimulationSource });
    reviewedPatch = gasless({ type: 'permit', value: '100000000', unlimited: false }); lifecycle(reviewedPatch); render();
    let chat = await say('Yes, I confirm');
    expect(last(chat).notes).toContain('Your wallet will ask you to confirm each request separately: Token approval (signature), Swap (signature).');
    // The gasless approval is one of the reviewed signatures, never "requested only if your allowance is still too low".
    expect(last(chat).notes!.some(note => /only if your current allowance/.test(note))).toBe(false);
    expect(translate('PT', 'Token approval (signature)')).toBe('Aprovação do token (assinatura)');
    expect(translate('PT', 'Swap (signature)')).toBe('Swap (assinatura)');
    // Permit2 already allowed: one signature, the trade.
    await say('No');
    reviewedPatch = gasless(null); lifecycle(reviewedPatch); render();
    await say('Review workflow');
    reviewedPatch = gasless(null); lifecycle(reviewedPatch); render();
    chat = await say('Yes, I confirm');
    expect(last(chat).notes).toContain('Your wallet will ask you to confirm each request separately: Swap (signature).');
  });
  it('review CH1: a 0x Gasless start abandoned at submit for a moved quote is re-quoted at once (the chat never goes silent)', async () => {
    await gaslessSigning();
    let chat = render();
    expect(last(chat).text).toMatch(/Confirm or decline the reviewed request in your wallet|confirm or reject it in your wallet/);
    // The run vanishes first (the abandoned attempt), then the error lands: nothing is said until the refusal is known, then once.
    reviewedPatch = { ...reviewedPatch, progress: null }; lifecycle(reviewedPatch); render(); await flush();
    const before = render().messages.length;
    abandoned('QUOTE_EXPIRED_REVIEW_REQUIRED'); render(); await flush(); render(); await flush(); chat = render();
    const said = chat.messages.slice(before).map(message => message.text);
    expect(said[0]).toMatch(/^Nothing was sent\. .*I am getting a fresh quote now; you review and confirm it again before anything is signed\.$/);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(controls.authorize).toHaveBeenCalledTimes(1);
    const count = chat.messages.length;
    render(); await flush(); render(); await flush();
    expect(render().messages.slice(count).some(message => /Nothing was sent/.test(message.text ?? ''))).toBe(false);
  });
  it('review CH1: a 0x Gasless start abandoned without the signatures says it could not start and why, and offers the Review', async () => {
    await gaslessSigning();
    abandoned('GASLESS_SIGNATURE_NOT_RECEIVED'); render(); await flush(); render(); await flush();
    const chat = render();
    expect(last(chat).text).toBe('The wallet request could not start, and nothing was sent. Your wallet did not return the signatures, so nothing was submitted. Authorize again when ready.');
    expect(last(chat).options).toEqual(['Review workflow']);
    expect(simulate).not.toHaveBeenCalled();
  });
  it('BUILD-FLOFI-MAINNET-EXEC-002 (review round 3): after an earlier confirmed request, the hand-off re-quote keeps that request and presents the next one only', async () => {
    await confirmedAndExecuting();
    simulate.mockClear();
    controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: approvalLanded as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); render(); await flush();
    const fresh = requoted('24990000000000000', '24865050000000000');
    const withRequote = (runId: string) => ({ ...fresh, progress: approvalLanded as unknown as ConversationBridge['progress'], source: { ...fresh.source!, state: { ...fresh.source!.state, error: null,
      requoted: { code: 'ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED', runId, changes: [] } } } as unknown as SimulationSource });
    // Another run's re-quote (e.g. one started from the Canvas) is never presented as this conversation's.
    reviewedPatch = withRequote('another-run'); lifecycle(reviewedPatch); render(); await flush(); render(); await flush();
    expect(render().messages.some(message => /fresh quote for the same workflow/.test(message.text))).toBe(false);
    reviewedPatch = withRequote('bas-1'); lifecycle(reviewedPatch); render(); await flush(); render(); await flush(); const chat = render();
    const texts = chat.messages.map(message => message.text);
    expect(texts.filter(text => text === 'Your earlier confirmed request stays in place. The network fee moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.')).toHaveLength(1);
    expect(texts.some(text => /needs attention|could not complete/i.test(text ?? ''))).toBe(false);
    expect(simulate).not.toHaveBeenCalled();
    expect(controls.authorize).toHaveBeenCalledTimes(1);
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

/**
 * BUILD-FLOFI-E2E-RELIABILITY-001 — the 2026-11-01 production chat (1 USDC → ETH on Base): the approval landed, the chat asked a generic
 * "Continue to your wallet?", the swap start was refused for a moved quote, and the chat only repeated "0 of 1 actions completed".
 */
const op = (id: string, title: string, state: string, approval: boolean) =>
  ({ id, nodeId: 'swap', title, label: state, state, hash: state === 'confirmed' ? `0x${'b'.repeat(64)}` : null, explorer: null, chain: 'eip155:8453', fee: null, approval, intent: false, wallet: true });
const approvalLanded = { started: true, restored: false, local: false, matchesWorkflow: true, completed: 0, label: 'Execution in progress', state: 'active' as const,
  message: '0 of 1 actions completed. The token approval is confirmed on-chain; it only allows the spend. The action itself has not been sent yet and needs its own confirmation in your wallet.',
  runKey: 'bas-1', fingerprint: 'approval-confirmed', busy: false,
  steps: [{ id: 'swap', number: 1, action: 'Swap', operations: [op('approval', 'Approve USDC', 'confirmed', true), op('swap', 'Swap', 'waiting', false)] }] };
(approvalLanded as unknown as { active: unknown }).active = approvalLanded.steps[0];
describe('BUILD-FLOFI-E2E-RELIABILITY-001 continuation after a landed approval', () => {
  async function executedWithLandedApproval(canContinue: boolean, ownerBound = false) {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    await say('Yes, I confirm');
    await say('Yes, execute');
    controls.authorizing = false;
    // Like the real controls: Authorize accepted the Review, and a continuation request is "requesting" from the click.
    controls.request = vi.fn(() => { (controls as Record<string, unknown>).requesting = true; });
    // The durable record: the approval is confirmed on-chain, the swap was never requested.
    reviewedPatch = { ...reviewedPatch, authorization: { ...reviewedPatch.authorization!, accepted: true }, progress: approvalLanded as unknown as ConversationBridge['progress'] };
    if (ownerBound) {
      const state = reviewedPatch.source!.state as unknown as { run: { quote: Record<string, unknown> } };
      reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, state: { ...state, run: { ...state.run, quote: { ...state.run.quote, ownerReview: { account: reviewOwner, step: 'approval' } } } } } as unknown as SimulationSource };
    }
    lifecycle(reviewedPatch); bridge = { ...bridge, controls: { ...bridge.controls, canContinue } as ConversationBridge['controls'] };
    render(); await flush(); return render();
  }
  it('names the landed approval and the unsent swap; a refused start for a moved quote re-quotes the swap only and asks once', async () => {
    let chat = await executedWithLandedApproval(true);
    expect(last(chat).text).toBe('Approve USDC is confirmed on-chain. An approval only allows the spend; it is not the action itself. Swap has not been sent yet and needs its own confirmation in your wallet. Continue to your wallet?');
    expect(last(chat).options).toEqual(['Continue', 'Not now']);
    await say('Continue');
    expect(controls.request).toHaveBeenCalledWith(true);
    // The runtime refuses the swap start (the quote moved below the reviewed minimum): nothing new was sent, the record did not move.
    render(); await flush();
    (controls as Record<string, unknown>).requesting = false;
    reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, state: { ...reviewedPatch.source!.state, error: 'QUOTE_CHANGED_REVIEW_REQUIRED' } } as SimulationSource };
    lifecycle(reviewedPatch); render(); await flush(); chat = render();
    const refusal = chat.messages.find(message => /nothing new was sent/.test(message.text));
    expect(refusal?.text).toBe('Your earlier confirmed request stays in place, and nothing new was sent. The quote moved outside the bounds of your Review. I am getting a fresh quote for the next request now; you confirm it before your wallet is asked.');
    expect(chat.messages.some(message => /^The wallet request could not start, and nothing was sent|could not complete this simulation/.test(message.text))).toBe(false);
    expect(simulate).toHaveBeenCalledTimes(2);
    // The fresh quote for the swap: presented with what changed, and accepted with one explicit answer that opens the wallet.
    reviewedPatch = { ...requoted('24000000000000000', '23880000000000000'), progress: approvalLanded as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).text).toBe('Here is the fresh quote for Swap, which has not been sent yet. Your earlier confirmed request stays in place and is not repeated. Amounts are estimates from this simulation, not executed results.');
    expect(last(chat).notes?.[0]).toMatch(/^The quote changed since your last Review: Expected receipt/);
    expect(last(chat).question).toBe('Accept this updated quote and continue to your wallet for this request?');
    expect(last(chat).options).toEqual(['Accept and continue', 'Not now']);
    expect(chat.question).toBe('CONFIRM_CONTINUE_REVIEW');
    chat = await say('Accept and continue');
    expect(controls.authorize).toHaveBeenCalledTimes(2);
    expect(last(chat).text).toMatch(/^Preparing your reviewed wallet request/);
  });
  it('an approval that lands after the reviewed quote expired: the swap is re-quoted once by itself, asked once, and never re-offered after "Not now"', async () => {
    await executedWithLandedApproval(false);
    // The Review expired while the approval confirmed: no Continue is offered; FloFi prepares the swap's own fresh Review (read-only).
    vi.setSystemTime(reviewNow + 200_000); lifecycle(reviewedPatch); bridge = { ...bridge, controls: { ...bridge.controls, canContinue: false } as ConversationBridge['controls'] };
    render(); await flush(); let chat = render();
    expect(chat.messages.some(message => message.text === 'Your earlier confirmed request stays in place, and nothing new was sent. The reviewed quote expired before the next request could start. I am getting a fresh quote for the next request now; you confirm it before your wallet is asked.')).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(2);
    vi.setSystemTime(reviewNow);
    reviewedPatch = { ...requoted('25000000000000000', '24875000000000000'), progress: approvalLanded as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).question).toBe('Accept this updated quote and continue to your wallet for this request?');
    chat = await say('Not now');
    expect(last(chat).text).toBe('The next wallet request did not start, so nothing new was sent. Earlier confirmed requests stay recorded. You chose not to continue now.');
    render(); await flush(); chat = render();
    expect(chat.question).toBeNull();
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(controls.authorize).toHaveBeenCalledTimes(1);
  });
  it('after a reload the restored run stays observation-only: nothing is re-quoted until the owner asks, then one question for the next request', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    // A reload: the durable record comes back (restored) with the approval landed and the Review expired; this conversation started nothing.
    vi.setSystemTime(reviewNow + 200_000);
    reviewedPatch = { ...reviewed(), authorization: { ...reviewed().authorization, accepted: true },
      progress: { ...approvalLanded, restored: true } as unknown as ConversationBridge['progress'] };
    lifecycle(reviewedPatch); render(); await flush(); let chat = render();
    expect(chat.messages.some(message => /restored this workflow’s execution/.test(message.text))).toBe(true);
    expect(chat.messages.some(message => /getting a fresh quote/.test(message.text))).toBe(false);
    expect(simulate).not.toHaveBeenCalled();
    // The owner asks: the remaining request gets its own fresh Review and one question.
    await say('Review workflow');
    expect(simulate).toHaveBeenCalledTimes(1);
    vi.setSystemTime(reviewNow);
    reviewedPatch = { ...requoted('25000000000000000', '24875000000000000'), progress: { ...approvalLanded, restored: true } as unknown as ConversationBridge['progress'] };
    lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).question).toBe('Accept this updated quote and continue to your wallet for this request?');
    expect(controls.authorize).not.toHaveBeenCalled();
  });
  it('"Not now" to the first Continue is remembered: when the quote then expires, FloFi does not re-quote or ask again by itself', async () => {
    await executedWithLandedApproval(true);
    let chat = await say('Not now');
    expect(last(chat).text).toBe('The next wallet request did not start, so nothing new was sent. Earlier confirmed requests stay recorded. You chose not to continue now.');
    vi.setSystemTime(reviewNow + 200_000); lifecycle(reviewedPatch); bridge = { ...bridge, controls: { ...bridge.controls, canContinue: false } as ConversationBridge['controls'] };
    render(); await flush(); chat = render();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(chat.question).toBeNull();
    // The owner can still ask: then the remaining request gets its own fresh Review.
    await say('Review workflow');
    expect(simulate).toHaveBeenCalledTimes(2);
  });
  it('another runtime\'s landed request (not the public swap) never gets the automatic re-quote or the single-answer Review', async () => {
    await executedWithLandedApproval(false);
    vi.setSystemTime(reviewNow + 200_000);
    reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, kind: 'universal' } as SimulationSource };
    lifecycle(reviewedPatch); bridge = { ...bridge, controls: { ...bridge.controls, canContinue: false } as ConversationBridge['controls'] };
    render(); await flush(); const chat = render();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(chat.messages.some(message => /getting a fresh quote/.test(message.text))).toBe(false);
  });
  it('reasons about the next request never say "nothing was sent" for the run (EN and PT)', async () => {
    const { aboutNextRequest } = await import('../domain/conversation-lifecycle');
    expect(aboutNextRequest('The workflow changed before your wallet was asked, so nothing was sent. Review it again.')).toBe('The workflow changed before your wallet was asked, so this request was not sent. Review it again.');
    expect(aboutNextRequest('Nothing was simulated or sent.')).toBe('Nothing new was simulated or sent.');
    expect(aboutNextRequest('A rede recusou, então nada foi enviado.')).toBe('A rede recusou, então nada novo foi enviado.');
  });
  const withRun = (patch: Record<string, unknown>) => {
    const state = reviewedPatch.source!.state as unknown as { run: Record<string, unknown> };
    reviewedPatch = { ...reviewedPatch, source: { ...reviewedPatch.source!, state: { ...state, run: { ...state.run, ...patch } } } as unknown as SimulationSource };
  };
  it('owner-bound networks: no Continue that cannot succeed — the swap gets its own fresh Review at once, with one question', async () => {
    let chat = await executedWithLandedApproval(true, true);
    expect(chat.messages.some(message => /Continue to your wallet\?$/.test(message.text))).toBe(false);
    expect(last(chat).text).toMatch(/^Approve USDC is confirmed on-chain\. An approval only allows the spend; it is not the action itself\. Swap is a new transaction from your wallet/);
    expect(simulate).toHaveBeenCalledTimes(2);
    reviewedPatch = { ...requoted('25000000000000000', '24875000000000000'), progress: approvalLanded as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(last(chat).question).toBe('Accept this updated quote and continue to your wallet for this request?');
  });
  it('an open Continue whose quote expires is retired; a continuation started here is re-quoted once, saying the quote expired', async () => {
    let chat = await executedWithLandedApproval(true);
    expect(chat.question).toBe('CONFIRM_CONTINUE');
    vi.setSystemTime(reviewNow + 200_000); lifecycle(reviewedPatch); bridge = { ...bridge, controls: { ...bridge.controls, canContinue: false } as ConversationBridge['controls'] };
    render(); await flush(); render(); await flush(); chat = render();
    expect(chat.messages.some(message => /The reviewed quote expired before the next request could start\. I am getting a fresh quote/.test(message.text))).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(2);
  });
  it('another wallet\'s run is never continued from this wallet: FloFi says so and reviews a separate run with both confirmations', async () => {
    await executedWithLandedApproval(false);
    withRun({ attempts: [{ step: 'approval', state: 'CONFIRMED', account: '0x2222222222222222222222222222222222222222' }] });
    vi.setSystemTime(reviewNow + 200_000); lifecycle(reviewedPatch);
    bridge = { ...bridge, controls: { ...bridge.controls, canContinue: false } as ConversationBridge['controls'] };
    let chat = await say('Review workflow');
    expect(chat.messages.some(message => /^This run's earlier request came from another wallet \(0x2222…2222\)/.test(message.text))).toBe(true);
    vi.setSystemTime(reviewNow);
    reviewedPatch = { ...reviewed(), progress: approvalLanded as unknown as ConversationBridge['progress'] }; withRun({ attempts: [{ account: '0x2222222222222222222222222222222222222222' }] });
    lifecycle(reviewedPatch); render(); await flush(); chat = render();
    expect(chat.question).not.toBe('CONFIRM_CONTINUE_REVIEW');
  });
  it('PT answers: every offered and common typed answer is classified', async () => {
    const { classifyAnswer } = await import('../domain/conversation-lifecycle');
    for (const text of ['Aceitar e continuar', 'sim aceito', 'sim, aceitar e continuar', 'Continuar', 'continuar para a carteira', 'yes, accept and continue'])
      expect(classifyAnswer(text, 'CONFIRM_CONTINUE_REVIEW'), text).toBe('YES');
    for (const text of ['Agora não', 'não agora', 'Não']) expect(classifyAnswer(text, 'CONFIRM_CONTINUE'), text).toBe('NO');
    expect(classifyAnswer('continuar para a carteira', 'CONFIRM_CONTINUE')).toBe('YES');
  });
  it('PT: the same continuation in Portuguese', async () => {
    const chat = await executedWithLandedApproval(true);
    void chat;
    const pt = (await import('../domain/conversation-copy')).conversationCopy('PT');
    expect(pt.continueAfter('Aprovar USDC', 'Trocar', true)).toBe('Aprovar USDC: confirmado na rede. Uma aprovação apenas autoriza o gasto; não é a ação em si. Trocar: ainda não enviado, precisa da sua própria confirmação na carteira. Continuar para a carteira?');
  });
});

describe('P0 hotfix (execution continuity): the Assistant while the workflow executes', () => {
  /** Step 1 of a two-step sequence completed and reconciled; step 2 not started (the shell's sequence and whole-workflow progress). */
  function between(): Partial<ConversationBridge> {
    return { sequence: { total: 2, current: 2, finished: false, issue: null, awaitingDelivery: false, steps: [
      { number: 1, action: 'Swap', amount: '10 USDC', detail: null, network: 'Base Sepolia', state: 'COMPLETED', funding: null, delivered: '0.004 WETH' },
      { number: 2, action: 'Swap', amount: '2 USDC', detail: null, network: 'Base Sepolia', state: 'CURRENT', funding: null, delivered: null }] },
    workflowProgress: { completed: 1, total: 2, current: 2, finished: false, attention: false, steps: [
      { number: 1, action: 'Swap', network: 'Base Sepolia', phase: 'RECONCILED', text: { key: 'Reconciled', args: [] }, current: false, delivered: '0.004 WETH' },
      { number: 2, action: 'Swap', network: 'Base Sepolia', phase: null, text: { key: 'Not started', args: [] }, current: true, delivered: null }] } };
  }
  it('between the steps, "continue" and "Review workflow" answer with the workflow status and next action — never "I can\'t start the review"', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('swap 2 USDC to WETH on Base Sepolia slippage 100 bps');
    reviewedPatch = between(); lifecycle(reviewedPatch);
    bridge = { ...bridge, simulationBlocked: 'Its provider is not available here.' };
    for (const text of ['continue', 'Review workflow', 'continuar']) {
      render().send(text); await flush();
      const message = last(render());
      expect(message.text).toBe('This workflow is executing: 1 of 2 steps completed · Step 2 (Swap): Not started. Its provider is not available here.');
      expect(message.text).not.toMatch(/can’t start the review|Simulate/);
    }
    expect(simulate).not.toHaveBeenCalled(); expect(controls.authorize).not.toHaveBeenCalled();
  });
  it('while the wallet is asked, review/continue says to answer the wallet; in Portuguese with the same numbers', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await say('swap 2 USDC to WETH on Base Sepolia slippage 100 bps');
    reviewedPatch = { ...between(), editingPaused: true }; controls = { ...controls, requesting: true } as typeof controls; lifecycle(reviewedPatch);
    render().send('continue'); await flush();
    expect(last(render()).text).toBe('This workflow is executing: 1 of 2 steps completed · Step 2 (Swap): Not started. Confirm or decline the request in your wallet. FloFi never signs for you.');
    expect(simulate).not.toHaveBeenCalled();
    harness.unmount(); harness.slots = [];
    const portuguese = () => harness.render(() => useFlofiConversation({ owner: { namespace: 'eip155', address: reviewOwner }, epoch: 0, bridge, direct, interfaceLanguage: 'PT' }));
    portuguese().send('continuar'); await flush();
    expect(portuguese().messages.at(-1)!.text).toBe('Este fluxo está em execução: 1 de 2 etapas concluídas · Etapa 2 (Trocar): Não iniciado. Confirme ou recuse o pedido na sua carteira. A FloFi nunca assina por você.');
  });
});

/**
 * HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001 (production 2026-11-16): the chat built a Solana Jupiter swap, the connected wallet identity
 * changed from the EVM wallet to the Solana session the swap needs, and the whole conversation was replaced by the welcome message while the
 * Canvas kept the swap. The conversation now belongs to the signed-in account (its opaque scope) and the workflow; this tab keeps it as read-only
 * history through a reload. Test doubles only: a memory sessionStorage, no wallet, signature, provider or network.
 */
describe('HOTFIX-P1 conversation identity and recovery', () => {
  const ACCOUNT_A = 'A'.repeat(32), ACCOUNT_B = 'B'.repeat(32), SOLANA = 'So1anaOwner1111111111111111111111111111111';
  const evm = { namespace: 'eip155' as const, address: reviewOwner }, solana = { namespace: 'solana' as const, address: SOLANA };
  let storage: Map<string, string>;
  const memory = () => ({ get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null, getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); }, clear: () => storage.clear() });
  type Options = { owner?: typeof evm | typeof solana | null; epoch?: number; scope?: string | null; persist?: boolean; direct?: boolean };
  /** A page of the Editor: its own React state (`page`), this tab's storage shared by every page (a reload is a new page). */
  const view = (page: HookHarness, options: Options = {}) => page.render(() => useFlofiConversation({ owner: options.owner === undefined ? evm : options.owner, epoch: options.epoch ?? 0,
    bridge, direct: options.direct ?? true, interfaceLanguage: 'EN', persist: options.persist ?? true, accountScope: options.scope === undefined ? ACCOUNT_A : options.scope }));
  const texts = (chat: FlofiConversation) => chat.messages.map(message => message.text);
  const workflow = (workflowId: string) => { editor = { ...editor, workflow: { ...editor.workflow, workflowId } }; store(); lifecycle(reviewedPatch); };
  async function author(page: HookHarness, options: Options = {}) {
    view(page, options).send('swap 10 USDC to WETH on Base Sepolia slippage 100 bps'); await flush(); store(); lifecycle(reviewedPatch);
    return view(page, options);
  }
  beforeEach(() => { storage = new Map(); vi.stubGlobal('window', { sessionStorage: memory() }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('authoring through the chat keeps the conversation when the wallet changes ecosystem, disconnects and reconnects', async () => {
    const page = new HookHarness();
    let chat = await author(page);
    const conversation = texts(chat);
    expect(conversation).toEqual([expect.any(String), 'swap 10 USDC to WETH on Base Sepolia slippage 100 bps', expect.stringMatching(/^Swap added to your workflow/)]);
    // The Canvas now holds the workflow; the review wallet becomes the Solana session (the incident), then the wallet disconnects and reconnects.
    for (const owner of [solana, null, solana, evm]) { chat = view(page, { owner }); expect(texts(chat), String(owner?.namespace)).toEqual(conversation); }
    expect(last(chat).options).toEqual(['Add another action', 'Review workflow', 'Undo this change']);
    page.unmount();
  });

  it('the same account and workflow get their conversation back after a reload, as read-only history (no stale answer buttons)', async () => {
    const before = new HookHarness(), chat = await author(before), shown = texts(chat);
    before.unmount();
    const reloaded = view(new HookHarness());
    expect(texts(reloaded)).toEqual(shown);
    expect(reloaded.messages.every(message => !message.options && !message.question)).toBe(true);
    expect(reloaded.messages.every(message => !message.variants || (!message.variants.EN.options && !message.variants.PT.options))).toBe(true);
    // A new message continues the restored conversation (ids keep increasing) and is kept again.
    const page = new HookHarness(); view(page); view(page).send('explain'); await flush();
    const continued = view(page);
    expect(texts(continued)).toEqual([...shown, 'explain', expect.any(String)]);
    expect(texts(continued).slice(0, shown.length)).toEqual(shown);
    expect(new Set(continued.messages.map(message => message.id)).size).toBe(continued.messages.length);
    expect(texts(view(new HookHarness())).length).toBe(continued.messages.length);
  });

  it('another account, a signed-out page or another workflow never receives this conversation', async () => {
    const shown = texts(await author(new HookHarness()));
    expect(texts(view(new HookHarness(), { scope: ACCOUNT_B }))).toHaveLength(1);
    expect(texts(view(new HookHarness(), { scope: null }))).toHaveLength(1);
    expect(texts(view(new HookHarness(), { persist: false }))).toHaveLength(1);
    workflow('workflow-another');
    expect(texts(view(new HookHarness()))).toHaveLength(1);
    // Account B writing in this tab removes account A's kept conversations (never two accounts' messages side by side).
    await author(new HookHarness(), { scope: ACCOUNT_B });
    expect([...storage.keys()].some(key => key.includes(ACCOUNT_A))).toBe(false);
    expect(shown.length).toBeGreaterThan(1);
  });

  it('explicit New workflow opens a distinct, empty conversation; reopening the earlier workflow restores its own', async () => {
    const page = new HookHarness(), first = editor.workflow.workflowId, shown = texts(await author(page));
    // New workflow: a fresh identity and the epoch together (app-shell resetForNewWorkflow).
    workflow('workflow-new'); let chat = view(page, { epoch: 1 });
    expect(texts(chat)).toHaveLength(1);
    expect(chat.question).toBeNull();
    // Reopening the earlier workflow (a saved workflow or the restored Canvas) brings back its own conversation, read-only.
    workflow(first); chat = view(page, { epoch: 1 });
    expect(texts(chat)).toEqual(shown);
    expect(chat.messages.some(message => message.options)).toBe(false);
    // The new workflow's conversation stayed separate.
    workflow('workflow-new'); expect(texts(view(page, { epoch: 1 }))).toHaveLength(1);
    // New workflow again over a stored identity: its stored conversation is not restored.
    workflow(first); chat = view(page, { epoch: 2 });
    expect(texts(chat)).toHaveLength(1);
    expect(texts(view(new HookHarness(), { epoch: 2 }))).toHaveLength(1);
  });

  it('a late Copilot answer of the previous workflow never lands in the next workflow or changes it', async () => {
    const answer = deferred<unknown>(); f.respond = () => answer.promise;
    const page = new HookHarness();
    view(page).send('make something nice'); await flush();
    expect(texts(view(page))).toContain('make something nice');
    workflow('workflow-next');
    const next = view(page, { epoch: 1 });
    expect(texts(next)).toHaveLength(1);
    const revision = editor.workflow.revision;
    answer.resolve({ text: 'Interpreted.', notes: [], command: { type: 'ADD_SWAP' } });
    await flush(); store(); lifecycle(reviewedPatch);
    expect(texts(view(page, { epoch: 1 }))).toHaveLength(1);
    expect(editor.workflow.revision).toBe(revision);
    expect(f.propose).toEqual([]);
  });

  it('never keeps a typed private key or seed phrase, and keeps nothing for a conversation the owner has not joined', async () => {
    const page = new HookHarness(); view(page); await flush();
    expect(storage.size).toBe(0);
    view(page).send(`my private key is 0x${'ab'.repeat(32)}`); await flush();
    view(page).send('explain'); await flush(); view(page);
    const kept = [...storage.values()].join('');
    expect(kept).not.toContain('ab'.repeat(32));
    expect(kept).not.toMatch(/private key is/);
    expect(kept).toContain('"text":"explain"');
    // This visit still shows what was typed; only this tab's kept copy leaves it out.
    expect(texts(view(page))).toContain(`my private key is 0x${'ab'.repeat(32)}`);
  });

  it('the approval surfaces keep their previous behaviour: one conversation per page, a new owner starts it again', async () => {
    direct = false;
    const page = new HookHarness();
    view(page, { direct: false }).send('swap 10 USDC to WETH on Base Sepolia slippage 100 bps'); await flush(); store(); lifecycle(reviewedPatch);
    expect(texts(view(page, { direct: false })).length).toBeGreaterThan(1);
    expect(texts(view(page, { direct: false, owner: solana }))).toEqual(['Review each proposed change before applying it.']);
    expect(storage.size).toBe(0);
  });

  it('a Copilot answer whose conversation ended while it was interpreted says nothing (no empty message)', async () => {
    f.respond = async () => ({ kind: 'FAILED', code: 'COPILOT_CONVERSATION_ENDED', text: '', notes: [], options: [] });
    const page = new HookHarness();
    view(page).send('make something nice'); await flush();
    expect(texts(view(page))).toEqual([expect.any(String), 'make something nice']);
  });

  it('the earlier conversation keeps the answer that started New workflow from the chat (same update as the switch)', async () => {
    const page = new HookHarness(), first = editor.workflow.workflowId;
    let epoch = 0;
    const options = () => ({ epoch });
    await author(page, options());
    bridge = { ...bridge, startNewWorkflow: () => { epoch += 1; workflow('workflow-new'); bridge = { ...bridge, startNewWorkflow: bridge.startNewWorkflow }; } };
    const startNew = conversationCopy('EN').startNew;
    view(page, options()).send(startNew); await flush();
    expect(texts(view(page, options()))).toHaveLength(1);
    workflow(first);
    expect(texts(view(page, options())).at(-1)).toBe(startNew);
    expect(texts(view(new HookHarness(), options())).at(-1)).toBe(startNew);
  });

  it('the account becoming known for the same workflow keeps the conversation on screen, then keeps it for this tab', async () => {
    const page = new HookHarness();
    view(page, { scope: null }).send('explain'); await flush();
    const before = texts(view(page, { scope: null }));
    expect(before).toContain('explain');
    expect(texts(view(page, { scope: ACCOUNT_A }))).toEqual(before);
    expect(texts(view(new HookHarness()))).toEqual(before);
  });

  it('a conversation begun on the untouched draft continues on the workflow that replaces it (restored Canvas, recovered run)', async () => {
    const page = new HookHarness();
    view(page).send('explain'); await flush();
    const before = texts(view(page));
    workflow('workflow-recovered');
    expect(texts(view(page))).toEqual(before);
    // An authored workflow is never carried into another: reopening one with no history shows the welcome alone.
    await author(page);
    workflow('workflow-other');
    expect(texts(view(page))).toHaveLength(1);
  });

  it('a different reviewing wallet ends what FloFi would do by itself for the previous one, never the conversation; a reconnect changes nothing', async () => {
    const page = new HookHarness(), shown = texts(await author(page));
    f.clears = 0;
    for (const owner of [null, evm]) view(page, { owner });
    expect(f.clears).toBe(0);
    expect(texts(view(page, { owner: solana }))).toEqual(shown);
    expect(f.clears).toBe(1);
  });

  it('after the reviewing wallet changes, the previous wallet\'s run never makes FloFi simulate by itself (no step hand-over, no re-quote)', async () => {
    const page = new HookHarness();
    const ask = async (text: string) => { view(page).send(text); await flush(); store(); lifecycle(reviewedPatch); return view(page); };
    await ask('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const sequence = { total: 2, current: 1, finished: false, steps: SEQUENCE_STEPS, issue: null, awaitingDelivery: false };
    reviewedPatch = { sequence }; lifecycle(reviewedPatch);
    await ask('Review workflow');
    reviewedPatch = { ...reviewed(), sequence }; lifecycle(reviewedPatch); view(page);
    await ask('Yes, I confirm'); await ask('Yes, execute');
    expect(controls.authorize).toHaveBeenCalledTimes(1); expect(simulate).toHaveBeenCalledTimes(1);
    const shown = texts(view(page)).length;
    // The reviewing wallet changes (e.g. to the Solana session); then step 1's run completes and step 2 becomes current.
    const other = () => view(page, { owner: solana });
    other(); controls.authorizing = false;
    reviewedPatch = { ...reviewedPatch, progress: completedRun as unknown as ConversationBridge['progress'] }; lifecycle(reviewedPatch); other(); await flush(); other();
    const next = { ...sequence, current: 2, steps: [{ ...SEQUENCE_STEPS[0]!, state: 'COMPLETED' as const, delivered: '0.0042 WETH' },
      { ...SEQUENCE_STEPS[1]!, state: 'CURRENT' as const, funding: { from: 1, cap: '0.001 WETH', bound: '0.001 WETH' } }] };
    reviewedPatch = { sequence: next }; lifecycle(reviewedPatch); other(); await flush();
    const chat = other();
    // Nothing is simulated, authorized or requested for the new wallet by FloFi itself; the owner asks for a Review when ready.
    expect(simulate).toHaveBeenCalledTimes(1); expect(controls.authorize).toHaveBeenCalledTimes(1); expect(controls.request).not.toHaveBeenCalled();
    expect(texts(chat).length).toBeGreaterThanOrEqual(shown);
  });
});

/**
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (P2): a bridge asked for in the chat while the account's wallets for its destination are still
 * being read (Privy after a reload, a slow or retried account read). The chat says so ONCE and, when the read settles, continues by itself for
 * the same workflow revision, wallet and network only — and says so once if something changed. Its simulation may ask the wallet to sign in, so
 * FloFi offers the Review instead of starting it; no resume FloFi starts by itself ever simulates such a runtime (FIX-07). MOCKED bridge/runtime.
 */
describe('BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 chat resumes after the destination wallets are read', () => {
  const LOADING = 'FloFi is still reading your wallets for Solana. Try again in a moment, or enter the destination\'s public address. Nothing was signed or sent.';
  const loading = { network: 'Solana', reason: LOADING };
  const IDENTIFYING = 'I’m still reading your wallets that can receive on Solana. I’ll let you know as soon as they’re read. Nothing was signed or sent.';
  const READY = 'Your wallets have been read, and the wallet that receives on Solana is set. The review may ask your wallet to sign in to FloFi (no funds move), so it starts when you choose Review workflow.';
  const DROPPED = 'Your workflow, wallet or network changed while I was reading your wallets, so I did not continue. Choose Review workflow when you are ready.';
  /** The universal bridge as the shell describes it: its simulation may ask for a sign-in, and while the read runs Simulate waits for it. */
  const waiting = () => { reviewedPatch = { manualSimulation: true, destinationLoading: loading }; lifecycle(reviewedPatch); bridge = { ...bridge, simulationBlocked: LOADING }; };
  const settled = (blocked: string | null = null) => { reviewedPatch = { manualSimulation: true, destinationLoading: null }; lifecycle(reviewedPatch); bridge = { ...bridge, simulationBlocked: blocked }; };
  const texts = (chat: FlofiConversation) => chat.messages.map(message => message.text);
  async function asked() {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    waiting();
    render().send('Review workflow'); await flush();
    return render();
  }
  it('says it is reading the wallets once, then offers the Review when they are read (no sign-in, no simulation, no repeat)', async () => {
    let chat = await asked();
    expect(last(chat).text).toBe(IDENTIFYING);
    expect(texts(chat).filter(text => /can’t start the review/.test(text))).toEqual([]);
    const before = chat.messages.length;
    for (let i = 0; i < 3; i++) { waiting(); render(); await flush(); }
    expect(render().messages).toHaveLength(before);
    settled(); render(); await flush(); chat = render();
    expect(last(chat).text).toBe(READY);
    expect(last(chat).options).toEqual(['Review workflow']);
    expect(chat.messages).toHaveLength(before + 1);
    // A re-read after the offer (a Try again, a recovered read elsewhere) never announces or offers again.
    for (let i = 0; i < 3; i++) { waiting(); render(); await flush(); settled(); render(); await flush(); }
    expect(render().messages).toHaveLength(before + 1);
    expect(simulate).not.toHaveBeenCalled(); expect(controls.authorize).not.toHaveBeenCalled(); expect(controls.request).not.toHaveBeenCalled();
    // The owner's own answer starts the review (its sign-in is then the owner's request).
    render().send('Review workflow'); await flush();
    expect(simulate).toHaveBeenCalledTimes(1);
  });
  it('a read that ends without a usable wallet says why once (no wait, no loop)', async () => {
    await asked();
    const missing = 'FloFi could not read which Solana wallets your account has for Solana. Choose one of your wallets or Try again on the Bridge card, or enter the destination’s public address. Nothing was signed or sent.';
    settled(missing); render(); await flush();
    const chat = render();
    expect(last(chat).text).toBe(`I can’t start the review yet: ${missing}`);
    expect(texts(chat).filter(text => text.startsWith('I can’t start the review yet')).length).toBe(1);
    for (let i = 0; i < 3; i++) { render(); await flush(); }
    expect(render().messages).toHaveLength(chat.messages.length);
    expect(simulate).not.toHaveBeenCalled();
  });
  it('another revision or wallet drops the resume and says so once; a wallet that only became known meanwhile continues', async () => {
    await asked();
    // The workflow's revision changed while the wallets were read (an edit on the Canvas, no chat message).
    editor = { ...editor, workflow: { ...editor.workflow, revision: editor.workflow.revision + 1 } }; store();
    settled(); render(); await flush(); const chat = render();
    expect(last(chat).text).toBe(DROPPED); expect(last(chat).options).toEqual(['Review workflow']);
    // Another wallet while reading: dropped too.
    waiting(); render().send('Review workflow'); await flush();
    expect(last(render()).text).toBe(IDENTIFYING);
    settled(); bridge = { ...bridge, wallet: { ...bridge.wallet, account: '0x2222222222222222222222222222222222222222' } }; render(); await flush();
    expect(last(render()).text).toBe(DROPPED);
    // A wallet that was not known yet when the chat started waiting (restored after a reload) is the same request: the Review is offered.
    lifecycle(); bridge = { ...bridge, wallet: { ...bridge.wallet, account: null, chain: null } }; waiting();
    bridge = { ...bridge, wallet: { ...bridge.wallet, account: null, chain: null } };
    render().send('Review workflow'); await flush();
    expect(last(render()).text).toBe(IDENTIFYING);
    settled(); render(); await flush();
    expect(last(render()).text).toBe(READY);
    expect(simulate).not.toHaveBeenCalled();
  });
  it('wallet-execution review: another signing wallet while reading ends the promise, said once', async () => {
    await asked();
    const other = () => harness.render(() => useFlofiConversation({ owner: { namespace: 'eip155', address: '0x2222222222222222222222222222222222222222' }, epoch: 0, bridge, direct,
      interfaceLanguage: 'EN' }));
    other(); await flush();
    expect(last(other()).text).toBe(DROPPED);
    settled(); other(); await flush();
    expect(texts(other()).filter(text => text === DROPPED)).toHaveLength(1);
    expect(texts(other()).some(text => text === READY)).toBe(false);
    expect(simulate).not.toHaveBeenCalled();
  });
  it('a message from the owner (without any change) replaces the waiting request: nothing is said for it afterwards', async () => {
    const chat = await asked();
    render().send('explain'); await flush();
    const after = render().messages.length;
    expect(after).toBeGreaterThan(chat.messages.length);
    settled(); render(); await flush();
    expect(render().messages).toHaveLength(after);
    expect(texts(render()).some(text => text === READY)).toBe(false);
  });
  it('wallet-execution review: a resume never simulates by itself, also when the workflow is between its steps', async () => {
    await asked();
    const sequence = { total: 2, current: 2, finished: false, issue: null, awaitingDelivery: false, steps: [
      { number: 1, action: 'Swap', amount: '10 USDC', detail: null, network: 'Base', state: 'COMPLETED', funding: null, delivered: '0.004 WETH' },
      { number: 2, action: 'Bridge', amount: '10 USDC', detail: null, network: 'Base → Solana', state: 'CURRENT', funding: null, delivered: null }] };
    reviewedPatch = { manualSimulation: true, destinationLoading: null, sequence } as Partial<ConversationBridge>; lifecycle(reviewedPatch);
    bridge = { ...bridge, simulationBlocked: null };
    render(); await flush();
    expect(texts(render()).some(text => /Simulating/.test(text))).toBe(false);
    expect(simulate).not.toHaveBeenCalled(); expect(controls.authorize).not.toHaveBeenCalled();
  });
  it('chat and workflow reviews: a review FloFi continues by itself after a network switch never starts a sign-in simulation either', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    const offer = { label: 'Switch to Base Sepolia', network: 'Base Sepolia', disabled: false, request: vi.fn() };
    reviewedPatch = { manualSimulation: true, networkAction: offer }; lifecycle(reviewedPatch);
    render().send('Review workflow'); await flush();
    expect(last(render()).options).toEqual(['Switch to Base Sepolia']);
    reviewedPatch = { manualSimulation: true, networkAction: undefined, walletNetwork: 'Base Sepolia' }; lifecycle(reviewedPatch);
    render(); await flush();
    // One message (never "Continuing the review" followed by an offer): where the wallet is now, and that the owner starts the review.
    expect(last(render()).text).toBe('Your wallet is now on Base Sepolia. The review may ask your wallet to sign in to FloFi (no funds move), so it starts when you choose Review workflow.');
    expect(texts(render()).some(text => /Continuing the review/.test(text))).toBe(false);
    expect(last(render()).options).toEqual(['Review workflow']);
    expect(simulate).not.toHaveBeenCalled();
  });
  it('in Portuguese, with the same single message and resume', async () => {
    await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    waiting();
    harness.unmount(); harness.slots = [];
    const portuguese = () => harness.render(() => useFlofiConversation({ owner: { namespace: 'eip155', address: reviewOwner }, epoch: 0, bridge, direct, interfaceLanguage: 'PT' }));
    portuguese().send('Revisar fluxo'); await flush();
    expect(last(portuguese()).text).toBe('Ainda estou lendo suas carteiras que podem receber em Solana. Aviso você assim que terminar. Nada foi assinado nem enviado.');
    settled(); portuguese(); await flush();
    expect(last(portuguese()).text).toMatch(/^Já li suas carteiras, e a carteira que recebe em Solana está definida\./);
    expect(last(portuguese()).options).toEqual(['Revisar fluxo']);
    expect(simulate).not.toHaveBeenCalled();
  });
});

/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: a Batch Payment in the product chat. Its confirmation lists every recipient, amount and the
 * all-or-nothing rule before Review (chat review L1), and a `pay` request FloFi read and refused says why, in both languages, without reaching the
 * interpretation (M2). Nothing is simulated, signed or sent here.
 */
describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment in the chat', () => {
  const A = '0x2222222222222222222222222222222222222222', B = '0x3333333333333333333333333333333333333333';
  const ATOMIC = 'It runs only as one atomic authorization of your wallet: every payment settles, or none does. Review every recipient before you authorize.';
  const ATOMIC_PT = 'Ele só executa como uma autorização atômica da sua carteira: todos os pagamentos são liquidados, ou nenhum. Revise cada destinatário antes de autorizar.';
  it('chat review L1: the exact `pay` confirmation lists each recipient and amount and the all-or-nothing rule', async () => {
    const chat = await say(`pay 0.001 ETH to ${A} and 0.002 ETH to ${B} on Base`);
    expect(editor.workflow.revision).toBe(1); expect(f.propose).toEqual([]);
    expect(editor.workflow.nodes.at(-1)!.actionType).toBe('asset.transfer.batch');
    // R09–R12: the batch is said as what was prepared (count, exact total, token, network), then every payment and the all-or-nothing rule.
    expect(last(chat).text).toBe('I prepared a batch payment of 0.003 ETH to 0x2222…2222 and 0x3333…3333.');
    expect(last(chat).notes).toEqual(['2 recipients · 0.003 ETH · Base', `1. 0.001 ETH → ${A}`, `2. 0.002 ETH → ${B}`, ATOMIC]);
    expect(last(chat).question).toBe('Would you like to add another recipient and amount, or review the payment?');
    expect(last(chat).options).toEqual(['Add a recipient', 'Review workflow', 'Undo this change']);
    // Chat review C4: switching the interface to Portuguese shows the all-or-nothing rule in Portuguese (never the English one reused), and back.
    expect(shownMessage(last(chat), 'PT').notes).toEqual(['2 destinatários · 0,003 ETH · Base', `1. 0,001 ETH → ${A}`, `2. 0,002 ETH → ${B}`, ATOMIC_PT]);
    expect(shownMessage(shownMessage(last(chat), 'PT'), 'EN').notes).toEqual(['2 recipients · 0.003 ETH · Base', `1. 0.001 ETH → ${A}`, `2. 0.002 ETH → ${B}`, ATOMIC]);
  });
  it('chat review L1: an interpreted Batch Payment keeps its per-recipient lines and atomic sentence in the confirmation', async () => {
    const command = { type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0,
      input: { network: 'Base', asset: 'ETH', payments: [{ recipient: A, amount: '0.001' }, { recipient: B, amount: '0.002' }] } };
    f.respond = async () => ({ kind: 'PROPOSAL', text: `One Batch Payment on Base to 2 recipients: 1. 0.001 ETH → ${A} 2. 0.002 ETH → ${B} ${ATOMIC}`,
      notes: ['Base uses real funds.'], options: [], sentence: 'batch payment of ETH to 2 recipients on Base', command });
    const chat = await say(`Send 0.001 ETH to ${A} and 0.002 ETH to ${B} on Base`);
    expect(editor.workflow.revision).toBe(1); expect(last(chat).role).toBe('ai');
    // R09–R12: the confirmation's text says the prepared batch, so the "Interpreted as" line is not repeated; the model's own notes stay.
    expect(last(chat).notes).toEqual(['2 recipients · 0.003 ETH · Base', `1. 0.001 ETH → ${A}`, `2. 0.002 ETH → ${B}`, ATOMIC, 'Base uses real funds.']);
    // Chat review C4: in Portuguese the payment lines keep their place and the all-or-nothing rule is the Portuguese one; the model's notes stay as written.
    expect(shownMessage(last(chat), 'PT').notes).toEqual(['2 destinatários · 0,003 ETH · Base', `1. 0,001 ETH → ${A}`, `2. 0,002 ETH → ${B}`,
      ATOMIC_PT, 'Base uses real funds.']);
  });
  it('chat review M2: a `pay` refusal says why in English and Portuguese and never reaches the interpretation', async () => {
    const asked: string[] = [];
    f.respond = async text => { asked.push(text); return { kind: 'PROPOSAL', text: 'x', notes: [], options: [], sentence: 'x', command: null }; };
    const cases: readonly (readonly [string, string])[] = [
      [`pay 0.001 ETH to ${A} and 0.002 ETH to ${A} on Base`, 'BATCH_PAYMENT_DUPLICATE_RECIPIENT'],
      [`pay 0 ETH to ${A} and 0.002 ETH to ${B} on Base`, 'BATCH_PAYMENT_AMOUNT_INVALID'],
      [`pay 1.1234567 USDC to ${A} and 2 USDC to ${B} on Base`, 'BATCH_PAYMENT_AMOUNT_TOO_PRECISE'],
      [`pay 0.001 ETH to 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD and 0.002 ETH to ${B} on Base`, 'BATCH_PAYMENT_RECIPIENT_INVALID'],
      [`batch pay 1 USDC to ${A} and 0.002 ETH to ${B} on Base`, 'BATCH_PAYMENT_ASSET_MIXED'],
      // Chat review C3: a recipient that is not an explicit address, and a network Batch Payment does not pay, are refusals too (never the generic help).
      [`pay 1 USDC to my wallet and 2 USDC to ${B} on Base`, 'BATCH_PAYMENT_RECIPIENT_INVALID'],
      [`batch pay 0.001 ETH to ${A} and 0.002 ETH to ${B} on Base Sepolia`, 'BATCH_PAYMENT_NETWORK_UNSUPPORTED'],
    ];
    const { copilotRejection } = await import('../domain/copilot-authoring');
    for (const [request, code] of cases) {
      const message = last(await say(request));
      expect(message.text, request).toBe(copilotRejection(code, 'EN').message);
      expect(shownMessage(message, 'PT').text, request).toBe(copilotRejection(code, 'PT').message);
    }
    expect(asked).toEqual([]);
    expect(editor.workflow.revision).toBe(0); expect(f.propose).toEqual([]);
  });
});

/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R09–R12, P1-03): the product chat confirms a Batch Payment built and edited with saved recipients on the
 * SAME card (names from this page's own list, display only; count, exact total, token and network), retires an earlier Review, offers "View in plan"
 * and marks the changed card on the Canvas. The engine's own resolution is covered in `domain/copilot-batch-payment-recipients.test.ts`.
 */
describe('R09–R12 / P1-03: Batch Payment with saved recipients in the product chat', () => {
  const CAIO = '0x2222222222222222222222222222222222222222', DAYANE = '0x3333333333333333333333333333333333333333', PEDRO = '0x4444444444444444444444444444444444444444';
  const saved = (label: string, address: string, id: string) => ({ id: `rcp_${id.padEnd(26, 'a')}`, label, address, ecosystem: 'EVM',
    createdAt: '2026-11-15T12:00:00.000Z', updatedAt: '2026-11-15T12:00:00.000Z' });
  const payments = (...list: readonly (readonly [string, string])[]) => list.map(([recipient, amount]) => ({ recipient, amount }));
  const proposal = (command: Record<string, unknown>) => async () => ({ kind: 'PROPOSAL', text: 'x', notes: [], options: [], sentence: 'batch payment of ETH on Base', command });
  beforeEach(() => { f.recipients = [saved('Caio', CAIO, 'b'), saved('Dayane', DAYANE, 'c'), saved('Pedro', PEDRO, 'd')]; });
  it('creates the batch, adds Pedro to the same card, says count · total · token · network in both languages and offers "View in plan"', async () => {
    f.respond = proposal({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0, input: { network: 'Base', asset: 'ETH', payments: payments([CAIO, '0.002'], [DAYANE, '0.003']) } });
    let chat = await say('Envie 0.002 ETH para Caio e 0.003 ETH para Dayane pela Base.');
    const card = editor.workflow.nodes.at(-1)!.nodeId;
    expect(last(chat).text).toBe('I prepared a batch payment of 0.005 ETH to Caio and Dayane.');
    expect(last(chat).focus).toBe(card);
    const pt = shownMessage(last(chat), 'PT');
    expect(pt.text).toBe('Preparei um pagamento em lote de 0,005 ETH para Caio e Dayane.');
    expect(pt.question).toBe('Deseja adicionar outro destinatário e valor ou revisar o pagamento?');
    expect(pt.notes!.slice(0, 3)).toEqual(['2 destinatários · 0,005 ETH · Base', `1. 0,002 ETH → Caio · ${CAIO}`, `2. 0,003 ETH → Dayane · ${DAYANE}`]);
    expect(pt.options).toEqual(['Adicionar destinatário', 'Revisar fluxo', 'Desfazer esta alteração']);
    chat = await say('Add a recipient');
    expect(last(chat).text).toBe('Tell me who to add and how much, for example “add 10 USDC for Pedro”.');
    f.respond = proposal({ type: 'SET_BATCH_PAYMENT', source: 'CHAT', baseRevision: 1, nodeId: card,
      input: { network: 'Base', asset: 'ETH', payments: payments([CAIO, '0.002'], [DAYANE, '0.003'], [PEDRO, '0.001']) } });
    chat = await say('Adicione mais 0.001 ETH para Pedro.');
    expect(editor.workflow.nodes.filter(node => node.actionType === 'asset.transfer.batch').map(node => node.nodeId)).toEqual([card]);
    expect(last(chat).text).toBe('Pedro was added. Now there are 3 recipients and a total of 0.006 ETH.');
    expect(shownMessage(last(chat), 'PT').text).toBe('Pedro foi adicionado. Agora são 3 destinatários e um total de 0,006 ETH.');
    expect(shownMessage(last(chat), 'PT').question).toBe('Deseja adicionar mais alguém ou revisar?');
    expect(last(chat).notes).toContain(`3. 0.001 ETH → Pedro · ${PEDRO}`);
    expect(last(chat).focus).toBe(card);
  });
  it('a recipient or amount change after a Review says the Review no longer applies, and "review" simulates the new list again', async () => {
    f.respond = proposal({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0, input: { network: 'Base', asset: 'ETH', payments: payments([CAIO, '0.002'], [DAYANE, '0.003']) } });
    await say('Envie 0.002 ETH para Caio e 0.003 ETH para Dayane pela Base.');
    const card = editor.workflow.nodes.at(-1)!.nodeId;
    await say('Review workflow');
    reviewedPatch = reviewed(); lifecycle(reviewedPatch); render();
    await say('No');
    f.respond = proposal({ type: 'SET_BATCH_PAYMENT', source: 'CHAT', baseRevision: 1, nodeId: card, input: { network: 'Base', asset: 'ETH', payments: payments([CAIO, '0.004'], [DAYANE, '0.003']) } });
    const chat = await say('mude o Caio para 0.004');
    expect(editor.workflow.revision).toBe(2);
    expect(last(chat).text).toBe('Caio: 0.002 → 0.004 ETH. Now there are 2 recipients and a total of 0.007 ETH.');
    expect(last(chat).notes).toContain('Any earlier simulation or review of this workflow no longer applies.');
    await say('Review workflow');
    expect(simulate).toHaveBeenCalledTimes(2);
  });
  it('an exact `pay` list naming a saved recipient reaches the interpretation; without that name it is refused as before', async () => {
    const asked: string[] = [];
    f.respond = async text => { asked.push(text); return { kind: 'CLARIFICATION', text: 'ok', notes: [], options: [] }; };
    await say(`pay 0.001 ETH to Caio and 0.002 ETH to ${DAYANE} on Base`);
    expect(asked).toEqual([`pay 0.001 ETH to Caio and 0.002 ETH to ${DAYANE} on Base`]);
    f.recipients = [];
    const { copilotRejection } = await import('../domain/copilot-authoring');
    expect(last(await say(`pay 0.001 ETH to Caio and 0.002 ETH to ${DAYANE} on Base`)).text).toBe(copilotRejection('BATCH_PAYMENT_RECIPIENT_INVALID', 'EN').message);
    expect(asked).toHaveLength(1);
  });
  it('the changed card is marked on the Canvas (one event with its id); nothing is selected or edited by it', async () => {
    const dispatched: Event[] = [];
    vi.stubGlobal('window', Object.assign(new EventTarget(), { dispatchEvent: (event: Event) => { dispatched.push(event); return true; } }));
    try {
      f.respond = proposal({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0, input: { network: 'Base', asset: 'ETH', payments: payments([CAIO, '0.002'], [DAYANE, '0.003']) } });
      await say('Envie 0.002 ETH para Caio e 0.003 ETH para Dayane pela Base.');
    } finally { vi.unstubAllGlobals(); }
    const highlight = dispatched.filter(event => event.type === 'flofi:canvas-highlight') as CustomEvent<unknown>[];
    expect(highlight.map(event => event.detail)).toEqual([[editor.workflow.nodes.at(-1)!.nodeId]]);
  });
});
