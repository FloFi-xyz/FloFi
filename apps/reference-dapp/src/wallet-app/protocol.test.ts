// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001: transaction requests may carry their FloFi run binding (`signing`), parsed strictly with the shared
// contract; requests without one still parse exactly as before (FloFi Wallet itself refuses to sign them).
import { describe, expect, it } from 'vitest';
import { parseSigningBinding, parseWalletRequest, signingHeader, WALLET_PROTOCOL } from './protocol';

const EVM = '0x' + 'a'.repeat(40), SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const tx = { from: EVM, to: '0x' + 'b'.repeat(40), value: '0x0', data: '0x', chainId: '0x2105', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x1' };
const signing = { flow: 'base-swap', runId: `bas-${'c'.repeat(24)}` };
const request = (operation: Record<string, unknown>) => parseWalletRequest({ protocol: WALLET_PROTOCOL, type: 'request', id: 'req_12345678', request: operation });

describe('run binding on transaction requests', () => {
  it('parses an EVM or Solana transaction request with its binding', () => {
    expect(request({ op: 'evm_sign_transaction', address: EVM, tx, signing })?.request).toEqual({ op: 'evm_sign_transaction', address: EVM, tx, signing });
    expect(request({ op: 'solana_sign_transaction', address: SOL, chain: 'solana:mainnet', transaction: 'AQID', signing: { flow: 'jupiter-swap', runId: `jupiter-${'d'.repeat(32)}` } })?.request)
      .toMatchObject({ op: 'solana_sign_transaction', signing: { flow: 'jupiter-swap' } });
  });
  it('keeps requests without a binding exactly as before', () => {
    expect(request({ op: 'evm_sign_transaction', address: EVM, tx })?.request).toEqual({ op: 'evm_sign_transaction', address: EVM, tx });
    expect(request({ op: 'solana_sign_transaction', address: SOL, chain: 'solana:mainnet', transaction: 'AQID' })?.request).not.toHaveProperty('signing');
    // Solana mainnet only: a Devnet or Testnet request is not a FloFi Wallet request at all.
    for (const chain of ['solana:devnet', 'solana:testnet']) expect(request({ op: 'solana_sign_transaction', address: SOL, chain, transaction: 'AQID' })).toBeNull();
  });
  it('refuses a malformed binding, extra keys, and a binding on operations that take none', () => {
    for (const bad of [{ flow: 'base-swap' }, { flow: 'Base-Swap', runId: signing.runId }, { flow: 'base-swap', runId: 'run:1' }, { ...signing, extra: 1 }, 'base-swap:bas-1', null])
      expect(request({ op: 'evm_sign_transaction', address: EVM, tx, signing: bad })).toBeNull();
    expect(request({ op: 'evm_sign_transaction', address: EVM, tx, signing, extra: true })).toBeNull();
    expect(request({ op: 'evm_sign_message', address: EVM, message: 'hello', signing })).toBeNull();
    expect(request({ op: 'connect', signing })).toBeNull();
  });
  it('shares the binding parser and relay header with the product side', () => {
    expect(parseSigningBinding(signing)).toEqual(signing);
    expect(signingHeader(signing)).toBe(`base-swap:bas-${'c'.repeat(24)}`);
  });
});

describe('typed-data requests (BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003)', () => {
  const typedData = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Permit: [{ name: 'value', type: 'uint256' }],
    SlippageAndActions: [{ name: 'actions', type: 'bytes[]' }] }, domain: { name: 'Permit2', chainId: 4663 }, primaryType: 'Permit', message: { value: '1' } };
  const bound = { flow: 'robinhood-swap', runId: `rhs-${'c'.repeat(24)}` };
  it('parses an eth_signTypedData_v4 payload with its run binding, lower-casing the address', () => {
    expect(request({ op: 'evm_sign_typed_data', address: EVM.toUpperCase().replace('0X', '0x'), typedData, signing: bound })?.request)
      .toEqual({ op: 'evm_sign_typed_data', address: EVM, typedData, signing: bound });
  });
  it('refuses a payload that is not strictly typed data', () => {
    for (const bad of [{ ...typedData, extra: 1 }, { ...typedData, types: { Permit: typedData.types.Permit } }, { ...typedData, primaryType: 'Missing' },
      { ...typedData, domain: { ...typedData.domain, other: 'x' } }, { ...typedData, types: { ...typedData.types, Permit: [{ name: 'value', type: 'uint256', extra: 1 }] } },
      { ...typedData, types: { ...typedData.types, Permit: [{ name: 'value', type: 'uint 256' }] } }, { ...typedData, message: { value: 'x'.repeat(70_000) } }])
      expect(request({ op: 'evm_sign_typed_data', address: EVM, typedData: bad, signing: bound })).toBeNull();
    expect(request({ op: 'evm_sign_typed_data', address: EVM, typedData, signing: bound, extra: 1 })).toBeNull();
  });
});
