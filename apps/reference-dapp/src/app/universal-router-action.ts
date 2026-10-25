// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { UNIVERSAL_NETWORKS, type SemanticWorkflow, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createUniversalRouterService, UNIVERSAL_RUN_ID, type UniversalRecord, type UniversalRouterService, type UniversalWalletDiagnostic } from '../server/universal-router/service';
import { createRelayProvider } from '../server/universal-router/relay-provider';
import { createUniversalDiscovery, type DiscoveryResult } from '../server/universal-router/discovery';
import { parseDiscoveryRequest } from '../server/universal-router/requests';
import { universalRouterMode, universalRouterRuntime, type UniversalRouterMode } from '../server/universal-router/runtime';
import { evmTokenDecimals } from '../server/universal-router/evm-chain';
import { solanaMintFacts } from '../server/universal-router/solana-chain';
import { cloudFlow, cloudFlowMode, cloudRuns } from '../server/flow-runtime';
import { assertRunOwnership, UNIVERSAL_OWNERSHIP } from '../server/run-ownership';
import { currentSolanaSession, currentWalletSession } from '../server/session-principal';

/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router's server actions. Discovery, quotes, simulation and Review are
 * read-only; every wallet request needs the owner's Review, Execute click and wallet signature. FloFi never signs; on Solana it
 * broadcasts only owner-signed bytes it verified against the Review. Deployed: forwards the identical contract to the FloFi API
 * (PostgreSQL, workers). Local: the same service on files. A run belongs to the wallet that simulated it: an EVM session
 * (Sign-In With Ethereum) for EVM sources, a Solana session (Sign-In With Solana) for Solana sources — `ecosystem` names which.
 */
type Result<T> = { ok: true; value: T } | { ok: false; code: string };
export type UniversalEcosystem = 'EVM' | 'SOLANA';
export type UniversalRunSummary = { runId: string; status: string; hasEvidence: boolean; updatedAt: string };
const FLOW = 'crosschain-universal' as const;
let service: UniversalRouterService | null = null;
const classified = (cause: unknown) => { const code = cause instanceof Error ? cause.message : ''; return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'UNIVERSAL_SERVICE_UNAVAILABLE'; };
function journalDir(): string {
  const dir = process.env.GRYLOO_UNIVERSAL_ROUTER_JOURNAL;
  if (!dir || !isAbsolute(dir)) throw new Error('UNIVERSAL_STORAGE_NOT_CONFIGURED');
  return dir;
}
function current(): UniversalRouterService {
  const mode = universalRouterMode(process.env);
  if (mode === 'off') throw new Error('UNIVERSAL_ROUTER_NOT_ENABLED');
  if (!service) {
    const runtime = universalRouterRuntime(mode, process.env);
    service = createUniversalRouterService({ storage: createFileExecutionStorage(journalDir(), 'UNIVERSAL_BUSY'), evmRpcs: runtime.evmRpcs, solanaRpc: runtime.solanaRpc,
      providers: { relay: createRelayProvider({ http: runtime.http, ...runtime.apis.relay ? { api: runtime.apis.relay } : {}, ...runtime.keys.relay ? { apiKey: runtime.keys.relay } : {} }) },
      provenance: runtime.provenance, executionEnabled: runtime.executionEnabled, ...runtime.mockedDeployment ? { mockedDeployment: runtime.mockedDeployment } : {} });
  }
  return service;
}
const ecosystemOfAddress = (address: unknown): UniversalEcosystem => typeof address === 'string' && /^0x/i.test(address) ? 'EVM' : 'SOLANA';
async function principalFor(ecosystem: UniversalEcosystem): Promise<string | null> {
  return ecosystem === 'EVM' ? (await currentWalletSession())?.account ?? null : (await currentSolanaSession())?.account ?? null;
}
async function run<T>(ecosystem: UniversalEcosystem, method: string, args: readonly unknown[], action: (s: UniversalRouterService) => Promise<T>): Promise<Result<T>> {
  if (ecosystem !== 'EVM' && ecosystem !== 'SOLANA') return { ok: false, code: 'UNIVERSAL_ECOSYSTEM_INVALID' };
  let principal: string | null;
  try { principal = await principalFor(ecosystem); } catch (cause) { return { ok: false, code: classified(cause) }; }
  // Cloud deployment (remote API or embedded PostgreSQL runtime): the same backend enforces ownership against the durable run.
  const cloud = await cloudFlow<T>(FLOW, method, args, { principal });
  if (cloud) return cloud;
  try {
    const s = current();
    await assertRunOwnership(UNIVERSAL_OWNERSHIP, method, args, principal, async id => (await s.load(id)).owner);
    return { ok: true, value: await action(s) };
  } catch (cause) { return { ok: false, code: classified(cause) }; }
}
export async function universalRouterAvailability(): Promise<UniversalRouterMode> {
  return await cloudFlowMode(FLOW) ?? universalRouterMode(process.env);
}
export async function universalInfo() { return run('EVM', 'info', [], async s => ({ executionEnabled: s.executionEnabled })); }
/** Read-only route discovery for a pair (every provider, every answer classified). Persists nothing; binds no owner. */
export async function universalDiscover(request: unknown): Promise<Result<DiscoveryResult>> {
  const cloud = await cloudFlow<DiscoveryResult>(FLOW, 'discover', [request], { principal: null });
  if (cloud) return cloud;
  try {
    const mode = universalRouterMode(process.env);
    if (mode === 'off') throw new Error('UNIVERSAL_ROUTER_NOT_ENABLED');
    const runtime = universalRouterRuntime(mode, process.env), parsed = parseDiscoveryRequest(request);
    return { ok: true, value: await createUniversalDiscovery({ http: runtime.http, apis: runtime.apis, keys: runtime.keys }).discover(parsed, parsed.providers) };
  } catch (cause) { return { ok: false, code: classified(cause) }; }
}
/** Read-only token facts for an explicit contract or mint (decimals and, on EVM, the token's own symbol), so a custom asset can be authored. */
export async function universalTokenFacts(network: UniversalNetworkKey, address: string): Promise<Result<{ decimals: number; symbol: string | null }>> {
  try {
    const mode = universalRouterMode(process.env);
    if (mode === 'off') throw new Error('UNIVERSAL_ROUTER_NOT_ENABLED');
    const n = UNIVERSAL_NETWORKS[network] ?? (() => { throw new Error('UNIVERSAL_REQUEST_NETWORK_INVALID'); })();
    const runtime = universalRouterRuntime(mode, process.env);
    if (n.ecosystem === 'SOLANA') return { ok: true, value: { decimals: (await solanaMintFacts(runtime.solanaRpc, address)).decimals, symbol: null } };
    const rpc = runtime.evmRpcs[n.chain]!, token = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('UNIVERSAL_ASSET_ADDRESS_INVALID');
    const decimals = await evmTokenDecimals(rpc, token);
    let symbol: string | null = null;
    try {
      const raw = await rpc('eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']);
      if (typeof raw === 'string' && raw.length >= 194) {
        const length = Number(BigInt('0x' + raw.slice(66, 130))), text = Buffer.from(raw.slice(130, 130 + length * 2), 'hex').toString('utf8');
        symbol = /^[A-Za-z0-9.$+_-]{1,24}$/.test(text) ? text : null;
      }
    } catch { symbol = null; }
    return { ok: true, value: { decimals, symbol } };
  } catch (cause) { return { ok: false, code: classified(cause) }; }
}
export async function universalSimulate(workflow: SemanticWorkflow, owner: string, destinationWallet?: string) {
  const args = destinationWallet === undefined ? [workflow, owner] : [workflow, owner, destinationWallet];
  return run(ecosystemOfAddress(owner), 'simulate', args, s => s.simulate(workflow, owner, destinationWallet));
}
export async function universalRefresh(ecosystem: UniversalEcosystem, id: string, destinationWallet?: string) {
  return run(ecosystem, 'refresh', destinationWallet === undefined ? [id] : [id, destinationWallet], s => s.refresh(id, destinationWallet));
}
export async function universalReview(ecosystem: UniversalEcosystem, id: string, commitment: string, workflow: SemanticWorkflow) {
  return run(ecosystem, 'review', [id, commitment, workflow], s => s.review(id, commitment, workflow));
}
export async function universalInvalidate(ecosystem: UniversalEcosystem, id: string, reason: 'SEMANTIC_EDIT' | 'WALLET_CHANGED' = 'SEMANTIC_EDIT') {
  return run(ecosystem, 'invalidate', reason === 'SEMANTIC_EDIT' ? [id] : [id, reason], s => s.invalidate(id, reason));
}
export async function universalBegin(ecosystem: UniversalEcosystem, id: string, owner: string, workflow: SemanticWorkflow) {
  return run(ecosystem, 'begin', [id, owner, workflow], s => s.begin(id, owner, workflow));
}
export async function universalHandoff(id: string) { return run('EVM', 'handoff', [id], s => s.handoff(id)); }
export async function universalReport(id: string, result: { kind: 'HASH'; hash: string } | { kind: 'UNKNOWN' | 'REJECTED'; code?: string }) {
  return run('EVM', 'report', [id, result], s => s.report(id, result));
}
export async function universalSubmit(id: string, signedTransaction: string) { return run('SOLANA', 'submit', [id, signedTransaction], s => s.submit(id, signedTransaction)); }
export async function universalWalletFailure(ecosystem: UniversalEcosystem, id: string, diagnostic: UniversalWalletDiagnostic) {
  return run(ecosystem, 'walletFailure', [id, diagnostic], s => s.walletFailure(id, diagnostic));
}
export async function universalObserve(ecosystem: UniversalEcosystem, id: string) { return run(ecosystem, 'observe', [id], s => s.observe(id)); }
export async function universalStatus(ecosystem: UniversalEcosystem, id: string): Promise<Result<UniversalRecord>> { return run(ecosystem, 'status', [id], s => s.load(id)); }
/** The signed-in wallet's universal runs, newest first, so a run can be recovered from any browser. */
export async function universalRuns(ecosystem: UniversalEcosystem): Promise<Result<UniversalRunSummary[]>> {
  let principal: string | null;
  try { principal = await principalFor(ecosystem); } catch (cause) { return { ok: false, code: classified(cause) }; }
  if (!principal) return { ok: false, code: 'WALLET_SESSION_REQUIRED' };
  const listed = await cloudRuns(FLOW, principal);
  if (listed) return listed.ok ? { ok: true, value: listed.value.map(r => ({ runId: r.runId, status: r.status, hasEvidence: r.hasEvidence, updatedAt: r.updatedAt })) } : listed;
  try {
    const s = current(), dir = journalDir();
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl') && UNIVERSAL_RUN_ID.test(name.slice(0, -6)));
    const dated = await Promise.all(names.map(async name => ({ id: name.slice(0, -6), at: (await stat(join(dir, name))).mtime })));
    const runs: UniversalRunSummary[] = [];
    for (const { id, at } of dated.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 50)) {
      const record = await s.load(id).catch(() => null);
      if (record?.owner !== principal) continue;
      runs.push({ runId: id, status: record.verdict !== 'PENDING' ? record.verdict : record.attempts.find(a => ['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN',
        'PENDING'].includes(a.state))?.state ?? record.phase, hasEvidence: record.evidence !== null, updatedAt: at.toISOString() });
      if (runs.length >= 25) break;
    }
    return { ok: true, value: runs };
  } catch (cause) { return { ok: false, code: classified(cause) }; }
}
