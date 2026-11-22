// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { NATIVE_TRANSFER_PROFILES } from '@defi-workflow-engine/action-registry';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { pinnedHttpsRequest } from '../platform/pinned-https.ts';
import { HYPEREVM, type StudioIntegration, type VaultIntegration } from './integration-manifest.ts';

// Only reviewed mainnet profiles can originate a request. This catalog is separate from the execution registry.
const networks = Object.freeze({
  [HYPEREVM.chainRef]: { ...HYPEREVM, checkpoint: '0x1',
    checkpointHash: '0xde151843548b88d06f201d86e860e45fbf07d49612f1934fba5746abd942fb01' },
  'eip155:1': { chainRef: 'eip155:1', chainId: 1, rpcUrl: 'https://ethereum.publicnode.com', nativeSymbol: 'ETH',
    checkpoint: '0x0', checkpointHash: '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3' },
});

export type ProbeMode = 'verify' | 'test';
type ReadMethod = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getBalance' | 'eth_getTransactionCount' | 'eth_estimateGas'
  | 'eth_gasPrice' | 'eth_getCode' | 'eth_call';
type RpcRead = (method: ReadMethod, params: readonly unknown[]) => Promise<unknown>;
type Block = { height: string; hash: string; timestamp: string; baseFeePerGas: string };
export type StudioEvidence = {
  readonly schemaVersion: 1;
  readonly mode: ProbeMode;
  readonly source: 'MAINNET_RPC';
  readonly chainRef: string;
  readonly rpcUrl: string;
  readonly observedAt: string;
  readonly checkpointHash: string;
  readonly block: Block;
  readonly facts: Readonly<Record<string, string | boolean>>;
};

const HASH = /^0x[0-9a-f]{64}$/i;
const DATA = /^0x(?:[0-9a-f]{2})+$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/i;
const PROBE_ADDRESS = '0x000000000000000000000000000000000000dead';
const word = (value: string) => value.slice(2).padStart(64, '0');

function parseHex(value: unknown, format: RegExp, error: string): string {
  if (typeof value !== 'string' || !format.test(value)) throw new Error(error);
  return value.toLowerCase();
}

function parseBlock(value: unknown, latest: boolean): Block {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STUDIO_BLOCK_INVALID');
  const block = value as Record<string, unknown>;
  return {
    height: parseHex(block.number, QUANTITY, 'STUDIO_BLOCK_INVALID'),
    hash: parseHex(block.hash, HASH, 'STUDIO_BLOCK_INVALID'),
    timestamp: parseHex(block.timestamp, QUANTITY, 'STUDIO_BLOCK_INVALID'),
    baseFeePerGas: latest ? parseHex(block.baseFeePerGas, QUANTITY, 'STUDIO_BLOCK_INVALID') : '0x0',
  };
}

function reader(url: string, transport: typeof pinnedHttpsRequest): RpcRead {
  let id = 0;
  return async (method, params) => {
    const requestId = ++id;
    const request = transport({ url: new URL(url), method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      timeoutMs: 4_500, maxBytes: 128 * 1024, errorPrefix: 'STUDIO_RPC' });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([request, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('STUDIO_RPC_UNAVAILABLE')), 5_000);
      })]);
      if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.contentType)) throw new Error('STUDIO_RPC_UNAVAILABLE');
      const payload = JSON.parse(response.body.toString()) as Record<string, unknown> | null;
      if (!payload || payload.jsonrpc !== '2.0' || payload.id !== requestId ||
        Object.hasOwn(payload, 'error') || !Object.hasOwn(payload, 'result')) throw new Error('STUDIO_RPC_UNAVAILABLE');
      return payload.result;
    } catch {
      throw new Error('STUDIO_RPC_UNAVAILABLE');
    } finally {
      clearTimeout(deadline);
    }
  };
}

async function verifyNetwork(chainRef: string, rpc: RpcRead, now: Date, finalized: boolean) {
  const network = networks[chainRef as keyof typeof networks];
  const chainId = parseHex(await rpc('eth_chainId', []), QUANTITY, 'STUDIO_CHAIN_MISMATCH');
  if (BigInt(chainId) !== BigInt(network.chainId)) throw new Error('STUDIO_CHAIN_MISMATCH');
  const [identity, head] = await Promise.all([
    rpc('eth_getBlockByNumber', [network.checkpoint, false]),
    rpc('eth_getBlockByNumber', [finalized ? 'finalized' : 'latest', false]),
  ]);
  const checkpoint = parseBlock(identity, false);
  if (checkpoint.height !== network.checkpoint || checkpoint.hash !== network.checkpointHash) throw new Error('STUDIO_CHAIN_MISMATCH');
  const block = parseBlock(head, true);
  const age = BigInt(Math.floor(now.getTime() / 1000)) - BigInt(block.timestamp);
  const maxAge = finalized ? 1_800n : 300n;
  if (age < -60n || age > maxAge || BigInt(block.height) <= BigInt(checkpoint.height)) throw new Error('STUDIO_BLOCK_STALE');
  return block;
}

async function testNetwork(rpc: RpcRead) {
  const [balance, nonce, gasPrice, estimate] = await Promise.all([
    rpc('eth_getBalance', [PROBE_ADDRESS, 'latest']),
    rpc('eth_getTransactionCount', [PROBE_ADDRESS, 'latest']),
    rpc('eth_gasPrice', []),
    rpc('eth_estimateGas', [{ from: PROBE_ADDRESS, to: PROBE_ADDRESS, value: '0x0', data: '0x' }]),
  ]);
  parseHex(balance, QUANTITY, 'STUDIO_NETWORK_TEST_FAILED');
  parseHex(nonce, QUANTITY, 'STUDIO_NETWORK_TEST_FAILED');
  const gasPriceWei = BigInt(parseHex(gasPrice, QUANTITY, 'STUDIO_NETWORK_TEST_FAILED'));
  const gasUnits = BigInt(parseHex(estimate, QUANTITY, 'STUDIO_NETWORK_TEST_FAILED'));
  if (gasPriceWei <= 0n || gasUnits !== 21_000n) throw new Error('STUDIO_NETWORK_TEST_FAILED');
  return { walletRpcReads: true, gasPriceWei: gasPriceWei.toString(), valueZeroGasUnits: gasUnits.toString(),
    walletAcceptance: 'REQUIRED' };
}

const bytecodeDigest = (value: unknown) => createHash('sha256')
  .update(Buffer.from(parseHex(value, DATA, 'STUDIO_VAULT_CODE_MISSING').slice(2), 'hex')).digest('hex');

async function vaultFacts(vault: VaultIntegration, mode: ProbeMode, rpc: RpcRead, block: Block) {
  const at = { blockHash: block.hash, requireCanonical: true };
  const call = (to: string, signature: string, args = '') => rpc('eth_call',
    [{ to, data: erc7710.selectorOf(signature) + args, gas: '0x7a120', from: PROBE_ADDRESS }, at]);
  const [code, underlyingCode, asset, decimals, sharesDecimals] = await Promise.all([
    rpc('eth_getCode', [vault.contractAddress, at]),
    rpc('eth_getCode', [vault.underlyingAsset, at]),
    call(vault.contractAddress, 'asset()'),
    call(vault.underlyingAsset, 'decimals()'),
    call(vault.contractAddress, 'decimals()'),
  ]);
  if ('0x' + parseHex(asset, ADDRESS_WORD, 'STUDIO_VAULT_ASSET_MISMATCH').slice(-40) !== vault.underlyingAsset) {
    throw new Error('STUDIO_VAULT_ASSET_MISMATCH');
  }
  const assetsDecimals = BigInt(parseHex(decimals, WORD, 'STUDIO_VAULT_READ_FAILED'));
  const shareDecimals = BigInt(parseHex(sharesDecimals, WORD, 'STUDIO_VAULT_READ_FAILED'));
  if (assetsDecimals > 36n || shareDecimals > 36n) throw new Error('STUDIO_VAULT_READ_FAILED');
  const identity = { vaultCodeSha256: bytecodeDigest(code), assetCodeSha256: bytecodeDigest(underlyingCode),
    asset: vault.underlyingAsset, assetDecimals: assetsDecimals.toString(), shareDecimals: shareDecimals.toString() };
  if (mode === 'verify') return identity;
  const assetUnit = word('0x' + (10n ** assetsDecimals).toString(16));
  const shareUnit = word('0x' + (10n ** shareDecimals).toString(16));
  const subject = word(PROBE_ADDRESS);
  const reads = {
    totalAssets: ['totalAssets()', ''], totalSupply: ['totalSupply()', ''],
    previewDeposit: ['previewDeposit(uint256)', assetUnit], previewMint: ['previewMint(uint256)', shareUnit],
    previewWithdraw: ['previewWithdraw(uint256)', assetUnit], previewRedeem: ['previewRedeem(uint256)', shareUnit],
    maxDeposit: ['maxDeposit(address)', subject], maxMint: ['maxMint(address)', subject],
    maxWithdraw: ['maxWithdraw(address)', subject], maxRedeem: ['maxRedeem(address)', subject],
  } as const;
  const values = await Promise.all(Object.entries(reads).map(async ([key, [signature, args]]) =>
    [key, BigInt(parseHex(await call(vault.contractAddress, signature, args), WORD, 'STUDIO_VAULT_READ_FAILED')).toString()] as const));
  return { ...identity, ...Object.fromEntries(values), probeAddress: PROBE_ADDRESS, assetUnit: (10n ** assetsDecimals).toString(),
    shareUnit: (10n ** shareDecimals).toString(), riskReview: 'REQUIRED' };
}

/** Performs bounded, read-only verification. Transport injection is available to deterministic tests. */
export async function probeStudioIntegration(manifest: StudioIntegration, mode: ProbeMode, now: Date,
  transport: typeof pinnedHttpsRequest = pinnedHttpsRequest): Promise<StudioEvidence> {
  if (manifest.kind === 'staking' || manifest.kind === 'cex') throw new Error('STUDIO_CONNECTOR_UNAVAILABLE');
  if (manifest.chainRef !== (manifest.kind === 'vault' ? 'eip155:1' : HYPEREVM.chainRef)) {
    throw new Error('STUDIO_NETWORK_UNSUPPORTED');
  }
  const network = networks[manifest.chainRef as keyof typeof networks];
  const rpc = reader(network.rpcUrl, transport);
  const block = await verifyNetwork(manifest.chainRef, rpc, now, manifest.kind === 'vault');
  const facts = manifest.kind === 'vault' ? await vaultFacts(manifest, mode, rpc, block) : {
    nativeSymbol: network.nativeSymbol,
    canonicalNativeTransferProfile: NATIVE_TRANSFER_PROFILES.some(profile => profile.chain === manifest.chainRef),
    ...(mode === 'test' ? await testNetwork(rpc) : {}),
  };
  const confirmed = parseBlock(await rpc('eth_getBlockByNumber', [block.height, false]), true);
  if (confirmed.height !== block.height || confirmed.hash !== block.hash) throw new Error('STUDIO_BLOCK_CHANGED');
  return { schemaVersion: 1, mode, source: 'MAINNET_RPC', chainRef: manifest.chainRef, rpcUrl: network.rpcUrl,
    observedAt: now.toISOString(), checkpointHash: network.checkpointHash, block, facts };
}
