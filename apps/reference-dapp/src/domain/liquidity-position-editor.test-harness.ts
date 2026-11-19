// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (Editor integration): real position runs for the Editor's presentation suites, closed and offline. The
 * workflow is the real reducer's MANAGE_LIQUIDITY_POSITION result; the runs are the real Uniswap position service (MOCKED in-process Base chain)
 * and the real Orca service (MOCKED Solana mainnet-beta loopback of the verified SOL/USDC pool). No public RPC, no wallet, nothing signed or sent
 * outside the in-process mocks. A test that needs a "live" Review states so explicitly (`asMainnet`, `provenance: 'PUBLIC_MAINNET'`): the
 * presentation then treats it like a Review read from the public network, which these MOCKED runs never are.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { catalogPoolOn, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, orcaPositionAddress, orcaPositionTokenAccount } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from './editor';
import type { LiquidityPositionChoice } from './liquidity-positions';
import type { LiquidityPositionPoolInput } from './commands';
import type { Workflow } from './initial-workflow';
import type { SimulationSource } from './simulation-presentation';
import type { ReviewAuthorization, ReviewWallet } from './review-presentation';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { createUniswapLiquidityService } from '../server/uniswap-liquidity-service';
import { createOrcaLiquidityService, type OrcaLiquidityRecord } from '../server/orca-liquidity-service';
import type { UniswapPositionRecord, UniswapPositionRequest } from '../server/uniswap-position-service';
import type { Rpc } from '../server/public-testnet-service';

export const positionContext = createBaseSepoliaReviewContext();
export const positionCatalog = baseCatalog();
const USDC = baseAsset(positionCatalog, 'USDC'), CBBTC = baseAsset(positionCatalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
export const UNI_PROFILE = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
const USDC_IS_0 = UNI_PROFILE.token0.address === USDC.address;
const TICK = USDC_IS_0 ? -69_082 : 69_082;
export const UNI_LOWER = Math.floor((TICK - 2_000) / 10) * 10, UNI_UPPER = Math.ceil((TICK + 2_000) / 10) * 10;
const view = (t: { symbol: string; address: string; decimals: number }) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals });
export { UNI_OWNER };
/** The pool the Dashboard hands over for a Uniswap position (its own principal, never deposited). */
export const UNI_POOL: LiquidityPositionPoolInput = { token0: view(UNI_PROFILE.token0), token1: view(UNI_PROFILE.token1), feeTier: 500, tickLower: UNI_LOWER, tickUpper: UNI_UPPER,
  amount0: '123456789', amount1: '987654', slippageBps: 100 };
export const uniswapChoice = (positionId: string, operation: LiquidityPositionChoice['operation'], partBps: number | null = null, close = false): LiquidityPositionChoice => ({
  position: { protocol: 'UNISWAP_V3', chain: 'eip155:8453', network: 'Base', manager: UNI_PROFILE.positionManager, pool: UNI_PROFILE.pool, positionId, owner: UNI_OWNER },
  operation, partBps, close });
/** The workflow the Editor holds after MANAGE_LIQUIDITY_POSITION (the real reducer, its guards and its marker). */
export function managedWorkflow(choice: LiquidityPositionChoice, pool: LiquidityPositionPoolInput, start: Workflow = initialEditor().workflow): Workflow {
  const result = editorReducer({ workflow: start, error: null }, { type: 'MANAGE_LIQUIDITY_POSITION', choice, pool, source: 'CANVAS', baseRevision: start.revision }, positionContext);
  if (result.error) throw new Error(result.error);
  return result.workflow;
}

/** A real Uniswap position run of the service: the managed workflow, the staged request, optionally executed by the scripted wallet. */
export async function uniswapPositionRun(request: Omit<UniswapPositionRequest, 'tokenId'>, execute = false): Promise<{ record: UniswapPositionRecord; workflow: Workflow }> {
  const chain = createUniswapLiquidityChain({ profile: UNI_PROFILE, tick: TICK, usdc: USDC_IS_0 ? 1_000_000_000n : 10_000_000n, weth: USDC_IS_0 ? 10_000_000n : 1_000_000_000n });
  const sepolia: Rpc = async () => { throw new Error('BASE_SEPOLIA_CLIENT_MUST_NOT_BE_USED'); };
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(await mkdtemp(join(tmpdir(), 'flofi-unipm-editor-')), 'UNISWAP_LIQUIDITY_BUSY'), rpc: sepolia,
    rpcs: { 'eip155:8453': chain.rpc }, provenance: 'MOCKED', now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, executionEnabled: true,
    catalog: { chain: 'eip155:8453', catalogFor: async () => positionCatalog, codePins: chain.catalogPins } });
  const tokenId = chain.seedPosition({ tickLower: UNI_LOWER, tickUpper: UNI_UPPER, liquidity: 6_000_000_000n, owed0: 7n });
  chain.accrueFees(tokenId, 1_000n, 2_000n);
  const workflow = managedWorkflow(uniswapChoice(tokenId, request.operation, request.partBps, request.close), { ...UNI_POOL, amount0: '0', amount1: '0' });
  const semantic = structuredClone(workflow) as unknown as SemanticWorkflow;
  let record = await service.positionSimulate(semantic, UNI_OWNER, { ...request, tokenId });
  if (execute) {
    await service.positionReview(record.id, record.review.commitment, semantic);
    const begun = await service.positionBegin(record.id, UNI_OWNER, semantic);
    await service.positionHandoff(record.id);
    await service.positionReport(record.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
    record = await service.positionObserve(record.id);
  }
  return { record, workflow };
}
/** Presented as a Review read from the public network (the run itself stays MOCKED evidence). */
export const asMainnet = (record: UniswapPositionRecord): UniswapPositionRecord => ({ ...record, provenance: 'PUBLIC_MAINNET' });
export const uniswapSource = (record: UniswapPositionRecord | null, state: { busy?: boolean; error?: string | null; retired?: boolean } = {}) => ({ kind: 'uniswap-pool',
  state: { record, busy: false, error: null, retired: false, recovered: false, signing: false, requoted: null, available: true, executionEnabled: true, engaged: true, ...state } }) as unknown as SimulationSource;
/** The Review the shell binds for a position run (`useReviewAuthorization`): one exact request, no token permission. */
export function positionAuthorization(key: string, owner: string, chain: string, accepted = false): ReviewAuthorization {
  return { key, manifest: null, owner, chain, ready: true, accepted, approve: async () => undefined, approvals: [], tokens: [], limits: [], technical: null };
}
export const positionWallet = (account: string, chain: string): ReviewWallet => ({ account, chain, environment: 'mainnet', changed: false });

export const ORCA_OWNER_WALLET = createMockedSolanaWallet();
/** The pool the Dashboard hands over for an Orca position (the verified SOL/USDC Whirlpool, the position's exact ticks). */
export const ORCA_POOL: LiquidityPositionPoolInput = { token0: { symbol: 'SOL', address: ORCA.token0.mint, decimals: 9 }, token1: { symbol: 'USDC', address: ORCA.token1.mint, decimals: 6 },
  feeTier: 400, tickLower: -39_104, tickUpper: -36_992, amount0: '1000000', amount1: '150000', slippageBps: 100 };
export const orcaChoice = (positionMint: string, operation: LiquidityPositionChoice['operation'], partBps: number | null = null): LiquidityPositionChoice => ({
  position: { protocol: 'ORCA', chain: ORCA.chain, network: 'Solana', manager: ORCA.programs.whirlpool, pool: ORCA.pool.address, positionId: positionMint, owner: ORCA_OWNER_WALLET.owner },
  operation, partBps, close: operation === 'EXIT' });
export const ORCA_CLOCK = Date.parse('2026-10-13T12:00:00.000Z');
/**
 * A real Orca run on the MOCKED Solana mainnet loopback: an existing position (held by the owner, never opened through FloFi) is managed by the
 * reducer's marked workflow. `provenance: 'PUBLIC_MAINNET'` is the service's own option, so the presentation treats its Review as live.
 */
export async function orcaPositionRun(operation: LiquidityPositionChoice['operation'], partBps: number | null = null): Promise<{ record: OrcaLiquidityRecord; workflow: Workflow; mint: string }> {
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: ORCA, accrueFees: { a: '1234', b: '56' } });
  env.fund(ORCA_OWNER_WALLET.owner, 3_000_000_000n, 50_000_000n);
  const service = createOrcaLiquidityService({ rpc: env.rpc, journalDir: await mkdtemp(join(tmpdir(), 'flofi-orca-editor-')), profile: ORCA, provenance: 'PUBLIC_MAINNET',
    executionEnabled: true, now: () => ORCA_CLOCK });
  const mint = createMockedSolanaWallet().owner, position = orcaPositionAddress(mint), owner = ORCA_OWNER_WALLET.owner;
  env.state.positions.set(position, { mint, liquidity: 40_000_000n, lower: ORCA_POOL.tickLower, upper: ORCA_POOL.tickUpper, feeOwedA: 10n, feeOwedB: 20n });
  env.state.lamportsOf.set(position, 2_885_440n); env.state.mints.add(mint); env.state.lamportsOf.set(mint, 1_676_400n);
  env.state.tokens2022.set(orcaPositionTokenAccount(owner, mint), { mint, owner, amount: 1n });
  const workflow = managedWorkflow(orcaChoice(mint, operation, partBps), ORCA_POOL);
  const record = await service.simulate(structuredClone(workflow) as unknown as SemanticWorkflow, owner,
    { operation: operation === 'DECREASE' ? 'DECREASE_PARTIAL' : operation, positionMint: mint, ...partBps ? { partBps } : {} });
  return { record, workflow, mint };
}
export const orcaSource = (record: OrcaLiquidityRecord | null) => ({ kind: 'solana-pool',
  state: { record, busy: false, error: null, retired: false, recovered: false, signing: false, executionEnabled: true } }) as unknown as SimulationSource;
