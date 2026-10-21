// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the one presentation and vocabulary registry of the networks FloFi authors on, keyed by CAIP-2 chain. Canvas marks,
 * the chat grammar of catalog networks, the Copilot vocabulary and display labels read it instead of keeping their own network lists.
 * It carries identity only (names, environment, local mark, the identifiers each surface uses); what a network supports stays in the
 * capability and profile registries. Nothing here grants authority: a mainnet entry only marks real funds.
 */
import { ARBITRUM_ONE, BASE_MAINNET, ETHEREUM_MAINNET, ETHEREUM_SEPOLIA, ROBINHOOD_CHAIN_MAINNET, ROBINHOOD_CHAIN_TESTNET, SOLANA_DEVNET_CHAIN } from '@defi-workflow-engine/action-registry';

export type NetworkEnvironment = 'MAINNET' | 'TESTNET';
/**
 * Copilot's network identifiers, in the order the model's schema lists them (the model reports one of these; FloFi decides support).
 * Each has exactly one registry entry below, which carries its name, environment, family and how a message names it.
 */
export const COPILOT_NETWORK_IDS = Object.freeze(['BASE', 'BASE_SEPOLIA', 'ARBITRUM', 'ARBITRUM_SEPOLIA', 'ETHEREUM', 'ETHEREUM_SEPOLIA', 'SOLANA', 'SOLANA_DEVNET',
  'ROBINHOOD', 'ROBINHOOD_TESTNET'] as const);
export type CopilotNetworkId = (typeof COPILOT_NETWORK_IDS)[number];
export type NetworkIdentity = {
  /** Stable key; equal to the MCP strategy network id where one exists. */ readonly key: string;
  readonly chain: string; readonly name: string;
  /** Other labels surfaces already show for this network ("Arbitrum", "Base (8453)"); never parsed as authority. */ readonly aliases: readonly string[];
  readonly environment: NetworkEnvironment;
  /** Canonical EVM metadata when registered; presentation fields never flow into workflow semantics. */
  readonly evm?: { readonly chainId: number; readonly chainHex: string; readonly rpc: string; readonly explorer: string;
    readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number } };
  /** A local, license-recorded network mark under `public/brand`, or null (a generated monogram is used). */ readonly mark: string | null;
  /** Assets come from a validated official catalog (search reaches the whole catalog; pinned assets always resolve). */ readonly catalog: boolean;
  readonly copilot: CopilotNetworkId | null;
  /** The brand a mainnet and its test networks share (`base` for Base and Base Sepolia): a test network never stands in for its mainnet. */
  readonly family: string;
  /** How a message names this network, in any language that uses network names (Copilot grounding); null when the Copilot cannot name it. */
  readonly mention: RegExp | null;
  /** Catalog networks only: the name the exact chat grammar accepts after "on" (case-insensitive), e.g. "Base", "Robinhood( Chain)". */
  readonly chatName: RegExp | null;
};
const SOLANA_MAINNET_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const network = (value: NetworkIdentity) => Object.freeze({ ...value, aliases: Object.freeze([...value.aliases]) });
export const NETWORKS: readonly NetworkIdentity[] = Object.freeze([
  network({ key: 'base', chain: BASE_MAINNET.chain, name: BASE_MAINNET.name, aliases: ['Base (8453)'], environment: 'MAINNET', mark: '/brand/crypto/base.svg',
    catalog: true, copilot: 'BASE', family: 'base', mention: /\bbase\b(?![\s-]*sepolia)/i, chatName: /Base(?![\s-]*Sepolia)/ }),
  network({ key: 'base-sepolia', chain: 'eip155:84532', name: 'Base Sepolia', aliases: [], environment: 'TESTNET', mark: '/brand/crypto/base.svg', catalog: false,
    copilot: 'BASE_SEPOLIA', family: 'base', mention: /\bbase[\s-]*sepolia\b/i, chatName: null }),
  network({ key: 'arbitrum-one', chain: ARBITRUM_ONE.chain, name: ARBITRUM_ONE.name, aliases: ['Arbitrum', 'Arbitrum (42161)', 'ARB network', 'ARB rede'], environment: ARBITRUM_ONE.environment,
    evm: ARBITRUM_ONE, mark: '/brand/crypto/arbitrum.png', catalog: true, copilot: 'ARBITRUM', family: 'arbitrum',
    // ARB alone is a token. Only an explicit network/rede phrase names the mainnet; Sepolia never does.
    mention: /\barbitrum\b(?![\s-]*(?:one[\s-]*)?sepolia)|\barb\s+(?:network|rede)\b(?![\s-]*sepolia)/i,
    chatName: /(?:Arbitrum(?: One)?|ARB (?:network|rede))(?![\s-]*(?:One[\s-]*)?Sepolia)/ }),
  network({ key: 'arbitrum-sepolia', chain: 'eip155:421614', name: 'Arbitrum Sepolia', aliases: [], environment: 'TESTNET', mark: '/brand/crypto/arbitrum.png',
    catalog: false, copilot: 'ARBITRUM_SEPOLIA', family: 'arbitrum', mention: /\barbitrum[\s-]*sepolia\b/i, chatName: null }),
  network({ key: 'ethereum', chain: ETHEREUM_MAINNET.chain, name: ETHEREUM_MAINNET.name, aliases: ['Ethereum Mainnet', 'Ethereum Mainnet (1)'], environment: 'MAINNET',
    evm: ETHEREUM_MAINNET, mark: '/brand/crypto/ethereum.svg', catalog: true, copilot: 'ETHEREUM', family: 'ethereum',
    mention: /\bethereum\b(?![\s-]*sepolia)/i, chatName: /Ethereum(?: Mainnet)?(?![\s-]*Sepolia)/ }),
  network({ key: 'ethereum-sepolia', chain: ETHEREUM_SEPOLIA.chain, name: 'Ethereum Sepolia', aliases: ['Ethereum Sepolia (11155111)'], environment: 'TESTNET',
    mark: '/brand/crypto/ethereum.svg', catalog: false, copilot: 'ETHEREUM_SEPOLIA', family: 'ethereum', mention: /\bethereum[\s-]*sepolia\b/i, chatName: null }),
  network({ key: 'solana', chain: SOLANA_MAINNET_CHAIN, name: 'Solana', aliases: ['Solana Mainnet'], environment: 'MAINNET', mark: '/brand/crypto/solana.svg',
    catalog: false, copilot: 'SOLANA', family: 'solana', mention: /\bsolana\b(?![\s-]*devnet)/i, chatName: null }),
  network({ key: 'solana-devnet', chain: SOLANA_DEVNET_CHAIN, name: 'Solana Devnet', aliases: [], environment: 'TESTNET', mark: '/brand/crypto/solana.svg',
    catalog: false, copilot: 'SOLANA_DEVNET', family: 'solana', mention: /\bsolana[\s-]*devnet\b/i, chatName: null }),
  network({ key: 'robinhood', chain: ROBINHOOD_CHAIN_MAINNET.chain, name: 'Robinhood Chain', aliases: ['Robinhood', 'Robinhood Chain (4663)'], environment: 'MAINNET',
    mark: '/brand/robinhood-avatar.jpg', catalog: true, copilot: 'ROBINHOOD', family: 'robinhood', mention: /\brobinhood(?![\s-]*(?:chain[\s-]*)?testnet)(?:[\s-]*chain)?\b/i, chatName: /Robinhood(?: Chain)?(?![\s-]*Testnet)/ }),
  network({ key: 'robinhood-testnet', chain: ROBINHOOD_CHAIN_TESTNET.chain, name: 'Robinhood Chain Testnet', aliases: ['Robinhood Testnet', 'Robinhood Chain Testnet (46630)'],
    environment: 'TESTNET', mark: '/brand/robinhood-avatar.jpg', catalog: false, copilot: 'ROBINHOOD_TESTNET', family: 'robinhood',
    mention: /\brobinhood[\s-]*(?:chain[\s-]*)?testnet\b/i, chatName: /Robinhood(?: Chain)? Testnet/ }),
]);
/** Networks FloFi only names (to explain or refuse), never authors on. */
const NAMED_ONLY: readonly NetworkIdentity[] = Object.freeze([
  network({ key: 'optimism', chain: 'eip155:10', name: 'Optimism', aliases: ['OP Mainnet'], environment: 'MAINNET', mark: '/brand/crypto/optimism.png',
    catalog: false, copilot: null, family: 'optimism', mention: null, chatName: null }),
]);
const ALL = [...NETWORKS, ...NAMED_ONLY];

/** The network of a CAIP-2 chain, a display name or alias (case-sensitive, as shown), or a registry key. */
export function networkIdentity(value: string | null | undefined): NetworkIdentity | null {
  if (!value) return null;
  return ALL.find(n => n.chain === value || n.name === value || n.key === value || n.aliases.includes(value)) ?? null;
}
export const networkOfCopilot = (id: CopilotNetworkId): NetworkIdentity => ALL.find(n => n.copilot === id)!;
/**
 * BUILD-SOLANA-MAINNET-001: the authoring network of the same family in `environment` (Base ↔ Base Sepolia, Solana ↔ Solana Devnet,
 * Robinhood Chain ↔ Robinhood Chain Testnet), the network itself when it is already there, or null when its family has none.
 */
export function familyCounterpart(value: string | null | undefined, environment: NetworkEnvironment): NetworkIdentity | null {
  const current = networkIdentity(value);
  if (!current) return null;
  return current.environment === environment ? current : NETWORKS.find(n => n.family === current.family && n.environment === environment) ?? null;
}
/** The Copilot networks a message names (each by its registry `mention`), in `COPILOT_NETWORK_IDS` order. */
export const copilotNetworksMentioned = (text: string): CopilotNetworkId[] => COPILOT_NETWORK_IDS.filter(id => networkOfCopilot(id).mention!.test(text));
/** Catalog visibility is independent of runtime capabilities. */
export const CATALOG_NETWORK_IDENTITIES: readonly NetworkIdentity[] = Object.freeze(NETWORKS.filter(n => n.catalog));
/** The catalog network named after "on" in a chat sentence (`on Base`, `on Robinhood Chain`), or null. */
export function catalogNetworkOfChatName(text: string): NetworkIdentity | null {
  return CATALOG_NETWORK_IDENTITIES.find(n => new RegExp(`^(?:${n.chatName!.source})$`, 'i').test(text.trim())) ?? null;
}
/**
 * The catalog networks a message names (by chat name, as a word) or an untrusted intent names (any `network`, `sourceNetwork` or
 * `destinationNetwork` field equal to a Copilot id): the catalogs a surface loads before resolving symbols. Loading grants nothing.
 */
export function catalogNetworksNamed(text: string, intent?: unknown): readonly NetworkIdentity[] {
  const ids = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^(?:network|sourceNetwork|destinationNetwork)$/.test(key)) ids.add(item);
      else walk(item, depth + 1);
    }
  };
  walk(intent, 0);
  return CATALOG_NETWORK_IDENTITIES.filter(n => ids.has(n.copilot!) || new RegExp(`(?<![A-Za-z0-9])(?:${n.chatName!.source})(?![A-Za-z0-9])`, 'i').test(text));
}
/** One regular-expression alternation of every catalog network's chat name, for exact-grammar patterns. */
export const CATALOG_CHAT_NETWORKS = CATALOG_NETWORK_IDENTITIES.map(n => `(?:${n.chatName!.source})`).join('|');
