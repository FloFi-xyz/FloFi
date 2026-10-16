// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-UI-002 (UX/UI-008 A): what each conversational surface does inside the conversation itself, and what still needs
 * FloFi. Repository truth, not a live acceptance claim: every cell restates a code path that `channel-capabilities.test.ts` checks
 * (tool names, channel switches, the WhatsApp clearance gate, the disabled in-frame wallet). A deployment's own switches can narrow any of
 * it, and none of it is financial authority: a signature always comes from the owner's wallet in FloFi.
 */
export type SurfaceId = 'chatgpt' | 'claude' | 'telegram' | 'whatsapp';
export type SurfaceCapability = {
  readonly id: SurfaceId;
  readonly name: string;
  /** Natural-language workflow composition inside the conversation. */
  readonly compose: string;
  /** A fresh, read-only simulation inside the conversation. */
  readonly simulation: string;
  /** Live status and evidence back in the same conversation. */
  readonly progress: string;
  /** Where the owner's signature happens. */
  readonly signing: string;
  /** Where the supported networks and actions come from. */
  readonly coverage: string;
  /** What a person (or the operator) needs before it works. */
  readonly activation: string;
};

const MCP: Omit<SurfaceCapability, 'id' | 'name' | 'activation'> = {
  compose: 'Yes. Your assistant interprets the request; compose_strategy, validate_strategy and review_strategy build and check the canonical workflow.',
  simulation: 'Yes. simulate_strategy runs the flow’s read-only preview for a public address you name: nothing is stored and it grants no authority.',
  progress: 'Yes. The FloFi panel follows the approval and its runs and reports status and evidence to the conversation; without MCP Apps, ask for get_approval_status.',
  signing: 'Your wallet, in FloFi. The panel opens FloFi with the workflow on its Canvas; the chat frame never holds a wallet (in-frame signing is disabled).',
  coverage: 'Asked live with get_supported_networks and get_capabilities; mainnet handoffs only for networks the operator lists.',
};
const CHANNEL = (name: string): Omit<SurfaceCapability, 'id' | 'name' | 'activation'> => ({
  compose: 'Yes. Exact commands always; natural language when the deployment’s Copilot interpreter is enabled (FLOFI_CHANNEL_COPILOT).',
  simulation: 'Yes, when enabled (FLOFI_CHANNEL_SIMULATION): a read-only preview before the link if it needs no account or the strategy names the one to read.',
  progress: 'STATUS at any time; “loaded”, “started” and “reconciled” notices after you share run status in FloFi (off by default).',
  signing: `Your wallet, in FloFi. Open FloFi shows the workflow on the Canvas; ${name} has no wallet signer, and no message (“yes”, “confirm”) authorizes anything.`,
  coverage: 'The shared strategy grammar; channel policy decides test funds and mainnets (none unless the operator lists them).',
});
export const SURFACE_CAPABILITIES: readonly SurfaceCapability[] = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT (MCP)', ...MCP, activation: 'A custom connector in Developer mode, with FloFi OAuth.' },
  { id: 'claude', name: 'Claude (MCP)', ...MCP, activation: 'A custom connector, with FloFi OAuth.' },
  { id: 'telegram', name: 'Telegram', ...CHANNEL('Telegram'), activation: 'FloFi’s bot, with the deployment’s verified webhook.' },
  { id: 'whatsapp', name: 'WhatsApp', ...CHANNEL('WhatsApp'), activation: 'Not live: blocked until the owner records provider policy clearance (WHATSAPP_POLICY_CLEARANCE).' },
]);
/** Execution without opening FloFi would need a signer in the chat or a standing delegation for chat requests: neither exists. */
export const IN_CHAT_EXECUTION = 'NOT_AVAILABLE' as const;
