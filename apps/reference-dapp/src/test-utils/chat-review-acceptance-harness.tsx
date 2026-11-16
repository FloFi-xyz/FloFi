// SPDX-License-Identifier: AGPL-3.0-only
// Browser-only test entry. No production route imports this module.
/**
 * HOTFIX-P1-UI-OVERFLOW-AND-ATTRIBUTION-001: the real FloFi Assistant panel (`CopilotPanel`) and its real Review card, mounted with a
 * conversation whose Review carries long Solana and EVM addresses, a long route, nested steps and technical details, so a browser can measure
 * that nothing leaves the panel. Display fixture only: nothing is simulated, quoted, signed or sent, and no value is read from a network.
 */
import { createRoot } from 'react-dom/client';
import { CopilotPanel } from '../components/copilot-panel';
import { LocaleProvider } from '../i18n/locale';
import type { ChatMessage } from '../domain/chat-message';
import type { ConversationReview } from '../domain/conversation-lifecycle';
import type { FlofiConversation } from '../state/flofi-conversation';
import { CHAT_REVIEW_FIXTURE } from './chat-review-fixture';

const { solana, evm, route, technical } = CHAT_REVIEW_FIXTURE;
const review = {
  status: 'READY', label: 'Review ready', message: 'Review ready', canConfirm: true,
  steps: [
    { number: 1, action: 'Swap', input: '0.5 USDC', pair: route, networks: 'Solana', provider: 'Jupiter', result: '0.00708719 SOL', resultLabel: 'Estimated output',
      minimum: '0.00705175 SOL', slippage: '0.5%', priceImpact: '0.01%', destination: null,
      details: [{ label: 'Token mint', value: 'So11111111111111111111111111111111111111112' }, { label: 'Route', value: technical }] },
    { number: 2, action: 'Send', input: '0.00708719 SOL', pair: null, networks: 'Solana', provider: null, result: null, resultLabel: 'Estimated output',
      minimum: null, slippage: null, priceImpact: null, destination: solana, details: [{ label: 'Step status', value: `Waits for step 1 · ${technical}` }] },
  ],
  fees: [{ label: 'Network fee', value: '0.000005 SOL', treatment: 'ADDITIONAL' }, { label: 'Priority fee', value: '0.000123456789 SOL', treatment: 'CEILING', note: technical }],
  limits: [{ label: 'Quote binding', value: technical }], warnings: [{ severity: 'attention', message: `The output goes to ${solana}; approval spender ${evm}.` }],
  approvals: [{ symbol: 'USDC', value: 'Exactly 0.5 USDC', spender: evm, network: 'Solana' }], walletRequests: ['Swap USDC to SOL', 'Send SOL'], providerSteps: [],
  account: solana, network: 'Solana', expiresAt: Date.parse('2026-11-16T13:05:00Z'), unknown: [], simulationProblem: null, sequence: null,
  totals: { additional: ['0.000005 SOL'], ceilings: ['0.000123456789 SOL'], excludes: [{ text: technical, parameters: [] }] },
  flofiFee: { value: '0.0005 USDC', note: technical, recorded: true },
} as unknown as ConversationReview;
const messages: ChatMessage[] = [
  { id: 0, role: 'system', text: 'Hi FloFier!' },
  { id: 1, role: 'you', text: `Swap 0.5 USDC to SOL on Solana and send it to ${solana}` },
  { id: 2, role: 'ai', text: `Interpreted as “swap 0.5 USDC to SOL on Solana, then send all SOL to ${solana}”. ${route}`, notes: [technical] },
  { id: 3, role: 'flofi', text: 'Your workflow Review is ready.', review, notes: [`Quote changes: ${technical}`], question: 'Do you confirm this workflow?', options: ['Yes, I confirm', 'No'] },
];
const conversation = { messages, input: '', setInput: () => undefined, send: () => undefined, submit: async () => undefined, busy: false, direct: true, phase: null,
  question: 'CONFIRM_WORKFLOW', copilot: { enabled: true, mode: 'live', busy: false }, automation: null, manage: null, dismissAutomation: () => undefined,
  dismissManage: () => undefined } as unknown as FlofiConversation;

/** Mounts into the Simulate / Execute stage container (app-shell `wrapStage`): the stage, then the Assistant as its direct child. */
export function mount(element: HTMLElement): void {
  createRoot(element).render(<LocaleProvider initialLanguage="EN"><section aria-label="Stage"/><CopilotPanel conversation={conversation}/></LocaleProvider>);
}
