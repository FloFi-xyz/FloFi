// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { commandIsValid, parseLocalCommand, parseMockCommand } from './commands';
import { editorReducer, initialEditor } from './editor';
import { BASE_CONTEXT } from './copilot-test-fixtures';
import { batchPaymentDetails } from './batch-payment-authoring';

describe('deterministic mock command grammar', () => {
  it('parses only the approved local edit forms with their captured revision', () => {
    expect(parseMockCommand('add transform', 3)).toEqual({ type: 'ADD', kind: 'transform', source: 'CHAT', baseRevision: 3 });
    expect(parseMockCommand('set node-001 amount 2500000', 4)).toEqual({ type: 'SET_AMOUNT', nodeId: 'node-001', amount: '2500000', source: 'CHAT', baseRevision: 4 });
  });

  it('rejects financial commands, malformed amounts, and forged command fields', () => {
    for (const text of ['swap 1', 'execute', 'add payment', 'set node-001 amount 01', 'set node-001 amount -1']) {
      expect(() => parseMockCommand(text, 0)).toThrow();
    }
    expect(commandIsValid({ type: 'LOCK', nodeId: 'node-001', locked: true, source: 'CHAT', baseRevision: 0 })).toBe(false);
    expect(commandIsValid({ type: 'ADD', kind: 'read', source: 'CHAT', baseRevision: 0, extra: true } as never)).toBe(false);
    const hidden = { type: 'ADD', kind: 'read', source: 'CHAT', baseRevision: 0 };
    Object.defineProperty(hidden, 'runtime', { value: 'EXECUTE', enumerable: false });
    expect(commandIsValid(hidden)).toBe(false);
    const symbolic = { type: 'ADD', kind: 'read', source: 'CHAT', baseRevision: 0, [Symbol('authority')]: true };
    expect(commandIsValid(symbolic)).toBe(false);
    const hostile = new Proxy({ type: 'ADD' }, { getPrototypeOf() { throw new Error('hostile'); } });
    expect(commandIsValid(hostile)).toBe(false);
  });
});

/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: the exact `pay` grammar the product chat, Telegram and WhatsApp share. Every recipient reaches the
 * Batch Payment authoring exactly as typed, so its EIP-55 rule applies on every surface (chat review H1), and two assets are a closed refusal (M2).
 */
describe('the Batch Payment `pay` grammar', () => {
  const OWNER = '0x1111111111111111111111111111111111111111', LOWER = '0x3333333333333333333333333333333333333333';
  // The EIP-55 specification's own example, and the same address with one letter's case changed (a mistyped checksum).
  const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', MISTYPED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
  const pay = (text: string) => parseLocalCommand(text, initialEditor().workflow, BASE_CONTEXT, OWNER);
  const refusal = (text: string) => { try { pay(text); return 'PARSED'; } catch (cause) { return (cause as Error).message; } };
  it('chat review H1: a mixed-case recipient with a wrong checksum is refused; a valid checksum and an all-lowercase address are accepted', () => {
    expect(refusal(`pay 0.001 ETH to ${MISTYPED} and 0.002 ETH to ${LOWER} on Base`)).toBe('BATCH_PAYMENT_RECIPIENT_INVALID');
    expect(refusal(`batch pay 0.001 ETH to ${LOWER}, 0.002 ETH to ${MISTYPED} on Arbitrum One`)).toBe('BATCH_PAYMENT_RECIPIENT_INVALID');
    const command = pay(`pay 0.001 ETH to ${CHECKSUMMED} and 0.002 ETH to ${LOWER} on Base`);
    expect(command).toEqual({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0,
      input: { network: 'Base', asset: 'ETH', payments: [{ recipient: CHECKSUMMED, amount: '0.001' }, { recipient: LOWER, amount: '0.002' }] } });
    expect(commandIsValid(command)).toBe(true);
    // The canonical node holds every recipient lower-cased, in the order written.
    const node = editorReducer(initialEditor(), command, BASE_CONTEXT).workflow.nodes.at(-1)!;
    expect(batchPaymentDetails(node as Parameters<typeof batchPaymentDetails>[0])?.payments).toEqual([{ recipient: CHECKSUMMED.toLowerCase(), amount: '0.001' }, { recipient: LOWER, amount: '0.002' }]);
  });
  it('chat review M2: two assets are refused as one closed code, never left to an interpretation that could split them', () => {
    expect(refusal(`pay 1 USDC to ${CHECKSUMMED} and 0.002 ETH to ${LOWER} on Base`)).toBe('BATCH_PAYMENT_ASSET_MIXED');
    expect(refusal(`batch pay 1 USDC to ${CHECKSUMMED}, 2 USDC to ${LOWER} and 0.1 ETH to 0x4444444444444444444444444444444444444444 on Base`)).toBe('BATCH_PAYMENT_ASSET_MIXED');
  });
  it('keeps every other refusal closed: a repeated recipient, an invalid or too precise amount', () => {
    expect(refusal(`pay 0.001 ETH to ${LOWER} and 0.002 ETH to ${LOWER.toUpperCase().replace('0X', '0x')} on Base`)).toBe('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    expect(refusal(`pay 0 ETH to ${CHECKSUMMED} and 0.002 ETH to ${LOWER} on Base`)).toBe('BATCH_PAYMENT_AMOUNT_INVALID');
    expect(refusal(`pay 1.1234567 USDC to ${CHECKSUMMED} and 2 USDC to ${LOWER} on Base`)).toBe('BATCH_PAYMENT_AMOUNT_TOO_PRECISE');
  });
  it('chat review C3: a pay list on a network Batch Payment does not pay is its own closed refusal, never the generic help', () => {
    const SOL_A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', SOL_B = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    // KAN-20: Solana mainnet is a Batch Payment network now ("… on Solana" is a positive case below); Solana Devnet is still refused.
    for (const text of [`pay 1 SOL to ${SOL_A}, 2 SOL to ${SOL_B} on Solana Devnet`,
      `pay 0.001 ETH to ${CHECKSUMMED} and 0.002 ETH to ${LOWER} on Base Sepolia`, `batch pay 1 USDC to ${CHECKSUMMED} and 2 USDC to ${LOWER} on ethereum sepolia`,
      `pay 0.001 ETH to ${CHECKSUMMED} and 0.002 ETH to ${LOWER} on Arbitrum Sepolia`, `pay 0.001 ETH to ${CHECKSUMMED} and 0.002 ETH to ${LOWER} on Robinhood Chain Testnet`,
      `pay 1 USDC to ${CHECKSUMMED} and 2 USDC to ${LOWER} on Optimism`]) expect(refusal(text), text).toBe('BATCH_PAYMENT_NETWORK_UNSUPPORTED');
  });
  it('chat review C3: a recipient that is not an explicit 0x address is refused inside a pay list, never resolved', () => {
    for (const text of [`pay 1 USDC to my wallet and 2 USDC to ${LOWER} on Base`, `batch pay 1 USDC to ${CHECKSUMMED}, 2 USDC to Alice on Arbitrum One`,
      `pay 0.001 ETH to 0x1234 and 0.002 ETH to ${LOWER} on Ethereum`, `pay 1 USDG to me and 2 USDG to my wallet on Robinhood Chain`])
      expect(refusal(text), text).toBe('BATCH_PAYMENT_RECIPIENT_INVALID');
  });
  it('chat review C3: anything that is not clearly a pay list keeps its earlier outcome', () => {
    // One payment, a network FloFi does not know, or payments not written as "<amount> <asset> to <recipient>" are not a pay list: the generic help.
    for (const text of [`pay 1 USDC to my wallet on Base`, `pay 1 USDC to ${CHECKSUMMED} and 2 USDC to ${LOWER} on Polygon`, `pay ${CHECKSUMMED} 1 USDC and ${LOWER} 2 USDC on Base`,
      // Every recipient holds a full address (with more words around it): not this exact grammar, never called an invalid recipient.
      `pay 1 USDC to ${CHECKSUMMED} on Base and 2 USDC to ${LOWER} on Base`])
      expect(refusal(text), text).toMatch(/^Try /);
    // A single Solana payment stays the Solana transfer grammar ("pay" is one of its verbs).
    expect(pay('pay 0.5 SOL to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU on Solana')).toMatchObject({ type: 'ADD_RH_TRANSFER', input: { network: 'Solana', asset: 'SOL' } });
    // A valid pay list on a Batch Payment network is still ONE Batch Payment.
    expect(pay(`pay 1 USDC to ${CHECKSUMMED} and 2 USDC to ${LOWER} on Arbitrum One`)).toMatchObject({ type: 'ADD_BATCH_PAYMENT', input: { network: 'Arbitrum One', asset: 'USDC' } });
  });
});

/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20, WS02 surfaces 4.1): the exact Solana pay list. Every recipient reaches the authoring exactly as
 * typed (base58 is case-sensitive: never lower-cased, never corrected), one asset (SOL, USDC or USDT), 2..8 payments, mainnet only. A, B and C are
 * seed-derived wallet keys on the Ed25519 curve; A_CASE is a different, also on-curve spelling of A; A_OFF is another spelling that is off the curve.
 */
describe('KAN-20: the Solana Batch Payment pay list', () => {
  const OWNER = '0x1111111111111111111111111111111111111111';
  const A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty', C = '8WcnkMD1aZFGDppfnerV37Fob9W1ij3yHkCL3LWgVKiG';
  const A_CASE = '2CErLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', A_OFF = '2cERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb';
  const pay = (text: string) => parseLocalCommand(text, initialEditor().workflow, BASE_CONTEXT, OWNER);
  const refusal = (text: string) => { try { pay(text); return 'PARSED'; } catch (cause) { return (cause as Error).message; } };
  const batch = (asset: string, payments: readonly (readonly [string, string])[]) => ({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0,
    input: { network: 'Solana', asset, payments: payments.map(([recipient, amount]) => ({ recipient, amount })) } });
  it('the owner\'s acceptance example is ONE Batch Payment: three recipients verbatim, in order, total 0.06 SOL', () => {
    const command = pay(`Send 0.01 SOL to ${A}, 0.02 SOL to ${B} and 0.03 SOL to ${C}`);
    expect(command).toEqual(batch('SOL', [[A, '0.01'], [B, '0.02'], [C, '0.03']]));
    expect(commandIsValid(command)).toBe(true);
    const node = editorReducer(initialEditor(), command, BASE_CONTEXT).workflow.nodes.at(-1)!;
    const details = batchPaymentDetails(node as Parameters<typeof batchPaymentDetails>[0])!;
    expect(details).toMatchObject({ network: 'Solana', asset: 'SOL', total: '0.06', payments: [{ recipient: A, amount: '0.01' }, { recipient: B, amount: '0.02' }, { recipient: C, amount: '0.03' }] });
    expect(details.fields.payments.map(p => p.amount)).toEqual(['10000000', '20000000', '30000000']);
    expect(node.adapterConstraints.adapters.map(a => a.id)).toEqual(['solana.batch-payment']);
  });
  it('accepts the Solana sentences of the surfaces spec (USDC, Portuguese, "on Solana", case variants as two keys)', () => {
    expect(pay(`pay 1 USDC to ${A} and 2 USDC to ${B} on Solana`)).toEqual(batch('USDC', [[A, '1'], [B, '2']]));
    expect(pay(`envie 0.5 SOL para ${A} e 0.25 SOL para ${B} na Solana`)).toEqual(batch('SOL', [[A, '0.5'], [B, '0.25']]));
    expect(pay(`batch pay 1 SOL to ${A} and 2 SOL to ${B} on Solana`)).toEqual(batch('SOL', [[A, '1'], [B, '2']]));
    // Two spellings that differ only in letter case are two different wallets (both on the curve): never merged.
    expect(pay(`pay 1 SOL to ${A} and 2 SOL to ${A_CASE}`)).toEqual(batch('SOL', [[A, '1'], [A_CASE, '2']]));
    // A single Solana send keeps its own grammar.
    expect(pay(`send 0.5 SOL to ${A}`)).toMatchObject({ type: 'ADD_RH_TRANSFER', input: { network: 'Solana', asset: 'SOL', amount: '0.5', recipient: A } });
  });
  it('refuses every other Solana pay list with its own closed code, never rounding, correcting or resolving anything', () => {
    for (const [text, code] of [
      [`pay 1 SOL to ${A} and 2 USDC to ${B}`, 'BATCH_PAYMENT_ASSET_MIXED'],
      [`pay 1 SOL to ${A} and 2 SOL to ${A}`, 'BATCH_PAYMENT_DUPLICATE_RECIPIENT'],
      [`pay 1 SOL to ${A_OFF} and 2 SOL to ${B}`, 'BATCH_PAYMENT_SOLANA_RECIPIENT_INVALID'],
      [`pay 1 SOL to TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA and 2 SOL to ${B}`, 'BATCH_PAYMENT_SOLANA_RECIPIENT_RESERVED'],
      [`pay 1 USDC to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v and 2 USDC to ${B}`, 'BATCH_PAYMENT_SOLANA_RECIPIENT_RESERVED'],
      [`pay 1.0000001 USDC to ${A} and 2 USDC to ${B} on Solana`, 'BATCH_PAYMENT_AMOUNT_TOO_PRECISE'],
      [`pay 1 SOL to ${A}, 2 SOL to ${B} on Solana Devnet`, 'BATCH_PAYMENT_NETWORK_UNSUPPORTED'],
      [`pay 1 SOL to my wallet and 2 SOL to ${B} on Solana`, 'BATCH_PAYMENT_SOLANA_RECIPIENT_INVALID'],
      // A mistyped letter that is not base58 (`l`) is refused, never corrected to a nearby key.
      [`pay 1 SOL to ${A.slice(0, -1)}l and 2 SOL to ${B}`, 'BATCH_PAYMENT_SOLANA_RECIPIENT_INVALID'],
      // 0x addresses are not Solana addresses.
      [`pay 1 USDC to 0x${'a1'.repeat(20)} and 2 USDC to 0x${'b2'.repeat(20)} on Solana`, 'BATCH_PAYMENT_SOLANA_RECIPIENT_INVALID'],
      // Only SOL, USDC and USDT of the verified registry: never another token, never a mint.
      [`pay 1 BONK to ${A} and 2 BONK to ${B} on Solana`, 'BATCH_PAYMENT_ASSET_UNSUPPORTED'],
      [`pay ${Array.from({ length: 9 }, (_, i) => `${i + 1} SOL to ${[A, B, C, A_CASE][i % 4]}`).join(', ')}`, 'BATCH_PAYMENT_TOO_MANY_RECIPIENTS'],
    ] as const) expect(refusal(text), text).toBe(code);
  });
  it('placeholders are never an address: "wallet A" is not this grammar (the Copilot asks for each address), and EVM pay lists are unchanged', () => {
    expect(refusal('Send 0.01 SOL to wallet A, 0.02 SOL to wallet B and 0.03 SOL to wallet C')).toMatch(/^Try /);
    const LOWER = '0x3333333333333333333333333333333333333333', OTHER = '0x4444444444444444444444444444444444444444';
    expect(pay(`pay 1 USDC to ${LOWER} and 2 USDC to ${OTHER} on Base`)).toEqual({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0,
      input: { network: 'Base', asset: 'USDC', payments: [{ recipient: LOWER, amount: '1' }, { recipient: OTHER, amount: '2' }] } });
  });
});
