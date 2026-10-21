// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SigningSurface } from './signing-surface';
import { useExecutionControls, type ExecutionControlsState } from '../state/execution-controls';
import { reviewFixture, reviewNow, reviewSpender } from '../test-utils/review-fixture';
import { solanaTransferReviewFixture } from '../test-utils/solana-transfer-review-fixture';
import { SOLANA_DEVNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { LocaleProvider, type Language } from '../i18n/locale';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { composeStrategy } from '../engine/strategy-engine';

function View({ data }: { data: ExecutionControlsState }) {
  const controls = useExecutionControls(data);
  return <SigningSurface {...data} controls={controls} workflowName="Requested operation" gated={false} simulationDisabled={false} simulate={vi.fn()}/>;
}
const render = (data: ExecutionControlsState, language: Language = 'EN') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}><View data={data}/></LocaleProvider>);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(reviewNow); });
afterEach(() => vi.useRealTimers());
describe('shared chat-first signing surface', () => {
  it('shows the simulated swap outcome and minimum output before authorization', () => {
    const html = render({ ...reviewFixture(), execution: { ready: true, started: false, start: vi.fn(), prompt: null, expiresAt: null } });
    expect(html).toContain('0.025 WETH'); expect(html).toContain('Minimum received'); expect(html).toContain('0.024875 WETH');
    expect(render({ ...reviewFixture(), execution: { ready: false, started: false, start: null, prompt: null, expiresAt: null } }, 'PT')).toContain('Mínimo recebido');
  });
  it('keeps Mainnet real-funds disclosure when a Solana wallet is on Devnet', async () => {
    const data = await solanaTransferReviewFixture();
    data.wallet = { ...data.wallet, chain: SOLANA_DEVNET_TRANSFER.chain, environment: 'testnet' };
    const html = render(data);
    expect(html).toContain('Mainnet · Real funds'); expect(html).not.toContain('Public testnet · Test funds');
    expect(html).toContain('Connect on the reviewed network');
  });
  it('keeps a testnet proposal classified as test funds when an EVM wallet is on Mainnet', () => {
    const data: ExecutionControlsState = { ...reviewFixture(), execution: { ready: false, started: false, start: null, prompt: null, expiresAt: null } };
    data.wallet = { ...data.wallet, chain: 'eip155:1', environment: 'mainnet' };
    const html = render(data);
    expect(html).toContain('Public testnet · Test funds'); expect(html).not.toContain('Mainnet · Real funds');
  });
  it('discloses an existing ATA recreation deposit as a maximum, separately from the network fee', async () => {
    const data = await solanaTransferReviewFixture(undefined, true); data.authorization.approve = vi.fn(); data.execution.start = vi.fn();
    const html = render(data);
    expect(html).toContain('Maximum token account deposit'); expect(html).toContain('Only paid if the recipient token account must be recreated');
    expect(html).toContain('Estimated network fee'); expect(html).not.toContain('Opens the recipient&#x27;s token account; paid once');
    expect(render(data, 'PT')).toContain('Depósito máximo da conta de token');
    expect(data.execution.start).not.toHaveBeenCalled();
  });
  it.each([undefined, SOLANA_DEVNET_TRANSFER])('shows the exact Solana transfer, full accounts, mint, fees and rent before one authorization (%s)', async profile => {
    const data = await solanaTransferReviewFixture(profile); data.authorization.approve = vi.fn(); data.execution.start = vi.fn();
    const html = render(data), record = data.source.kind === 'solana-transfer' ? data.source.state.record! : null;
    for (const value of [data.wallet.account!, record!.review.recipient, record!.review.asset.mint!, '1.5', 'Estimated network fee', 'Recipient token account deposit', 'Authorize in wallet']) expect(html).toContain(value);
    expect(html).not.toMatch(/mock-read|mock:local|type="checkbox"|Workflow stages|Back to Build|Credentials|beta-notice/);
    expect(data.authorization.approve).not.toHaveBeenCalled(); expect(data.execution.start).not.toHaveBeenCalled();
    expect(render(data, 'PT')).toContain('Autorizar na carteira'); expect(render(data, 'PT')).toContain('Destinatário');
  });
  it('keeps EVM allowance amounts, full spender addresses and unlimited-allowance risk visible', () => {
    const data: ExecutionControlsState = { ...reviewFixture(), execution: { ready: true, started: false, start: vi.fn(), prompt: null, expiresAt: null } };
    data.authorization.approvals = [{ token: reviewSpender, chain: data.wallet.chain!, spender: reviewSpender, amount: ((1n << 256n) - 1n).toString(), kind: 'exact' }];
    const html = render(data);
    expect(html).toContain('Token approvals'); expect(html).toContain(reviewSpender); expect(html).toContain('Unlimited approval'); expect(html).toContain('until changed or revoked');
    expect(data.execution.start).not.toHaveBeenCalled();
  });
  it.each(STRATEGY_EXAMPLES.map(example => [example.id, example.strategy] as const))('renders the requested %s action without internal template cards', (_id, strategy) => {
    const composition = composeStrategy(strategy); expect(composition.ok).toBe(true); if (!composition.ok) return;
    const fixture = reviewFixture();
    const data: ExecutionControlsState = { ...fixture, workflow: composition.workflow, authorization: { ...fixture.authorization, key: null, ready: false, manifest: null, policy: null },
      source: { kind: 'unavailable', state: { busy: false, error: null } }, execution: { ready: false, started: false, start: vi.fn(), prompt: null, expiresAt: null } };
    const html = render(data);
    expect(html).toContain('Requested actions'); expect(html).not.toMatch(/mock-read|mock:local|sample units|type="checkbox"|beta-notice/);
    expect(data.execution.start).not.toHaveBeenCalled();
  });
});
