// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Explicit MOCKED offline Solana Devnet RPC + Orca Whirlpool on loopback. No public transport; never DEVNET_EXECUTED evidence.
 * BUILD-SOLANA-MAINNET-001: `/mainnet-rpc` and `/mainnet-control` serve a separate MOCKED loopback of the mainnet-beta Orca SOL/USDC profile
 * (its genesis, pool, mints and vaults; synthetic price). Never public or mainnet evidence.
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: `seed` writes positions opened outside FloFi, `trade` models more pool trading (fee accrual), and
 * `position` / `balances` (mainnet only) read the MOCKED state, for the Orca position-management browser suite. The RPC answers
 * `getTokenAccountsByOwner`, so the Dashboard's position scan reads `/mainnet-rpc` like a node.
 */
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY, createMockedSolanaDevnetOrca, orcaPositionAddress } from '../../../packages/reference-compiler/dist/index.js';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 test controls (loopback only, every input validated). `seed`: positions opened outside FloFi for `owner`
 * (the owner's Token-2022 associated account holds the position token, amount 1; `delegate` names an approved delegate, which FloFi does not
 * manage); `trade`: more pool trading, so each position with liquidity accrues `fees` at its next checkpoint; `position` / `balances` read the
 * MOCKED state. Nothing here signs, sends or reaches a public network.
 */
const UINT = /^(0|[1-9][0-9]{0,37})$/;
const units = value => { if (typeof value !== 'string' || !UINT.test(value)) throw new Error('MOCK_CONTROL_DENIED'); return value; };
function seedPositions(chain, value) {
  if (typeof value.owner !== 'string' || !Array.isArray(value.positions) || value.positions.length < 1 || value.positions.length > 4) throw new Error('MOCK_CONTROL_DENIED');
  return value.positions.map(p => {
    if (!p || typeof p !== 'object' || p.delegate !== undefined && typeof p.delegate !== 'string') throw new Error('MOCK_CONTROL_DENIED');
    return chain.seedPosition({ owner: value.owner, liquidity: BigInt(units(p.liquidity)), tickLower: p.tickLower, tickUpper: p.tickUpper,
      feeOwedA: BigInt(units(p.feeOwedA ?? '0')), feeOwedB: BigInt(units(p.feeOwedB ?? '0')), ...p.delegate ? { delegate: p.delegate } : {} });
  });
}
function positionOf(chain, mint) {
  if (typeof mint !== 'string') throw new Error('MOCK_CONTROL_DENIED');
  const position = chain.state.positions.get(orcaPositionAddress(mint));
  if (!position) return null;
  const token = [...chain.state.tokens2022.values()].find(t => t.mint === mint) ?? null;
  return { liquidity: position.liquidity, feeOwedA: position.feeOwedA, feeOwedB: position.feeOwedB, tokenOwner: token?.owner ?? null, tokenAmount: token?.amount ?? null,
    delegate: token?.delegate ?? null };
}
function balancesOf(chain, owner) {
  if (typeof owner !== 'string') throw new Error('MOCK_CONTROL_DENIED');
  return { lamports: chain.state.lamports.get(owner) ?? 0n, usdc: chain.state.tokens.get(chain.ata(owner, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY.token1.mint))?.amount ?? 0n };
}
if (process.argv.includes('--serve')) {
  let options = {}, env = createMockedSolanaDevnetOrca(options);
  let mainnetOptions = { liquidityProfile: ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY }, mainnet = createMockedSolanaDevnetOrca(mainnetOptions);
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') { res.end('MOCKED Solana Devnet / Orca harness'); return; }
      let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 1_048_576) throw new Error('MOCK_INPUT_TOO_LARGE'); }
      const value = JSON.parse(body);
      if (req.url === '/control' || req.url === '/mainnet-control') {
        const onMainnet = req.url === '/mainnet-control';
        let result = true;
        if (value.action === 'reset') {
          if (onMainnet) { mainnetOptions = { ...value.options ?? {}, liquidityProfile: ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY }; mainnet = createMockedSolanaDevnetOrca(mainnetOptions); }
          else { options = { ...value.options ?? {} }; env = createMockedSolanaDevnetOrca(options); }
          (onMainnet ? mainnet : env).fund(value.owner, BigInt(value.lamports ?? '3000000000'), BigInt(value.devUsdc ?? '50000000'));
        } else if (value.action === 'advance') (onMainnet ? mainnet : env).advance(Number(value.blocks));
        else if (value.action === 'set') Object.assign(onMainnet ? mainnetOptions : options, value.options ?? {});
        else if (value.action === 'sent') result = (onMainnet ? mainnet : env).state.sent.length;
        else if (value.action === 'seed') result = seedPositions(onMainnet ? mainnet : env, value);
        else if (value.action === 'trade') {
          // MOCKED pool trading since every position's last fee checkpoint: each position with liquidity accrues `fees` (or the current
          // accrueFees) once more at its next checkpoint.
          if (value.fees !== undefined) Object.assign(onMainnet ? mainnetOptions : options, { accrueFees: { a: units(value.fees?.a), b: units(value.fees?.b) } });
          (onMainnet ? mainnet : env).trade();
        } else if (value.action === 'position') result = positionOf(onMainnet ? mainnet : env, value.mint);
        else if (value.action === 'balances' && onMainnet) result = balancesOf(mainnet, value.owner);
        else throw new Error('MOCK_CONTROL_DENIED');
        res.setHeader('content-type', 'application/json'); res.end(json({ result })); return;
      }
      if (req.url !== '/rpc' && req.url !== '/mainnet-rpc') throw new Error('MOCK_PATH_DENIED');
      try {
        const result = await (req.url === '/mainnet-rpc' ? mainnet : env).rpc(value.method, value.params ?? []);
        res.setHeader('content-type', 'application/json'); res.end(json({ jsonrpc: '2.0', id: value.id, result }));
      } catch (cause) {
        res.setHeader('content-type', 'application/json');
        res.end(json({ jsonrpc: '2.0', id: value.id, error: { code: cause?.rpc ?? -32000, message: String(cause?.message ?? 'MOCK_RPC_DENIED') } }));
      }
    } catch { res.statusCode = 400; res.end(json({ error: 'MOCK_HARNESS_DENIED' })); }
  });
  server.listen(8552, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
