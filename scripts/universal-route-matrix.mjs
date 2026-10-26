// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 read-only route matrix: the 20 directed pairs of FloFi's five mainnets, every routing provider asked
 * through FloFi's own discovery (the code the product runs), plus the Relay contract pins re-read on every network.
 *
 * Read-only by construction: public quote APIs (no API key, FloFi's fixed public quote subjects, for which no private key exists) and
 * public RPC reads (eth_blockNumber, eth_getCode, eth_call decimals(); Solana getSlot, getMultipleAccounts). No wallet, no key, no signing,
 * no transaction, no simulation with anyone's funds. A quote is not an execution: "simulation" is reported as not run (it needs the owner's
 * funded wallet at Simulate time), and nothing here is evidence of a public execution or a certification.
 *
 * Usage: node scripts/universal-route-matrix.mjs output.json   (Node 24 strips the TypeScript types of the imported product modules)
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORKS } from '../packages/workflow-contracts/dist/index.js';
import { UNIVERSAL_ROUTER_DEPLOYMENT } from '../packages/action-registry/dist/index.js';
import { createUniversalDiscovery } from '../apps/reference-dapp/src/server/universal-router/discovery.ts';
import { parseDiscoveryRequest } from '../apps/reference-dapp/src/server/universal-router/requests.ts';
import { createUniversalHttp } from '../apps/reference-dapp/src/server/universal-router/http.ts';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/universal-route-matrix.mjs output.json');
const READ_METHODS = new Set(['eth_blockNumber', 'eth_getCode', 'eth_call', 'getSlot', 'getMultipleAccounts']);
const D = UNIVERSAL_ROUTER_DEPLOYMENT;
let requests = 0;
async function rpc(url, method, params) {
  if (!READ_METHODS.has(method)) throw Error('READ_METHOD_DENIED');
  requests += 1;
  const response = await globalThis.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'FloFi/BUILD-CROSSCHAIN-UNIVERSAL-001 read-only matrix' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requests, method, params }), redirect: 'error', signal: globalThis.AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (!response.ok || body.error || !('result' in body)) throw Error(`PUBLIC_RPC_READ_FAILED ${method}`);
  return body.result;
}
const sleep = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = bytes => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; } return s; };

// --- the assets each pair bridges: the dollar stablecoin of each network (Robinhood Chain's is USDG), and native coins --------------
const STABLE = { solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }, base: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
  'arbitrum-one': { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC' }, ethereum: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
  robinhood: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG' } };
const NATIVE_AMOUNT = { SOL: '150000000', ETH: '10000000000000000' }; // 0.15 SOL, 0.01 ETH
const STABLE_AMOUNT = '25000000';                                     // 25 units (6 decimals)

// --- contract pins, re-read now --------------------------------------------------------------------------------------------------
async function evmPins() {
  const out = {};
  for (const d of Object.values(D.evm)) {
    try {
      const block = await rpc(d.rpc, 'eth_blockNumber', []);
      const code = await rpc(d.rpc, 'eth_getCode', [d.relayDepository, block]);
      const sha256 = createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
      const key = Object.values(UNIVERSAL_NETWORKS).find(n => n.chain === d.chain).key;
      const decimals = Number(BigInt(await rpc(d.rpc, 'eth_call', [{ to: STABLE[key].address, data: '0x313ce567' }, block])));
      out[d.chain] = { block: Number(BigInt(block)), depository: d.relayDepository, codeSha256: sha256, pinned: d.relayDepositoryCodeSha256, matches: sha256 === d.relayDepositoryCodeSha256,
        stablecoin: { ...STABLE[key], decimals, matches: decimals === 6 } };
    } catch (cause) { out[d.chain] = { error: String(cause?.message ?? cause).slice(0, 120) }; }
  }
  return out;
}
async function solanaPin() {
  const s = D.solana;
  try {
    const slot = await rpc(s.rpc, 'getSlot', [{ commitment: 'confirmed' }]);
    const accounts = await rpc(s.rpc, 'getMultipleAccounts', [[s.relayProgram, s.relayProgramData], { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 45 } }]);
    const [program, data] = accounts.value.map(a => a && { owner: a.owner, executable: a.executable, bytes: Buffer.from(a.data[0], 'base64') });
    const programData = program && program.bytes.length >= 36 ? base58(program.bytes.subarray(4, 36)) : null;
    const deploymentSlot = data && data.bytes.length >= 45 ? Number(data.bytes.readBigUInt64LE(4)) : null;
    const authority = data && data.bytes[12] === 1 ? base58(data.bytes.subarray(13, 45)) : null;
    return { slot, program: s.relayProgram, executable: program?.executable ?? false, programData, deploymentSlot, authority,
      matches: programData === s.relayProgramData && deploymentSlot === s.relayDeploymentSlot && authority === s.relayUpgradeAuthority };
  } catch (cause) { return { error: String(cause?.message ?? cause).slice(0, 120) }; }
}

// --- the matrix ----------------------------------------------------------------------------------------------------------------------
const discovery = createUniversalDiscovery({ http: createUniversalHttp() });
const tokenOf = (key, kind) => kind === 'NATIVE' ? { kind: 'NATIVE' } : { kind: 'TOKEN', address: STABLE[key].address, decimals: 6, symbol: STABLE[key].symbol };
const symbolOf = (key, kind) => kind === 'NATIVE' ? UNIVERSAL_NETWORKS[key].native.symbol : STABLE[key].symbol;
function summary(result) {
  const relay = result.candidates.find(c => c.provider === 'relay');
  const executable = result.candidates.filter(c => c.status === 'EXECUTABLE');
  return {
    discovery: { status: result.status, quoteSubjects: result.quoteSubjects, observedAt: result.observedAt,
      providers: result.candidates.map(c => ({ provider: c.provider, bridge: c.bridge, status: c.status, executableBy: c.executableBy, expectedOutput: c.expectedOutput,
        minimumOutput: c.minimumOutput, estimatedDurationSeconds: c.estimatedDurationSeconds, fees: c.fees.map(f => ({ label: f.label, amount: f.amount, symbol: f.symbol,
          decimals: f.decimals, included: f.included })), reason: c.reason })) },
    liveQuote: relay ? { provider: 'relay', status: relay.status, expectedOutput: relay.expectedOutput, minimumOutput: relay.minimumOutput, reason: relay.reason }
      : { provider: null, status: 'NO_ROUTE', reason: 'NO_PROVIDER_ANSWER' },
    simulation: { status: 'NOT_RUN', reason: 'OWNER_FUNDS_REQUIRED: FloFi simulates the exact deposit with the connected owner at Simulate (eth_simulateV1 / simulateTransaction)' },
    execution: executable.length ? { status: 'EXECUTABLE_BY_CODE', by: [...new Set(executable.map(c => c.executableBy))],
      gates: ['GRYLOO_UNIVERSAL_ROUTER=live', 'GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED', 'owner Review + wallet signature'] }
      : { status: 'NOT_EXECUTABLE_NOW', reason: relay?.reason ?? result.status },
    evidence: 'PUBLIC_READ_ONLY_QUOTE',
    certification: 'NOT_CERTIFIED',
  };
}
async function row(source, destination, inputKind, outputKind, amount) {
  const request = { source, destination, inputToken: tokenOf(source, inputKind), outputToken: tokenOf(destination, outputKind),
    amount: amount ?? (inputKind === 'NATIVE' ? NATIVE_AMOUNT[UNIVERSAL_NETWORKS[source].native.symbol] : STABLE_AMOUNT), slippageBps: 100 };
  const base = { source, destination, assets: { input: symbolOf(source, inputKind), output: symbolOf(destination, outputKind) }, amount: request.amount };
  try {
    const parsed = parseDiscoveryRequest(request);
    return { ...base, ...summary(await discovery.discover(parsed, parsed.providers)) };
  } catch (cause) { return { ...base, error: String(cause?.message ?? cause).slice(0, 120) }; }
}

const commit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const pins = { evm: await evmPins(), solana: await solanaPin() };
const pairs = [];
for (const { source, destination } of UNIVERSAL_DIRECTED_PAIRS) {
  for (const inputKind of ['STABLE', 'NATIVE']) {
    pairs.push(...await Promise.all(['STABLE', 'NATIVE'].map(outputKind => row(source, destination, inputKind, outputKind))));
    await sleep(1_200);
  }
  process.stderr.write(`${source} → ${destination}\n`);
}
// Mandatory cross-token regression uses the same discovery path, no execution or funded wallet.
const regressionRequest = parseDiscoveryRequest({ source: 'base', destination: 'arbitrum-one', inputToken: tokenOf('base', 'STABLE'),
  outputToken: { kind: 'TOKEN', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18, symbol: 'WETH' }, amount: '1000000', slippageBps: 100 });
const regression = { request: { source: 'base', destination: 'arbitrum-one', input: 'USDC', output: 'WETH', amount: '1000000', slippageBps: 100 },
  ...summary(await discovery.discover(regressionRequest, regressionRequest.providers)) };
const count = status => pairs.filter(p => p.discovery?.status === status).length;
const sourceFiles = ['discovery.ts', 'http.ts', 'relay-provider.ts', 'requests.ts'];
const sourceFingerprint = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name,
  createHash('sha256').update(await readFile(new URL(`../apps/reference-dapp/src/server/universal-router/${name}`, import.meta.url))).digest('hex')])));
const workingTreeDirty = (() => { try { execFileSync('git', ['diff', '--quiet']); return false; } catch { return true; } })();
const report = { sourceFingerprint, workingTreeDirty, format: 'flofi.universal-route-matrix.v1', build: 'BUILD-CROSSCHAIN-UNIVERSAL-001', commit, generatedAt: new Date().toISOString(),
  method: 'Read-only public provider quotes through FloFi discovery (public quote subjects, no keys) and public RPC reads of the Relay contract pins.',
  limits: ['A quote is not an execution; no simulation with real funds was run; nothing here is public execution evidence or a certification.',
    'Provider availability changes by the minute: TEMPORARILY_UNAVAILABLE is a moment, not a verdict.'],
  pins, regression, totals: { rows: pairs.length, executable: count('EXECUTABLE'), liveQuoteOnly: count('LIVE_QUOTE'), supportedNoQuote: count('SUPPORTED_BY_PROVIDER'),
    belowMinimum: count('BELOW_MINIMUM'), aboveMaximum: count('ABOVE_MAXIMUM'), insufficientLiquidity: count('INSUFFICIENT_LIQUIDITY'),
    temporarilyUnavailable: count('TEMPORARILY_UNAVAILABLE'), noRoute: count('NO_ROUTE'), errors: pairs.filter(p => p.error).length }, rpcReads: requests, pairs };
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
process.stderr.write(`${JSON.stringify(report.totals)}\n`);
