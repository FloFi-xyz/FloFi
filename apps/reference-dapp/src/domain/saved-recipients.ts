// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: Saved Recipients — an account's address book of PUBLIC destination addresses ("Minha Solana", "Carteira da
 * empresa"), shared by the Credentials screen and the web Copilot. Chat channels and MCP do not read it (no verified account link there).
 *
 * A saved recipient is a name for a public address and nothing else. It is NOT a private key, a seed phrase, a signing credential, a delegation,
 * an authorization to move funds or proof that the account controls that address: a label never makes an address "your wallet". Its
 * ownership status is derived at read time from verified account wallets (`recipientStatus`), never stored or claimed from the label.
 *
 * Resolution is deterministic and conservative: only an exact (case- and accent-insensitive) label written by the user selects a recipient;
 * a partial name or several matches is a question, never a guess; there is no typo tolerance for a destination. The address is re-checked for
 * the destination network at every use (`checkRecipient` for transfers, `checkDestinationAddress` for bridges), shown in full at Review, and
 * never substituted after Review. Labels (and partial names) are masked in every transcript entry before a request leaves for the model
 * (`maskSavedRecipients`), so neither the label nor the address of a saved recipient is sent to a model provider. A label cannot be a network,
 * asset or "my wallet" phrase (`reservedRecipientLabel`): such a word keeps its meaning in a request.
 */
import { isSolanaPublicKey } from '@defi-workflow-engine/workflow-contracts';
import { RECIPIENT_FORMATS } from './recipient-address';
import { credentialLabel } from './credentials';
import { COPILOT_NETWORK_IDS, networkOfCopilot } from './network-registry';
import { LEXICON_ASSETS } from './copilot-lexicon';

export const SAVED_RECIPIENT_ECOSYSTEMS = ['EVM', 'SOLANA'] as const;
export type SavedRecipientEcosystem = (typeof SAVED_RECIPIENT_ECOSYSTEMS)[number];
export const SAVED_RECIPIENT_LIMITS = Object.freeze({ maxPerAccount: 100, labelMax: 40 });
export const SAVED_RECIPIENT_ID = /^rcp_[a-z2-7]{26}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVM_ZERO = '0x0000000000000000000000000000000000000000';
const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';

export type SavedRecipient = { readonly id: string; readonly label: string; readonly address: string; readonly ecosystem: SavedRecipientEcosystem;
  readonly createdAt: string; readonly updatedAt: string };
/**
 * What FloFi can say about who controls the address, derived at read time: ACCOUNT_WALLET when the address is one of the account's verified
 * wallets, CONNECTED when it is a wallet connected in this session, EXTERNAL otherwise (the default: a label is not proof).
 */
export type SavedRecipientStatus = 'EXTERNAL' | 'ACCOUNT_WALLET' | 'CONNECTED';
export type SavedRecipientView = SavedRecipient & { readonly status: SavedRecipientStatus };

/** The ecosystem an address is shaped for (EVM 0x…, or Solana base58 of exactly 32 bytes), or null. */
export function ecosystemOfAddress(value: string): SavedRecipientEcosystem | null {
  const text = value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return 'EVM';
  return isSolanaPublicKey(text) ? 'SOLANA' : null;
}
/**
 * The canonical stored address: EVM lower case after an EIP-55 check of mixed-case input (a mistyped letter fails), never the zero address;
 * Solana exactly as typed (base58 is case-sensitive), a 32-byte on-curve wallet key, never the System Program. Null when not valid.
 */
export function savedRecipientAddress(ecosystem: SavedRecipientEcosystem, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (ecosystem === 'EVM') { const address = RECIPIENT_FORMATS.eip155!.normalize(text); return address && address !== EVM_ZERO ? address : null; }
  const address = RECIPIENT_FORMATS.solana!.normalize(text);
  return address && address !== SOLANA_SYSTEM_PROGRAM ? address : null;
}
/** A label shaped like key material or an address (long hex or base58 runs) is refused, so a label can never carry an address or a secret. */
export const keyShapedLabel = (value: string): boolean => /[0-9a-fA-F]{20,}/.test(value) || /[1-9A-HJ-NP-Za-km-z]{24,}/.test(value);
/** The comparison key of a label (case, every combining mark, punctuation and spacing folded): two labels with one key are the same name. */
export const recipientLabelKey = (label: string): string =>
  label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * Names that already mean something in a request and so can never be a saved name: a network (and its aliases), an asset or coin name, or a
 * phrase meaning the user's own wallet. "Solana" as a saved name would otherwise turn "bridge to Solana" into a send to that address.
 */
const RESERVED_LABELS: ReadonlySet<string> = (() => {
  const out = new Set<string>(['me', 'mim', 'eu', 'myself', 'mim mesmo', 'mim mesma', 'my wallet', 'my own wallet', 'my connected wallet', 'minha carteira',
    'minha propria carteira', 'a minha carteira', 'carteira conectada', 'connected wallet', 'ether', 'ethereum', 'solana', 'bitcoin', 'tether', 'usd coin',
    'usdc e', 'arb', 'arbitrum']);
  for (const asset of LEXICON_ASSETS) out.add(asset.toLowerCase());
  for (const id of COPILOT_NETWORK_IDS) {
    const network = networkOfCopilot(id);
    for (const name of [network.name, ...network.aliases]) out.add(recipientLabelKey(name));
  }
  return out;
})();
export const reservedRecipientLabel = (label: string): boolean => RESERVED_LABELS.has(recipientLabelKey(label));
/** A writable label: Credentials' printable single-line rule (≤ 40, no card number), never key-shaped or reserved. Null when not usable. */
export function savedRecipientLabel(value: unknown): string | null {
  const label = credentialLabel(value);
  return label && !keyShapedLabel(label) && !reservedRecipientLabel(label) ? label : null;
}

const KEYS = ['id', 'label', 'address', 'ecosystem', 'createdAt', 'updatedAt'] as const;
/** Strict reader: an entry with any extra or missing field, an invalid address or label is dropped, never repaired. */
export function readSavedRecipient(value: unknown): SavedRecipient | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, own = Object.keys(v);
  if (own.length !== KEYS.length || !KEYS.every(key => own.includes(key))) return null;
  if (typeof v.id !== 'string' || !SAVED_RECIPIENT_ID.test(v.id)) return null;
  if (v.ecosystem !== 'EVM' && v.ecosystem !== 'SOLANA') return null;
  if (savedRecipientAddress(v.ecosystem, v.address) !== v.address || savedRecipientLabel(v.label) !== v.label) return null;
  if (typeof v.createdAt !== 'string' || !TIMESTAMP.test(v.createdAt) || typeof v.updatedAt !== 'string' || !TIMESTAMP.test(v.updatedAt)) return null;
  return { id: v.id, label: v.label as string, address: v.address as string, ecosystem: v.ecosystem, createdAt: v.createdAt, updatedAt: v.updatedAt };
}
/** A bounded, strictly read list (duplicates by id, address or label key keep the first). */
export function readSavedRecipients(value: unknown): SavedRecipient[] {
  if (!Array.isArray(value)) return [];
  const out: SavedRecipient[] = [];
  for (const item of value.slice(0, SAVED_RECIPIENT_LIMITS.maxPerAccount)) {
    const recipient = readSavedRecipient(item);
    if (recipient && !out.some(other => other.id === recipient.id || (other.ecosystem === recipient.ecosystem && other.address === recipient.address)
      || recipientLabelKey(other.label) === recipientLabelKey(recipient.label))) out.push(recipient);
  }
  return out;
}
/** Derived status (never stored): a verified account wallet, a wallet connected now, or an external address. */
export function recipientStatus(recipient: Pick<SavedRecipient, 'address' | 'ecosystem'>, verified: { readonly account: readonly string[]; readonly connected: readonly string[] }): SavedRecipientStatus {
  const same = (other: string) => recipient.ecosystem === 'EVM' ? other.toLowerCase() === recipient.address : other === recipient.address;
  return verified.account.some(same) ? 'ACCOUNT_WALLET' : verified.connected.some(same) ? 'CONNECTED' : 'EXTERNAL';
}

// ── Resolution in a message ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type RecipientMention = { readonly kind: 'NONE' } | { readonly kind: 'ONE'; readonly recipient: SavedRecipient }
  /** Several saved names match, or only part of a name was written: the user chooses (one candidate is confirmed, never assumed). */
  | { readonly kind: 'CHOOSE'; readonly candidates: readonly SavedRecipient[] };
const folded = (text: string) => ` ${recipientLabelKey(text)} `;
/** Saved recipients named in `text`: exact label phrases first (longest wins, overlapping shorter ones are dropped); else a partial name. */
export function matchSavedRecipients(text: string, recipients: readonly SavedRecipient[]): RecipientMention {
  if (!recipients.length || !text.trim()) return { kind: 'NONE' };
  const haystack = folded(text);
  // Every place each label is written, as spans of the folded message; a shorter name counts only where it is not part of a longer one
  // ("Carteira" inside "Carteira da Ana"), so "pra Ana, não pra Mariana" names both and is a question.
  const spans = (key: string): (readonly [number, number])[] => {
    const out: (readonly [number, number])[] = [];
    for (let at = haystack.indexOf(` ${key} `); at >= 0; at = haystack.indexOf(` ${key} `, at + 1)) out.push([at + 1, at + 1 + key.length]);
    return out;
  };
  const exact = recipients.map(recipient => { const key = recipientLabelKey(recipient.label); return { recipient, key, spans: key ? spans(key) : [] }; })
    .filter(entry => entry.spans.length).sort((a, b) => b.key.length - a.key.length);
  const kept: typeof exact = [];
  for (const entry of exact)
    if (entry.spans.some(([start, end]) => !kept.some(other => other.spans.some(([from, to]) => from <= start && end <= to)))) kept.push(entry);
  if (kept.length === 1) return { kind: 'ONE', recipient: kept[0]!.recipient };
  if (kept.length > 1) return { kind: 'CHOOSE', candidates: kept.map(entry => entry.recipient) };
  // A partial name ("carteira da empresa" for "Carteira da empresa Solana"): at least two words of a label, in order, from its start.
  const partial = recipients.filter(recipient => partialNames(recipient.label).some(name => haystack.includes(` ${name} `)));
  return partial.length ? { kind: 'CHOOSE', candidates: partial } : { kind: 'NONE' };
}
/** The leading word groups of a label of three or more words that count as writing it partially (two words up to all but one). */
function partialNames(label: string): readonly string[] {
  const words = recipientLabelKey(label).split(' ').filter(Boolean);
  return words.length > 2 ? Array.from({ length: words.length - 2 }, (_, index) => words.slice(0, index + 2).join(' ')) : [];
}
/** What leaves for a model provider: every saved label (and a saved address written in full) replaced by a neutral marker. */
export const SAVED_RECIPIENT_MARKER = '[saved recipient]';
export function maskSavedRecipients(text: string, recipients: readonly SavedRecipient[]): string {
  if (!recipients.length) return text;
  // Matched on the decomposed text so any accent or mark folds as the label key does ("Łódź", "Šimon", "São"); recomposed afterwards.
  let out = text.normalize('NFD');
  const phrases = recipients.flatMap(recipient => [recipientLabelKey(recipient.label), ...partialNames(recipient.label)]).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const letters = (word: string) => [...word].map(char => `${char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{M}*`).join('');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${phrase.split(' ').map(letters).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(pattern, SAVED_RECIPIENT_MARKER);
  }
  for (const recipient of recipients)
    out = recipient.ecosystem === 'SOLANA' ? out.split(recipient.address).join(SAVED_RECIPIENT_MARKER) : out.replace(new RegExp(recipient.address, 'gi'), SAVED_RECIPIENT_MARKER);
  return out.normalize('NFC');
}
/** A short, display-only form of a saved recipient for lists and chips: label, ecosystem and the first/last characters of the address. */
export const recipientChip = (recipient: SavedRecipient): string => `${recipient.label} · ${recipient.ecosystem === 'EVM' ? 'EVM' : 'Solana'} · ${recipient.address.slice(0, 6)}…${recipient.address.slice(-4)}`;
