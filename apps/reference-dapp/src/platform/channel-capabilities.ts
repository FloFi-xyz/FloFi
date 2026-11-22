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
  progress: 'The FloFi panel follows the approval. Run status and evidence require the owner’s consent. Without MCP Apps, use get_approval_status.',
  signing: 'Your own wallet through the existing signing surface, embedded in MCP Apps when the host allows the FloFi frame and the wallet exposes a compatible provider there. Open FloFi is an optional external fallback; Canvas is optional. Live host/wallet acceptance must be verified.',
  coverage: 'Asked live with get_supported_networks and get_capabilities; mainnet handoffs only for networks the operator lists.',
};
const CHANNEL = (name: string): Omit<SurfaceCapability, 'id' | 'name' | 'activation'> => ({
  compose: 'With channel access, use exact commands or natural language if Copilot is enabled (FLOFI_CHANNEL_COPILOT).',
  simulation: 'Yes, when enabled (FLOFI_CHANNEL_SIMULATION): a read-only preview before the link if it needs no account or the strategy names the one to read.',
  progress: 'STATUS at any time; “loaded”, “started” and “reconciled” notices after you share run status in FloFi (off by default).',
  signing: `Your wallet, in FloFi. The link opens the signing surface with an optional Canvas; ${name} has no wallet signer, and no message (“yes”, “confirm”) authorizes anything.`,
  coverage: 'Hosted channels use registered mainnet routes subject to channel and beta policy. Test-fund routes require local engineering.',
});
export const SURFACE_CAPABILITIES: readonly SurfaceCapability[] = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT (MCP)', ...MCP, activation: 'A configured custom connector in Developer mode, with FloFi OAuth and an eligible linked FloFi account in the beta.' },
  { id: 'claude', name: 'Claude (MCP)', ...MCP, activation: 'A configured custom connector, with FloFi OAuth and an eligible linked FloFi account in the beta.' },
  { id: 'telegram', name: 'Telegram', ...CHANNEL('Telegram'), activation: 'The official @FloFiAppBot is listed publicly. Chat and workflow availability depend on the bot policy, beta access and configured webhook.' },
  { id: 'whatsapp', name: 'WhatsApp', ...CHANNEL('WhatsApp'), activation: 'Not live. The capabilities above are exercised only in local fixtures; hosted use requires provider policy clearance (WHATSAPP_POLICY_CLEARANCE).' },
]);
/** The MCP App can embed the existing runtime; this does not assert that a particular host/wallet supports signing. */
export const IN_CHAT_EXECUTION = 'HOST_AND_WALLET_DEPENDENT' as const;
