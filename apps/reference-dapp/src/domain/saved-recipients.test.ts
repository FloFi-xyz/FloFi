// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIFIED-COPILOT-001: the Saved Recipients contract (public addresses only; exact names; never proof of ownership). */
import { describe, expect, it } from 'vitest';
import { ecosystemOfAddress, maskSavedRecipients, matchSavedRecipients, readSavedRecipient, readSavedRecipients, recipientLabelKey, recipientStatus,
  savedRecipientAddress, savedRecipientLabel, SAVED_RECIPIENT_MARKER, type SavedRecipient } from './saved-recipients';

const EVM = '0x52908400098527886e0f7030069857d2e4169ee7';
const EVM_CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq', SOL_2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const at = '2026-11-15T12:00:00.000Z';
const rcp = (id: string, label: string, address: string, ecosystem: 'EVM' | 'SOLANA'): SavedRecipient =>
  ({ id: `rcp_${id.padEnd(26, 'a')}`, label, address, ecosystem, createdAt: at, updatedAt: at });

describe('saved recipient addresses and labels', () => {
  it('validates EVM (EIP-55 when mixed case) and Solana (case-sensitive, 32-byte wallet key) and rejects the wrong ecosystem', () => {
    expect(savedRecipientAddress('EVM', EVM_CHECKSUM)).toBe(EVM);
    expect(savedRecipientAddress('EVM', EVM)).toBe(EVM);
    expect(savedRecipientAddress('EVM', '0x52908400098527886E0F7030069857D2E4169Ee7')).toBeNull();
    expect(savedRecipientAddress('EVM', '0x0000000000000000000000000000000000000000')).toBeNull();
    expect(savedRecipientAddress('EVM', SOL)).toBeNull();
    expect(savedRecipientAddress('SOLANA', SOL)).toBe(SOL);
    expect(savedRecipientAddress('SOLANA', SOL.toLowerCase())).toBeNull();
    expect(savedRecipientAddress('SOLANA', EVM)).toBeNull();
    expect(savedRecipientAddress('SOLANA', '11111111111111111111111111111111')).toBeNull();
    expect(ecosystemOfAddress(` ${EVM_CHECKSUM} `)).toBe('EVM');
    expect(ecosystemOfAddress(SOL)).toBe('SOLANA');
    expect(ecosystemOfAddress('minha solana')).toBeNull();
  });
  it('accepts friendly names and refuses names that carry an address, a key or a card number', () => {
    expect(savedRecipientLabel('  Minha   Solana ')).toBe('Minha Solana');
    expect(savedRecipientLabel('Carteira da empresa')).toBe('Carteira da empresa');
    expect(savedRecipientLabel(`Wallet ${SOL}`)).toBeNull();
    expect(savedRecipientLabel('0x52908400098527886e0f7030069857d2e41')).toBeNull();
    expect(savedRecipientLabel('4111 1111 1111 1111')).toBeNull();
    expect(savedRecipientLabel('x'.repeat(41))).toBeNull();
    expect(recipientLabelKey('Família  Silva!')).toBe('familia silva');
  });
  it('reads stored records strictly: extra fields (a key, a seed) or invalid values drop the record', () => {
    const good = rcp('one', 'Minha Solana', SOL, 'SOLANA');
    expect(readSavedRecipient(good)).toEqual(good);
    expect(readSavedRecipient({ ...good, privateKey: 'x' })).toBeNull();
    expect(readSavedRecipient({ ...good, address: EVM })).toBeNull();
    expect(readSavedRecipients([good, { ...good, id: rcp('two', 'Outra', SOL, 'SOLANA').id }, rcp('three', 'minha solana', EVM, 'EVM')])).toEqual([good]);
  });
  it('derives ownership from verified wallets only, never from the label', () => {
    const mine = rcp('one', 'Minha MetaMask', EVM, 'EVM');
    expect(recipientStatus(mine, { account: [], connected: [] })).toBe('EXTERNAL');
    expect(recipientStatus(mine, { account: [EVM_CHECKSUM], connected: [] })).toBe('ACCOUNT_WALLET');
    expect(recipientStatus(mine, { account: [], connected: [EVM] })).toBe('CONNECTED');
    expect(recipientStatus(rcp('two', 'Minha Solana', SOL, 'SOLANA'), { account: [SOL.toLowerCase()], connected: [] })).toBe('EXTERNAL');
  });
});

describe('saved recipient names in a message', () => {
  const list = [rcp('a', 'Minha Solana', SOL, 'SOLANA'), rcp('b', 'Carteira da empresa', EVM, 'EVM'), rcp('c', 'Família', '0x1111111111111111111111111111111111111111', 'EVM')];
  it('selects only an exact name (case and accents ignored), the longest one when names overlap', () => {
    expect(matchSavedRecipients('Envia 10 USDC para Minha Solana', list)).toEqual({ kind: 'ONE', recipient: list[0] });
    expect(matchSavedRecipients('manda para a familia', list)).toEqual({ kind: 'ONE', recipient: list[2] });
    expect(matchSavedRecipients('usa a carteira da empresa', list)).toEqual({ kind: 'ONE', recipient: list[1] });
    expect(matchSavedRecipients('manda para minha solanaa', list)).toEqual({ kind: 'NONE' });
    expect(matchSavedRecipients('swap 1 ETH to USDC', list)).toEqual({ kind: 'NONE' });
  });
  it('asks instead of guessing when several names or only part of a name match', () => {
    const two = [...list, rcp('d', 'Carteira da empresa Solana', SOL_2, 'SOLANA')];
    expect(matchSavedRecipients('manda para Minha Solana e para Família', list)).toMatchObject({ kind: 'CHOOSE', candidates: [list[0], list[2]] });
    const sole = [rcp('e', 'Carteira da empresa Solana', SOL, 'SOLANA')];
    expect(matchSavedRecipients('usa a carteira da empresa', sole)).toEqual({ kind: 'CHOOSE', candidates: sole });
    expect(matchSavedRecipients('usa a carteira da empresa solana', two)).toEqual({ kind: 'ONE', recipient: two[3] });
  });
  it('masks every saved name and saved address before a request leaves for a model', () => {
    expect(maskSavedRecipients('Manda 5 USDC para minha solana, e depois pra FAMÍLIA', list)).toBe(`Manda 5 USDC para ${SAVED_RECIPIENT_MARKER}, e depois pra ${SAVED_RECIPIENT_MARKER}`);
    expect(maskSavedRecipients(`envia para ${SOL}`, list)).toBe(`envia para ${SAVED_RECIPIENT_MARKER}`);
    expect(maskSavedRecipients(`send to ${EVM_CHECKSUM}`, list)).toBe(`send to ${SAVED_RECIPIENT_MARKER}`);
    expect(maskSavedRecipients('Swap 1 ETH to USDC on Base', list)).toBe('Swap 1 ETH to USDC on Base');
  });
});

describe('review regressions (flofi-security, flofi-chat)', () => {
  it('a shorter name written on its own still counts beside a longer one ("pra Ana, não pra Mariana" is a question)', () => {
    const ana = rcp('a', 'Ana', EVM, 'EVM'), mariana = rcp('b', 'Mariana', SOL, 'SOLANA');
    expect(matchSavedRecipients('manda 10 USDC pra Ana, não pra Mariana', [ana, mariana])).toMatchObject({ kind: 'CHOOSE' });
    // Inside a longer name only, the shorter one is not a second mention.
    const carteira = rcp('c', 'Carteira', EVM, 'EVM'), daAna = rcp('d', 'Carteira da Ana', SOL, 'SOLANA');
    expect(matchSavedRecipients('envia para carteira da ana', [carteira, daAna])).toEqual({ kind: 'ONE', recipient: daAna });
  });
  it('masks names with any accent or mark the key folds (Łódź, Šimon, São), and partial names', () => {
    expect(maskSavedRecipients('para Łódź agora', [rcp('a', 'Łódź', EVM, 'EVM')])).toBe(`para ${SAVED_RECIPIENT_MARKER} agora`);
    expect(maskSavedRecipients('to ŠIMON please', [rcp('a', 'Šimon', EVM, 'EVM')])).toBe(`to ${SAVED_RECIPIENT_MARKER} please`);
    expect(maskSavedRecipients('manda pra carteira da empresa', [rcp('a', 'Carteira da empresa Solana', SOL, 'SOLANA')])).toBe(`manda pra ${SAVED_RECIPIENT_MARKER}`);
    // Text without a saved name is unchanged, accents included.
    expect(maskSavedRecipients('Não sei, você decide', [rcp('a', 'Ana', EVM, 'EVM')])).toBe('Não sei, você decide');
  });
  it('refuses names that already mean a network, a token or the user\'s own wallet', () => {
    for (const name of ['Solana', 'Base', 'arbitrum one', 'ETH', 'usdc', 'Ethereum', 'minha carteira', 'My wallet', 'mim']) expect(savedRecipientLabel(name), name).toBeNull();
    for (const name of ['Carteira da empresa Solana', 'Mãe', 'Base da Ana', 'Exchange']) expect(savedRecipientLabel(name), name).toBe(name);
  });
  it('round 2: stored rows whose name later became reserved stay listed and masked, but never resolve; a pasted saved address resolves', () => {
    const legacy = { ...rcp('a', 'Sonic', EVM, 'EVM'), label: 'Solana' };
    expect(readSavedRecipient(legacy)).toEqual(legacy);
    expect(matchSavedRecipients('manda para Solana', [legacy])).toEqual({ kind: 'NONE' });
    expect(maskSavedRecipients('manda para Solana', [legacy])).toBe(`manda para ${SAVED_RECIPIENT_MARKER}`);
    const ana = rcp('b', 'Ana', EVM, 'EVM');
    expect(matchSavedRecipients(`envia para ${EVM_CHECKSUM}`, [ana])).toEqual({ kind: 'ONE', recipient: ana });
    // "Arbitrum One Ana": its leading words "arbitrum one" are a network and never count as writing the name partially.
    const named = rcp('c', 'Arbitrum One Ana', SOL, 'SOLANA');
    expect(matchSavedRecipients('bridge to Arbitrum One', [named])).toEqual({ kind: 'NONE' });
    expect(maskSavedRecipients('bridge to Arbitrum One', [named])).toBe('bridge to Arbitrum One');
  });
  it('round 2: the mask cannot backtrack exponentially on a crafted label and mark-stuffed text', () => {
    // Letters separated only by combining marks, ending in a letter so the match fails at the end: the old separator ([^\p{L}\p{N}]+, which
    // also matches marks) split each gap several ways and took seconds at 12 words and effectively forever at 20.
    const label = 'a b c d e f g h i j k l m n o p q r s t';
    const text = label.split(' ').slice(0, -1).map(letter => `${letter}\u0301\u0302\u0303\u0304`).join('') + 'tx';
    const started = performance.now();
    maskSavedRecipients(text, [rcp('a', label, EVM, 'EVM')]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
