// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 within BUILD-FLOFI-UX-EDITOR-FINOPS-001's Editor: the Simulate panel (B2) and the Execute Review (C1 valid, C2
 * expired) of every Uniswap v3 and Orca position operation, from real runs of the real services on closed MOCKED chains (`liquidity-position-editor
 * .test-harness.ts`). Simulate states the outcome with no authorization or permission row; Execute's "You are authorizing" lists the position
 * Review lines, no token permission and one wallet request; an expired Review shows the configured operation — never deposit amounts or stale
 * figures — and neither surface has an authorize control (the ONE action is the Editor footer's). EN and PT-BR.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';
import { LocaleProvider } from '../i18n/locale';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import type { SimulationSource } from '../domain/simulation-presentation';
import type { Workflow } from '../domain/initial-workflow';
import { asMainnet, ORCA_CLOCK, ORCA_OWNER_WALLET, orcaPositionRun, orcaSource, positionAuthorization, positionCatalog, positionContext as context, positionWallet,
  UNI_OWNER, uniswapPositionRun, uniswapSource } from '../domain/liquidity-position-editor.test-harness';
import { ReviewSummaryPanel } from './review-summary-panel';
import { displayTokenAmount } from '../domain/token-amount-display';

beforeAll(() => registerNetworkCatalog(positionCatalog));
afterAll(() => resetNetworkCatalogs());
afterEach(() => { vi.useRealTimers(); });

type Bound = { workflow: Workflow; source: SimulationSource; key: string; owner: string; chain: string };
function render(bound: Bound, stage: 'simulate' | 'execute', language: 'EN' | 'PT' = 'EN', at?: number) {
  if (at !== undefined) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); }
  const panel: ReactElement = createElement(ReviewSummaryPanel, { stage, workflow: bound.workflow, canvasWorkflow: bound.workflow, context, source: bound.source,
    authorization: positionAuthorization(bound.key, bound.owner, bound.chain), wallet: positionWallet(bound.owner, bound.chain), technical: createElement('p', null, 'TECHNICAL') });
  return renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: panel }));
}
/** The visible text of a rendered panel (tags removed), and its definition rows as label → value. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');
const rows = (html: string) => Object.fromEntries([...html.matchAll(/<dt>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(match => [text(match[1]!).trim(),
  // A shortened amount's disclosure control names itself to assistive technology ("— Show exact value"); the row's value is the amount.
  text(match[2]!).replace(/ — (?:Show|Hide) exact value| — (?:Mostrar|Ocultar) valor exato/g, '').trim()]));
/** BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001 (B): engineering figures live under Technical details, never in the short Review's rows. */
const TECHNICAL_ROWS = ['Liquidity removed', 'Liquidity remaining', 'Liquidity', 'Price range', 'Range state', 'Current price', 'Position Manager', 'Deadline',
  'Owed tokens and fees', 'Collected (expected)', 'Expected principal returned', 'Minimum principal (enforced)', 'Tokens returned'];
const AMOUNTS = /^(?:≈ )?[\d.,]+(?:M| mi)? \S+ \+ (?:≈ )?[\d.,]+(?:M| mi)? \S+$/;
const NO_AUTHORIZE = /data-lifecycle-action|Authorize workflow|Authorize in wallet|Autorizar fluxo|<button[^>]*class="primary"/;
const NO_YIELD = /\byield\b|rendimento/i;

async function uniswap(operation: 'COLLECT' | 'DECREASE' | 'EXIT', partBps: number | null = null, close = false) {
  const { record, workflow } = await uniswapPositionRun({ operation, partBps, close });
  const live = asMainnet(record);
  return { bound: { workflow, source: uniswapSource(live), key: `${live.id}:${live.review.commitment}`, owner: UNI_OWNER, chain: 'eip155:8453' },
    observedAt: Date.parse(record.review.observedAt), expiresAt: Date.parse(record.review.expiresAt), record: live };
}

describe('Uniswap v3 position operations in the Editor', () => {
  it('Simulate before a simulation: the operation as configured, what the simulation does, no deposit amounts and no authorization', async () => {
    const { bound } = await uniswap('DECREASE', 5_000);
    const html = render({ ...bound, source: uniswapSource(null) }, 'simulate');
    expect(html).toContain('data-position-operation="DECREASE"');
    expect(text(html)).toContain('Simulate workflow');
    expect(text(html)).toContain('Remove 50% of liquidity');
    expect(text(html)).toMatch(/Uniswap v3 position #\d+/);
    expect(text(html)).toContain('What does the simulation do?');
    expect(html).not.toMatch(/Pool \/ Liquidity|Review before authorizing|You are authorizing|Token permission/);
    expect(html).not.toMatch(NO_AUTHORIZE);
  });

  it('Simulate result of a partial withdrawal: liquidity removed and remaining, principal and its enforced minimum, owed tokens and fees as lower bounds, the NFT, the fee', async () => {
    const { bound, observedAt, record } = await uniswap('DECREASE', 5_000);
    const html = render(bound, 'simulate', 'EN', observedAt);
    expect(html).toContain('data-review-state="ready"');
    expect(text(html)).toContain('Simulation result');
    const shown = rows(html);
    // B: the short Review — operation, protocol/network/pool, position, what comes back and its guaranteed minimum, the NFT, the fee.
    expect(shown.Operation).toBe('Remove part of the position\'s liquidity and collect');
    expect(shown.Pool).toMatch(/^Uniswap V3 · Base · \S+\/\S+ · [\d.]+%$/);
    expect(shown.Position).toBe(`#${record.review.position.tokenId} · 50%`);
    expect(shown['You receive (estimated)']).toMatch(AMOUNTS);
    expect(shown['Minimum you receive']).toMatch(AMOUNTS);
    expect(shown['Position NFT']).toBe('Stays in your wallet');
    // The one figure the owner authorizes, shown rounded UP (never below the authorized wei); the minimum rounded DOWN (never above the floor).
    const fee = record.review.fees.totalUpperBoundWei!;
    expect(shown['Network fee, at most']).toBe(displayTokenAmount({ units: fee, decimals: 18 }, { rounding: 'up', symbol: 'ETH' })!.text);
    expect(BigInt(Math.round(Number(shown['Network fee, at most']!.split(' ')[0]) * 1e18))).toBeGreaterThanOrEqual(BigInt(fee));
    const [min0, min1] = shown['Minimum you receive']!.split(' + ').map(part => Number(part.split(' ')[0]!.replace(/,/g, '')));
    expect(min0).toBeLessThanOrEqual(Number(record.review.minimums.amount0Min) / 10 ** record.review.token0.decimals);
    expect(min1).toBeLessThanOrEqual(Number(record.review.minimums.amount1Min) / 10 ** record.review.token1.decimals);
    for (const label of TECHNICAL_ROWS) expect(shown[label], label).toBeUndefined();
    // Explanations of how the figures are built are Technical details, not amber banners.
    expect(text(html)).not.toMatch(/Owed tokens and fees can include|returned to your wallet as the pool|reverts on chain if the principal/);
    // Simulate is not the authorization: no permission rows, no Review heading, no authorize control, no wallet-request row.
    expect(html).not.toMatch(/Review before authorizing|You are authorizing|Token permission|Wallet requests|Pool \/ Liquidity/);
    expect(html).not.toMatch(NO_AUTHORIZE);
    expect(text(html)).not.toMatch(NO_YIELD);
  });

  it('Execute C1: "Review before authorizing" the position Review lines — no token permission, one wallet request — and no authorize control in the panel', async () => {
    const { bound, observedAt, record } = await uniswap('EXIT', null, true);
    const html = render(bound, 'execute', 'EN', observedAt);
    expect(html).toContain('data-review-state="ready"');
    expect(text(html)).toContain('Review before authorizing');
    expect(text(html)).toMatch(/Review valid until/);
    const shown = rows(html);
    expect(shown.Operation).toBe('Remove all liquidity, collect and close the position (burns the NFT)');
    expect(shown.Pool).toMatch(/^Uniswap V3 · Base · /);
    expect(shown.Position).toBe(`#${record.review.position.tokenId} · 100%`);
    expect(shown['You receive (estimated)']).toMatch(AMOUNTS);
    expect(shown['Minimum you receive']).toMatch(AMOUNTS);
    expect(shown.Slippage).toBe('1%');
    expect(shown.Recipient).toMatch(/^Your wallet · 0x[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(shown['Position NFT']).toBe('Burned (closed)');
    expect(shown['Wallet requests']).toBe('1');
    expect(shown['Token permission']).toBe('None — this operation needs no token permission');
    for (const label of TECHNICAL_ROWS) expect(shown[label], label).toBeUndefined();
    // Material: the irreversible close stays visible, once (the operation is not repeated as a banner).
    expect(text(html)).toContain('Closing burns the position NFT. This cannot be undone.');
    expect(text(html).split('Remove all liquidity, collect and close the position').length).toBe(2);
    expect(html).not.toMatch(NO_AUTHORIZE);
    expect(text(html)).not.toMatch(NO_YIELD);
  });

  it('a collection: owed tokens and fees as a lower bound, liquidity unchanged, no principal minimum', async () => {
    const { bound, observedAt, record } = await uniswap('COLLECT');
    const shown = rows(render(bound, 'simulate', 'EN', observedAt));
    expect(shown.Operation).toBe('Collect owed tokens and fees (liquidity unchanged)');
    expect(shown.Position).toBe(`#${record.review.position.tokenId}`);
    // A collection has only a lower bound: no estimate row, no slippage, no principal minimum.
    expect(shown['You receive, at least']).toMatch(AMOUNTS);
    expect(shown['You receive (estimated)']).toBeUndefined();
    expect(shown['Minimum you receive']).toBeUndefined();
    expect(rows(render(bound, 'simulate', 'PT', observedAt))['Você recebe, no mínimo']).toMatch(AMOUNTS);
    for (const label of TECHNICAL_ROWS) expect(shown[label], label).toBeUndefined();
  });

  it('Execute C2 (expired): "Your review expired" first, the configured operation — never the expired figures — fee to refresh, no permission, one wallet request', async () => {
    const { bound, expiresAt, record } = await uniswap('DECREASE', 2_500);
    const html = render(bound, 'execute', 'EN', expiresAt + 1_000);
    expect(html).toContain('data-review-state="expired"');
    expect(text(html).indexOf('Your review expired')).toBeLessThan(text(html).indexOf('Operation summary'));
    expect(text(html)).toContain('Remove 25% of liquidity');
    expect(text(html)).toContain(`Uniswap v3 position #${record.review.position.tokenId}`);
    const shown = rows(html);
    // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001: the badge is followed by why it needs refreshing (its tooltip, also read by assistive technology).
    expect(shown['Network fee']).toMatch(/^Needs to be refreshed \. The network fee is calculated again when you refresh the review\.$/);
    expect(shown['Token permission']).toBe('None — this operation needs no token permission');
    expect(shown['Wallet requests']).toBe('1');
    // Nothing of the expired Review is presented as current.
    expect(html).not.toMatch(/Review before authorizing|You are authorizing|Expected principal returned|Minimum principal|Network fee, at most|Pool \/ Liquidity/);
    expect(html).not.toMatch(NO_AUTHORIZE);
  });

  it('PT-BR: the same Simulate result, Review and expired Review', async () => {
    const { bound, observedAt, expiresAt } = await uniswap('DECREASE', 5_000);
    const simulate = text(render(bound, 'simulate', 'PT', observedAt));
    expect(simulate).toContain('Resultado da simulação');
    for (const label of ['Operação', 'Posição', 'Você recebe (estimado)', 'Mínimo que você recebe', 'NFT da posição'])
      expect(simulate, label).toContain(label);
    // The rows' values read in Portuguese too: never "of", "per", "(unchanged)", "Your wallet", and PT decimal separators.
    const shown = rows(render(bound, 'simulate', 'PT', observedAt));
    expect(shown['Você recebe (estimado)']).toMatch(AMOUNTS);
    expect(shown['Você recebe (estimado)']).not.toMatch(/\.\d+ [A-Za-z]/);
    const valid = text(render(bound, 'execute', 'PT', observedAt));
    const authorizing = rows(render(bound, 'execute', 'PT', observedAt));
    expect(authorizing['Destinatário']).toMatch(/^Sua carteira · 0x[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(authorizing.Desvio).toBe('1%');
    expect(Object.values(authorizing).join(' ')).not.toMatch(/\bof\b|\bper\b|\(unchanged\)|\band\b.*\bto\b/);
    expect(valid).toContain('Revise antes de autorizar');
    expect(valid).toContain('Nenhuma — esta operação não precisa de permissão de token');
    expect(valid).toContain('Pedidos à carteira');
    const expired = text(render(bound, 'execute', 'PT', expiresAt + 1_000));
    expect(expired).toContain('Sua revisão expirou');
    expect(expired).toContain('Resumo da operação');
    expect(expired).toContain('Remover 50% da liquidez');
    expect(expired).toMatch(/Posição Uniswap v3 #\d+/);
    expect(`${simulate} ${valid} ${expired}`).not.toMatch(NO_YIELD);
  });
});

describe('one authorization surface (#219: authorization lives only on Execute, in the footer)', () => {
  it('the engineering Uniswap position panel is read-only: it simulates, authorizes, executes and observes nothing', () => {
    const source = readFileSync(new URL('./uniswap-liquidity-panel.tsx', import.meta.url), 'utf8');
    const panel = source.slice(source.indexOf('function UniswapPositionPanel'));
    expect(panel.length).toBeGreaterThan(500);
    expect(panel).not.toMatch(/position\.(?:simulate|refresh|review|execute|observe|switchNetwork)\(|wallet\.connect\(|<button/);
    expect(panel).toContain('data-position-panel="read-only"');
  });
});

describe('Orca position operations in the Editor', () => {
  async function orca(operation: 'COLLECT' | 'DECREASE' | 'EXIT', partBps: number | null = null) {
    const { record, workflow, mint } = await orcaPositionRun(operation, partBps);
    return { bound: { workflow, source: orcaSource(record), key: `${record.id}:${record.review.commitment}`, owner: ORCA_OWNER_WALLET.owner, chain: ORCA.chain }, mint,
      expiresAt: Date.parse(record.review.expiresAt) };
  }
  it('Simulate result of a partial withdrawal: principal and minimum, liquidity removed and remaining, fees as a lower bound, the NFT kept', async () => {
    const { bound, mint } = await orca('DECREASE', 5_000);
    const html = render(bound, 'simulate', 'EN', ORCA_CLOCK);
    expect(html).toContain('data-review-state="ready"');
    const shown = rows(html);
    const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    expect(shown.Operation).toBe('Remove part of the position\'s liquidity and collect fees');
    expect(shown.Pool).toMatch(/^Orca Whirlpools · Solana · SOL\/USDC · [\d.]+%$/);
    expect(shown.Position).toBe(`${short} · 50%`);
    expect(shown['You receive (estimated)']).toMatch(/SOL \+ .* USDC$/);
    expect(shown['Minimum you receive']).toMatch(/SOL \+ .* USDC$/);
    expect(shown['Position NFT']).toBe('Stays in your wallet');
    for (const label of [...TECHNICAL_ROWS, 'Fees collected, at least']) expect(shown[label], label).toBeUndefined();
    expect(shown['Estimated network fee']).toBe('0.000005 SOL');
    expect(html).not.toMatch(/Review before authorizing|You are authorizing|Token permission|Pool \/ Liquidity/);
    expect(html).not.toMatch(NO_AUTHORIZE);
  });
  it('Execute C1 of an exit: the position closes and its rent is refunded, no token permission, one wallet request', async () => {
    const { bound, mint } = await orca('EXIT');
    const html = render(bound, 'execute', 'EN', ORCA_CLOCK);
    expect(text(html)).toContain('Review before authorizing');
    const shown = rows(html);
    expect(shown.Operation).toBe('Remove all liquidity, collect fees and close the position; the position NFT is closed and its account rent is refunded');
    expect(shown.Pool).toMatch(/^Orca Whirlpools · Solana · /);
    expect(shown.Position).toBe(`${mint.slice(0, 4)}…${mint.slice(-4)} · 100%`);
    expect(shown.Recipient).toMatch(/^Your wallet · \S{6}…\S{4}$/);
    for (const label of TECHNICAL_ROWS) expect(shown[label], label).toBeUndefined();
    expect(shown['Position NFT']).toBe('Closed (account rent refunded)');
    expect(shown['Account rent refunded']).toMatch(/SOL$/);
    expect(shown['Wallet requests']).toBe('1');
    expect(shown['Token permission']).toBe('None — this operation needs no token permission');
    expect(html).not.toMatch(NO_AUTHORIZE);
  });
  it('a collection and the expired Review (C2), in EN and PT-BR', async () => {
    const collect = await orca('COLLECT');
    const shown = rows(render(collect.bound, 'simulate', 'EN', ORCA_CLOCK));
    expect(shown.Position).toBe(`${collect.mint.slice(0, 4)}…${collect.mint.slice(-4)}`);
    expect(shown['You receive, at least']).toMatch(/SOL \+ .* USDC$/);
    expect(shown['Minimum you receive']).toBeUndefined();
    const exit = await orca('EXIT');
    const expired = render(exit.bound, 'execute', 'EN', exit.expiresAt + 1_000);
    expect(expired).toContain('data-review-state="expired"');
    expect(text(expired)).toContain('Close position');
    expect(text(expired)).toMatch(/Orca position \S+…\S+/);
    expect(rows(expired)['Token permission']).toBe('None — this operation needs no token permission');
    expect(expired).not.toMatch(/Account rent refunded|Expected principal returned|Pool \/ Liquidity/);
    const pt = text(render(exit.bound, 'execute', 'PT', exit.expiresAt + 1_000));
    expect(pt).toContain('Sua revisão expirou');
    expect(pt).toContain('Fechar posição');
    expect(pt).toMatch(/Posição Orca \S+…\S+/);
    expect(text(render(exit.bound, 'execute', 'PT', ORCA_CLOCK))).toContain('Fechada (reserva de saldo devolvida)');
  });
});
