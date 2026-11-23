// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { NATIVE_TRANSFER_PROFILES } from '@defi-workflow-engine/action-registry';
import type { BuiltinStudioAdapter } from '@defi-workflow-engine/developer-sdk';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { isSolanaPublicKey, SOLANA_SYSTEM_PROGRAM } from '@defi-workflow-engine/workflow-contracts';
import { isTestNetwork } from '../domain/network-scope.ts';
import { pinnedHttpsRequest } from '../platform/pinned-https.ts';
import { HYPEREVM, parseStudioIntegration, supportsStudioProbe, type StudioIntegration, type VaultIntegration } from './integration-manifest.ts';

// Schema 0035 keeps its original reviewed endpoints, identity pins and evidence shape.
const legacyNetworks = Object.freeze({
  [HYPEREVM.chainRef]: { ...HYPEREVM, checkpoint: '0x1',
    checkpointHash: '0xde151843548b88d06f201d86e860e45fbf07d49612f1934fba5746abd942fb01' },
  'eip155:1': { chainRef: 'eip155:1', chainId: 1, rpcUrl: 'https://ethereum.publicnode.com', nativeSymbol: 'ETH',
    checkpoint: '0x0', checkpointHash: '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3' },
});

export type ProbeMode = 'verify' | 'test';
type ReadMethod = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getBalance' | 'eth_getTransactionCount' | 'eth_estimateGas'
  | 'eth_gasPrice' | 'eth_getCode' | 'eth_call' | 'getGenesisHash' | 'getSlot' | 'getBlock' | 'getBalance' | 'status' | 'commit' | 'abci_info';
type RpcRead = (method: ReadMethod, params: readonly unknown[]) => Promise<unknown>;
type Block = { height: string; hash: string; timestamp: string };
type EvmBlock = Block & { baseFeePerGas: string };
type EvidenceFields = {
  readonly mode: ProbeMode;
  readonly chainRef: string;
  readonly rpcUrl: string;
  readonly observedAt: string;
  readonly facts: Readonly<Record<string, string | boolean>>;
};
export type StudioEvidence = EvidenceFields & (
  | { readonly schemaVersion: 1; readonly source: 'MAINNET_RPC'; readonly checkpointHash: string; readonly block: EvmBlock }
  | { readonly schemaVersion: 2; readonly source: 'PROPOSAL_RPC'; readonly checkpointHash: string | null;
      readonly block: Block & { readonly baseFeePerGas?: string }; readonly adapterId: BuiltinStudioAdapter; readonly adapterVersion: 1 }
);
type EvmIdentity = { chainRef: string; checkpoint: string; checkpointHash: string };
type VaultTarget = Pick<VaultIntegration, 'contractAddress' | 'underlyingAsset'>;

const HASH = /^0x[0-9a-f]{64}$/i;
const DATA = /^0x(?:[0-9a-f]{2})+$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/i;
const COMET_HASH = /^[0-9a-fA-F]{64}$/;
const HEIGHT = /^[1-9][0-9]{0,18}$/;
const COMET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// Additional non-mainnet identifiers known to the probe. Unknown identities remain unverified proposals.
const nonMainnet = new Set(['eip155:31337', 'eip155:1337', 'eip155:998', 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z']);
const PROBE_ADDRESS = '0x000000000000000000000000000000000000dead';
const word = (value: string) => value.slice(2).padStart(64, '0');

function parseHex(value: unknown, format: RegExp, error: string): string {
  if (typeof value !== 'string' || !format.test(value)) throw new Error(error);
  return value.toLowerCase();
}

function rpcRecord(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function parseBlock(value: unknown, latest: boolean): EvmBlock {
  const block = rpcRecord(value, 'STUDIO_BLOCK_INVALID');
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

function checkBlockAge(now: Date, timestamp: bigint, maxAge: bigint) {
  const age = BigInt(Math.floor(now.getTime() / 1000)) - timestamp;
  if (age < -60n || age > maxAge) throw new Error('STUDIO_BLOCK_STALE');
}

async function verifyNetwork(network: EvmIdentity, rpc: RpcRead, now: Date, finalized: boolean) {
  const chainId = parseHex(await rpc('eth_chainId', []), QUANTITY, 'STUDIO_CHAIN_MISMATCH');
  if (BigInt(chainId) !== BigInt(network.chainRef.slice('eip155:'.length))) throw new Error('STUDIO_CHAIN_MISMATCH');
  const [identity, head] = await Promise.all([
    rpc('eth_getBlockByNumber', [network.checkpoint, false]),
    rpc('eth_getBlockByNumber', [finalized ? 'finalized' : 'latest', false]),
  ]);
  const checkpoint = parseBlock(identity, false);
  if (checkpoint.height !== network.checkpoint || checkpoint.hash !== network.checkpointHash) throw new Error('STUDIO_CHAIN_MISMATCH');
  const block = parseBlock(head, true);
  checkBlockAge(now, BigInt(block.timestamp), finalized ? 1_800n : 300n);
  if (BigInt(block.height) <= BigInt(checkpoint.height)) throw new Error('STUDIO_BLOCK_STALE');
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

async function vaultFacts(vault: VaultTarget, mode: ProbeMode, rpc: RpcRead, block: EvmBlock) {
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

async function probeEvm(network: EvmIdentity, mode: ProbeMode, now: Date, rpc: RpcRead, vault?: VaultTarget) {
  const block = await verifyNetwork(network, rpc, now, vault !== undefined);
  const facts = vault ? await vaultFacts(vault, mode, rpc, block) : {
    canonicalNativeTransferProfile: NATIVE_TRANSFER_PROFILES.some(profile => profile.chain === network.chainRef),
    ...(mode === 'test' ? await testNetwork(rpc) : {}),
  };
  const confirmed = parseBlock(await rpc('eth_getBlockByNumber', [block.height, false]), true);
  if (confirmed.height !== block.height || confirmed.hash !== block.hash) throw new Error('STUDIO_BLOCK_CHANGED');
  return { checkpointHash: network.checkpointHash, block, facts };
}

function unsignedInteger(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(error);
  return value;
}

const hexQuantity = (value: bigint | number) => '0x' + value.toString(16);

async function probeSvm(chainRef: string, mode: ProbeMode, now: Date, rpc: RpcRead) {
  const genesis = await rpc('getGenesisHash', []);
  if (!isSolanaPublicKey(genesis) || `solana:${genesis.slice(0, 32)}` !== chainRef) throw new Error('STUDIO_CHAIN_MISMATCH');
  const slot = unsignedInteger(await rpc('getSlot', [{ commitment: 'finalized' }]), 'STUDIO_BLOCK_INVALID');
  if (slot === 0) throw new Error('STUDIO_BLOCK_INVALID');
  const readBlock = async () => {
    const data = rpcRecord(await rpc('getBlock', [slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false }]), 'STUDIO_BLOCK_INVALID');
    const height = unsignedInteger(data.blockHeight, 'STUDIO_BLOCK_INVALID');
    const time = unsignedInteger(data.blockTime, 'STUDIO_BLOCK_INVALID');
    if (!isSolanaPublicKey(data.blockhash) || height > slot) throw new Error('STUDIO_BLOCK_INVALID');
    return { height, hash: data.blockhash, time };
  };
  const block = await readBlock();
  checkBlockAge(now, BigInt(block.time), 1_800n);
  const facts: Record<string, string | boolean> = { finalizedSlot: String(slot) };
  if (mode === 'test') {
    const error = 'STUDIO_NETWORK_TEST_FAILED';
    const balance = rpcRecord(await rpc('getBalance', [SOLANA_SYSTEM_PROGRAM, { commitment: 'finalized', minContextSlot: slot }]), error);
    const context = rpcRecord(balance.context, error);
    if (unsignedInteger(context.slot, error) < slot) throw new Error(error);
    facts.probeBalanceLamports = String(unsignedInteger(balance.value, error));
    facts.balanceContextSlot = String(context.slot);
  }
  const confirmed = await readBlock();
  if (block.hash !== confirmed.hash || block.height !== confirmed.height || block.time !== confirmed.time) throw new Error('STUDIO_BLOCK_CHANGED');
  return { checkpointHash: genesis, block: { height: hexQuantity(block.height), hash: block.hash, timestamp: hexQuantity(block.time) }, facts };
}

function positiveHeight(value: unknown, error: string): string {
  if (typeof value !== 'string' || !HEIGHT.test(value) || BigInt(value) > (1n << 63n) - 1n) throw new Error(error);
  return value;
}

function cometTime(value: unknown): { raw: string; seconds: bigint } {
  if (typeof value !== 'string' || !COMET_TIME.test(value)) throw new Error('STUDIO_BLOCK_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('STUDIO_BLOCK_INVALID');
  return { raw: value, seconds: BigInt(Math.floor(parsed / 1000)) };
}

async function probeCosmos(chainRef: string, mode: ProbeMode, now: Date, rpc: RpcRead) {
  const badBlock = 'STUDIO_BLOCK_INVALID';
  const status = rpcRecord(await rpc('status', []), badBlock);
  const node = rpcRecord(status.node_info, badBlock);
  if (typeof node.network !== 'string' || `cosmos:${node.network}` !== chainRef) throw new Error('STUDIO_CHAIN_MISMATCH');
  const sync = rpcRecord(status.sync_info, badBlock);
  if (sync.catching_up !== false) throw new Error('STUDIO_BLOCK_STALE');
  const height = positiveHeight(sync.latest_block_height, badBlock);
  const hash = parseHex(sync.latest_block_hash, COMET_HASH, badBlock);
  const time = cometTime(sync.latest_block_time);
  checkBlockAge(now, time.seconds, 1_800n);
  const facts: Record<string, string | boolean> = { catchingUp: false };
  if (mode === 'test') {
    const error = 'STUDIO_NETWORK_TEST_FAILED';
    const info = rpcRecord(await rpc('abci_info', []), error);
    const app = rpcRecord(info.response, error);
    const appHeight = positiveHeight(app.last_block_height, error);
    if (BigInt(appHeight) < BigInt(height)) throw new Error(error);
    facts.applicationHeight = appHeight;
  }
  const result = rpcRecord(await rpc('commit', [height]), badBlock);
  const signed = rpcRecord(result.signed_header, badBlock);
  const header = rpcRecord(signed.header, badBlock);
  const commit = rpcRecord(signed.commit, badBlock);
  const id = rpcRecord(commit.block_id, badBlock);
  if (header.chain_id !== node.network) throw new Error('STUDIO_CHAIN_MISMATCH');
  if (header.height !== height || commit.height !== height || parseHex(id.hash, COMET_HASH, badBlock) !== hash
    || cometTime(header.time).raw !== time.raw) throw new Error('STUDIO_BLOCK_CHANGED');
  return { checkpointHash: null, block: { height: hexQuantity(BigInt(height)), hash, timestamp: hexQuantity(time.seconds) }, facts };
}

/** Performs bounded read-only checks. Proposal evidence reflects the specified endpoint, with independent identity and risk review still required. */
export async function probeStudioIntegration(input: StudioIntegration, mode: ProbeMode, now: Date,
  transport: typeof pinnedHttpsRequest = pinnedHttpsRequest): Promise<StudioEvidence> {
  const manifest = input.schemaVersion === 2 ? parseStudioIntegration(input) : input;
  if (!supportsStudioProbe(manifest)) throw new Error('STUDIO_CONNECTOR_UNAVAILABLE');
  const { chainRef } = manifest;
  const common = { mode, chainRef, observedAt: now.toISOString() };
  if (manifest.schemaVersion === 1) {
    if (chainRef !== (manifest.kind === 'vault' ? 'eip155:1' : HYPEREVM.chainRef)) throw new Error('STUDIO_NETWORK_UNSUPPORTED');
    const network = legacyNetworks[chainRef as keyof typeof legacyNetworks];
    const { rpcUrl } = network;
    const evidence = await probeEvm(network, mode, now, reader(rpcUrl, transport), manifest.kind === 'vault' ? manifest : undefined);
    const facts = manifest.kind === 'vault' ? evidence.facts : { nativeSymbol: network.nativeSymbol, ...evidence.facts };
    return { schemaVersion: 1, mode, source: 'MAINNET_RPC', chainRef, rpcUrl, observedAt: common.observedAt, ...evidence, facts };
  }
  if (manifest.environment !== 'mainnet' || isTestNetwork(chainRef) || nonMainnet.has(chainRef)) throw new Error('STUDIO_NETWORK_UNSUPPORTED');
  const { rpcUrl, adapter: { id: adapterId, version: adapterVersion } } = manifest;
  const rpc = reader(rpcUrl, transport);
  const envelope = { ...common, schemaVersion: 2 as const, source: 'PROPOSAL_RPC' as const, rpcUrl, adapterId, adapterVersion };
  if (adapterId === 'svm-rpc') return { ...envelope, ...await probeSvm(chainRef, mode, now, rpc) };
  if (adapterId === 'cosmos-rpc') return { ...envelope, ...await probeCosmos(chainRef, mode, now, rpc) };
  if (!manifest.checkpoint) throw new Error('STUDIO_MANIFEST_INVALID');
  let vault: VaultTarget | undefined;
  if (adapterId === 'erc4626-read') {
    if (!manifest.deploymentRef || !manifest.underlyingAsset) throw new Error('STUDIO_MANIFEST_INVALID');
    vault = { contractAddress: manifest.deploymentRef, underlyingAsset: manifest.underlyingAsset };
  }
  const network = { chainRef, checkpoint: manifest.checkpoint.height, checkpointHash: manifest.checkpoint.hash };
  return { ...envelope, ...await probeEvm(network, mode, now, rpc, vault) };
}
