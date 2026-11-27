// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02 review F3): Escape on the Batch Payment card. It cancels a saved step's draft (the step keeps what it
 * had) and a brand-new card nobody has edited yet; it never throws away a new card whose recipients were typed (they could not be brought back): that
 * card's explicit Cancel does. The card's own key handler is driven directly (a hook emulator, no DOM); nothing is applied, signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { HookHarness } from '../test-utils/hook-harness';
import { checkBatchPaymentDraft, defaultBatchPaymentDraft, type BatchPaymentInput } from '../domain/batch-payment-authoring';
import type { BatchPaymentCardData } from './batch-payment-fields';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks, useId: () => 'batch' }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ t: (key: string) => key }) }));
const { BatchPaymentFields } = await import('./batch-payment-fields');

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const SAVED: BatchPaymentInput = { network: 'Base', asset: 'USDC', payments: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }] };
const data = (patch: Partial<BatchPaymentCardData>, draft: BatchPaymentInput = defaultBatchPaymentDraft()): BatchPaymentCardData => ({
  network: draft.network, asset: draft.asset, networks: ['Base'], assets: ['USDC'], rows: draft.payments, minRecipients: 2, maxRecipients: 8,
  check: checkBatchPaymentDraft(draft), changed: true, saved: false, fresh: true, applyLabel: 'Apply batch payment',
  onNetwork: vi.fn(), onAsset: vi.fn(), onRow: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onSameAmount: vi.fn(), onApply: vi.fn(() => null), onCancel: vi.fn(), ...patch });

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
/** The first element of the rendered tree the predicate accepts. */
function find(node: ReactNode, accept: (element: Element) => boolean): Element | null {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, accept); if (found) return found; } return null; }
  if (!node || typeof node !== 'object' || !('props' in node)) return null;
  const element = node as Element;
  return accept(element) ? element : find(element.props.children, accept);
}
let host: HookHarness;
const render = (batch: BatchPaymentCardData) => host.render(() => BatchPaymentFields({ batch }) as Element);
const escape = (form: Element) => {
  const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (form.props.onKeyDown as (e: typeof event) => void)(event);
  return event;
};
beforeEach(() => { host = new HookHarness(); });
afterEach(() => host.unmount());

describe('F3: Escape on the Batch Payment card never discards typed recipients', () => {
  it('a brand-new card nobody has edited goes away on Escape (nothing typed is lost)', () => {
    const batch = data({});
    const event = escape(render(batch));
    expect(batch.onCancel).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('an edited new card stays on Escape with its recipients; its explicit Cancel still discards it', () => {
    // Edited as the store records it (`fresh` false once the draft changed).
    const edited = data({ fresh: false }, { ...SAVED });
    const form = render(edited);
    const event = escape(form);
    expect(edited.onCancel).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    const cancel = find(form, element => element.type === 'button' && element.props.children === 'Cancel')!;
    (cancel.props.onClick as () => void)();
    expect(edited.onCancel).toHaveBeenCalledTimes(1);
    // Typed into in this render, before the store's `fresh` follows: the card's own edit already holds Escape back.
    const typing = data({});
    const before = render(typing);
    const address = find(before, element => element.type === 'input' && element.props['aria-label'] === 'Recipient {0} address')!;
    (address.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: A } });
    expect(typing.onRow).toHaveBeenCalledWith(0, 'recipient', A);
    escape(render(typing));
    expect(typing.onCancel).not.toHaveBeenCalled();
  });

  it('a saved step\'s draft is cancelled on Escape (the step keeps what it had); a saved step without a draft has nothing to cancel', () => {
    const draft = data({ saved: true, fresh: false, applyLabel: 'Apply changes' }, { ...SAVED, payments: [SAVED.payments[0]!, { recipient: B, amount: '60' }] });
    escape(render(draft));
    expect(draft.onCancel).toHaveBeenCalledTimes(1);
    host.unmount(); host = new HookHarness();
    const clean = data({ saved: true, fresh: false, changed: false }, SAVED);
    escape(render(clean));
    expect(clean.onCancel).not.toHaveBeenCalled();
  });
});
