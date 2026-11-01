// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ROUTER_PHASES, UNIVERSAL_NETWORKS, type RouteChange, type RouterPhase, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { bridgeFailureMessage } from '../domain/bridge-failure';
import { useLocale } from '../i18n/locale';
import { useWorkflow } from '../state/workflow-store';
import { useUniversalRouter } from '../state/universal-router-store';
import { createUniversalBridgeFromInput, resolveUniversalAsset, universalAssetResolves, universalBridgeDetails,
  universalFeaturedAssets, universalInputOf, UNIVERSAL_BRIDGE_DEFAULT_SLIPPAGE, UNIVERSAL_BRIDGE_NETWORKS, UNIVERSAL_BRIDGE_ROUTING_LABEL,
  type UniversalBridgeInput, type UniversalBridgeRouting } from '../domain/universal-bridge-authoring';
import { formatSlippage } from '../domain/slippage-policy';
import { formatTokenAmount } from '../domain/jupiter-authoring';
import { TokenAmountInput } from './token-amount-input';
import { AssetSearch } from './asset-search';
import { SolanaVerifiedAssetSearch } from './solana-verified-asset-search';
import { PendingExecutionNote } from './execution-concurrency-notes';
import type { DiscoveryCandidate } from '../server/universal-router/discovery';

/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal bridge on the Canvas — any of the five mainnets to any other, any provider-supported asset on
 * either side. The form authors the canonical node; "Find routes" asks every provider and shows each answer with its status and reason; the
 * panel simulates the exact source transaction, shows the Review (route, provider order, guaranteed minimum, every fee, signatures needed),
 * and after the owner's acceptance asks the source wallet for exactly the reviewed request. FloFi never signs.
 *
 * BUILD-FLOFI-PRODUCT-UX-001: source and destination assets are independent searchable selectors over FloFi's catalogs (parity with Swap), not a
 * three-token hard-coded list. Selecting a catalog asset never invents a route — discovery still reports executable, quote-only, no liquidity, or provider failure.
 */
const amountOf = (units: string | null | undefined, decimals: number, symbol: string) => units ? `${formatTokenAmount(units, decimals)} ${symbol}` : '--';
const short = (account: string) => account.length > 14 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
const LIFECYCLE: readonly RouterPhase[] = ['PREPARED', 'AUTHORIZED', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'RECONCILED'];
const STATUS_LABEL: Readonly<Record<DiscoveryCandidate['status'], string>> = { INTERNAL_ERROR: 'Internal quote error', EXECUTABLE: 'Builder verified · simulation and Review still required', LIVE_QUOTE: 'Live quote only', SUPPORTED_BY_PROVIDER: 'Supported, no quote',
  TEMPORARILY_UNAVAILABLE: 'Temporarily unavailable', NO_ROUTE: 'No route', BELOW_MINIMUM: 'Below provider minimum', ABOVE_MAXIMUM: 'Above provider maximum', INSUFFICIENT_LIQUIDITY: 'Insufficient liquidity' };
const PROVIDER_LABEL: Readonly<Record<string, string>> = { relay: 'Relay', lifi: 'LI.FI', mayan: 'Mayan', across: 'Across' };
/** User-facing reasons for stable codes; anything else shows the code itself. */
const REASONS: Readonly<Record<string, string>> = {
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the discovery window closed before this provider answered; it was not compared.
  RELAY_DISCOVERY_WINDOW_ELAPSED: 'Did not answer within the comparison window.', LIFI_DISCOVERY_WINDOW_ELAPSED: 'Did not answer within the comparison window.',
  MAYAN_DISCOVERY_WINDOW_ELAPSED: 'Did not answer within the comparison window.', ACROSS_DISCOVERY_WINDOW_ELAPSED: 'Did not answer within the comparison window.',
  LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED: 'FloFi cannot yet verify this bridge\'s transactions independently, so it is shown for comparison only.',
  MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED: 'Mayan transactions are built by its SDK; FloFi has no verified builder yet, so this quote is for comparison only.',
  ACROSS_EXECUTES_ON_CERTIFIED_ROUTER_PAIRS_ONLY: 'Across executes through the certified Router for its USDC/USDG pairs only.',
  ACROSS_NETWORK_UNSUPPORTED: 'Across has no route for this network.', MAYAN_NETWORK_UNSUPPORTED: 'Mayan does not serve this network.',
  RELAY_NO_ROUTE: 'The provider has no route or liquidity for this pair right now.', RELAY_AMOUNT_TOO_LOW: 'The amount is below the provider minimum.',
  RELAY_AMOUNT_TOO_HIGH: 'The amount is above the provider maximum.', UNIVERSAL_PROVIDER_UNAVAILABLE: 'The provider could not be reached. Try again shortly.',
  UNIVERSAL_PROVIDER_RATE_LIMITED: 'The provider is rate limiting requests. Try again shortly.', LIFI_NO_ROUTE: 'LI.FI has no route for this pair right now.',
  MAYAN_NO_ROUTE: 'Mayan has no route for this pair right now.',
};
const MESSAGES: Readonly<Record<string, string>> = {
  UNIVERSAL_ROUTER_NOT_ENABLED: 'The universal Cross-chain Router is not enabled on this server.', UNIVERSAL_STORAGE_NOT_CONFIGURED: 'Execution storage is not configured on this server.',
  UNIVERSAL_EXECUTION_NOT_ENABLED: 'Owner execution is not enabled on this server. Route discovery, quotes, simulation and Review remain read-only.',
  UNIVERSAL_WALLET_REQUIRED: 'Connect your wallet first.', UNIVERSAL_SOLANA_WALLET_REQUIRED: 'Connect your Solana wallet first.',
  UNIVERSAL_DESTINATION_WALLET_REQUIRED: 'Connect your wallet on the destination network, or enter a recipient address in the bridge.',
  UNIVERSAL_WRONG_CHAIN: 'Switch your wallet to the source network.', UNIVERSAL_WRONG_OWNER: 'Select the wallet account shown in Review.',
  UNIVERSAL_REVIEW_REQUIRED: 'Accept the current Review first.', UNIVERSAL_REVIEW_EXPIRED: 'This Review expired. Get a fresh route and review again.',
  ROUTE_CHANGED: 'The provider no longer offers the reviewed route. Your authorization was cleared and nothing was sent. Get a fresh route, then review it.',
  UNIVERSAL_REQUOTE_REQUIRED: 'A fresh route and Review are required before you can authorize again.',
  UNIVERSAL_STATE_CHANGED_REVIEW_REQUIRED: 'Chain state changed materially since Review. Your authorization was cleared and nothing was sent.',
  UNIVERSAL_ROUTE_REVALIDATION_UNAVAILABLE: 'The provider could not confirm the reviewed route right now. Nothing was sent; try again shortly.',
  UNIVERSAL_NO_EXECUTABLE_ROUTE: 'No provider returned a route FloFi can verify and execute for this bridge. See the routes found for the reasons.',
  UNIVERSAL_INSUFFICIENT_TOKEN: 'Your wallet needs more of the source asset for this bridge.', UNIVERSAL_INSUFFICIENT_NATIVE: 'Your wallet needs more of the source asset for this bridge.',
  UNIVERSAL_INSUFFICIENT_GAS: 'Your wallet needs more native coin on the source network for network fees.',
  UNIVERSAL_INSUFFICIENT_SOL_FOR_FEES: 'Your Solana wallet needs more SOL for the network fee.',
  UNIVERSAL_SIMULATION_UNAVAILABLE: 'The network provider cannot simulate this transaction right now. Nothing was signed.',
  UNIVERSAL_SIMULATION_DEPOSIT_REVERTED: 'The simulation of the bridge deposit failed. Nothing was signed.',
  UNIVERSAL_UNEXPECTED_CONTRACT: 'A bridge contract does not match its verified deployment. Nothing was signed.',
  UNIVERSAL_OWNER_NONCE_IN_USE: 'An earlier request from this wallet is still open in your wallet and holds the next transaction slot. Confirm or reject it, then try again.',
  UNIVERSAL_ORDER_IN_FLIGHT_SIMULATE_AGAIN: 'This exact provider order is already handled by another FloFi run. Get a new route for a separate bridge.',
  UNIVERSAL_ATTEMPT_ACTIVE_OBSERVE_EXISTING: 'A transaction is still being observed. Check it before continuing.',
  UNIVERSAL_SUBMISSION_UNKNOWN_OBSERVE_EXISTING: 'The wallet result is unknown. FloFi is observing the network and will not send another request.',
  UNIVERSAL_REJECTED: 'You declined the request in your wallet. Nothing was sent.', UNIVERSAL_WALLET_REJECTED: 'You declined the request in your wallet. Nothing was sent.',
  UNIVERSAL_TRANSACTION_CHANGED: 'Your wallet returned a different transaction than the reviewed one. It was not broadcast.',
  UNIVERSAL_TRANSACTION_PENDING: 'The transaction is pending on the source network.', UNIVERSAL_TRANSACTION_NOT_OBSERVED: 'No transaction is visible yet. Observe again; nothing will be resent.',
  UNIVERSAL_AWAITING_SOURCE_FINALITY: 'The deposit is waiting for finality on the source network.',
  UNIVERSAL_DESTINATION_PENDING: 'The deposit is confirmed. Waiting for the delivery on the destination network.',
  UNIVERSAL_DELIVERY_DELAYED: 'The delivery is taking longer than expected. FloFi keeps observing and will verify a late delivery or a refund.',
  UNIVERSAL_PROVIDER_REPORTED_FAILURE_REFUND_EXPECTED: 'The provider reported a failure. A refund is expected; FloFi will verify it on chain.',
  UNIVERSAL_REFUND_NOT_OBSERVED: 'Waiting for the refund to be visible on chain.', UNIVERSAL_AWAITING_FINALITY: 'The delivery is observed. Waiting for finality before success.',
  UNIVERSAL_DELIVERY_BELOW_MINIMUM: 'The delivery is below the reviewed minimum. The run needs your attention.',
  UNIVERSAL_DELIVERY_RECIPIENT_MISMATCH: 'The referenced delivery did not credit the reviewed recipient. The run needs your attention.',
  UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE: 'The delivery could not be verified independently yet. FloFi keeps observing.',
  UNIVERSAL_DEPOSIT_REVERTED: 'The deposit reverted on the source network; nothing was bridged.',
  UNIVERSAL_TRANSACTION_EXPIRED_NOT_EXECUTED: 'The transaction expired without executing. Nothing was bridged. Get a fresh route to try again.',
  WALLET_SESSION_REQUIRED: 'Sign in with your wallet first. Signing in moves no funds and authorizes no transaction.',
  RUN_OWNER_MISMATCH: 'This run belongs to another wallet. Only the wallet that created it can open or continue it.',
};
const CHANGE: Readonly<Record<RouteChange, string>> = { CHAIN_CHANGED: 'chain', TOKEN_CHANGED: 'token', AMOUNT_CHANGED: 'amount', RECIPIENT_CHANGED: 'recipient',
  DEPOSITOR_CHANGED: 'depositor', REFUND_ADDRESS_CHANGED: 'refund address', PROVIDER_CHANGED: 'provider', PROTOCOL_CHANGED: 'protocol', STEPS_CHANGED: 'route steps',
  FEES_OUT_OF_BOUNDS: 'fees', FEE_RECIPIENT_CHANGED: 'fee recipient', MINIMUM_OUTPUT_DECREASED: 'lower expected delivery', SLIPPAGE_CHANGED: 'slippage',
  APPROVAL_CHANGED: 'approval', TRANSACTION_TARGET_CHANGED: 'transaction target', TRANSACTION_FUNCTION_CHANGED: 'transaction function', VALUE_CHANGED: 'value',
  BRIDGE_CONTRACT_CHANGED: 'bridge contract', BRIDGE_MESSAGE_CHANGED: 'destination message', CALLDATA_CHANGED: 'calldata', QUOTE_CHANGED: 'quote', DEADLINE_CHANGED: 'deadline' };

/** Independent source/destination asset field: catalog search on EVM, verified Solana tokens, plus free-form `address@decimals`. */
function UniversalAssetPicker({ networkKey, value, onChange, label, inputLabel }: {
  networkKey: UniversalNetworkKey; value: string; onChange(asset: string): void; label: string; inputLabel: string;
}): ReactNode {
  const { t: tr } = useLocale();
  const network = UNIVERSAL_NETWORKS[networkKey];
  const featured = universalFeaturedAssets(networkKey);
  const selected = (() => { try { return resolveUniversalAsset(networkKey, value).symbol; } catch { return undefined; } })();
  return <div className="universal-asset-picker">
    <label>{label}<input aria-label={inputLabel} autoComplete="off" spellCheck={false} maxLength={80} value={value}
      onChange={e => onChange(e.target.value)}/></label>
    <div className="universal-asset-shortcuts" role="group" aria-label={tr('{0} shortcuts', network.name)}>
      {featured.map(symbol => <button key={symbol} type="button" className="quiet" aria-pressed={selected === symbol}
        onClick={() => onChange(symbol)}>{symbol}</button>)}
    </div>
    {network.ecosystem === 'EVM'
      ? <AssetSearch chain={network.chain} selected={selected} onSelect={onChange} copy={{
        heading: tr('Search assets'), searchLabel: tr('Search {0} tokens', network.name), placeholder: tr('Search by symbol, name or contract…'),
        loading: tr('Loading {0} tokens…', network.name), unavailable: tr('{0} tokens are unavailable right now.', network.name),
        retry: tr('Try again'), empty: tr('No token matches this search.'), results: tr('{0} token results', network.name),
        total: count => tr('{0} tokens · type to search', count) }}/>
      : <>
        <SolanaVerifiedAssetSearch selected={selected} onSelect={onChange} copy={{
          heading: tr('Search assets'), searchLabel: tr('Search Solana tokens'), placeholder: tr('Search by symbol or mint…'),
          loading: tr('Loading Solana tokens…'), unavailable: tr('Solana tokens are unavailable right now.'),
          retry: tr('Try again'), empty: tr('No verified Solana token matches this search.'), results: tr('Solana token results'),
          excluded: count => tr('{0} entries excluded because display metadata is incomplete.', count), total: count => tr('{0} verified Solana tokens · type to search', count) }}/>
        <small>{tr('Jupiter verified tokens. Mint identity and decimals are checked on chain at Simulate. A match does not guarantee a route.')}</small>
      </>}
  </div>;
}

/** Canvas form for the universal bridge node (create, or edit an existing one). */
export function UniversalBridgeForm({ nodeId, onDone }: { nodeId?: string; onDone?: () => void }) {
  const { t: tr } = useLocale();
  const { state, propose } = useWorkflow();
  const node = state.workflow.nodes.find(n => n.nodeId === nodeId), existing = node ? universalBridgeDetails(node) : null;
  const [input, setInput] = useState<UniversalBridgeInput>(existing ? universalInputOf(existing)
    : { source: 'solana', destination: 'base', inputAsset: 'USDC', outputAsset: 'USDC', amount: '', recipient: '', slippage: UNIVERSAL_BRIDGE_DEFAULT_SLIPPAGE, routing: 'BEST' });
  const [error, setError] = useState('');
  const set = (patch: Partial<UniversalBridgeInput>) => setInput(value => {
    const next = { ...value, ...patch };
    // A source token change never changes the independently selected destination token.
    // Clear a token that does not exist on a new network so the owner can select one explicitly.
    if (next.source === next.destination) next.destination = UNIVERSAL_BRIDGE_NETWORKS.find(n => n.key !== next.source)!.key;
    if (patch.source && !universalAssetResolves(next.source, next.inputAsset)) next.inputAsset = '';
    if (!universalAssetResolves(next.destination, next.outputAsset)) next.outputAsset = '';
    return next;
  });
  const cross = UNIVERSAL_NETWORKS[input.source].ecosystem !== UNIVERSAL_NETWORKS[input.destination].ecosystem;
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      createUniversalBridgeFromInput(nodeId ?? 'node-preview', input); setError('');
      propose(nodeId ? { type: 'SET_UNIVERSAL_BRIDGE', nodeId, input, source: 'CANVAS', baseRevision: state.workflow.revision }
        : { type: 'ADD_UNIVERSAL_BRIDGE', input, source: 'CANVAS', baseRevision: state.workflow.revision });
      onDone?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'UNIVERSAL_BRIDGE_INPUT_INVALID'); }
  }
  return <form className="inspector-fields universal-bridge-form" aria-label={tr(nodeId ? 'Edit universal bridge' : 'Create universal bridge')} onSubmit={submit}>
    <p className="muted">{tr('Universal Cross-chain Router · any FloFi mainnet to any other · real funds. Routes are discovered live; the one you authorize is shown at Review.')}</p>
    <label>{tr('Source network')}<select aria-label={tr('Universal bridge source network')} value={input.source} onChange={e => set({ source: e.target.value as UniversalNetworkKey })}>
      {UNIVERSAL_BRIDGE_NETWORKS.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}</select></label>
    <UniversalAssetPicker networkKey={input.source} value={input.inputAsset} onChange={inputAsset => set({ inputAsset })}
      label={tr('Source asset')} inputLabel={tr('Universal bridge source asset')}/>
    <label>{tr('Destination network')}<select aria-label={tr('Universal bridge destination network')} value={input.destination}
      onChange={e => set({ destination: e.target.value as UniversalNetworkKey })}>
      {UNIVERSAL_BRIDGE_NETWORKS.filter(n => n.key !== input.source).map(n => <option key={n.key} value={n.key}>{n.label}</option>)}</select></label>
    <UniversalAssetPicker networkKey={input.destination} value={input.outputAsset} onChange={outputAsset => set({ outputAsset })}
      label={tr('Destination asset')} inputLabel={tr('Universal bridge destination asset')}/>
    <small>{tr('Any catalog asset by symbol or name, or a contract / mint written as address@decimals (identity verified on chain at Simulate). A valid asset does not guarantee a route.')}</small>
    <label>{tr('Amount')}<TokenAmountInput aria-label={tr('Universal bridge amount')} maxLength={40} value={input.amount} onValueChange={amount => set({ amount })}/></label>
    <label>{tr('Recipient')}<input aria-label={tr('Universal bridge recipient')} autoComplete="off" spellCheck={false} maxLength={80} value={input.recipient}
      placeholder={tr(cross ? 'Your connected destination wallet' : 'Your connected wallet')} onChange={e => set({ recipient: e.target.value })}/></label>
    <label>{tr('Routing')}<select aria-label={tr('Universal bridge routing')} value={input.routing} onChange={e => set({ routing: e.target.value as UniversalBridgeRouting })}>
      {(Object.keys(UNIVERSAL_BRIDGE_ROUTING_LABEL) as UniversalBridgeRouting[]).map(k => <option key={k} value={k}>{tr(UNIVERSAL_BRIDGE_ROUTING_LABEL[k])}</option>)}</select></label>
    <label>{tr('Slippage (bps)')}<input aria-label={tr('Universal bridge slippage (bps)')} inputMode="numeric" autoComplete="off" maxLength={3} value={input.slippage}
      onChange={e => set({ slippage: e.target.value })}/></label>
    <small>{tr('Shown as')} {formatSlippage(input.slippage)}. {tr('The guaranteed minimum you receive is fixed in the reviewed provider order. Provider fees are listed at Review. FloFi records a 0.1% fee obligation on each completed workflow; collection is not settled on-chain yet.')}</small>
    {error && <p role="alert">{tr(MESSAGES[error] ?? error)}</p>}
    <button type="submit">{tr(nodeId ? 'Review bridge change' : 'Review bridge proposal')}</button>
    {onDone && <button type="button" className="quiet" onClick={onDone}>{tr('Cancel')}</button>}
  </form>;
}

/** Every provider's answer for the authored pair, with status and reason; executable routes can be chosen as the bridge's provider. */
function RouteDiscovery() {
  const { t: tr } = useLocale();
  const router = useUniversalRouter(), { state, propose } = useWorkflow(), d = router.details;
  if (!d) return null;
  const node = state.workflow.nodes.find(n => universalBridgeDetails(n));
  const choose = (routing: UniversalBridgeRouting) => node && propose({ type: 'SET_UNIVERSAL_BRIDGE', nodeId: node.nodeId, input: { ...universalInputOf(d), routing }, source: 'CANVAS',
    baseRevision: state.workflow.revision });
  const result = router.discovery;
  return <section aria-label={tr('Routes found')}>
    <button type="button" disabled={router.busy || !router.available} onClick={() => void router.discover()}>{tr('Find routes')}</button>
    {result && <>
      <p role="status">{tr('Every provider was asked about this pair. Executable routes are verified by FloFi; others are shown with the reason they cannot be executed.')}</p>
      {result.completeness === 'PARTIAL' && <p className="muted" data-discovery="provisional">{tr('Provisional comparison: {0} did not answer in time. Find routes again to compare them.',
        (result.pendingProviders ?? []).map(p => PROVIDER_LABEL[p] ?? p).join(', '))}</p>}
      {result.quoteSubjects === 'PUBLIC_QUOTE_SUBJECT' && <p className="muted">{tr('Indicative quotes for a public address. Simulate quotes again for your own wallet.')}</p>}
      <table aria-label={tr('Route options')}><thead><tr><th>{tr('Provider')}</th><th>{tr('Bridge')}</th><th>{tr('Status')}</th><th>{tr('Expected')}</th><th>{tr('Minimum')}</th>
        <th>{tr('Time')}</th><th>{tr('Fees')}</th><th>{tr('Note')}</th><th/></tr></thead>
        <tbody>{result.candidates.map((c, i) => <tr key={`${c.provider}-${c.bridge}-${i}`} aria-current={i === result.recommended ? 'true' : undefined}>
          <td>{PROVIDER_LABEL[c.provider] ?? c.provider}</td><td>{c.bridge}</td><td>{tr(STATUS_LABEL[c.status])}{i === result.recommended ? tr(' · recommended') : ''}</td>
          <td>{amountOf(c.expectedOutput, d.outputDecimals, d.outputSymbol)}</td><td>{amountOf(c.minimumOutput, d.outputDecimals, d.outputSymbol)}</td>
          <td>{c.estimatedDurationSeconds === null ? '--' : `${c.estimatedDurationSeconds}s`}</td>
          <td>{c.fees.map(f => `${f.label}: ${formatTokenAmount(f.amount, f.decimals)} ${f.symbol}${f.included ? '' : ' (separate)'}`).join('; ') || '--'}</td>
          <td>{c.reason ? tr(REASONS[c.reason] ?? bridgeFailureMessage(c.reason) ?? c.reason) : c.executableBy === 'CERTIFIED_ROUTER' ? tr('Executes on the certified Router bridge for this pair.') : ''}</td>
          <td>{c.executableBy === 'UNIVERSAL_ROUTER' && c.provider === 'relay' && d.routing !== 'RELAY' &&
            <button type="button" className="quiet" disabled={router.busy} onClick={() => choose('RELAY')}>{tr('Use this route')}</button>}</td></tr>)}</tbody></table>
    </>}
  </section>;
}

export function UniversalBridgePanel({ view }: { view: 'simulate' | 'execute' }) {
  const { t: tr } = useLocale();
  const router = useUniversalRouter(), record = router.record, r = record?.review, route = r?.route, d = router.details;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const fresh = r ? Math.max(0, Math.round((Date.parse(r.expiresAt) - clock) / 1000)) : 0;
  const last = record?.attempts.at(-1);
  const pending = Boolean(last && record?.verdict === 'PENDING' && ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(last.state));
  const settling = Boolean(record && ['SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'RECOVERY_REQUIRED'].includes(record.phase) && record.verdict === 'PENDING');
  const authorized = record?.phase === 'AUTHORIZED' && record.authorization === r?.commitment;
  const canExecute = Boolean(authorized && !router.retired && !pending && fresh > 0 && router.executionEnabled);
  const canRefresh = Boolean(record && record.verdict === 'PENDING' && !pending && ['PREPARED', 'AUTHORIZED'].includes(record.phase) &&
    !record.attempts.some(a => a.step === 'DEPOSIT' && !['CANCELLED', 'NOT_FOUND'].includes(a.state)) && (record.requote || fresh === 0));
  const message = (code: string | null | undefined) => code ? MESSAGES[code] ?? bridgeFailureMessage(code) : null;
  const info = router.error ?? record?.error;
  const inp = route ? (u: string | null | undefined) => amountOf(u, route.inputToken.decimals, route.inputToken.symbol) : () => '--';
  const outp = route ? (u: string | null | undefined) => amountOf(u, route.outputToken.decimals, route.outputToken.symbol) : () => '--';
  const net = (chain: string | undefined) => Object.values(UNIVERSAL_NETWORKS).find(n => n.chain === chain)?.name ?? chain ?? '';
  const src = r?.source, nativeFee = r ? amountOf(r.feePolicy.networkFeeUpperBound, r.feePolicy.networkFeeDecimals, r.feePolicy.networkFeeSymbol) : '--';
  const explorer = (chain: string, hash: string) => (Object.values(UNIVERSAL_NETWORKS).find(n => n.chain === chain)?.explorer ?? '') + 'tx/' + hash;
  return <section className="panel" aria-label={tr('Universal cross-chain bridge')}>
    <h2>{tr(view === 'simulate' ? 'Simulate universal bridge' : 'Review universal bridge')}</h2>
    {d && <p>{tr('Bridge')} {d.amount} {d.inputSymbol} {tr('from')} {d.sourceLabel} {tr('to')} {d.destinationLabel}{tr(', receiving')} {d.outputSymbol}.</p>}
    <p role="note">{tr('Real funds. FloFi never signs: your source wallet signs every transaction after your Review. FloFi records a 0.1% fee obligation when the workflow completes; provider fees are shown below.')}</p>
    {!router.available && <p role="status">{tr(MESSAGES.UNIVERSAL_ROUTER_NOT_ENABLED!)}</p>}
    {router.retired && <p role="alert">{tr('The workflow changed. Prior authorization is invalid. Simulate the current bridge again.')}</p>}
    {router.recovered && record && <p role="status">{tr('Recovered run')} {record.id}{tr('. Its state comes from the server; nothing is resent automatically.')}</p>}
    <div aria-label={tr('Wallets')}>
      {router.owner ? <p>{tr('Source wallet:')} <code>{router.owner}</code>{router.destinationWallet && <> · {tr('destination wallet:')} <code>{router.destinationWallet}</code></>}</p>
        : <button type="button" disabled={router.busy} onClick={() => void router.connect()}>{tr('Connect wallets')}</button>}
      {router.owner && !router.signedIn && <p><button type="button" disabled={router.busy} onClick={() => void router.signIn()}>{tr('Sign in with source wallet')}</button>{' '}
        <small>{tr('One signature proves this wallet is yours. It moves no funds and authorizes no transaction.')}</small></p>}
      {router.ecosystem === 'EVM' && <button type="button" className="quiet" disabled={router.busy} onClick={() => void router.switchNetwork()}>{tr('Switch wallet to the source network')}</button>}
    </div>
    {view === 'simulate' && <><RouteDiscovery/>
      <button type="button" disabled={router.busy || !router.available || !d} onClick={() => void router.simulate()}>{tr('Get route and simulate')}</button>
      <PendingExecutionNote pending={pending || settling}/></>}
    {record?.error === 'ROUTE_CHANGED' && record.routeChanges.length > 0 && <p role="alert">{tr('Route changed:')} {record.routeChanges.map(c => tr(CHANGE[c])).join(', ')}.</p>}
    {r && route && src && !router.retired && <dl className="swap-summary" aria-label={tr('Route review')}>
      <dt>{tr('Provider')}</dt><dd>{PROVIDER_LABEL[route.provider] ?? route.provider} · {route.protocol} · {tr('order')} <code>{route.order.orderId}</code></dd>
      <dt>{tr('Selection')}</dt><dd>{r.selection.considered.map(c => `${PROVIDER_LABEL[c.provider] ?? c.provider}: ${tr(c.outcome === 'SELECTED' ? 'selected' : c.outcome === 'AVAILABLE' ? 'available'
        : c.outcome === 'NOT_EXECUTABLE' ? 'not executable' : c.outcome === 'UNAVAILABLE' ? 'unavailable' : 'refused')}${c.code ? ` (${tr(REASONS[c.code] ?? c.code)})` : ''}`).join('; ')}</dd>
      <dt>{tr('You send')}</dt><dd>{inp(route.inputAmount)} {tr('on')} {net(route.sourceChain)}</dd>
      <dt>{tr('Expected to receive')}</dt><dd>{outp(route.expectedOutput)} {tr('on')} {net(route.destinationChain)}</dd>
      <dt>{tr('Guaranteed minimum')}</dt><dd>{outp(route.minimumOutput)} {tr('— fixed in the provider order; a smaller delivery is a mismatch')}</dd>
      <dt>{tr('Provider fees')}</dt><dd>{route.fees.length ? route.fees.map((f, i) => <span key={i}>{f.label}: {amountOf(f.amount, f.decimals, f.symbol)}{tr(f.included ? ' (included in the quote)' : ' (paid separately)')}. </span>) : tr('none listed')}</dd>
      <dt>{tr('FloFi fee')}</dt><dd>{tr('0.1% of the completed workflow input — obligation recorded at reconciliation; not collected on-chain yet.')}</dd>
      <dt>{tr('Network fees')}</dt><dd>{tr('at most')} {nativeFee} {tr('on')} {net(route.sourceChain)}</dd>
      <dt>{tr('Estimated duration')}</dt><dd>{tr('about')} {route.quote.estimatedDurationSeconds}s {tr('after the deposit confirms (provider estimate)')}</dd>
      <dt>{tr('Signatures')}</dt><dd>{r.authorizations.sourceSignatures} {tr(r.authorizations.sourceSignatures === 1 ? 'wallet signature on the source network' : 'wallet signatures on the source network (an exact approval, then the deposit)')}{tr('; nothing to sign on the destination network.')}</dd>
      {src.ecosystem === 'EVM' && src.approvals.map((a, i) => <dd key={i}>{tr(a.required ? 'Approval: exactly the amount, never unlimited, to the Relay Depository' : 'Existing allowance is sufficient; no approval')}</dd>)}
      <dt>{tr('Recipient')}</dt><dd><code>{r.recipient}</code> {tr('on')} {net(route.destinationChain)}{tr(r.recipientKind === 'EXPLICIT' ? '' : ' (your connected wallet)')}{tr(r.recipientHasCode ? ' · this address is a contract' : '')}</dd>
      <dt>{tr('Refunds')}</dt><dd>{tr('If the order is not filled, the provider refunds to')} <code>{short(route.refundAddress)}</code> {tr('on')} {net(route.sourceChain)}.</dd>
      <dt>{tr('Simulation')}</dt><dd>{src.ecosystem === 'EVM' ? `eth_simulateV1 · block ${src.simulation.block}` : `simulateTransaction · slot ${src.simulation.slot}`} · {tr('debit')} {inp(src.simulation.ownerDebit)}{tr('. Not simulated: the destination delivery and refunds.')}</dd>
      <dt>{tr('Review valid')}</dt><dd>{fresh > 0 ? `${fresh}s` : tr('no longer — get a fresh route')}</dd>
      <dt>{tr('Strategy Manifest')}</dt><dd><code>{r.artifacts.hashes.manifest}</code></dd>
    </dl>}
    {/* Engineering diagnostic lifecycle (Canvas Authorize stays blocked for MOCKED): Accept / Execute / Observe on both stages. */}
    {record && !router.retired && <>
      {view === 'execute' && <ol className="lifecycle" aria-label={tr('Bridge lifecycle')}>{(ROUTER_PHASES.includes(record.phase) && !LIFECYCLE.includes(record.phase)
        ? [...LIFECYCLE.slice(0, LIFECYCLE.indexOf('SOURCE_CONFIRMED')), record.phase] : LIFECYCLE).map(p =>
        <li key={p} aria-current={record.phase === p ? 'step' : undefined}>{tr(p.toLowerCase().replaceAll('_', ' '))}</li>)}</ol>}
      {record.phase === 'PREPARED' && !record.requote && record.verdict === 'PENDING' && fresh > 0 && !pending && <>
        <p>{tr('Accepting authorizes only the wallet requests listed in this Review. Each request still needs your signature.')}</p>
        <button type="button" disabled={router.busy} onClick={() => void router.review()}>{tr('Accept route review')}</button></>}
      {authorized && !router.executionEnabled && <p role="status">{tr(MESSAGES.UNIVERSAL_EXECUTION_NOT_ENABLED!)}</p>}
      {canExecute && <button type="button" className="primary" disabled={router.busy} onClick={() => void router.execute()}>{tr('Execute with your wallet')}</button>}
      {canRefresh && <button type="button" disabled={router.busy} onClick={() => void router.refresh()}>{tr('Get a fresh route and review')}</button>}
      {(pending || settling) && <button type="button" disabled={router.busy} onClick={() => void router.observe()}>{tr('Observe bridge')}</button>}
      {record.attempts.length > 0 && <ol aria-label={tr('Source transactions')}>{record.attempts.map(a => <li key={a.attemptId}>{tr(a.step === 'APPROVAL' ? 'Approval' : 'Bridge deposit')}:
        {' '}{tr(a.state.toLowerCase().replaceAll('_', ' '))}{a.transactionHash && <> · <a href={explorer(record.review.route.sourceChain, a.transactionHash)} target="_blank" rel="noreferrer">{tr('view transaction')}</a></>}
        {a.note ? ` · ${tr(message(a.note) ?? a.note)}` : ''}</li>)}</ol>}
      {record.source && <p>{tr('Deposit confirmed on')} {net(record.source.chainId)}{tr(record.source.final ? ' (final)' : '')}: {inp(record.source.ownerDebit)}.</p>}
      {record.destination && <p>{tr('Delivery observed on')} {net(record.destination.chainId)}{tr(record.destination.final ? ' (final)' : '')}: {outp(record.destination.amount)} {tr('to')} <code>{record.destination.recipient}</code> ·
        {' '}<a href={explorer(record.destination.chainId, record.destination.transactionHash)} target="_blank" rel="noreferrer">{tr('view transaction')}</a></p>}
      {record.evidence && <section aria-label={tr('Bridge result')} className="swap-result"><h3>{tr('Bridge reconciled')}</h3>
        <p>{outp(record.evidence.received)} {tr('arrived (guaranteed minimum')} {outp(record.evidence.minimumOutput)}{tr('). Verified on both chains.')}</p>
        <p>{tr('Evidence:')} {record.evidence.evidenceClass} · {record.evidence.bundleHash}</p>
        <ul aria-label={tr('Evidence transactions')}>{record.evidence.transactions.map(t => <li key={t.transactionHash}>{t.step.toLowerCase()} · <a href={t.explorer} target="_blank" rel="noreferrer">{t.transactionHash}</a></li>)}</ul>
        <a download="flofi-crosschain-universal-evidence.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(record.evidence, null, 2))}>{tr('Download Evidence Bundle')}</a></section>}
      {record.refund && <p role="status">{tr('Refunded')} {record.refund.amount} {tr('to')} <code>{record.refund.recipient}</code> {tr('on')} {net(record.refund.chainId)}.</p>}
    </>}
    {view === 'execute' && router.runs.length > 0 && <section aria-label={tr('Your runs')}><h3>{tr('Your universal bridge runs')}</h3><ul>{router.runs.map(run => <li key={run.runId}>
      <button type="button" className="quiet" disabled={router.busy} onClick={() => void router.open(run.runId)}>{run.runId}</button> · {tr(run.status.toLowerCase().replaceAll('_', ' '))}</li>)}</ul></section>}
    {router.correlationId && <p>{tr('Support reference')}: <code>{router.correlationId}</code></p>}
    {info && <p role="status">{tr(message(info) ?? 'Execution needs attention. Inspect technical details and observe any existing transaction.')}</p>}
    {router.busy && <p role="status">{tr('Working…')}</p>}
    <details><summary>{tr('Show technical details')}</summary><pre>{JSON.stringify({ error: info, run: record?.id, owner: record?.owner, phase: record?.phase, commitment: r?.commitment,
      routeCommitment: r?.routeCommitment, order: route?.order.orderId, attempts: record?.attempts, source: record?.source, destination: record?.destination, verdict: record?.verdict }, null, 2)}</pre></details>
  </section>;
}
