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
const f = vi.hoisted(() => ({ store: null as unknown as Record<string, unknown>, propose: [] as unknown[], respond: null as null | ((text: string) => Promise<unknown>) }));
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
let bridge: ConversationBridge, controls: { authorize: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; checkStatus: ReturnType<typeof vi.fn> };
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
  controls = { authorize: vi.fn(), request: vi.fn(), checkStatus: vi.fn() };
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
    expect(last(chat).text).toMatch(/Confirm or reject it in your wallet; FloFi never signs for you/);
    expect(controls.request).not.toHaveBeenCalled();
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
    const chat = await say('Swap 3 USDC to ETH on Base Sepolia.');
    expect(editor.workflow.revision).toBe(1); expect(f.propose).toEqual([]);
    expect(last(chat).role).toBe('ai');
    expect(last(chat).text).toMatch(/^Swap added to your workflow: 3 USDC/);
    expect(last(chat).notes).toEqual(['Interpreted as “swap 3 USDC to WETH on Base Sepolia slippage 100 bps”.', 'Flofi swaps the ERC-20 WETH (wrapped ETH), not native ETH.']);
  });
  it('in an approval context the chat keeps its proposal behaviour and has no lifecycle controls', async () => {
    direct = false;
    const chat = await say('swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    expect(f.propose).toHaveLength(1); expect(editor.workflow.revision).toBe(0);
    expect(chat.phase).toBeNull(); expect(chat.execution).toBeNull();
    await say('Review workflow');
    expect(simulate).not.toHaveBeenCalled();
  });
});
