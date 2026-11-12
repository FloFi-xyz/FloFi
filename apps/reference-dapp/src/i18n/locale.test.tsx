// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookHarness } from '../test-utils/hook-harness';
import { DEFAULT_LANGUAGE, LocaleProvider, LANGUAGE_COOKIE, LANGUAGE_KEY, parseLanguage, translate, useLocale } from './locale';
import { defaultLanguageFor, documentLanguage } from './language';
import { EMBEDDED_APPROVAL_PATH } from '../server/embedded-approval';
import { portuguese } from './pt';
import { YourWorkflows } from '../components/saved-workflows';
import { WorkflowProvider, useWorkflow } from '../state/workflow-store';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from '../domain/editor';
import { validateSavedWorkflow } from '../domain/saved-workflow';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
let host: HookHarness, locale: ReturnType<typeof useLocale>, workflow: ReturnType<typeof useWorkflow>;
let storage: Map<string, string>, jar: Map<string, string>;
const context = createBaseSepoliaReviewContext();
function Probe() { locale = useLocale(); workflow = useWorkflow(); return <span>{locale.t('Save workflow')}</span>; }
// The layouts pass the cookie's language (`requestLanguage`); a test passes it the same way.
const render = (initialLanguage?: 'EN' | 'PT') => host.render(() => renderToStaticMarkup(<LocaleProvider {...initialLanguage ? { initialLanguage } : {}}><WorkflowProvider initialContext={context}><Probe/></WorkflowProvider></LocaleProvider>));
beforeEach(() => {
  host = new HookHarness(); storage = new Map(); jar = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  // A minimal cookie jar: `document.cookie` reads every pair and writes one.
  const doc = Object.assign(new EventTarget(), { documentElement: { lang: '' } });
  Object.defineProperty(doc, 'cookie', { get: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (line: string) => { const [pair] = line.split(';'); const at = pair!.indexOf('='); jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim()); } });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval, location: { protocol: 'https:' } }));
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });
describe('locale preference and workflow isolation', () => {
  it('switches PT/EN, persists the choice (cookie and storage, synchronously) and updates the document language', () => {
    expect(render()).toContain('Save workflow');
    locale.setLanguage('PT');
    // Written before any re-render or refresh: a server render started right after the choice already reads it.
    expect(jar.get(LANGUAGE_COOKIE)).toBe('PT'); expect(storage.get(LANGUAGE_KEY)).toBe('PT');
    expect(render()).toContain('Salvar fluxo'); expect(document.documentElement.lang).toBe('pt-BR');
    locale.setLanguage('EN'); expect(render()).toContain('Save workflow');
    expect(jar.get(LANGUAGE_COOKIE)).toBe('EN'); expect(storage.get(LANGUAGE_KEY)).toBe('EN'); expect(document.documentElement.lang).toBe('en');
  });
  // P0 hotfix (locale contract): this test used to pin the defect itself (a value kept only in storage flipped the page after load). The
  // server now renders the cookie's language and the provider keeps it across unmount/reload.
  it('loads the cookie\'s language and preserves it after unmount/reload', () => {
    jar.set(LANGUAGE_COOKIE, 'PT'); expect(render('PT')).toContain('Salvar fluxo');
    host.unmount(); host = new HookHarness(); expect(render('PT')).toContain('Salvar fluxo');
    expect(locale.language).toBe('PT');
  });
  it('never flips the page to a stored value: the cookie wins and storage is aligned to it', () => {
    jar.set(LANGUAGE_COOKIE, 'EN'); storage.set(LANGUAGE_KEY, 'PT');
    expect(render('EN')).toContain('Save workflow'); expect(locale.language).toBe('EN');
    expect(storage.get(LANGUAGE_KEY)).toBe('EN'); expect(jar.get(LANGUAGE_COOKIE)).toBe('EN');
  });
  it('without a cookie, a stored value neither flips the page nor is overwritten (the root layout migrates it before the first paint)', () => {
    storage.set(LANGUAGE_KEY, 'PT');
    expect(render()).toContain('Save workflow'); expect(locale.language).toBe('EN');
    expect(storage.get(LANGUAGE_KEY)).toBe('PT'); expect(jar.has(LANGUAGE_COOKIE)).toBe(false);
  });
  it('nested providers (root layout and route group) follow one choice at once', () => {
    let outer!: ReturnType<typeof useLocale>, inner!: ReturnType<typeof useLocale>;
    function Outer() { outer = useLocale(); return <LocaleProvider><Inner/></LocaleProvider>; }
    function Inner() { inner = useLocale(); return <span>{inner.t('Save workflow')}</span>; }
    const draw = () => host.render(() => renderToStaticMarkup(<LocaleProvider><Outer/></LocaleProvider>));
    draw(); inner.setLanguage('PT');
    expect(draw()).toContain('Salvar fluxo'); expect(outer.language).toBe('PT'); expect(inner.language).toBe('PT');
  });
  it('ignores an invalid saved preference', () => { storage.set(LANGUAGE_KEY, 'FR'); jar.set(LANGUAGE_COOKIE, 'FR'); expect(render()).toContain('Save workflow'); expect(storage.get(LANGUAGE_KEY)).toBe('FR'); });
  it('keeps the real authored workflow and restoration epoch when language changes', () => {
    render();
    const saved = validateSavedWorkflow(editorReducer(initialEditor(), { type: 'ADD_TESTNET_SWAP', direction: 'USDC_TO_WETH', amount: '2', slippage: '50', source: 'CANVAS', baseRevision: 0 }, context).workflow);
    workflow.restoreWorkflow(saved); render();
    const before = workflow.state.workflow, epoch = workflow.restorationEpoch;
    locale.setLanguage('PT'); render(); locale.setLanguage('EN'); render();
    expect(workflow.state.workflow).toBe(before); expect(workflow.state.workflow).toEqual(saved);
    expect(workflow.restorationEpoch).toBe(epoch);
  });
  it.each(['Your workflows are temporarily unavailable.', 'Showing up to 100 workflows.', 'Workflow saved.', 'Workflow restored. Simulate again before reviewing.', 'This workflow was updated in another session. Reopen it before saving.'])('uses the catalog for normal saved-workflow copy: %s', message => {
    expect(portuguese[message]).toBeDefined(); expect(translate('PT', message)).toBe(portuguese[message]); expect(translate('EN', message)).toBe(message);
  });
  it('renders saved-workflow empty/error/pagination messages through the PT catalog', () => {
    const html = host.render(() => renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><YourWorkflows list={{ items: [], hasMore: true }} busy={false} error="WORKFLOW_UNAVAILABLE" open={vi.fn()} refresh={vi.fn()}/></LocaleProvider>));
    for (const message of ['Your workflows are temporarily unavailable.', 'Showing up to 100 workflows.']) expect(html).toContain(portuguese[message]);
    const empty = host.render(() => renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><YourWorkflows list={{ items: [], hasMore: false }}/></LocaleProvider>));
    expect(empty).toContain(portuguese['No saved workflows waiting.']!);
    expect(html).not.toContain('Workflows are temporarily unavailable');
  });
  it('preserves user names, addresses and template values', () => {
    expect(translate('PT', 'My workflow 0x1234')).toBe('My workflow 0x1234');
    expect(translate('PT', '  Save workflow  ')).toBe('  Salvar fluxo  ');
    // BUILD-BASE-001: a catalog network's name is a template value, not a catalog entry per network.
    expect(translate('PT', 'Base tokens are unavailable right now. Try again in a moment.')).toBe('Os tokens da Base estão indisponíveis no momento. Tente novamente em instantes.');
  });

  // Team decision (BUILD-FLOFI-LAUNCH-001): English for a visitor with no saved preference; a saved one is read as is (layouts use `??`).
  it('defaults to English only when no preference is saved, and keeps a saved Portuguese', () => {
    expect(DEFAULT_LANGUAGE).toBe('EN');
    expect(parseLanguage('EN') ?? DEFAULT_LANGUAGE).toBe('EN');
    expect(parseLanguage('PT') ?? DEFAULT_LANGUAGE).toBe('PT');
    for (const missing of [undefined, null, '', 'pt', 'fr']) expect(parseLanguage(missing) ?? DEFAULT_LANGUAGE).toBe('EN');
    expect([documentLanguage('PT'), documentLanguage('EN')]).toEqual(['pt-BR', 'en']);
    // The landing, the rest of the site, sign-in, onboarding and /app all default to English, so the entry journey never switches language.
    for (const path of ['/', '/faq', '/docs', '/docs/simulation', '/how-it-works', '/developers', '/login', '/onboarding/wallets', '/app', '/app/dashboard',
      '/approve', '/connections', '/walletx', null]) expect(defaultLanguageFor(path), String(path)).toBe('EN');
    // These keep English whatever the product default is: the MCP surface embedded in a chat host, FloFi Wallet's own host and the admin console.
    for (const path of [EMBEDDED_APPROVAL_PATH, '/wallet', '/wallet/export', '/admin', '/admin/access']) expect(defaultLanguageFor(path), path).toBe('EN');
  });
});
