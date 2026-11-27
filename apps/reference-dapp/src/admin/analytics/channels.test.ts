// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): the channel of a completed execution comes only from trusted, immutable records
 * (requester kind and OAuth client id, never a self-declared name), unattributable executions stay UNKNOWN whenever they ran (never FloFi Web
 * by time or by the absence of a record), folding never counts an execution twice, periods are UTC, the section renders in English and
 * Portuguese, and it is reachable only behind the Admin page gate.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttemptFact } from './classify.ts';
import { executionsOf, FULL_COVERAGE, type LoadedRun } from './workflows.ts';

const request = vi.hoisted(() => ({ token: undefined as string | undefined, platformStateHost: vi.fn() }));
vi.mock('../../server/platform-state-host.ts', () => ({ platformStateHost: request.platformStateHost }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'flofi.example' }),
  cookies: async () => ({ get: (name: string) => name === 'flofi_admin_session' && request.token ? { value: request.token } : undefined }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (path: string) => { throw new Error(path); } }));
vi.mock('./channels.ts', async original => ({ ...await original<typeof import('./channels.ts')>(), loadChannelCounts: vi.fn(async () => { throw new Error('UNREACHABLE'); }) }));
const { CHANNELS, channelOf, channelOfOrigin, channelPeriod, completedExecutions, foldChannels, loadChannelCounts } = await import('./channels.ts');
type ChannelCounts = import('./channels.ts').ChannelCounts;
const { ChannelCounts: Section } = await import('../../components/admin/channel-counts');

afterEach(() => { request.token = undefined; request.platformStateHost.mockReset(); vi.unstubAllEnvs(); });

const done: AttemptFact = { step: 'MAIN', state: 'CONFIRMED', hash: true, reconciled: true };
function run(over: Partial<LoadedRun>): LoadedRun {
  const id = over.runId ?? 'run';
  return { runId: id, workflowId: `wf-${id}`, flow: 'base-swap', status: 'RECONCILED', provenance: 'PUBLIC_MAINNET', recoveryOf: null, errorCode: null, needsObservation: false,
    attentionRequired: false, hasEvidence: true, createdAt: new Date('2026-11-18T10:00:00Z'), updatedAt: new Date('2026-11-18T10:05:00Z'), attempts: [done],
    journalAuthorized: true, fact: null, ...over };
}
const NONE = { FLOFI_WEB: 0, LEGACY_WEB: 0, CHATGPT_MCP: 0, CLAUDE_MCP: 0, TELEGRAM: 0, DEVELOPER_API: 0, MCP_UNIDENTIFIED: 0, UNKNOWN: 0 };

describe('BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 channel attribution', () => {
  it('names a channel only from the requester kind and an exact CIMD client id', () => {
    expect(CHANNELS).toEqual(['FLOFI_WEB', 'LEGACY_WEB', 'CHATGPT_MCP', 'CLAUDE_MCP', 'TELEGRAM', 'DEVELOPER_API', 'MCP_UNIDENTIFIED', 'UNKNOWN']);
    expect(channelOf('EDITOR_SESSION', 'flofi-editor')).toBe('FLOFI_WEB');
    expect(channelOf('DEVELOPER_PROJECT', 'prj_abc')).toBe('DEVELOPER_API');
    expect(channelOf('AUTOMATION_RULE', 'flofi-automations')).toBe('AUTOMATION');
    expect(channelOf('CHANNEL_CONVERSATION', 'telegram:123456789')).toBe('TELEGRAM');
    for (const other of ['whatsapp:123456789', 'telegram:', 'telegram:abc', 'telegram:0123456', 'telegram:123456789:extra']) expect(channelOf('CHANNEL_CONVERSATION', other)).toBe('UNKNOWN');
    expect(channelOf('MCP_ACCOUNT', 'https://chatgpt.com/oauth/abc123/client.json')).toBe('CHATGPT_MCP');
    expect(channelOf('MCP_ACCOUNT', 'https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('CLAUDE_MCP');
    // Anything that is not exactly an https CIMD URL on that very host is an unidentified MCP client: look-alike hosts, other hosts, http, a
    // port, credentials, a query, a bare host, a non-canonical spelling and dynamically registered clients (whose names are self-declared).
    for (const other of ['https://chatgpt.com.evil.example/oauth/client.json', 'https://claude.ai.evil/oauth/client.json', 'https://evilchatgpt.com/oauth/client.json',
      'https://sub.chatgpt.com/oauth/client.json', 'https://claude.com/oauth/client.json', 'https://chat.openai.com/oauth/client.json', 'http://chatgpt.com/oauth/client.json',
      'http://claude.ai/oauth/client.json', 'https://chatgpt.com:443/oauth/client.json', 'https://chatgpt.com:8443/oauth/client.json', 'https://user@claude.ai/oauth/client.json',
      'https://claude.ai/oauth/client.json?x=1', 'https://claude.ai/oauth/client.json#x', 'https://claude.ai/', 'https://CLAUDE.AI/oauth/client.json',
      'flofi_dcr_abcdefghijkl', 'ChatGPT', 'chatgpt.com'])
      expect(channelOf('MCP_ACCOUNT', other), other).toBe('MCP_UNIDENTIFIED');
    for (const kind of ['', 'MCP', 'mcp_account', 'SOMETHING_NEW']) expect(channelOf(kind, 'https://chatgpt.com/oauth/abc123/client.json')).toBe('UNKNOWN');
  });

  it('periods: Today from UTC midnight, 7 and 30 days back, All time from the epoch; anything else is the last 30 days', () => {
    const now = new Date('2026-11-20T10:15:00.000Z');
    expect(channelPeriod('today', now)).toEqual({ id: 'today', from: new Date('2026-11-20T00:00:00.000Z'), to: now, invalid: false });
    expect(channelPeriod('today', new Date('2026-11-20T00:00:00.000Z')).from).toEqual(new Date('2026-11-20T00:00:00.000Z'));
    expect(channelPeriod('today', new Date('2026-11-20T23:59:59.999Z')).from).toEqual(new Date('2026-11-20T00:00:00.000Z'));
    expect(channelPeriod('7d', now).from).toEqual(new Date('2026-11-13T10:15:00.000Z'));
    expect(channelPeriod('30d', now).from).toEqual(new Date('2026-10-21T10:15:00.000Z'));
    expect(channelPeriod('all', now).from).toEqual(new Date(0));
    expect(channelPeriod(undefined, now)).toMatchObject({ id: '30d', invalid: false });
    for (const value of ['24h', 'custom', '', 'ALL', '30']) expect(channelPeriod(value, now)).toMatchObject({ id: '30d', invalid: true });
  });

  it('folds recoveries, retries and composition steps into one execution and counts only completed ones', () => {
    const runs = [
      run({ runId: 'root', status: 'INCONCLUSIVE', hasEvidence: false, attempts: [{ step: 'MAIN', state: 'SUBMISSION_RESULT_UNKNOWN', hash: true, reconciled: false }] }),
      run({ runId: 'root-r', recoveryOf: 'root', createdAt: new Date('2026-11-18T11:00:00Z') }),
      run({ runId: 'retried', attempts: [{ ...done, state: 'CANCELLED', hash: false, reconciled: false }, { ...done, state: 'REVERTED', reconciled: false }, done] }),
      run({ runId: 'comp', flow: 'solana-devnet-composition', status: 'COMPLETED', provenance: 'PUBLIC_DEVNET', attempts: [],
        fact: { state: 'INDEXED', code: null, compositionOf: null, actions: [{ i: 0, kind: 'SWAP', type: 'asset.swap.exact-input', chain: 'solana:x', runs: ['comp-step'] }] } }),
      run({ runId: 'comp-step', flow: 'solana-devnet-swap', provenance: 'PUBLIC_DEVNET' }),
      run({ runId: 'failed', status: 'REVERTED', hasEvidence: false, attempts: [{ ...done, state: 'REVERTED', reconciled: false }] }),
      run({ runId: 'uncertain', status: 'INCONCLUSIVE', hasEvidence: false, attempts: [{ ...done, state: 'SUBMISSION_RESULT_UNKNOWN', reconciled: false }] }),
      run({ runId: 'observing', needsObservation: true }),
    ];
    const completed = completedExecutions(executionsOf(runs), runs);
    expect(completed.map(e => [...e.runIds].sort())).toEqual([['root', 'root-r'], ['retried'], ['comp', 'comp-step']]);
    expect(completed.map(e => e.environment)).toEqual(['MAINNET', 'MAINNET', 'TESTNET']);
    // A binding of any run of an execution (here the recovery and the composition's step) attributes the one execution.
    const bindings = [{ requesterKind: 'MCP_ACCOUNT', clientId: 'https://claude.ai/oauth/x', runIds: ['root-r'] },
      { requesterKind: 'CHANNEL_CONVERSATION', clientId: 'telegram:123456789', runIds: ['comp-step'] }];
    const folded = foldChannels({ workflowRuns: [], executions: completed, steps: new Set(), bindings });
    expect(folded.byEnvironment.MAINNET).toEqual({ counts: { ...NONE, CLAUDE_MCP: 1, UNKNOWN: 1 }, total: 2, automation: 0 });
    expect(folded.byEnvironment.TESTNET).toEqual({ counts: { ...NONE, TELEGRAM: 1 }, total: 1, automation: 0 });
  });

  it('counts workflow runs and single flows once, by their records, and keeps unattributable ones UNKNOWN', () => {
    const single = (id: string, workflowId = `wf-${id}`, environment: 'MAINNET' | 'TESTNET' | null = 'MAINNET') => ({ environment, runIds: [id], workflowIds: [workflowId] });
    const folded = foldChannels({
      workflowRuns: [
        { runKind: 'EDITOR_SESSION', requesterKind: 'EDITOR_SESSION', clientId: 'flofi-editor', networkEnvironment: 'MAINNET', count: 3 },
        { runKind: 'MCP_ACCOUNT', requesterKind: 'MCP_ACCOUNT', clientId: 'https://chatgpt.com/oauth/a/client.json', networkEnvironment: 'MAINNET', count: 2 },
        { runKind: 'MCP_ACCOUNT', requesterKind: 'MCP_ACCOUNT', clientId: 'flofi_dcr_abcdefghijkl', networkEnvironment: 'MAINNET', count: 1 },
        { runKind: 'DEVELOPER_PROJECT', requesterKind: 'DEVELOPER_PROJECT', clientId: 'prj_x', networkEnvironment: 'PUBLIC_TESTNET', count: 1 },
        { runKind: 'AUTOMATION_RULE', requesterKind: 'AUTOMATION_RULE', clientId: 'flofi-automations', networkEnvironment: 'MAINNET', count: 4 },
        { runKind: 'EDITOR_SESSION', requesterKind: 'MCP_ACCOUNT', clientId: 'https://chatgpt.com/oauth/a/client.json', networkEnvironment: 'MAINNET', count: 1 },
        { runKind: 'EDITOR_SESSION', requesterKind: 'EDITOR_SESSION', clientId: 'flofi-editor', networkEnvironment: 'MOCK', count: 2 },
      ],
      executions: [single('step-run'), single('dev-step', 'wfr_abcdefghijklmnopqrstuvwxyz-step-0'), single('bound'), single('twice'), single('conflict'),
        single('unbound'), single('editor-bound'), single('auto'), single('testnet', undefined, 'TESTNET'), single('nowhere', undefined, null)],
      steps: new Set(['step-run']),
      bindings: [{ requesterKind: 'MCP_ACCOUNT', clientId: 'https://claude.ai/oauth/x', runIds: ['bound'] },
        { requesterKind: 'MCP_ACCOUNT', clientId: 'https://claude.ai/oauth/x', runIds: ['twice'] }, { requesterKind: 'MCP_ACCOUNT', clientId: 'https://claude.ai/oauth/y', runIds: ['twice'] },
        { requesterKind: 'MCP_ACCOUNT', clientId: 'https://claude.ai/oauth/x', runIds: ['conflict'] }, { requesterKind: 'DEVELOPER_PROJECT', clientId: 'prj_x', runIds: ['conflict'] },
        { requesterKind: 'AUTOMATION_RULE', clientId: 'flofi-automations', runIds: ['auto'] },
        // The rule for a one-step run an Editor approval names (FloFi Web, a positive record). No current code records one: Editor approvals are
        // SEQUENTIAL, and run_ids is written only for single-flow plans.
        { requesterKind: 'EDITOR_SESSION', clientId: 'flofi-editor', runIds: ['editor-bound'] }],
    });
    // FloFi Web: the 3 Editor workflow runs and the Editor-bound one-step run of the rule above. Unknown: the run whose requester disagrees with its
    // handoff, the conflicting binding and the unbound single flow (never FloFi Web by absence of a record).
    expect(folded.byEnvironment.MAINNET).toEqual({ counts: { FLOFI_WEB: 4, LEGACY_WEB: 0, CHATGPT_MCP: 2, CLAUDE_MCP: 2, TELEGRAM: 0, DEVELOPER_API: 0, MCP_UNIDENTIFIED: 1, UNKNOWN: 3 },
      total: 12, automation: 5 });
    expect(folded.byEnvironment.TESTNET).toEqual({ counts: { ...NONE, DEVELOPER_API: 1, UNKNOWN: 1 }, total: 2, automation: 0 });
    expect(folded.unrecognizedEnvironment).toBe(3);
  });

  it('an execution no record names is Unknown origin whenever it ran; a bound one-step run keeps its channel; an Editor workflow run is FloFi Web', () => {
    // Unbound single flows of every age and flow (direct app runs, Pix payments, approval runs whose binding is gone): never FloFi Web.
    const runs = [run({ runId: 'old', createdAt: new Date('2019-01-01T00:00:00Z'), updatedAt: new Date('2019-01-01T00:05:00Z') }),
      run({ runId: 'recent', createdAt: new Date('2026-11-20T09:59:00Z'), updatedAt: new Date('2026-11-20T09:59:30Z') }),
      run({ runId: 'future-dated', createdAt: new Date('2030-01-01T00:00:00Z'), updatedAt: new Date('2030-01-01T00:01:00Z') }),
      run({ runId: 'pix', flow: 'pix-payment', status: 'PAYMENT_SETTLED' }), run({ runId: 'solana', flow: 'solana-transfer' }),
      run({ runId: 'mcp-one-step', createdAt: new Date('2026-11-19T12:00:00Z') })];
    const executions = completedExecutions(executionsOf(runs), runs);
    expect(executions.map(e => e.runIds)).toEqual([['old'], ['recent'], ['future-dated'], ['pix'], ['solana'], ['mcp-one-step']]);
    const none = foldChannels({ workflowRuns: [], executions, steps: new Set(), bindings: [] });
    expect(none.byEnvironment.MAINNET).toEqual({ counts: { ...NONE, UNKNOWN: 6 }, total: 6, automation: 0 });
    // A one-step run an MCP approval bound keeps that channel, and an Editor workflow run is FloFi Web (the PostgreSQL suite proves that a
    // Batch Payment of 8 recipients is one such run, counted once).
    const folded = foldChannels({ executions, steps: new Set(),
      bindings: [{ requesterKind: 'MCP_ACCOUNT', clientId: 'https://chatgpt.com/oauth/a/client.json', runIds: ['mcp-one-step'] }],
      workflowRuns: [{ runKind: 'EDITOR_SESSION', requesterKind: 'EDITOR_SESSION', clientId: 'flofi-editor', networkEnvironment: 'MAINNET', count: 1 }] });
    expect(folded.byEnvironment.MAINNET).toEqual({ counts: { ...NONE, FLOFI_WEB: 1, CHATGPT_MCP: 1, UNKNOWN: 5 }, total: 7, automation: 0 });
  });

  it('a workflow run whose steps carry MOCKED evidence is counted under Mocked, whatever network environment its approval names', () => {
    const folded = foldChannels({ executions: [], steps: new Set(), bindings: [], workflowRuns: [
      { runKind: 'MCP_ACCOUNT', requesterKind: 'MCP_ACCOUNT', clientId: 'https://chatgpt.com/oauth/a/client.json', networkEnvironment: 'MAINNET', mocked: true, count: 2 },
      { runKind: 'EDITOR_SESSION', requesterKind: 'EDITOR_SESSION', clientId: 'flofi-editor', networkEnvironment: 'PUBLIC_TESTNET', mocked: true, count: 1 },
      { runKind: 'EDITOR_SESSION', requesterKind: 'EDITOR_SESSION', clientId: 'flofi-editor', networkEnvironment: 'MAINNET', mocked: false, count: 1 }] });
    expect(folded.byEnvironment.MAINNET).toEqual({ counts: { ...NONE, FLOFI_WEB: 1 }, total: 1, automation: 0 });
    expect(folded.byEnvironment.MOCKED).toEqual({ counts: { ...NONE, FLOFI_WEB: 1, CHATGPT_MCP: 2 }, total: 3, automation: 0 });
    expect(folded.byEnvironment.TESTNET.total).toBe(0);
  });

  it('runs every read under the 4 s statement timeout, the run loader included, and never on the pool directly', async () => {
    const { loadChannelCounts: load } = await vi.importActual<typeof import('./channels.ts')>('./channels.ts');
    const direct: string[] = [], bounded: string[] = [], empty = { rows: [], rowCount: 0 };
    const db = { close: async () => undefined, query: async (sql: string) => { direct.push(sql); return empty; },
      transaction: async <T,>(work: (tx: { query: (sql: string) => Promise<typeof empty> }) => Promise<T>) => {
        let first: string | null = null;
        return work({ query: async (sql: string) => {
          first ??= sql;
          if (first !== "SET LOCAL statement_timeout = '4000'") throw new Error('UNBOUNDED_TRANSACTION');
          if (sql !== first) bounded.push(sql);
          return empty;
        } });
      } };
    const result = await load({ db: db as never, tenantId: 'tenant-review' }, { period: channelPeriod('all', new Date('2026-11-20T10:00:00Z')) });
    expect(result.ok).toBe(true);
    expect(direct).toEqual([]);
    expect(bounded.some(sql => /FROM execution_runs/.test(sql))).toBe(true);
    expect(bounded.some(sql => /FROM workflow_runs/.test(sql))).toBe(true);
  });
});

const counts = (over: Partial<ChannelCounts> = {}): ChannelCounts => {
  const empty = { counts: NONE, total: 0, automation: 0 };
  return { period: channelPeriod('30d', new Date('2026-11-20T10:00:00Z')), byEnvironment: { MAINNET: { counts: { ...NONE, FLOFI_WEB: 2, CHATGPT_MCP: 1 }, total: 3, automation: 1 },
    TESTNET: empty, MOCKED: empty }, unrecognizedEnvironment: 0, coverage: FULL_COVERAGE, workflowRunsTruncated: false, compositionsWithoutRecord: { MAINNET: 0, TESTNET: 0, MOCKED: 0 },
    originsRecorded: false, ...over };
};
const render = (result: Parameters<typeof Section>[0]['result'], language: 'EN' | 'PT' = 'EN', environment: 'MAINNET' | 'TESTNET' = 'MAINNET', channels = '30d') =>
  renderToStaticMarkup(createElement(Section, { result, period: channelPeriod(channels, new Date('2026-11-20T10:00:00Z')), environment, params: { range: '7d', env: environment, channels }, language }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 channel section', () => {
  it('lists every channel in a fixed order with a total, an accessible period control and its notes', () => {
    const html = render({ ok: true, value: counts() }), body = text(html);
    expect(html).toContain('aria-labelledby="admin-channels"');
    expect(html).toMatch(/<nav class="admin-segmented" aria-label="Period">/);
    expect(html).toContain('href="/admin?range=7d&amp;env=MAINNET&amp;channels=today"');
    expect(html).toContain('href="/admin?range=7d&amp;env=MAINNET&amp;channels=30d" aria-current="true"');
    expect([...html.matchAll(/<th scope="row">(?:<strong>)?([^<]+)</g)].map(m => m[1])).toEqual(['FloFi Web (Chat or Editor)', 'Legacy Web (recovered history)',
      'ChatGPT MCP', 'Claude MCP', 'Telegram', 'Developer API', 'Unidentified MCP client', 'Unknown origin', 'Total']);
    expect([...html.matchAll(/<td class="num">(?:<strong>)?([^<]+)</g)].map(m => m[1])).toEqual(['2', '0', '1', '0', '0', '0', '0', '0', '3']);
    expect(html).toContain('<th scope="col">Channel</th>');
    expect(body).toContain('A Batch Payment counts once');
    expect(body).toContain('FloFi Web combines Web Chat and the Editor: they are the same app page and no server-side record says which of the two started a run.');
    expect(body).toContain('FloFi Web in total: 2 (2 recorded when they started, 0 recovered from history).');
    expect(body).toContain('One-step runs started directly in the app have no origin record and are shown as Unknown origin.');
    expect(body.replaceAll('&#x27;', "'")).toContain("A one-step run started from an approval keeps its channel only while that approval's record of the run exists: an approval records at most "
      + '16 runs, and approvals may be removed by retention. Otherwise it is shown as Unknown origin.');
    expect(body).toContain('Executions without a recorded origin, including earlier history, are shown as Unknown origin.');
    expect(body).toContain('Executions from other channels, such as WhatsApp, are shown as Unknown origin.');
    expect(body).toContain('1 completed executions requested by automation rules are not attributed to a channel.');
    // No time-based web attribution is configured or described.
    expect(body).not.toMatch(/attributed from|web attribution|cutover/i);
  });

  it('says what it leaves out: an empty period, a partial read, a failure and an unrecognized period', () => {
    const empty = text(render({ ok: true, value: counts() }, 'EN', 'TESTNET'));
    expect(empty).toContain('No completed executions in this period.');
    expect(empty).not.toContain('Unknown origin 0');
    const partial = render({ ok: true, value: counts({ coverage: { truncated: true, runsInRange: 30_000, coveredFrom: new Date('2026-11-10T00:00:00Z') } }) });
    expect([...partial.matchAll(/<td class="num">(?:<strong>)?([^<]+)</g)].map(m => m[1]).at(-1)).toBe('At least 3');
    expect(text(partial)).toContain('single-flow executions are counted only from 2026-11-10 00:00 UTC on');
    const failed = render({ ok: false, code: 'ADMIN_CHANNEL_COUNTS_UNAVAILABLE' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('<code>ADMIN_CHANNEL_COUNTS_UNAVAILABLE</code>');
    expect(failed).not.toContain('<table');
    expect(text(render({ ok: true, value: counts() }, 'EN', 'MAINNET', 'week'))).toContain('The requested period was not recognized, so the last 30 days are shown.');
  });

  it('is translated to Portuguese through the Admin copy', () => {
    const value = counts({ unrecognizedEnvironment: 2, workflowRunsTruncated: true,
      coverage: { truncated: true, runsInRange: 30_000, coveredFrom: new Date('2026-11-10T00:00:00Z') }, compositionsWithoutRecord: { MAINNET: 1, TESTNET: 0, MOCKED: 0 } });
    const pt = text(render({ ok: true, value }, 'PT', 'MAINNET', 'nope')) + text(render({ ok: false, code: 'ADMIN_CHANNEL_COUNTS_UNAVAILABLE' }, 'PT'))
      + text(render({ ok: true, value: counts() }, 'PT', 'TESTNET'));
    for (const phrase of ['Execuções concluídas por canal', 'Canal', 'Origem desconhecida', 'Cliente MCP não identificado', 'API para desenvolvedores', 'Total', 'Hoje',
      'Últimos 7 dias', 'Últimos 30 dias', 'Todo o período', 'Pagamento em lote conta uma vez', 'Pelo menos 3', 'Nenhuma execução concluída neste período.',
      'FloFi Web reúne o Chat na web e o Editor', 'iniciadas diretamente no app não têm registro de origem',
      'uma aprovação registra no máximo 16 execuções, e aprovações podem ser removidas pela retenção',
      'Execuções de outros canais, como o WhatsApp, aparecem como Origem desconhecida.', 'As contagens de execuções concluídas estão indisponíveis.', 'O período solicitado não foi reconhecido'])
      expect(pt).toContain(phrase);
    // No English sentence of the section is left untranslated.
    for (const english of ['Completed executions', 'Unknown origin', 'Each count', 'An execution belongs', 'combines Web Chat', 'without a recorded origin', 'started directly',
      'started from an approval', 'removed by retention', 'other channels',
      'automation rules', 'no recognized environment', 'lower bound', 'not indexed', 'No completed', 'unavailable', 'not recognized', 'Last 30 days', 'All time', 'Period'])
      expect(pt).not.toContain(english);
  });
});

describe('BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 channel counts access', () => {
  // Filesystem paths, not URLs: some route directories carry percent signs in their names (`%5F_engineering`).
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const sources = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? entry.name === 'node_modules' ? [] : sources(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [join(dir, entry.name)] : []);
  it('the loader is reachable only from the Overview page, after its Admin gate', () => {
    // Every static or dynamic import whose relative specifier resolves to this module.
    const target = 'src/admin/analytics/channels';
    const importsChannels = (path: string) => [...read(path).matchAll(/(?:from\s+|import\(\s*)'(\.[^']+)'/g)]
      .some(([, specifier]) => relative(root, resolve(root, dirname(path), specifier!)).replace(/\.ts$/, '') === target);
    const importers = [...sources('src'), ...sources('backend')].filter(importsChannels);
    expect(importers.sort()).toEqual(['src/app/admin/page.tsx', 'src/components/admin/channel-counts.tsx']);
    expect(read('src/components/admin/channel-counts.tsx')).not.toContain('loadChannelCounts');
    const page = read('src/app/admin/page.tsx');
    expect(page.indexOf('await adminPage()')).toBeGreaterThan(0);
    expect(page.indexOf('await adminPage()')).toBeLessThan(page.indexOf('loadChannelCounts('));
    expect(page).toMatch(/if \(!page\.ok\) return <AdminUnavailable/);
  });

  it('the Overview never reads the counts without a live admin session', async () => {
    const { default: AdminOverviewPage } = await import('../../app/admin/page');
    const searchParams = Promise.resolve({ channels: 'all' });
    await expect(AdminOverviewPage({ searchParams })).rejects.toThrow('NOT_FOUND'); // the console is off
    vi.stubEnv('FLOFI_ADMIN', 'enabled');
    vi.stubEnv('FLOFI_ADMIN_SESSION_SECRET', randomBytes(32).toString('hex'));
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    request.platformStateHost.mockResolvedValue({ db: { query }, tenantId: 'tenant-review' });
    await expect(AdminOverviewPage({ searchParams })).rejects.toThrow('/admin/login'); // no session cookie
    const { adminConfig } = await import('../config.ts'), { sealAdminSession } = await import('../session.ts'), config = adminConfig(process.env);
    if (!config.enabled) throw new Error('Expected test admin configuration');
    request.token = sealAdminSession(config.key, { sessionId: 'b'.repeat(32), principalId: 'adm_' + 'b'.repeat(26), domain: 'flofi.example', issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000) });
    await expect(AdminOverviewPage({ searchParams })).rejects.toThrow('/admin/login'); // a sealed cookie whose session is not live
    expect(loadChannelCounts).not.toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => !/workflow_runs|mcp_handoffs|execution_runs/.test(String(sql)))).toBe(true);
  });
});

describe('BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 recorded execution origins (0037)', () => {
  it('a recorded origin wins over a binding except a web record an approval binding contradicts; Legacy Web is its own row', () => {
    const execution = (runIds: string[]) => ({ environment: 'MAINNET' as const, runIds, workflowIds: ['wf'] });
    const folded = foldChannels({ workflowRuns: [], steps: new Set(), executions: [execution(['web-run']), execution(['legacy-run']), execution(['bound-run']),
      execution(['root', 'recovery']), execution(['unrecorded'])],
      bindings: [{ requesterKind: 'MCP_ACCOUNT', clientId: 'flofi_dcr_x', runIds: ['web-run', 'bound-run', 'unrecorded'] }],
      recorded: new Map([['web-run', { origin: 'web', basis: 'CREATION' }], ['legacy-run', { origin: 'legacy_web', basis: 'BACKFILL' }],
        ['root', { origin: 'telegram', basis: 'APPROVAL_BINDING' }], ['recovery', { origin: 'mcp_claude', basis: 'APPROVAL_BINDING' }],
        ['web-only', { origin: 'web', basis: 'CREATION' }], ['corrected', { origin: 'mcp_chatgpt', basis: 'CORRECTION' }]] as const) });
    // web-run: created on an /app URL but bound by an MCP approval (exact reviewed hash after its claim): the approval's channel wins over the
    // browser-chosen page. legacy-run: recovered history. root+recovery: two channels, Unknown. unrecorded: the binding as before.
    expect(folded.byEnvironment.MAINNET.counts).toEqual({ ...NONE, LEGACY_WEB: 1, MCP_UNIDENTIFIED: 3, UNKNOWN: 1 });
    expect(folded.byEnvironment.MAINNET.total).toBe(5);
    const more = foldChannels({ workflowRuns: [], steps: new Set(), executions: [execution(['web-only']), execution(['corrected'])],
      bindings: [{ requesterKind: 'MCP_ACCOUNT', clientId: 'flofi_dcr_x', runIds: ['corrected'] }],
      recorded: new Map([['web-only', { origin: 'web', basis: 'CREATION' }], ['corrected', { origin: 'mcp_chatgpt', basis: 'CORRECTION' }]] as const) });
    // An unbound web record stays FloFi Web; an approved correction wins over any binding.
    expect(more.byEnvironment.MAINNET.counts).toEqual({ ...NONE, FLOFI_WEB: 1, CHATGPT_MCP: 1 });
  });
  it('maps every recorded origin to exactly one reported row (Chat and Editor are FloFi Web; automation stays in its note)', () => {
    expect(['web', 'web_chat', 'web_editor'].map(o => channelOfOrigin(o as never))).toEqual(['FLOFI_WEB', 'FLOFI_WEB', 'FLOFI_WEB']);
    expect(channelOfOrigin('legacy_web')).toBe('LEGACY_WEB');
    expect(channelOfOrigin('mcp_chatgpt')).toBe('CHATGPT_MCP');
    expect(channelOfOrigin('mcp_claude')).toBe('CLAUDE_MCP');
    expect(channelOfOrigin('mcp_other')).toBe('MCP_UNIDENTIFIED');
    expect(channelOfOrigin('telegram')).toBe('TELEGRAM');
    expect(channelOfOrigin('developer_api')).toBe('DEVELOPER_API');
    expect(channelOfOrigin('automation')).toBe('AUTOMATION');
    expect(channelOfOrigin('unknown')).toBe('UNKNOWN');
  });
  it('with origins recorded, the obsolete "no origin record" notes are gone and the recovery rule is stated', () => {
    const body = text(render({ ok: true, value: counts({ originsRecorded: true }) }));
    expect(body).not.toContain('One-step runs started directly in the app have no origin record');
    expect(body).toContain('New executions keep the channel they started from');
    expect(text(render({ ok: true, value: counts({ originsRecorded: true }) }, 'PT'))).toContain('Novas execuções mantêm o canal de origem');
  });
});
