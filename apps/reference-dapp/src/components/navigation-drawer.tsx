// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { SECONDARY_WORKSPACES as items, secondaryWorkspaceRoute, type SecondaryWorkspace } from '../domain/secondary-workspaces';
import { dashboardRoute } from '../lib/dashboard/routes';
import type { WorkflowStage } from '../domain/product-shell';
import { automationsAvailability } from '../app/automation-action';
import { delegationEnabled } from '../app/delegation-action';

type NavigationItem = SecondaryWorkspace['id'] | 'dashboard' | 'chat' | 'build' | 'logout';
/** P0 approved UX (board 03b): a status next to an item that is not available yet (never a disabled control that looks clickable). */
type ItemStatus = 'Coming soon' | 'In testing' | null;

function NavigationIcon({ item }: { item: NavigationItem }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {item === 'chat' ? <><path d="M12 5v14M5 12h14"/></>
      : item === 'dashboard' ? <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>
      : item === 'build' ? <><rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="16" width="7" height="5" rx="1.5"/><path d="M6.5 8v7a3.5 3.5 0 0 0 3.5 3.5h4M14 5.5h7m-3-3 3 3-3 3"/></>
        : item === 'logout' ? <><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M10 12h11m-4-4 4 4-4 4"/></>
          : item === 'workflows' ? <><path d="M4 3h12l4 4v14H4Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></>
          : item === 'automations' ? <><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></>
          : item === 'credentials' ? <><rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="9" r="2"/><path d="M8 16c0-3 8-3 8 0"/></>
      : item === 'agents' ? <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M2 12h2m16 0h2M9 16h6"/><path d="M9 11v1m6-1v1"/></>
        : <><circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-3-3 3-3m-6 0 3-3"/></>}
  </svg>;
}
/** BUILD UX POLISH 004 (UX-01): Terms and Privacy as icons in the collapsed rail; the expanded rail and the mobile drawer keep the text line. */
function LegalIcon({ item }: { item: 'terms' | 'privacy' }) {
  return <svg className="navigation-legal-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {item === 'terms' ? <><path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 12h7M9 16h5"/></> : <><path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6Z"/><path d="m9 12 2 2 4-4"/></>}
  </svg>;
}

/**
 * BUILD UX POLISH 004 (UX-01): above the shell's compact breakpoint (the 800 px the Canvas rail and the mobile layout already use) navigation is a
 * persistent rail: icon-only by default, expanded to the names and groups with the chevron next to the logo. At or below it, the ☰ drawer
 * overlays the workspace exactly as before. The server renders the desktop markup; CSS keeps the drawer closed on a narrow screen until the
 * client knows it (`inert`/`aria-hidden` follow then).
 */
// The exact complement of the CSS `(min-width: 801px)`, so a fractional width (browser zoom) never falls between the two.
const COMPACT_NAVIGATION_QUERY = 'not all and (min-width: 801px)';
/** Below 1360 px the expanded rail floats over the workspace (globals.css) instead of moving it aside. */
const FLOATING_RAIL_QUERY = 'not all and (min-width: 1360px)';
function useMediaFlag(source: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    let query: MediaQueryList;
    try { query = window.matchMedia(source); } catch { return; }
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [source]);
  return matches;
}
/**
 * Whether the desktop rail shows names. One value for the page, so a section change (which remounts the top bar) keeps the owner's choice; a
 * new page load starts collapsed again (nothing is stored). The server always renders the collapsed rail.
 */
let railExpanded = false;
const railListeners = new Set<() => void>();
const subscribeRail = (listener: () => void) => { railListeners.add(listener); return () => { railListeners.delete(listener); }; };
function setRailExpanded(value: boolean) { railExpanded = value; for (const listener of railListeners) listener(); }
const useRailExpanded = () => useSyncExternalStore(subscribeRail, () => railExpanded, () => false);
/**
 * Where the pointer chose a rail item. The section it opens may remount the top bar under a pointer that has not moved, and the browser then
 * reports a fresh pointer-over: no name is shown again until the pointer actually moves away from this point.
 */
let tipHold: { readonly x: number; readonly y: number } | null = null;
const held = (x: number, y: number) => tipHold !== null && Math.abs(x - tipHold.x) < 3 && Math.abs(y - tipHold.y) < 3;

/**
 * All navigation uses the persistent product shell (the desktop rail or the mobile overlay). BUILD-FLOFI-CHAT-EDITOR-UX-001: the drawer agrees with the top bar —
 * Chat (offered only where the top bar offers it, `onChat`) is current on the intent entry, and the Editor on each of its sections (the Canvas,
 * the simulation and Review, the execution). The click targets are the top bar's: Chat opens the entry, the Editor opens the Canvas.
 */
export function NavigationDrawer({ pathname, section = 'Build', onBuild, onChat, onDisconnect, disconnectDisabled }: {
  pathname?: string | null; section?: WorkflowStage | 'Dashboard' | 'Chat'; onBuild: () => void; onChat?: (() => void) | undefined;
  onDisconnect: () => void; disconnectDisabled: boolean;
}) {
  const { t: tr, language } = useLocale();
  // `open`: the mobile overlay. `expanded`: the desktop rail's names (UX-01). Only one of them applies at a time.
  const [open, setOpen] = useState(false);
  const compact = useMediaFlag(COMPACT_NAVIGATION_QUERY);
  const expanded = useRailExpanded();
  // The rail's names and tags are visible (or about to be): only then are the availability tags read.
  const [engaged, setEngaged] = useState(false);
  // Accurate availability tags, read once navigation is first opened, expanded or explored (the same server answers the pages themselves use;
  // nothing is enabled here).
  const [status, setStatus] = useState<{ readonly automations: ItemStatus; readonly passkeys: ItemStatus } | null>(null);
  useEffect(() => {
    if (!(open || expanded || engaged) || status) return;
    let live = true;
    void Promise.all([automationsAvailability().then(r => r.enabled, () => null), delegationEnabled().then(r => r.enabled, () => null)])
      .then(([automations, passkeys]) => { if (live) setStatus({ automations: automations === false ? 'Coming soon' : null, passkeys: passkeys === false ? 'Coming soon' : null }); });
    return () => { live = false; };
  }, [open, expanded, engaged, status]);
  const itemStatus = (id: SecondaryWorkspace['id']): ItemStatus => id === 'agents' ? 'In testing' : id === 'automations' ? status?.automations ?? null
    : id === 'passkeys' ? status?.passkeys ?? null : null;
  /** The name a collapsed rail shows beside an item (its status tag included). */
  const tipOf = (label: string, state: ItemStatus = null) => state ? `${tr(label)} · ${tr(state)}` : tr(label);
  const row = (item: typeof items[number]) => <Link key={item.id} href={item.href} className="navigation-row" aria-current={selected === item.id ? 'page' : undefined}
    data-navigation-tip={tipOf(item.label, itemStatus(item.id))} onClick={() => dismiss()}>
    <NavigationIcon item={item.id}/><span className="navigation-row-label">{tr(item.label)}</span>
    {itemStatus(item.id) && <span className="navigation-status" data-status={itemStatus(item.id) === 'In testing' ? 'testing' : 'soon'}>{tr(itemStatus(item.id)!)}</span>}
  </Link>;
  const workspace = !pathname || pathname === '/app';
  const selected = secondaryWorkspaceRoute(pathname)?.id
    ?? (dashboardRoute(pathname) || (!pathname && section === 'Dashboard') ? 'dashboard'
      : workspace && section === 'Chat' && onChat ? 'chat'
        : workspace && (section === 'Build' || section === 'Simulate' || section === 'Execute') ? 'build' : null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLAnchorElement>(null);
  const drawerId = useId();
  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  /** After choosing an item: the mobile overlay closes and returns focus to ☰; the desktop rail stays as the owner left it. */
  const dismiss = () => { if (open) close(true); };
  // A window widened past the breakpoint while the overlay was open: the rail takes over and the overlay's listeners end.
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);
  // An expanded rail that floats over the workspace (801–1359 px) gets out of the way like the drawer did: a pointer press outside navigation
  // collapses it (the press still reaches what it was meant for), and so does Escape from inside it, returning focus to the chevron. From
  // 1360 px it sits beside the workspace and stays as the owner left it.
  useEffect(() => {
    if (!expanded || typeof window.matchMedia !== 'function') return;
    const compactScreen = window.matchMedia(COMPACT_NAVIGATION_QUERY);
    const floatingScreen = window.matchMedia(FLOATING_RAIL_QUERY);
    // CSS responds to a resize before React can run effect cleanup. Read the current viewport when handling input.
    const railFloats = () => !compactScreen.matches && floatingScreen.matches;
    function outside(event: Event) {
      if (railFloats() && event.target instanceof Node && !container.current?.contains(event.target)) setRailExpanded(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !railFloats() || !container.current?.contains(document.activeElement)) return;
      setRailExpanded(false);
      trigger.current?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [expanded]);

  // UX-01: the collapsed rail names each item beside it — after 300 ms on hover, at once on keyboard focus; leaving, Escape or scrolling hides
  // it. The same timing and look as the Canvas rail's tooltip; presentation only (every item keeps its accessible name).
  const tips = !compact && !expanded;
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTip = useCallback(() => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null; setTip(null);
  }, []);
  useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current); }, []);
  useEffect(() => { if (!tips) hideTip(); }, [tips, hideTip]);
  function showTip(target: EventTarget | null, delay: number) {
    const item = target instanceof Element ? target.closest<HTMLElement>('[data-navigation-tip]') : null;
    if (!tips || !item || !drawer.current?.contains(item)) return;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    const label = item.dataset.navigationTip ?? '';
    const place = () => {
      if (!item.isConnected) return;
      const box = item.getBoundingClientRect();
      setTip({ label, top: box.top + box.height / 2, left: box.right + 8 });
    };
    if (delay > 0) tipTimer.current = setTimeout(place, delay); else place();
  }
  const tipHandlers = {
    onPointerOver: (event: ReactPointerEvent<HTMLElement>) => {
      setEngaged(true);
      if (event.pointerType !== 'mouse' || held(event.clientX, event.clientY)) return;
      tipHold = null; showTip(event.target, 300);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse' || !tipHold || held(event.clientX, event.clientY)) return;
      tipHold = null; showTip(event.target, 300);
    },
    onPointerOut: (event: ReactPointerEvent<HTMLElement>) => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest('[data-navigation-tip]') : null;
      if (next !== (event.target instanceof Element ? event.target.closest('[data-navigation-tip]') : null)) hideTip();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      setEngaged(true);
      let keyboard = true; try { keyboard = (event.target as Element).matches(':focus-visible'); } catch { /* older engines */ }
      if (keyboard) showTip(event.target, 0); else hideTip();
    },
    onBlur: hideTip,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => { if (event.key === 'Escape') hideTip(); },
    // Choosing an item hides its name (and cancels a pending one), as the Canvas rail does; moving the pointer again shows names again.
    onClick: (event: ReactMouseEvent<HTMLElement>) => { hideTip(); if (event.detail > 0) tipHold = { x: event.clientX, y: event.clientY }; },
  };

  useEffect(() => {
    const header = trigger.current?.closest('header');
    if (!header) return;
    function position() {
      const bottom = Math.max(0, Math.min(window.innerHeight, header!.getBoundingClientRect().bottom));
      layer.current?.style.setProperty('--navigation-top', `${bottom}px`);
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(header);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    firstItem.current?.focus({ preventScroll: true });
    function outside(event: Event) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    }
    // Keep the header in view without changing body overflow or scrollbar width.
    function preventBackgroundScroll(event: Event) {
      const nav = navigation.current;
      if (!(event.target instanceof Node && nav?.contains(event.target) && nav.scrollHeight > nav.clientHeight)) event.preventDefault();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    document.addEventListener('wheel', preventBackgroundScroll, { passive: false });
    document.addEventListener('touchmove', preventBackgroundScroll, { passive: false });
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('wheel', preventBackgroundScroll);
      document.removeEventListener('touchmove', preventBackgroundScroll);
    };
  }, [open, close]);

  const closed = compact && !open;
  // One control in the header, so assistive technology and keyboard order always meet exactly one: on a phone ☰ opens the overlay drawer (as
  // before); on a desktop the chevron shows or hides the rail's names, like the Canvas rail's own toggle (it points right while collapsed). The
  // server renders the desktop control; CSS shows the matching icon at once and the label follows once the client knows the width.
  const label = compact ? open ? 'Close navigation' : 'Open navigation' : expanded ? 'Collapse navigation' : 'Expand navigation';
  return <div className="navigation-control" ref={container}>
    <button ref={trigger} type="button" className="navigation-trigger" aria-label={tr(label)} title={compact ? undefined : tr(label)}
      aria-expanded={compact ? open : expanded} aria-controls={drawerId}
      onClick={() => { if (compact) { if (open) close(true); else setOpen(true); } else { hideTip(); setRailExpanded(!expanded); } }}>
      <svg className="navigation-trigger-menu" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      <svg className="navigation-trigger-rail" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
    </button>
    <div ref={layer} className="navigation-layer" data-open={open} data-expanded={expanded} aria-hidden={closed || undefined} inert={closed}>
      <div className="navigation-backdrop" aria-hidden="true" onClick={() => close(true)}/>
      <aside ref={drawer} id={drawerId} className="navigation-drawer" aria-label={tr("FloFi navigation")} {...tipHandlers}>
        <div ref={navigation} className="navigation-content" onScroll={hideTip}>
          {/* P0 approved UX (board 03b): New workflow (the Chat entry), Editor, Dashboard; Library; Access. The only place navigation lives. */}
          <nav aria-label={tr("FloFi navigation")}>
            {onChat && <Link ref={firstItem} href="/app" className="navigation-row" aria-current={selected === 'chat' ? 'page' : undefined} data-navigation-tip={tipOf('New workflow')}
              onClick={event => { event.preventDefault(); onChat(); dismiss(); }}>
              <NavigationIcon item="chat"/><span className="navigation-row-label">{tr("New workflow")}</span>
            </Link>}
            <Link ref={onChat ? undefined : firstItem} href="/app" className="navigation-row" aria-current={selected === 'build' ? 'page' : undefined} data-navigation-tip={tipOf('Editor')}
              onClick={event => { event.preventDefault(); onBuild(); dismiss(); }}>
              <NavigationIcon item="build"/><span className="navigation-row-label">{tr("Editor")}</span>
            </Link>
            <Link href="/app/dashboard" className="navigation-row" aria-current={selected === 'dashboard' ? 'page' : undefined} data-navigation-tip={tipOf('Dashboard')} onClick={() => dismiss()}>
              <NavigationIcon item="dashboard"/><span className="navigation-row-label">{tr("Dashboard")}</span>
            </Link>
            <p className="navigation-section-label" id={`${drawerId}-library`}>{tr("Library")}</p>
            <div role="group" aria-labelledby={`${drawerId}-library`}>{items.filter(item => item.id === 'workflows' || item.id === 'automations').map(row)}</div>
            <p className="navigation-section-label" id={`${drawerId}-access`}>{tr("Access")}</p>
            <div role="group" aria-labelledby={`${drawerId}-access`}>{items.filter(item => item.id === 'credentials' || item.id === 'agents' || item.id === 'passkeys').map(row)}</div>
          </nav>
        </div>
        <div className="navigation-footer">
          <button type="button" className="navigation-row" disabled={disconnectDisabled} data-navigation-tip={tipOf('Log out')}
            onClick={() => { onDisconnect(); dismiss(); }}><NavigationIcon item="logout"/><span className="navigation-row-label">{tr("Log out")}</span></button>
          <p className="navigation-legal">
            <a href="/terms" data-navigation-tip={language === 'PT' ? 'Termos' : 'Terms'}><LegalIcon item="terms"/><span className="navigation-legal-label">{language === 'PT' ? 'Termos' : 'Terms'}</span></a>
            <span className="navigation-legal-separator" aria-hidden="true"> · </span>
            <a href="/privacy" data-navigation-tip={language === 'PT' ? 'Privacidade' : 'Privacy'}><LegalIcon item="privacy"/><span className="navigation-legal-label">{language === 'PT' ? 'Privacidade' : 'Privacy'}</span></a>
          </p>
        </div>
      </aside>
      {tip && tips && <span className="canvas-rail-tooltip navigation-rail-tooltip" aria-hidden="true" style={{ top: tip.top, left: tip.left }}>{tip.label}</span>}
    </div>
  </div>;
}
