// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps, ReactElement, SubmitEvent } from 'react';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRouterNode } from '../domain/router-authoring';
import { HookHarness } from '../test-utils/hook-harness';

const fixture = vi.hoisted(() => ({
  nodes: [] as SemanticWorkflow['nodes'],
  bridgeNetworkInputs: {} as Record<string, { source: string; destination: string }>,
  propose: vi.fn(),
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ t: (text: string) => text }) }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: { nodes: fixture.nodes, revision: 2 } },
  propose: fixture.propose, bridgeNetworkInputs: fixture.bridgeNetworkInputs }) }));
vi.mock('../state/capability-store', () => ({ authoringEnvironment: () => 'mainnet', useExecutionEnvironment: () => ({ walletEnvironment: 'mainnet' }) }));
vi.mock('../state/router-store', () => ({ useRouter: () => null }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => null }));
const { RouterForm } = await import('./router-panel');

function render(options: boolean) {
  const host = new HookHarness();
  return host.render(() => {
    const form = RouterForm({ nodeId: 'bridge', options }) as ReactElement<ComponentProps<'form'>>;
    return { form, html: renderToStaticMarkup(form) };
  });
}

describe('existing Router form keeps the authored route', () => {
  it.each([true, false])('refuses an unmatched draft pair with options=%s', options => {
    fixture.propose.mockClear();
    fixture.nodes = [createRouterNode('bridge', { source: 'Ethereum', destination: 'Robinhood Chain', token: 'USDC', amount: '5', recipient: '', slippage: '100', routing: 'AUTO' })];
    fixture.bridgeNetworkInputs = { bridge: { source: 'Ethereum', destination: 'Solana' } };
    const { form, html } = render(options);
    expect(html).toContain('Choose matching networks');
    expect(html).toContain('Recipient on Robinhood Chain');
    expect(html).not.toContain('Recipient on Arbitrum');
    expect(html).not.toContain('Base → Arbitrum One');
    expect(html).toMatch(/<button type="submit" disabled="">Review bridge change/);
    const preventDefault = vi.fn();
    form.props.onSubmit?.({ preventDefault } as Pick<SubmitEvent<HTMLFormElement>, 'preventDefault'> as SubmitEvent<HTMLFormElement>);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(fixture.propose).not.toHaveBeenCalled();
  });

  it('reviews the selected certified pair when a draft changes to one', () => {
    fixture.propose.mockClear();
    fixture.nodes = [createRouterNode('bridge', { source: 'Ethereum', destination: 'Robinhood Chain', token: 'USDC', amount: '5', recipient: '', slippage: '100', routing: 'AUTO' })];
    fixture.bridgeNetworkInputs = { bridge: { source: 'Ethereum', destination: 'Arbitrum' } };
    const { form, html } = render(true);
    expect(html).toContain('Recipient on Arbitrum One');
    expect(html).toContain('<button type="submit">Review bridge change');
    form.props.onSubmit?.({ preventDefault: vi.fn() } as Pick<SubmitEvent<HTMLFormElement>, 'preventDefault'> as SubmitEvent<HTMLFormElement>);
    expect(fixture.propose).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_ROUTER_BRIDGE', nodeId: 'bridge', input: expect.objectContaining({
      source: 'Ethereum', destination: 'Arbitrum', token: 'USDC', amount: '5',
    }) }));
  });
});
