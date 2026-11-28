// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTimeline } from './execution-timeline';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from '../domain/execution-lifecycle';
import { projectExecutionResult } from '../domain/execution-result';
import { projectExecutionStepEvidence } from '../domain/execution-step-evidence';
import { projectExecutionEvidence } from '../domain/execution-evidence';
import { ExecutionEvidenceDetails } from './execution-evidence-details';
import { reviewFixture } from '../test-utils/review-fixture';
import { LocaleProvider } from '../i18n/locale';
import { initialEditor } from '../domain/editor';
import { createUniversalBridgeFromInput } from '../domain/universal-bridge-authoring';

function render(state = 'CONFIRMED', outcome: unknown = null, restored = false) {
  const fixture = reviewFixture();
  const source = { ...fixture.source, state: { ...fixture.source.state, recoveryOnly: restored,
    run: { ...('run' in fixture.source.state ? fixture.source.state.run : {}), outcome, attempts: [{ step: 'swap', state, txHash: null }] },
  } } as unknown as ExecutionLifecycleSource;
  const progress = projectExecutionLifecycle(fixture.workflow, fixture.context, source);
  progress.stepEvidence = projectExecutionStepEvidence(source, progress);
  const backToBuild = vi.fn();
  const html = renderToStaticMarkup(createElement(ExecutionTimeline, { progress, result: projectExecutionResult(progress), workflowName: 'Approved swap', backToBuild }));
  return { html, backToBuild };
}
describe('per-step result presentation in the execution timeline', () => {
  it('shows the recorded step outcome read-only, without simulated actual values or new execution actions', () => {
    const { html, backToBuild } = render();
    expect(html).toContain('Swap result evidence'); expect(html).toContain('Step outcome'); expect(html).toContain('>Confirmed</strong>');
    expect(html).not.toMatch(/Planned and actual values|Reconciled|Recovered|Retry|<input|<select|Actual output/);
    expect(backToBuild).not.toHaveBeenCalled();
  });
  it('shows an actual comparison only when execution evidence supplies both sides', () => {
    const { html } = render('CONFIRMED', { evidence: { outcome: 'RECONCILED' }, inputSpent: '100000000', outputReceived: '24300000000000000' });
    for (const text of ['Reconciled', 'Planned and actual values', '>Planned</span>', '>Actual</span>', '0.025 WETH', '0.0243 WETH']) expect(html).toContain(text);
    expect(html).not.toMatch(/Actual network fee|View transaction/);
  });
  it('labels restored data without claiming uncertainty recovery occurred', () => {
    const { html } = render('CONFIRMED', null, true);
    expect(html).toContain('This step’s saved result was restored.'); expect(html).not.toContain('>Recovered<');
  });
  it('keeps unresolved per-step evidence separate from a confirmed result', () => {
    const { html } = render('UNKNOWN');
    expect(html).toContain('>Unresolved</strong>'); expect(html).toContain('FloFi has not yet confirmed the final state of this step.');
    expect(html).not.toMatch(/>Confirmed<|>Reconciled<|Planned and actual values|Retry/);
  });
  it('uses product language for a recorded request that was not submitted', () => {
    const fixture = reviewFixture();
    const source = { kind: 'supply', state: { record: { id: 'not-submitted', provenance: 'PUBLIC_TESTNET',
      review: { workflow: fixture.workflow, chain: fixture.wallet.chain }, notSubmitted: true,
      attempts: [{ step: 'SUPPLY', state: 'CANCELLED', transactionHash: null, reconciled: false }],
    } } } as unknown as ExecutionLifecycleSource;
    const progress = projectExecutionLifecycle(fixture.workflow, fixture.context, source);
    const html = renderToStaticMarkup(createElement(ExecutionTimeline, { progress, result: projectExecutionResult(progress), workflowName: 'Not submitted', backToBuild: vi.fn() }));
    expect(html).toContain('This request was recorded as not submitted.');
    expect(html).not.toMatch(/runtime|journal|Retry|View transaction/);
  });
  it('renders real identifiers and full technical records while retaining approval/action separation', () => {
    const fixture = reviewFixture(), a = '0x' + 'a'.repeat(64), b = '0x' + 'b'.repeat(64);
    const current = { ...fixture.source, state: { ...fixture.source.state, run: { ...('run' in fixture.source.state ? fixture.source.state.run : {}), attempts: [{ step: 'approval', state: 'CONFIRMED', txHash: a }, { step: 'swap', state: 'REVERTED', txHash: b }] } } } as unknown as ExecutionLifecycleSource;
    const progress = projectExecutionLifecycle(fixture.workflow, fixture.context, current);
    progress.evidence = projectExecutionEvidence(current, progress);
    const html = renderToStaticMarkup(createElement(ExecutionTimeline, { progress, result: projectExecutionResult(progress), workflowName: 'Run', backToBuild: vi.fn() }));
    expect(html).toContain('Approval transaction'); expect(html).toContain('Action transaction'); expect(html).toContain('Transaction reverted');
    expect(html).toContain(`title="${b}"`); expect(html).toContain('0xbbbbbb…bbbbbb'); expect(html).not.toMatch(/Retry|Known network cost|Actual received/);
    const technical = renderToStaticMarkup(createElement(ExecutionEvidenceDetails, { progress }));
    expect(technical).toContain(`>${b}</span>`); expect(technical).not.toContain('<pre');
  });
});

// BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R06/R07): the owner's Ethereum → Robinhood Chain bridge, as its "Execution details" read while the
// delivery awaits finality, once it is reconciled and once refunded. Every recorded amount reads at six significant digits; the exact value stays
// one tap away and in the evidence itself.
describe('six significant digits in the Execution details of a universal bridge', () => {
  const deposit = `0x${'d'.repeat(64)}`, fill = `0x${'e'.repeat(64)}`, owner = `0x${'1'.repeat(40)}`;
  const bridge = { ...initialEditor().workflow, revision: 1, resourceEdges: [], nodes: [createUniversalBridgeFromInput('bridge', { source: 'ethereum', destination: 'robinhood',
    inputAsset: 'ETH', outputAsset: 'ETH', amount: '0.057923834925903535', recipient: '', slippage: '50', routing: 'RELAY' })] };
  const nodeId = bridge.nodes[0]!.nodeId;
  const eth = { kind: 'NATIVE', decimals: 18, symbol: 'ETH' };
  function universal(over: Record<string, unknown> = {}) {
    const record = { id: 'universal-run', workflow: bridge, provenance: 'PUBLIC_MAINNET', owner, phase: 'DESTINATION_OBSERVED', verdict: 'PENDING',
      review: { nodeId, commitment: 'reviewed', source: { ecosystem: 'EVM', calls: [{ purpose: 'BRIDGE_DEPOSIT' }] },
        route: { provider: 'relay', sourceChain: 'eip155:1', destinationChain: 'eip155:4663', order: { orderId: 'relay-order' }, inputToken: eth, outputToken: eth,
          inputAmount: '57923834925903535', expectedOutput: '57900000000000000' } },
      attempts: [{ step: 'DEPOSIT', ecosystem: 'EVM', state: 'CONFIRMED', transactionHash: deposit, reconciled: true, commitment: 'reviewed',
        receipt: { transactionHash: deposit, gasCostWei: '39961699395000574', from: owner } }],
      source: { ownerDebit: '57923834925903535', final: false }, destination: { transactionHash: fill, amount: '57923834925903535', final: false },
      refund: null, observation: null, allowanceObservation: undefined, ...over };
    const current = { kind: 'universal', state: { record, busy: false, signing: false, recovered: false } } as unknown as ExecutionLifecycleSource;
    const progress = projectExecutionLifecycle(bridge, reviewFixture().context, current);
    progress.evidence = projectExecutionEvidence(current, progress);
    progress.stepEvidence = projectExecutionStepEvidence(current, progress);
    return progress;
  }
  const html = (progress: ReturnType<typeof universal>, language: 'EN' | 'PT' = 'EN') => renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language,
    children: createElement(ExecutionTimeline, { progress, result: projectExecutionResult(progress), workflowName: 'Bridge', embedded: true }) }));
  it('awaiting finality: the source debit, the observed delivery and the network fee read 0.0579238 / 0.0399617 ETH, never 18 recorded digits', () => {
    const progress = universal();
    // The evidence itself stays exact (Technical details, copy); only its presentation is shortened.
    expect(progress.evidence!.operations.DEPOSIT!.values).toContainEqual({ label: 'Source debit confirmed · awaiting finality', value: '0.057923834925903535 ETH' });
    const text = html(progress);
    for (const label of ['Source debit confirmed · awaiting finality', 'Destination amount observed · awaiting reconciliation']) expect(text).toContain(label);
    expect(text).toContain('>≈ 0.0579238 ETH</button>'); expect(text).toContain('>≈ 0.0399617 ETH</button>');
    // The exact recorded value is one tap away (the disclosure's title), never the visible text.
    expect(text).toContain('title="0.057923834925903535 ETH"'); expect(text).toContain('title="0.039961699395000574 ETH"');
    expect(text).not.toMatch(/>0\.057923834925903535 ETH</); expect(text).not.toMatch(/>0\.039961699395000574 ETH</);
  });
  it('reconciled: "Actual received" and the planned/actual comparison follow the same rule, without trailing zeros; PT uses the decimal comma', () => {
    const progress = universal({ phase: 'RECONCILED', verdict: 'RECONCILED', source: { ownerDebit: '57923834925903535', final: true },
      destination: { transactionHash: fill, amount: '40000000000000000', final: true } });
    const text = html(progress);
    expect(text).toContain('Actual received'); expect(text).toMatch(/>0\.04 ETH</); expect(text).not.toMatch(/0\.0400000/);
    expect(text).toContain('Planned and actual values'); expect(text).toContain('>≈ 0.0579238 ETH</button>');
    const pt = html(progress, 'PT');
    expect(pt).toContain('>≈ 0,0579238 ETH</button>'); expect(pt).toMatch(/>0,04 ETH</);
  });
  it('a verified refund and a tiny amount never read as zero', () => {
    const progress = universal({ phase: 'REFUNDED', verdict: 'REFUNDED', destination: null, refund: { transactionHash: fill, chainId: 'eip155:1', amount: '123456789' } });
    const text = html(progress);
    expect(text).toContain('Verified refund'); expect(text).toContain('>≈ 0.000000000123457 ETH</button>');
  });
});
