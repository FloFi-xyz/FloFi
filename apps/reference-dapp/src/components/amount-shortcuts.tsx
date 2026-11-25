// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): 25% · 50% · 75% · Max under FloFi's own question for an amount.
 *
 * A shortcut writes only the amount, as the person's answer (the same path as typing it), after reading the balance again. It never signs,
 * approves, submits, executes or skips Simulate and Review. Without an authoritative balance of the exact asset in the wallet that would sign,
 * the buttons stay visible but disabled, with the reason; nothing is estimated.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { walletPortfolio } from '../app/portfolio-action';
import { amountBalance, amountShortcuts, amountSource, NATIVE_FEE_RESERVE, relativeShortcut, shortcutFigure, workflowTouches, type AmountShortcut, type AmountShortcutKey,
  type AwaitingAmount } from '../domain/amount-shortcuts';
import { networkCatalogsVersion, subscribeNetworkCatalogs } from '../domain/asset-catalogs';
import type { Workflow } from '../domain/initial-workflow';
import { networkOfCopilot } from '../domain/network-registry';
import { ensureNetworkCatalog } from '../state/asset-catalog-store';
import { useLocale } from '../i18n/locale';

type Read = { readonly status: 'loading' } | { readonly status: 'ready'; readonly units: bigint; readonly observedAt: string | null }
  | { readonly status: 'unavailable'; readonly reason: 'wallet' | 'balance' };
const LABEL: Readonly<Record<AmountShortcutKey, string>> = { '25': '25%', '50': '50%', '75': '75%', MAX: 'Max' };
/** A balance older than this is read again before a shortcut writes its amount. */
const FRESH_MS = 30_000;

export function AmountShortcuts({ request, evm, solana, workflow, disabled, stillOpen, onPick }: { request: AwaitingAmount; evm: string | null; solana: string | null;
  workflow: Workflow; disabled: boolean;
  /** Whether FloFi still waits for this same amount (read again after the balance read: the conversation may have moved on meanwhile). */
  stillOpen(): boolean; onPick(amount: string): void }) {
  const { t: tr, language } = useLocale();
  const lang = language === 'PT' ? 'PT' : 'EN';
  // Keyed on the asset and network written (the request object is rebuilt on every render of the panel).
  const { asset, network } = request;
  // BUILD-FLOFI-BETA-REGRESSION-FIX-001 (FIX-01): the question can render before the network's catalog is registered; the asset identity is
  // re-resolved when a catalog arrives (and the missing catalog is loaded below), so the shortcuts appear instead of silently never rendering.
  const catalogVersion = useSyncExternalStore(subscribeNetworkCatalogs, networkCatalogsVersion, networkCatalogsVersion);
  const source = useMemo(() => { void catalogVersion; return amountSource({ asset, network }); }, [asset, network, catalogVersion]);
  const identity = networkOfCopilot(network);
  useEffect(() => { if (!source && identity.catalog) void ensureNetworkCatalog(false, identity.chain); }, [source, identity.catalog, identity.chain]);
  const owner = source ? source.ecosystem === 'evm' ? evm : solana : null;
  // A step already in the workflow spends or delivers this asset here: today's balance says nothing about this step (no shortcut at all).
  const follows = useMemo(() => source ? workflowTouches(workflow, source) : true, [source, workflow]);
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const [changed, setChanged] = useState(false), [working, setWorking] = useState(false);
  const readAt = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (): Promise<Read> => {
    if (!source || !owner) return { status: 'unavailable', reason: 'wallet' };
    const result = await walletPortfolio({ evm: source.ecosystem === 'evm' ? owner : null, solana: source.ecosystem === 'solana' ? owner : null }).catch(() => null);
    const balance = result?.ok ? amountBalance(result.portfolio, source) : null;
    readAt.current = Date.now();
    return balance?.kind === 'READY' ? { status: 'ready', units: balance.units, observedAt: balance.observedAt } : { status: 'unavailable', reason: 'balance' };
  }, [source, owner]);
  useEffect(() => {
    if (follows) return;
    setRead({ status: 'loading' }); setChanged(false);
    void load().then(next => { if (alive.current) setRead(next); });
  }, [load, follows]);
  // BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: "todo o USDC que tenho", "half my ETH": the user already chose the share of this balance, so the amount
  // it gives is sent once as their answer, straight from this fresh read (the same path and checks as pressing the button; nothing is signed).
  const relative = request.relative ?? null;
  const relativeAnswer = source && relative && read.status === 'ready' ? relativeShortcut(read.units, source, relative) : null;
  const answered = useRef<string | null>(null);
  useEffect(() => {
    if (!relativeAnswer?.amount || disabled || working || answered.current === request.question || !stillOpen()) return;
    answered.current = request.question;
    onPick(relativeAnswer.amount);
  }, [relativeAnswer?.amount, disabled, working, request.question, stillOpen, onPick]);
  if (!source || follows) return null;
  const shortcuts: readonly AmountShortcut[] = read.status === 'ready' ? amountShortcuts(read.units, source) : [];
  async function pick(key: AmountShortcutKey) {
    if (!source || read.status !== 'ready' || working) return;
    const shown = shortcuts.find(item => item.key === key)?.amount;
    if (!shown) return;
    setWorking(true);
    try {
      // Stale protection: an older read is read again; if the amount this button showed is no longer right, nothing is sent.
      // Age from when the balance was observed (the server may answer from a recent snapshot), else from when this browser received it.
      let current: Read = read;
      const observed = read.observedAt ? Date.parse(read.observedAt) : NaN;
      if (Date.now() - (Number.isFinite(observed) ? Math.min(observed, readAt.current) : readAt.current) > FRESH_MS) {
        current = await load();
        if (!alive.current) return;
        setRead(current);
      }
      const now = current.status === 'ready' ? amountShortcuts(current.units, source).find(item => item.key === key)?.amount ?? null : null;
      if (now !== shown) { if (alive.current) setChanged(true); return; }
      // The question may have closed or changed while the balance was read again: never answer a different one.
      if (!alive.current || !stillOpen()) return;
      onPick(shown);
    } finally { if (alive.current) setWorking(false); }
  }
  const symbol = source.symbol, networkName = networkOfCopilot(request.network).name;
  const time = read.status === 'ready' && read.observedAt ? new Date(read.observedAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : null;
  const reserve = source.native ? NATIVE_FEE_RESERVE[source.chain] ?? null : null;
  const busy = disabled || working || read.status === 'loading';
  return <div className="amount-shortcuts">
    <div className="copilot-options" role="group" aria-label={tr('Amount shortcuts')} aria-busy={read.status === 'loading' || working || undefined}>
      {(['25', '50', '75', 'MAX'] as const).map(key => {
        const shortcut = shortcuts.find(item => item.key === key), amount = shortcut?.amount ?? null;
        const name = key === 'MAX' ? tr('Max') : LABEL[key];
        // People read the exact amount in their language's separators; the answer sent stays the canonical decimal text.
        const exact = shortcut && amount ? shortcutFigure(shortcut.units, source.decimals, symbol, lang, false) : null;
        const accessible = exact ? key === 'MAX' ? tr('Use your maximum: {0}', exact) : tr('Use {0} of your balance: {1}', LABEL[key], exact) : name;
        return <button key={key} type="button" className="chat-action amount-shortcut" data-variant="secondary" data-shortcut={key} disabled={busy || !amount}
          aria-label={accessible} title={exact ?? undefined} onClick={() => void pick(key)}>
          <span>{name}</span>{shortcut && amount && <small className="amount-shortcut-figure" aria-hidden="true">{shortcutFigure(shortcut.units, source.decimals, symbol, lang)}</small>}
        </button>;
      })}
    </div>
    <p className="amount-shortcuts-note" role="status">
      {read.status === 'loading' ? tr('Reading your balance…')
        : read.status === 'unavailable' ? tr(read.reason === 'wallet' ? 'Connect the wallet that will sign to use your balance. You can still type an amount.'
          : 'Your balance could not be read. Type an amount instead.')
          : changed ? tr('Your balance changed. Check the amounts and choose again.')
          : relative && relativeAnswer && !relativeAnswer.amount ? tr('Your {0} balance on {1} is {2}, so there is nothing to use for this request. Add funds or type an amount.',
            symbol, networkName, shortcutFigure(read.status === 'ready' ? read.units : 0n, source.decimals, symbol, lang))
            : <>{time ? tr('Balance on {0} at {1}: {2}', networkName, time, shortcutFigure(read.units, source.decimals, symbol, lang))
              : tr('Balance on {0}: {1}', networkName, shortcutFigure(read.units, source.decimals, symbol, lang))}
            {reserve !== null && <> {tr('Max keeps {0} for network fees.', shortcutFigure(reserve, source.decimals, symbol, lang))}</>}
            {' '}{tr('Nothing is signed: you still simulate and review.')}</>}
    </p>
  </div>;
}
