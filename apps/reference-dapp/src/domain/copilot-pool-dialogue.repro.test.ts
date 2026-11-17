// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability: the two production incidents, replayed turn by turn in the public (Mainnet-only) scope against the real
 * conversation engine. The interpreter is scripted with exactly what it returned in production (or what a well-behaved one would return); a pool read
 * is a scripted read-only fixture, as the web chat would make it. No network, wallet, signature or transaction.
 * Before the fix every test here failed on `main` (d49f80a): see docs/builds/BUILD-P1-POOL-CONVERSATIONAL-E2E.md.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sqrtRatioAtTick } from '@defi-workflow-engine/reference-compiler';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { setActiveNetworkScope } from './network-scope';
import type { PoolPriceRead, PoolRef } from './pool-range';

beforeAll(() => registerNetworkCatalog(baseCatalog()));
afterAll(() => resetNetworkCatalogs());
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
afterEach(() => setActiveNetworkScope(null));
const NOW = 1_800_000_000_000;
const ORCA = { protocol: 'ORCA', network: 'SOLANA' } as const;
const DEPOSITS = [{ asset: 'SOL', maxAmount: '0.1' }, { asset: 'USDC', maxAmount: '10' }];
/** Base WETH/USDC 0.3% at about 3,000 USDC per WETH (WETH is token0 there). */
const BASE_TICK = -196_257;
const reader = (ref: PoolRef): PoolPriceRead => ref.kind === 'UNISWAP_V3'
  ? { ref, readAt: NOW, ok: true, sqrtPrice: sqrtRatioAtTick(BASE_TICK).toString(), tick: BASE_TICK, at: 22_000_000 }
  : { ref, readAt: NOW, ok: true, price: '150.000000', tick: -18_972, at: 300_000_000 };
const session = () => Object.assign(new CopilotSession(), { poolReader: reader, now: NOW });

describe('Incident A — Orca: a short range answer keeps the request', () => {
  it('replays the captured sequence: "1usdc" → "lower" → only the upper price is asked, then a proposal', () => {
    const s = session();
    s.say('I want to add liquidity on Orca on Solana', intent.action(act.liquidity({ ...ORCA })));
    s.say('0.1 SOL and 10 USDC', intent.action(act.liquidity({ ...ORCA, deposits: DEPOSITS })));
    // What the interpreter answered in production (its own question, naming a Devnet token), if FloFi still asked it.
    const first = s.say('1usdc', intent.clarify(['range'], 'Is 1 devUSDC per SOL the lower or upper price? What should the other bound be?'));
    expect(first?.kind).toBe('CLARIFICATION');
    expect(first?.text).not.toMatch(/devUSDC|Devnet/i);
    const second = s.say('lower', intent.action(act.liquidity({ ...ORCA, deposits: DEPOSITS, rangeUnit: 'PRICE', lower: '1', upper: null })));
    expect(second?.kind).toBe('CLARIFICATION');
    expect(second?.text).toMatch(/upper/i);
    expect(second?.text).not.toMatch(/still cannot prepare/i);
    const done = s.say('180', intent.action(act.liquidity({ ...ORCA, deposits: DEPOSITS, rangeUnit: 'PRICE', lower: '1', upper: '180' })));
    expect(done?.kind).toBe('PROPOSAL');
    expect(done?.sentence).toMatch(/^add liquidity 0\.1 SOL and 10 USDC from 1 to 180 USDC per SOL on Solana slippage \d+ bps$/);
  });
});

describe('Incident B — Uniswap: a percentage answer is understood', () => {
  const base = { network: 'BASE', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'ETH', maxAmount: '0.004' }] };
  it.each([['±10%', '±10%'], ['10% range', '10%']])('"%s" (the model copied the bound as written) is not discarded as an invalid answer', (answer, written) => {
    const s = session();
    s.say('Add liquidity to the USDC/ETH pool on Base with 10 USDC and 0.004 ETH',
      intent.clarify(['range'], 'What price range should I use for the USDC/ETH pool?', ['Full range', 'A percentage range (for example, ±10%)']));
    s.say('A percentage range (for example, ±10%)', intent.clarify(['range'], 'What percentage range would you like around the current pool price?'));
    const reply = s.say(answer, intent.action(act.catalogLiquidity({ ...base, rangeUnit: 'PERCENT', upper: written })));
    expect(reply?.text).not.toMatch(/could not validate/i);
  });
  it('a valid PERCENT intent is never silently turned into the full range', () => {
    const s = session();
    const reply = s.say('Add liquidity on Base with 10 USDC and 0.004 ETH in a 10% range',
      intent.action(act.catalogLiquidity({ ...base, rangeUnit: 'PERCENT', upper: '10' })));
    expect(reply?.kind).toBe('PROPOSAL');
    expect(reply?.sentence).toMatch(/ticks -?\d+ to -?\d+/);
    expect(reply?.notes.join(' ') ?? '').not.toMatch(/full price range/i);
  });
});
