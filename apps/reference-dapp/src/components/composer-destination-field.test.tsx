// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 review round 2: a Bridge card's "Destination wallet". With several wallets of the destination ecosystem (CHOOSE)
 * each one is a visible button that fills the field (the datalist stays); a destination drafted on its own says "Press Enter to apply" and offers
 * Cancel, which clears the recipient draft through the card's existing cancel; `aria-describedby` only names elements that are rendered.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../state/workflow-store', () => ({ useWorkflow: () => { throw new Error('NOT_USED_BY_A_CARD_WITHOUT_POOL'); } }));
vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' } }));
const { ComposerCard, DestinationField } = await import('./composer-card');
const { LocaleProvider } = await import('../i18n/locale');
import type { CardDestination, ComposerCardData } from './composer-card';
import type { Language } from '../i18n/locale';

const PHANTOM = '8xYk2PvDDaGkR9ZnAwzXeVGkXzW1sTdQfWw3mVdKk2P1', BACKPACK = '9yZk3QwEEbHlS1aOBxaYfWHlYaX2tUeRgXx4nWeLl3Q2';
const destination = (patch: Partial<CardDestination> = {}): CardDestination => ({ network: 'Solana', value: '', auto: null, autoAddress: null,
  candidates: [{ address: PHANTOM, label: 'Solana · Phantom · 8xY…k2P1' }, { address: BACKPACK, label: 'Solana · Backpack · 9yZ…l3Q2' }],
  status: 'choose', placeholder: 'Solana address', onChange: vi.fn(), ...patch });
type FieldProps = Parameters<typeof DestinationField>[0];
const render = (props: FieldProps, language: Language = 'EN') =>
  renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: createElement(DestinationField, props) }));
/** The elements of one real render, so a button's own handler can be invoked. */
function tree(node: ReactNode, type: string | ((...args: never[]) => unknown)) {
  const found: ReactElement<Record<string, unknown> & { children?: ReactNode }>[] = [];
  const walk = (item: ReactNode): void => {
    if (Array.isArray(item)) { item.forEach(walk); return; }
    if (!isValidElement<{ children?: ReactNode }>(item)) return;
    if (item.type === type) found.push(item as (typeof found)[number]);
    walk(item.props.children);
  };
  walk(node);
  return found;
}
function fieldButtons(props: FieldProps) {
  let rendered: ReactNode = null;
  function Capture() { rendered = DestinationField(props); return null; }
  renderToStaticMarkup(createElement(Capture));
  return tree(rendered, 'button') as unknown as ReactElement<{ children: ReactNode; onClick(): void; title?: string }>[];
}
const describedBy = (html: string) => /aria-describedby="([^"]+)"/.exec(html)?.[1]?.split(' ') ?? [];
const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);

describe('BUILD-FLOFI-MAINNET-EXEC-002 Bridge card destination wallet', () => {
  it('CHOOSE: every candidate wallet is a visible button (its label) that fills the field; the datalist stays as a convenience', () => {
    const props = { destination: destination() };
    const html = render(props);
    expect(html).toContain('<div class="composer-destination-choices" role="group" aria-label="Your wallets">');
    expect(html).toContain(`<button type="button" class="composer-destination-choice" title="${PHANTOM}">Solana · Phantom · 8xY…k2P1</button>`);
    expect(html).toContain(`<button type="button" class="composer-destination-choice" title="${BACKPACK}">Solana · Backpack · 9yZ…l3Q2</button>`);
    expect(html).toMatch(/<datalist id="[^"]+-wallets"><option value="8xYk2P/);
    expect(html).toContain('Choose one of your wallets or enter an address.');
    const [phantom, backpack] = fieldButtons(props);
    phantom!.props.onClick(); expect(props.destination.onChange).toHaveBeenLastCalledWith(PHANTOM);
    backpack!.props.onClick(); expect(props.destination.onChange).toHaveBeenLastCalledWith(BACKPACK);
    // Once a wallet is in the field (or there is one automatic wallet), no choice buttons.
    expect(render({ destination: destination({ value: PHANTOM, status: 'valid', changed: true }) })).not.toContain('composer-destination-choice');
    expect(render({ destination: destination({ status: 'valid', auto: 'Solana · Phantom · 8xY…k2P1', autoAddress: PHANTOM, candidates: [] }) })).not.toContain('composer-destination-choices');
    expect(render(props, 'PT')).toContain('aria-label="Suas carteiras"');
  });
  it('a destination drafted alone shows "Press Enter to apply" and Cancel; Cancel is the card\'s own cancel', () => {
    const onCancel = vi.fn(), onCommit = vi.fn();
    const props = { destination: destination({ value: PHANTOM, status: 'valid', changed: true }), onCommit, onCancel, pending: true };
    const html = render(props);
    expect(html).toMatch(/<div class="composer-amount-actions composer-amount-direct"><span id="[^"]+-hint" class="composer-amount-hint">Press Enter to apply<\/span><button type="button" class="composer-amount-cancel">Cancel<\/button><\/div>/);
    const cancel = fieldButtons(props).find(button => button.props.children === 'Cancel');
    cancel!.props.onClick(); expect(onCancel).toHaveBeenCalledTimes(1); expect(onCommit).not.toHaveBeenCalled();
    expect(render(props, 'PT')).toContain('Pressione Enter para aplicar</span><button type="button" class="composer-amount-cancel">Cancelar</button>');
    // Not drafted, or Enter does not apply here (a reviewed proposal): no hint.
    expect(render({ ...props, pending: false })).not.toContain('Press Enter to apply');
    expect(render({ ...props, onCommit: undefined })).not.toContain('Press Enter to apply');
  });
  it('aria-describedby names only rendered elements', () => {
    const cases: FieldProps[] = [
      { destination: destination() },
      // A typed address with an automatic wallet available: the "Automatic" note is not shown, so it is not referenced.
      { destination: destination({ value: PHANTOM, status: 'valid', auto: 'Solana · Phantom · 8xY…k2P1', autoAddress: PHANTOM, candidates: [] }) },
      { destination: destination({ value: '', status: 'valid', auto: 'Solana · Phantom · 8xY…k2P1', autoAddress: PHANTOM, candidates: [] }) },
      { destination: destination({ value: '0x12', status: 'wrong-ecosystem' }) },
      { destination: destination({ value: PHANTOM, status: 'valid', changed: true }), onCommit: vi.fn(), pending: true },
    ];
    for (const props of cases) {
      const html = render(props), present = ids(html);
      for (const id of describedBy(html)) expect(present, `${props.destination.status}: ${id}`).toContain(id);
    }
    expect(describedBy(render(cases[1]!))).toEqual([]);
    expect(describedBy(render(cases[2]!))).toHaveLength(1);
    expect(describedBy(render(cases[4]!))).toHaveLength(1);
  });
  it('on the card: a destination-only draft gets the hint and Cancel (the amount editor\'s cancel); with an amount draft only the amount form says it', () => {
    const onCancel = vi.fn();
    const card = (amountChanged: boolean): ComposerCardData => ({ composer: true, step: 1, selected: false, vertical: false,
      summary: { action: 'Swap', provider: 'Uniswap', chain: 'Base (8453)', amount: '1 USDC', detail: 'USDC → WETH', bridgePair: undefined, linked: false, risk: undefined },
      validation: { findings: [], status: 'Configured', tone: 'neutral', message: undefined, next: undefined },
      cardStatus: { kind: 'configured', label: 'Configured', detail: 'Configured.' },
      amountEditor: { value: '1', changed: amountChanged, canApply: true, onChange: vi.fn(), onReview: () => null, onApply: vi.fn(), onCancel, onCommit: () => null },
      destination: destination({ value: PHANTOM, status: 'valid', changed: true }),
    } as unknown as ComposerCardData);
    const alone = renderToStaticMarkup(createElement(ComposerCard, { data: card(false) }));
    expect(alone.match(/Press Enter to apply/g)).toHaveLength(1);
    expect(alone.slice(alone.indexOf('composer-recipient composer-destination'))).toMatch(/Press Enter to apply<\/span><button type="button" class="composer-amount-cancel">Cancel<\/button>/);
    const both = renderToStaticMarkup(createElement(ComposerCard, { data: card(true) }));
    expect(both.match(/Press Enter to apply/g)).toHaveLength(1);
    expect(both.slice(both.indexOf('composer-recipient composer-destination'))).not.toContain('Press Enter to apply');
    // The card hands its existing cancel to the field: Cancel clears the drafts (the recipient's included) through it.
    let rendered: ReactNode = null;
    function Capture() { rendered = ComposerCard({ data: card(false) }); return null; }
    renderToStaticMarkup(createElement(Capture));
    const field = tree(rendered, DestinationField)[0] as ReactElement<FieldProps> | undefined;
    expect(field?.props.pending).toBe(true);
    field!.props.onCancel!(); expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
