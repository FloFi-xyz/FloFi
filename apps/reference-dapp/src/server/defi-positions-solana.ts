// SPDX-License-Identifier: AGPL-3.0-only

import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as PROFILE } from '@defi-workflow-engine/action-registry';
import { decodeOrcaPosition, decodeRpcAccount, decodeSplTokenAccount, decodeWhirlpool, orcaLiquidityAmounts,
  orcaPositionAddress, readSolanaAccounts, verifySolanaCluster, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { isSolanaPublicKey } from '@defi-workflow-engine/workflow-contracts';
import type { DefiPosition, PositionScan } from '../domain/defi-positions';
import type { ValuePositionAsset } from './defi-positions-evm';

export const ORCA_POSITION_LIMIT = 40;
const TOKEN_ACCOUNT_LIMIT = 400;
type Stake = { readonly tokenAccount: string; readonly mint: string; readonly program: string };
const programIds = [PROFILE.programs.token, PROFILE.programs.token2022] as const;
const invalid = () => new Error('POSITION_SOLANA_RPC_INVALID');

async function tokenCandidates(rpc: SolanaRpc, owner: string, program: string) {
  const result = await rpc('getTokenAccountsByOwner', [owner, { programId: program }, { encoding: 'base64', commitment: 'confirmed' }]) as {
    readonly value?: unknown; readonly context?: { readonly slot?: number };
  } | null;
  const slot = result?.context?.slot;
  if (!result || typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(result.value)) throw invalid();
  let partial = result.value.length > TOKEN_ACCOUNT_LIMIT;
  const candidates: Stake[] = [];
  for (const item of result.value.slice(0, TOKEN_ACCOUNT_LIMIT)) {
    try {
      if (!item || !isSolanaPublicKey(item.pubkey)) throw invalid();
      const account = decodeRpcAccount(item.account);
      if (!account || account.owner !== program) throw invalid();
      const token = decodeSplTokenAccount(account.data, program === PROFILE.programs.token2022);
      if (token.owner !== owner) throw invalid();
      if (token.state !== 0 && token.amount === 1n) candidates.push({ tokenAccount: item.pubkey, mint: token.mint, program });
    } catch { partial = true; }
  }
  return { candidates, partial, slot };
}

/** Standalone position certificates in this wallet on the registered pool. Bundled NFTs are outside this scan's scope. */
export async function orcaPositions(rpc: SolanaRpc, owner: string, now: Date, value: ValuePositionAsset):
  Promise<Pick<PositionScan, 'status' | 'positions' | 'observedAt'>> {
  await verifySolanaCluster(rpc, PROFILE.genesisHash);
  const listed = await Promise.allSettled(programIds.map(program => tokenCandidates(rpc, owner, program)));
  const results = listed.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  if (!results.length) throw invalid();
  const candidates = results.flatMap(result => result.candidates);
  let partial = results.length !== programIds.length || results.some(result => result.partial) || candidates.length > ORCA_POSITION_LIMIT;
  if (!candidates.length) return { status: partial ? 'PARTIAL' : 'COMPLETE', positions: [], observedAt: now.toISOString() };
  // Scan bounded candidates, verify each certificate again at the same slot as its position and the pool.
  const selected = candidates.slice(0, ORCA_POSITION_LIMIT);
  const keys = [PROFILE.pool.address, ...selected.flatMap(candidate => [candidate.tokenAccount, orcaPositionAddress(candidate.mint)])];
  const minimumSlot = Math.max(...results.map(result => result.slot));
  const snapshot = await readSolanaAccounts((method, params) => rpc(method, [params[0], { ...params[1] as object, minContextSlot: minimumSlot }]), keys);
  if (snapshot.slot < minimumSlot) throw invalid();
  const account = snapshot.accounts[0];
  if (!account || account.owner !== PROFILE.programs.whirlpool) throw invalid();
  const pool = decodeWhirlpool(PROFILE.pool.address, account.data, snapshot.slot);
  if (pool.whirlpoolsConfig !== PROFILE.whirlpoolsConfig || pool.tokenMintA !== PROFILE.pool.tokenMintA || pool.tokenMintB !== PROFILE.pool.tokenMintB ||
      pool.tokenVaultA !== PROFILE.pool.tokenVaultA || pool.tokenVaultB !== PROFILE.pool.tokenVaultB || pool.tickSpacing !== PROFILE.pool.tickSpacing ||
      pool.feeRate !== PROFILE.feeTier || BigInt(pool.sqrtPrice) <= 0n) throw invalid();
  const positions = new Map<string, DefiPosition>();
  for (const [index, candidate] of selected.entries()) {
    const positionAccount = snapshot.accounts[2 + index * 2];
    if (!positionAccount || positionAccount.owner !== PROFILE.programs.whirlpool) continue;
    try {
      const position = decodeOrcaPosition(keys[2 + index * 2]!, positionAccount.data);
      if (position.positionMint !== candidate.mint) throw invalid();
      if (position.whirlpool !== PROFILE.pool.address) continue;
      const certificate = snapshot.accounts[1 + index * 2];
      if (!certificate || certificate.owner !== candidate.program) throw invalid();
      const token = decodeSplTokenAccount(certificate.data, candidate.program === PROFILE.programs.token2022);
      if (token.mint !== candidate.mint || token.owner !== owner || token.state === 0 || token.amount !== 1n ||
          position.tickLowerIndex >= position.tickUpperIndex) throw invalid();
      const liquidity = BigInt(position.liquidity);
      if (!liquidity && position.feeOwedA === '0' && position.feeOwedB === '0') continue;
      const amounts = orcaLiquidityAmounts({ tickCurrentIndex: pool.tickCurrentIndex, sqrtPrice: BigInt(pool.sqrtPrice) },
        position.tickLowerIndex, position.tickUpperIndex, liquidity, false);
      positions.set(position.positionMint, {
        id: position.positionMint, type: 'LIQUIDITY',
        assets: [{ token: PROFILE.token0, units: amounts.amount0, owed: position.feeOwedA }, { token: PROFILE.token1, units: amounts.amount1, owed: position.feeOwedB }]
          .map(({ token, units, owed }) => value({ address: token.mint, decimals: token.decimals, symbol: token.symbol, units: units.toString(),
            ...owed !== '0' && { recordedOwedUnits: owed } })),
      });
    } catch { partial = true; }
  }
  return { status: partial ? 'PARTIAL' : 'COMPLETE', positions: [...positions.values()], observedAt: now.toISOString() };
}
