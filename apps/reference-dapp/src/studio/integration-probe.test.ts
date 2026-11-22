// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { base58Encode, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { executionCapabilityRegistry } from '@defi-workflow-engine/action-registry';
import type { pinnedHttpsRequest } from '../platform/pinned-https.ts';
import { HYPEREVM, SAVINGS_DAI, parseStudioIntegration } from './integration-manifest.ts';
import { probeStudioIntegration, supportsStudioProbe } from './integration-probe.ts';

const network = { schemaVersion: 1, slug: 'hyperevm', name: 'HyperEVM', kind: 'network', chainRef: HYPEREVM.chainRef } as const;
const vault = { schemaVersion: 1, slug: 'savings-dai', name: 'Savings Dai', kind: 'vault', standard: 'ERC-4626', ...SAVINGS_DAI } as const;
const now = new Date('2026-11-22T20:00:00Z');
const timestamp = '0x' + (now.getTime() / 1_000).toString(16);
const checkpointHash = '0xde151843548b88d06f201d86e860e45fbf07d49612f1934fba5746abd942fb01';
const genesisHash = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3';
const hash = '0x' + 'a'.repeat(64);
const block = { number: '0x100', hash, timestamp, baseFeePerGas: '0x10' };
const abiWord = (value: string) => '0x' + value.padStart(64, '0');
type Request = { id: number; method: string; params: unknown[] };

function answer(request: Request, isVault: boolean): unknown {
  const { method, params } = request;
  if (method === 'eth_chainId') return isVault ? '0x1' : '0x3e7';
  if (method === 'eth_getBlockByNumber') {
    if (params[0] === (isVault ? '0x0' : '0x1')) return { number: params[0], hash: isVault ? genesisHash : checkpointHash, timestamp: '0x0' };
    return block;
  }
  if (method === 'eth_estimateGas') return '0x5208';
  if (method === 'eth_gasPrice') return '0x10';
  if (method === 'eth_getBalance' || method === 'eth_getTransactionCount') return '0x0';
  if (method === 'eth_getCode') return '0x6000';
  if (method === 'eth_call') {
    const { data } = params[0] as { data: string };
    if (data === erc7710.selectorOf('asset()')) return abiWord(SAVINGS_DAI.underlyingAsset.slice(2));
    if (data === erc7710.selectorOf('decimals()')) return abiWord('12');
    return abiWord('1');
  }
  throw new Error('unrecognized method');
}

function mockRpc(resolve: (request: Request) => unknown) {
  const read: typeof pinnedHttpsRequest = async input => {
    const req = JSON.parse(input.body!) as Request;
    const payload = { jsonrpc: '2.0', id: req.id, result: resolve(req) };
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)) };
  };
  return vi.fn(read);
}

function fixture(isVault = false, override?: (request: Request, result: unknown) => unknown) {
  return mockRpc(request => {
    const result = answer(request, isVault);
    return override ? override(request, result) : result;
  });
}

describe('closed Studio manifests and read-only mainnet probes', () => {
  it('rejects request-controlled targets, unknown fields, invalid addresses and exchange credentials', () => {
    for (const input of [null, [], { ...network, rpcUrl: 'https://untrusted.test/' }, { ...network, walletAuthorization: true },
      { ...network, headers: {} }, { ...vault, contractAddress: '0x' + '0'.repeat(40) },
      { ...vault, underlyingAsset: '0x6b175474E89094c44da98b954eedeac495271d0f' },
      { ...network, kind: 'cex', provider: 'Exchange', withdrawals: true, access: 'user-scoped' },
      { schemaVersion: 1, slug: 'exchange', name: 'Exchange', kind: 'cex', provider: 'Exchange', withdrawals: false,
        access: 'user-scoped', credentials: {} }]) {
      expect(() => parseStudioIntegration(input)).toThrow('STUDIO_MANIFEST_INVALID');
    }
    expect(parseStudioIntegration({ ...vault, underlyingAsset: '0x' + vault.underlyingAsset.slice(2).toUpperCase() })).toEqual(vault);
  });

  it('reuses the canonical adapter registry and bounds the HyperEVM test to wallet reads and a zero-value estimate', async () => {
    const transport = fixture();
    const result = await probeStudioIntegration(network, 'test', now, transport);
    expect(result).toMatchObject({ chainRef: 'eip155:999', checkpointHash, block: { hash }, facts: {
      nativeSymbol: 'HYPE', valueZeroGasUnits: '21000', canonicalNativeTransferProfile: false, walletAcceptance: 'REQUIRED',
    } });
    expect(executionCapabilityRegistry.some(profile => profile.chainId === network.chainRef && profile.environment === 'MAINNET'
      && profile.capabilities.EXECUTE)).toBe(false);
    for (const [input] of transport.mock.calls) {
      expect(input.url.href).toBe(HYPEREVM.rpcUrl);
      expect(input.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json' });
    }
    expect(transport.mock.calls.map(([input]) => JSON.parse(input.body!).method)).toEqual([
      'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getTransactionCount',
      'eth_gasPrice', 'eth_estimateGas', 'eth_getBlockByNumber',
    ]);
    expect(JSON.parse(transport.mock.calls[6]![0].body!).params[0]).toMatchObject({ value: '0x0', data: '0x' });
  });

  it('rejects unknown mainnets before transport, and rejects malformed or divergent network results', async () => {
    const transport = fixture();
    await expect(probeStudioIntegration({ ...network, chainRef: 'eip155:998' }, 'verify', now, transport)).rejects.toThrow('STUDIO_NETWORK_UNSUPPORTED');
    expect(transport).not.toHaveBeenCalled();
    await expect(probeStudioIntegration(network, 'verify', now, fixture(false,
      (req, result) => req.method === 'eth_chainId' ? '0x3e6' : result))).rejects.toThrow('STUDIO_CHAIN_MISMATCH');
    await expect(probeStudioIntegration(network, 'verify', now, fixture(false,
      (req, result) => req.params[0] === '0x1' ? { number: '0x1', timestamp: '0x0', hash } : result))).rejects.toThrow('STUDIO_CHAIN_MISMATCH');
    await expect(probeStudioIntegration(network, 'verify', now, fixture(false,
      (req, result) => req.params[0] === 'latest' ? { ...block, timestamp: '0x1' } : result))).rejects.toThrow('STUDIO_BLOCK_STALE');
    await expect(probeStudioIntegration(network, 'verify', now, fixture(false,
      (req, result) => req.params[0] === block.number ? { ...block, hash: checkpointHash } : result))).rejects.toThrow('STUDIO_BLOCK_CHANGED');
    await expect(probeStudioIntegration(network, 'verify', now, async () => ({
      status: 302, contentType: 'application/json', body: Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x3e7"}'),
    }))).rejects.toThrow('STUDIO_RPC_UNAVAILABLE');
    await expect(probeStudioIntegration(network, 'verify', now, async () => ({
      status: 200, contentType: 'application/json', body: Buffer.from('{"jsonrpc":"2.0","id":2,"result":"0x3e7"}'),
    }))).rejects.toThrow('STUDIO_RPC_UNAVAILABLE');
  });

  it('reads ERC-4626 asset, previews and limits at the same block and refuses mismatched or missing contracts', async () => {
    const transport = fixture(true);
    const result = await probeStudioIntegration(vault, 'test', now, transport);
    expect(result.facts).toMatchObject({ asset: SAVINGS_DAI.underlyingAsset, assetDecimals: '18', shareDecimals: '18',
      previewDeposit: '1', previewMint: '1', previewWithdraw: '1', previewRedeem: '1',
      maxDeposit: '1', maxMint: '1', maxWithdraw: '1', maxRedeem: '1', riskReview: 'REQUIRED' });
    const reads = transport.mock.calls.map(([input]) => JSON.parse(input.body!) as Request)
      .filter(req => req.method === 'eth_call' || req.method === 'eth_getCode');
    expect(reads).toHaveLength(15);
    expect(reads.map(req => req.params[1])).toEqual(Array(15).fill({ blockHash: hash, requireCanonical: true }));
    await expect(probeStudioIntegration({ ...vault, underlyingAsset: vault.contractAddress }, 'verify', now, transport))
      .rejects.toThrow('STUDIO_VAULT_ASSET_MISMATCH');
    await expect(probeStudioIntegration(vault, 'verify', now, fixture(true,
      (req, value) => req.method === 'eth_getCode' ? '0x' : value))).rejects.toThrow('STUDIO_VAULT_CODE_MISSING');
  });
});

const proposal = { schemaVersion: 2, slug: 'example-chain', kind: 'network', name: 'Example Chain',
  architecture: 'evm', chainRef: 'eip155:222222', environment: 'mainnet', rpcUrl: 'https://rpc.studio-example.test/evm',
  checkpoint: { height: '0x3', hash: checkpointHash }, adapter: { kind: 'builtin', id: 'evm-rpc', version: 1 },
  capabilities: ['network.read', 'transfer.native'], dependencies: [] } as const;

function proposalAnswer(req: Request): unknown {
  if (req.method === 'eth_chainId') return '0x' + (222222).toString(16);
  if (req.method === 'eth_getBlockByNumber') {
    if (req.params[0] === proposal.checkpoint.height) return { number: proposal.checkpoint.height, hash: checkpointHash, timestamp: '0x0' };
    return block;
  }
  return answer(req, false);
}

describe('Studio package probes', () => {
  it('reuses the EVM verifier for an arbitrary CAIP-2 chain through the bounded proposal RPC', async () => {
    const manifest = parseStudioIntegration(proposal);
    expect(supportsStudioProbe(manifest)).toBe(true);
    const transport = mockRpc(proposalAnswer);
    const result = await probeStudioIntegration(manifest, 'test', now, transport);
    expect(result).toMatchObject({ schemaVersion: 2, source: 'PROPOSAL_RPC', adapterId: 'evm-rpc', adapterVersion: 1,
      chainRef: proposal.chainRef, checkpointHash, block: { height: block.number, hash }, facts: {
        canonicalNativeTransferProfile: false, valueZeroGasUnits: '21000', walletAcceptance: 'REQUIRED',
      } });
    expect(transport.mock.calls).toHaveLength(8);
    for (const [input] of transport.mock.calls) {
      expect(input.url.href).toBe(proposal.rpcUrl);
      expect(input).toMatchObject({ method: 'POST', timeoutMs: 4_500, maxBytes: 128 * 1024,
        headers: { 'content-type': 'application/json', accept: 'application/json' } });
    }
    await expect(probeStudioIntegration(manifest, 'verify', now, mockRpc(req => req.method === 'eth_chainId' ? '0x1' : proposalAnswer(req))))
      .rejects.toThrow('STUDIO_CHAIN_MISMATCH');
    await expect(probeStudioIntegration(parseStudioIntegration({ ...proposal, checkpoint: { ...proposal.checkpoint, hash } }), 'verify', now, transport))
      .rejects.toThrow('STUDIO_CHAIN_MISMATCH');
  });

  it('reuses read-only ERC-4626 calls without a chain-specific branch for the deployment address', async () => {
    const contract = '0x' + '1'.repeat(40), asset = '0x' + '2'.repeat(40);
    const manifest = parseStudioIntegration({ ...proposal, kind: 'vault', deploymentRef: contract, underlyingAsset: asset,
      adapter: { kind: 'builtin', id: 'erc4626-read', version: 1 }, capabilities: ['vault.read', 'vault.deposit'] });
    const transport = mockRpc(req => {
      if (req.method === 'eth_call' && (req.params[0] as { data: string }).data === erc7710.selectorOf('asset()')) return abiWord(asset.slice(2));
      return proposalAnswer(req);
    });
    const result = await probeStudioIntegration(manifest, 'test', now, transport);
    expect(result).toMatchObject({ source: 'PROPOSAL_RPC', adapterId: 'erc4626-read', chainRef: proposal.chainRef, facts: {
      asset, previewDeposit: '1', riskReview: 'REQUIRED',
    } });
    const requests = transport.mock.calls.map(([input]) => JSON.parse(input.body!) as Request);
    expect(requests).toContainEqual(expect.objectContaining({ method: 'eth_getBlockByNumber', params: ['finalized', false] }));
    expect(requests.filter(req => req.method === 'eth_getCode').map(req => req.params[0])).toEqual([contract, asset]);
  });

  it('refuses declared and known non-mainnets, invalid RPC URLs and external adapters before transport', async () => {
    const transport = mockRpc(proposalAnswer);
    for (const value of [{ ...proposal, environment: 'testnet' }, { ...proposal, chainRef: 'eip155:11155111' }, { ...proposal, chainRef: 'eip155:31337' }]) {
      await expect(probeStudioIntegration(parseStudioIntegration(value), 'verify', now, transport)).rejects.toThrow('STUDIO_NETWORK_UNSUPPORTED');
    }
    for (const rpcUrl of ['https://127.0.0.1/', 'https://localhost/', 'https://rpc.studio-example.test:8443/', 'https://rpc.studio-example.test/path?parameter=1']) {
      await expect(probeStudioIntegration({ ...proposal, rpcUrl }, 'verify', now, transport)).rejects.toThrow('STUDIO_MANIFEST_INVALID');
    }
    const external = parseStudioIntegration({ ...proposal, architecture: 'move', chainRef: 'sui:Example-1', checkpoint: undefined,
      adapter: { kind: 'external', repository: 'https://github.com/company/adapter', commit: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), sdkVersion: 1 } });
    expect(supportsStudioProbe(external)).toBe(false);
    await expect(probeStudioIntegration(external, 'test', now, transport)).rejects.toThrow('STUDIO_CONNECTOR_UNAVAILABLE');
    expect(transport).not.toHaveBeenCalled();
  });

  it('checks SVM genesis identity and verifies a finalized block and bounded account read', async () => {
    const genesis = base58Encode(Buffer.alloc(32, 1)), blockhash = base58Encode(Buffer.alloc(32, 2));
    const manifest = parseStudioIntegration({ ...proposal, chainRef: `solana:${genesis.slice(0, 32)}`, architecture: 'svm', checkpoint: undefined,
      adapter: { kind: 'builtin', id: 'svm-rpc', version: 1 }, capabilities: ['network.read'] });
    const answers: Record<string, unknown> = { getGenesisHash: genesis, getSlot: 100,
      getBlock: { blockHeight: 90, blockTime: now.getTime() / 1_000, blockhash }, getBalance: { context: { slot: 100 }, value: 1 } };
    const transport = mockRpc(req => answers[req.method]);
    const result = await probeStudioIntegration(manifest, 'test', now, transport);
    expect(result).toMatchObject({ source: 'PROPOSAL_RPC', adapterId: 'svm-rpc', checkpointHash: genesis,
      block: { height: '0x5a', hash: blockhash, timestamp }, facts: { finalizedSlot: '100', balanceContextSlot: '100', probeBalanceLamports: '1' } });
    expect(result.block).not.toHaveProperty('baseFeePerGas');
    expect(transport.mock.calls.map(([input]) => JSON.parse(input.body!))).toContainEqual(expect.objectContaining({ method: 'getBlock',
      params: [100, { commitment: 'finalized', transactionDetails: 'none', rewards: false }] }));
    await expect(probeStudioIntegration(manifest, 'verify', now, mockRpc(req => req.method === 'getGenesisHash' ? blockhash : answers[req.method])))
      .rejects.toThrow('STUDIO_CHAIN_MISMATCH');
    await expect(probeStudioIntegration(manifest, 'test', now, mockRpc(req => req.method === 'getBalance'
      ? { context: { slot: 99 }, value: 1 } : answers[req.method]))).rejects.toThrow('STUDIO_NETWORK_TEST_FAILED');
  });

  it('checks Cosmos status, the same block commit and application height using read-only CometBFT methods', async () => {
    const chain = 'unlisted-1', blockHash = 'A'.repeat(64), blockTime = '2026-11-22T20:00:00.123456789Z';
    const manifest = parseStudioIntegration({ ...proposal, chainRef: `cosmos:${chain}`, architecture: 'cosmos', checkpoint: undefined,
      adapter: { kind: 'builtin', id: 'cosmos-rpc', version: 1 }, capabilities: ['network.read'] });
    const answers: Record<string, unknown> = { status: { node_info: { network: chain }, sync_info: {
      latest_block_height: '200', latest_block_hash: blockHash, latest_block_time: blockTime, catching_up: false,
    } }, commit: { signed_header: { header: { chain_id: chain, height: '200', time: blockTime }, commit: { height: '200', block_id: { hash: blockHash } } } },
    abci_info: { response: { last_block_height: '201' } } };
    const transport = mockRpc(req => answers[req.method]);
    const result = await probeStudioIntegration(manifest, 'test', now, transport);
    expect(result).toMatchObject({ source: 'PROPOSAL_RPC', adapterId: 'cosmos-rpc', checkpointHash: null,
      block: { height: '0xc8', hash: blockHash.toLowerCase(), timestamp }, facts: { catchingUp: false, applicationHeight: '201' } });
    expect(transport.mock.calls.map(([input]) => JSON.parse(input.body!).method)).toEqual(['status', 'abci_info', 'commit']);
    await expect(probeStudioIntegration(manifest, 'verify', now, mockRpc(req => req.method === 'commit'
      ? { signed_header: { header: { chain_id: chain, height: '199', time: blockTime }, commit: { height: '199', block_id: { hash: blockHash } } } }
      : answers[req.method]))).rejects.toThrow('STUDIO_BLOCK_CHANGED');
  });
});
