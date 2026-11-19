// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PositionScan } from '../../domain/defi-positions';
import { LocaleProvider } from '../../i18n/locale';
import { DefiPositions, liquidityPositionActions, liquidityPositionChoiceFor, liquidityPositionPoolOf, PositionResults, PreparationRefusal } from './defi-positions';
import { readFileSync } from 'node:fs';
import { liquidityPositionChoiceValid, type LiquidityPositionView } from '../../domain/liquidity-positions';

const scan = (status: PositionScan['status']): PositionScan => ({ protocol: 'Aave V3', network: 'Ethereum', chain: 'eip155:1',
  status, observedAt: null, provenance: 'PUBLIC_MAINNET', positions: [] });
afterEach(() => vi.useRealTimers());

describe('Dashboard positions rendering', () => {
  it('discloses the read-only section in EN and PT before loading wallets', () => {
    const english = renderToStaticMarkup(<DefiPositions evm={null} solana={null}/>);
    expect(english).toMatch(/<h2[^>]*><button type="button"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>My DeFi Positions<\/button><\/h2>/);
    expect(english).not.toContain('Checking wallets');
    const portuguese = renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><DefiPositions evm={null} solana={null}/></LocaleProvider>);
    expect(portuguese).toContain('Minhas posições DeFi');
  });
  it('reserves the empty label for complete scans', () => {
    expect(renderToStaticMarkup(<PositionResults scans={[scan('COMPLETE')]}/>)).toContain('No positions found in this scan.');
    for (const status of ['PARTIAL', 'UNAVAILABLE', 'UNSUPPORTED', 'NETWORK_UNAVAILABLE'] as const) {
      expect(renderToStaticMarkup(<PositionResults scans={[scan(status)]}/>)).not.toContain('No positions found');
    }
    expect(renderToStaticMarkup(<PositionResults scans={[scan('PARTIAL')]}/>)).toContain('Partial scan');
    expect(renderToStaticMarkup(<PositionResults scans={[scan('UNSUPPORTED')]}/>)).toContain('Protocol unsupported');
  });
  it('shows debt as debt and hides expired prices', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    const available = [{ ...scan('COMPLETE'), positions: [{ id: 'debt', type: 'VARIABLE_DEBT' as const, assets: [{
      address: '0x' + '3'.repeat(40), symbol: 'USDC', decimals: 6, units: '2500000', valuation: {
        usd: '2.51', observedAt: '2026-11-18T11:59:00.000Z', expiresAt: '2026-11-18T12:01:00.000Z',
      },
    }] }] }];
    const valued = renderToStaticMarkup(<PositionResults scans={available}/>);
    expect(valued).toContain('Variable debt');
    expect(valued).toContain('2.5 USDC');
    expect(valued).toContain('≈ $2.51 (Chainlink)');
    vi.setSystemTime(new Date('2026-11-18T12:01:00.000Z'));
    const expired = renderToStaticMarkup(<PositionResults scans={available}/>);
    expect(expired).not.toContain('$2.51');
    expect(expired).toContain('Valuation unavailable');
  });
});

/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a verified liquidity position's facts and its capability-driven, prepare-only actions. */
describe('Dashboard liquidity position actions', () => {
  const NPM = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', OWNER = '0x5555555555555555555555555555555555555555';
  const uniswap = (patch: Partial<LiquidityPositionView> = {}): LiquidityPositionView => ({
    ref: { protocol: 'UNISWAP_V3', chain: 'eip155:8453', network: 'Base', manager: NPM, pool: '0x' + '4'.repeat(40), positionId: '42', owner: OWNER },
    token0: { symbol: 'USDC', address: '0x' + '1'.repeat(40), decimals: 6 }, token1: { symbol: 'cbBTC', address: '0x' + '2'.repeat(40), decimals: 8 }, feeTier: 500,
    tickLower: -71_090, tickUpper: -67_080, price: { base: 'cbBTC', quote: 'USDC' }, lowerPrice: '81000', upperPrice: '121000', currentPrice: '100000',
    rangeState: 'IN_RANGE', liquidity: '5000000000', principal: ['12000000', '9000'], recordedOwed: ['7', '0'], collectable: ['1234', '56'], status: 'OPEN',
    manageable: { ok: true }, operations: ['COLLECT', 'DECREASE', 'EXIT'], observedAt: '2026-11-18T12:00:00.000Z', observedAtHeight: 1, ...patch });
  const orca = (patch: Partial<LiquidityPositionView> = {}): LiquidityPositionView => uniswap({ ref: { protocol: 'ORCA', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    network: 'Solana', manager: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', pool: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ', positionId: 'Fm7mfcbKeHsUo2u8nDWjpcAfNudKk7XqzGu1QW8k6PJx',
    owner: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }, ...patch });
  const scans = (liquidity: LiquidityPositionView): PositionScan[] => [{ ...scan('COMPLETE'), protocol: 'Uniswap V3', network: 'Base', chain: 'eip155:8453',
    positions: [{ id: liquidity.ref.positionId, type: 'LIQUIDITY', assets: [], liquidity }] }];
  const prepare = vi.fn(() => null);

  it('shows range and state, current price, liquidity status, principal, recorded owed tokens and fees, collectable now and last verified (EN and PT)', () => {
    const html = renderToStaticMarkup(<PositionResults scans={scans(uniswap())} prepare={prepare}/>);
    for (const text of ['Range', '81000–121000 USDC per cbBTC', 'In range', 'Current price', '100000 USDC per cbBTC', 'Liquidity', 'Open (has liquidity)', 'Principal', '12 USDC',
      'Owed tokens and fees (recorded)', 'Collectable now', 'Last verified']) expect(html, text).toContain(text);
    expect(html).not.toMatch(/\byield\b/i);
    const empty = renderToStaticMarkup(<PositionResults scans={scans(uniswap({ status: 'EMPTY', rangeState: 'BELOW_RANGE', collectable: null, currentPrice: null, operations: ['EXIT'] }))} prepare={prepare}/>);
    for (const text of ['Empty (no liquidity)', 'Out of range (below)', 'Unavailable']) expect(empty, text).toContain(text);
    const pt = renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><PositionResults scans={scans(uniswap())} prepare={prepare}/></LocaleProvider>);
    for (const text of ['Tokens devidos e taxas (registrados)', 'Coletável agora', 'Dentro da faixa', 'Coletar taxas', 'Remover liquidez', 'Fechar posição', 'Última verificação'])
      expect(pt, text).toContain(text);
    expect(pt).not.toMatch(/rendimento/i);
    // The status is the adjective ("Aberta"), never the buttons' verb "Abrir"; the price unit reads "por", never an English "per".
    for (const text of ['Aberta (com liquidez)', '81000–121000 USDC por cbBTC', '100000 USDC por cbBTC']) expect(pt, text).toContain(text);
    expect(pt).not.toMatch(/Abrir|\bper\b/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('offers only the actions the verified view lists, and none without a hand-off or for an unmanageable position', () => {
    const all = renderToStaticMarkup(<PositionResults scans={scans(uniswap())} prepare={prepare}/>);
    for (const label of ['Collect fees', 'Remove liquidity', 'Close position']) expect(all, label).toContain(`>${label}</button>`);
    expect(all).toContain('These actions prepare the workflow only.');
    const exitOnly = renderToStaticMarkup(<PositionResults scans={scans(uniswap({ operations: ['EXIT'] }))} prepare={prepare}/>);
    expect(exitOnly).toContain('>Close position</button>');
    expect(exitOnly).not.toContain('>Collect fees</button>');
    expect(exitOnly).not.toContain('>Remove liquidity</button>');
    expect(renderToStaticMarkup(<PositionResults scans={scans(uniswap())}/>)).not.toContain('</button>');
    const blocked = renderToStaticMarkup(<PositionResults scans={scans(uniswap({ manageable: { ok: false, reason: 'POOL_NOT_VERIFIED' }, operations: [] }))} prepare={prepare}/>);
    expect(blocked).toContain('FloFi cannot verify this pool');
    expect(blocked).not.toContain('</button>');
    expect(liquidityPositionActions(uniswap({ manageable: { ok: false, reason: 'REWARDS_UNSUPPORTED' } }))).toEqual([]);
  });

  it('each action prepares exactly the owner\'s choice: close only on "Close position", a 100% removal keeps the Uniswap NFT, an Orca exit always closes', () => {
    const view = uniswap();
    expect(liquidityPositionChoiceFor(view, 'COLLECT')).toEqual({ position: view.ref, operation: 'COLLECT', partBps: null, close: false });
    expect(liquidityPositionChoiceFor(view, 'REMOVE', 2_500)).toEqual({ position: view.ref, operation: 'DECREASE', partBps: 2_500, close: false });
    expect(liquidityPositionChoiceFor(view, 'REMOVE', 10_000)).toEqual({ position: view.ref, operation: 'EXIT', partBps: null, close: false });
    expect(liquidityPositionChoiceFor(view, 'CLOSE')).toEqual({ position: view.ref, operation: 'EXIT', partBps: null, close: true });
    expect(liquidityPositionChoiceFor(uniswap({ operations: ['EXIT'] }), 'COLLECT')).toBeNull();
    const pool = orca();
    expect(liquidityPositionChoiceFor(pool, 'REMOVE', 10_000)).toBeNull();
    expect(liquidityPositionChoiceFor(pool, 'CLOSE')).toEqual({ position: pool.ref, operation: 'EXIT', partBps: null, close: true });
    for (const action of ['COLLECT', 'REMOVE', 'CLOSE'] as const) for (const v of [view, pool]) {
      const choice = liquidityPositionChoiceFor(v, action);
      if (choice) expect(liquidityPositionChoiceValid(choice)).toBe(true);
    }
    // The node is prepared on the verified pool and range; an unavailable principal is never invented.
    expect(liquidityPositionPoolOf(uniswap({ principal: [null, '9000'] }))).toMatchObject({ feeTier: 500, tickLower: -71_090, tickUpper: -67_080, amount0: '0', amount1: '9000', slippageBps: 100 });
  });

  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 within the Editor: the open workflow's rules (the shell's `positionPreparationRefusal`) as the owner reads them.
  it('a refused preparation says why: other steps (start a new workflow, an explicit click), a workflow still executing (nothing changed), or a failure (EN and PT)', () => {
    const startNew = vi.fn();
    const other = renderToStaticMarkup(<PreparationRefusal code="POSITION_WORKFLOW_HAS_OTHER_STEPS" startNew={startNew}/>);
    expect(other).toContain('Your current workflow has other steps.');
    expect(other).toContain('>Start a new workflow</button>');
    const executing = renderToStaticMarkup(<PreparationRefusal code="POSITION_WORKFLOW_EXECUTING" startNew={startNew}/>);
    expect(executing).toContain('Your current workflow is still being executed or checked. Follow it in Operate;');
    expect(executing).not.toMatch(/<button/);
    expect(renderToStaticMarkup(<PreparationRefusal code="LIQUIDITY_POSITION_CHOICE_INVALID" startNew={startNew}/>)).toContain('This position could not be prepared.');
    const pt = renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><PreparationRefusal code="POSITION_WORKFLOW_EXECUTING" startNew={startNew}/>
      <PreparationRefusal code="POSITION_WORKFLOW_HAS_OTHER_STEPS" startNew={startNew}/></LocaleProvider>);
    expect(pt).toContain('Acompanhe-o em Operar');
    expect(pt).toContain('Iniciar um novo fluxo');
    expect(startNew).not.toHaveBeenCalled();
  });

  it('the actions only prepare: the component reaches no runtime, wallet or server action, and keeps its wrapping layout (PR #210 .ux-row unchanged)', () => {
    const source = readFileSync(new URL('./defi-positions.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/\.\.\/(?:app|state|wallet|server)\//);
    expect(source).not.toMatch(/eth_sendTransaction|signTransaction|simulate\(|execute\(/);
    const css = readFileSync(new URL('./defi-positions.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.actions \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.facts \{[^}]*repeat\(auto-fit, minmax\(min\(100%/);
    const page = readFileSync(new URL('../../app/approved-ux-pages.css', import.meta.url), 'utf8');
    expect(page).toContain('.ux-page .ux-row{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;min-width:0;padding:12px 0}');
  });
});
