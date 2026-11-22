// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { defineIntegrationPackage } from '../src/index';

const evm = {
  schemaVersion: 2, kind: 'network', slug: 'example-evm', name: 'Example Network', architecture: 'evm',
  chainRef: 'eip155:987654321', environment: 'mainnet', rpcUrl: 'https://rpc.example.org/',
  checkpoint: { height: '0x0', hash: '0x' + 'a'.repeat(64) }, capabilities: ['transfer.native', 'network.read'],
  dependencies: [], adapter: { kind: 'builtin', id: 'evm-rpc', version: 1 },
};

const move = {
  schemaVersion: 2, kind: 'network', slug: 'example-move', name: 'Example Move', architecture: 'move',
  chainRef: 'move:example', environment: 'mainnet', capabilities: ['network.read'], dependencies: [],
  adapter: { kind: 'external', repository: 'https://github.com/example-org/adapter', commit: 'a'.repeat(40),
    sourceSha256: 'b'.repeat(64), sdkVersion: 1 },
};

describe('Studio integration package SDK', () => {
  it('accepts unregistered CAIP-2 chains and produces an immutable canonical package', () => {
    expect(defineIntegrationPackage(move)).toEqual(move);
    const proposal = defineIntegrationPackage(evm);
    expect(proposal.chainRef).toBe(evm.chainRef);
    expect(proposal.capabilities).toEqual(['network.read', 'transfer.native']);
    expect(proposal.rpcUrl).toBe('https://rpc.example.org/');
    expect(Object.isFrozen(proposal.checkpoint)).toBe(true);
    expect(Object.isFrozen(proposal.capabilities)).toBe(true);
    expect(JSON.stringify(defineIntegrationPackage(JSON.parse(JSON.stringify(proposal))))).toBe(JSON.stringify(proposal));
  });

  it('refuses credentials, URL ambiguity, claimed certification and mismatched adapter capabilities', () => {
    const malformed = [
      ...['http://rpc.example.org/', 'https://user@rpc.example.org/', 'https://rpc.example.org/?key=bad',
        'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://rpc.localhost/',
        'https://rpc.example.org:8443/', 'https://rpc.example.org/%2F', 'https://rpc.example.org/rpc#key']
        .map(rpcUrl => ({ ...evm, rpcUrl })),
      { ...evm, approvedCapabilities: ['transfer.native'] }, { ...evm, capabilities: ['swap'] },
      { ...evm, chainRef: 'cosmos:example-1' }, { ...evm, adapter: move.adapter, checkpoint: evm.checkpoint },
      { ...move, adapter: { ...move.adapter, commit: 'main' } },
      { ...move, adapter: { ...move.adapter, permissions: ['wallet'] } },
      { ...move, adapter: { ...move.adapter, repository: 'https://github.com/example-org/..' } },
    ];
    for (const input of malformed) expect(() => defineIntegrationPackage(input)).toThrow('STUDIO_MANIFEST_INVALID');
  });
});
