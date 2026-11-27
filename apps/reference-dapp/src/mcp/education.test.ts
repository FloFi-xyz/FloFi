// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The MCP education tools and the static automation catalog over the real gateway (raw JSON-RPC, as a remote client speaks it): explain_concept,
 * explain_strategy, get_platform_help and list_automation_types. FloFi's own deterministic copy — no network, no model, no state, never live data —
 * and the same shared modules every surface uses (parity with `answerConcept`, `platformGuide`, `automationFaq`).
 */
import { describe, expect, it, vi } from 'vitest';
import { AUTOMATION_KINDS } from '../automations/definition';
import { AUTOMATION_FAQ_TOPICS, automationFaq } from '../automations/explain';
import { answerConcept, CONCEPT_IDS, CONCEPT_LEVELS, conceptProtocols } from '../domain/intelligence/concepts';
import { platformAnswer, platformGuide } from '../domain/intelligence/platform-guide';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { FLOFI_PRODUCTION_ORIGIN } from '../platform/navigation';
import { credential, gatewayEnv, session } from './gateway.test-harness';
import { credentialDigest, newCredential } from './oauth/crypto';
import { readOAuthConfig, type McpScope, type OAuthConfig } from './oauth/config';
import { oauthEnv } from './oauth/oauth-test-harness';
import type { McpState } from './oauth/state';

const alice = { principal: 'dev-alice', token: credential() };
const env = gatewayEnv([alice]);
const client = () => session({ env, token: alice.token });
const example = (id: string) => STRATEGY_EXAMPLES.find(e => e.id === id)!.strategy;

describe('explain_concept: FloFi\'s shared concept catalog over MCP', () => {
  it('equals answerConcept for the same input — every concept, level and language, and every protocol note (parity with web and channels)', async () => {
    const c = client();
    for (const id of CONCEPT_IDS) for (const language of ['EN', 'PT'] as const) {
      for (const level of CONCEPT_LEVELS) {
        const result = await c.callTool('explain_concept', { concept: id, level, language });
        const shared = answerConcept(id, { level, language });
        expect(result.isError, `${id} ${level} ${language}`).toBe(false);
        expect(result.output, `${id} ${level} ${language}`).toMatchObject({ ok: true, id, level, language, text: shared.text, notes: [...shared.notes], generalKnowledge: true,
          liveData: false, authority: expect.stringMatching(/^NONE/) });
      }
      for (const protocol of conceptProtocols(id)) {
        const result = await c.callTool('explain_concept', { concept: id, protocol, language });
        expect(result.output.text, `${id} ${protocol}`).toBe(answerConcept(id, { protocol, language }).text);
      }
    }
  }, 30_000);

  it('resolves a term in the user\'s words (EN/PT, small typos) to the same answer, and says live values come only from Simulation and Review', async () => {
    const c = client();
    for (const [term, id, language] of [['what is a health factor?', 'HEALTH_FACTOR', 'EN'], ['perda impermanente', 'IMPERMANENT_LOSS', 'PT'], ['slipage', 'SLIPPAGE', 'EN'],
      ['token approval', 'TOKEN_APPROVAL', 'EN']] as const) {
      const result = await c.callTool('explain_concept', { term, language });
      expect(result.output, term).toMatchObject({ ok: true, id, resolvedFrom: 'TERM', text: answerConcept(id, { language }).text });
      expect(String(result.output.liveValues), term).toMatch(language === 'PT' ? /Simulação da FloFi e da Review/ : /Simulation and the owner's Review/);
    }
  });

  it('refuses an unknown term with CONCEPT_UNKNOWN and the catalog ids, never echoing the term; exactly one of concept / term; closed schema', async () => {
    const c = client();
    const unknown = await c.callTool('explain_concept', { term: 'zorblax quux frobnicate' });
    expect(unknown).toMatchObject({ isError: true, output: { ok: false, code: 'CONCEPT_UNKNOWN', concepts: [...CONCEPT_IDS] } });
    expect(unknown.text).not.toContain('zorblax');
    for (const args of [{}, { concept: 'SLIPPAGE', term: 'slippage' }]) expect((await c.callTool('explain_concept', args)).output).toMatchObject({ ok: false, code: 'CONCEPT_INPUT_INVALID' });
    for (const args of [{ concept: 'NOT_A_CONCEPT' }, { term: 'x'.repeat(81) }, { term: 'slip\u0000page' }, { term: 'slippage', level: 'EXPERT' }, { term: 'slippage', extra: true },
      { term: 'slippage', language: 'ES' }]) {
      const refused = await c.callTool('explain_concept', args);
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      expect(refused.output.ok, JSON.stringify(args)).not.toBe(true);
    }
  });
});

describe('explain_strategy: a composed strategy explained, never a live value', () => {
  it('explains a borrow with collateral, health factor and liquidation first, on the same composition and hash as compose_strategy', async () => {
    const c = client(), strategy = example('borrow-base');
    const composed = await c.callTool('compose_strategy', { strategy });
    const explained = await c.callTool('explain_strategy', { strategy, workflowHash: composed.output.workflowHash });
    expect(explained.isError, explained.text.slice(0, 300)).toBe(false);
    expect(explained.output).toMatchObject({ ok: true, workflowHash: composed.output.workflowHash, fundsClass: 'REAL_FUNDS', liveData: false, generalKnowledge: true,
      authority: expect.stringMatching(/^NONE/), review: { kind: 'DETERMINISTIC_STRATEGY_REVIEW' } });
    expect(String(explained.output.liveValues)).toMatch(/No live health factor, LTV, price or APY is given here/);
    const concepts = explained.output.concepts as { id: string; highlighted: boolean; text: string }[];
    expect(concepts.filter(item => item.highlighted).map(item => item.id)).toEqual(['COLLATERAL', 'LTV', 'HEALTH_FACTOR', 'LIQUIDATION']);
    expect(concepts.find(item => item.id === 'LIQUIDATION')!.text).toBe(answerConcept('LIQUIDATION', { language: 'EN' }).text);
    expect((explained.output.steps as { keyConcepts: string[] }[])[0]!.keyConcepts).toEqual(['COLLATERAL', 'HEALTH_FACTOR', 'LIQUIDATION', 'LTV']);
    // The review is the same deterministic review review_strategy gives for this strategy.
    const reviewed = await c.callTool('review_strategy', { strategy, workflowHash: composed.output.workflowHash });
    expect((explained.output.review as { steps: { findings: unknown }[] }).steps[0]!.findings).toEqual(reviewed.output.findings);
  });

  it('explains swaps, bridges and liquidity (slippage, approvals, impermanent loss) in Portuguese too', async () => {
    const c = client();
    const swap = await c.callTool('explain_strategy', { strategy: example('swap-base'), language: 'PT' });
    expect(swap.output).toMatchObject({ ok: true, language: 'PT' });
    expect((swap.output.steps as { keyConcepts: string[] }[])[0]!.keyConcepts).toEqual(['SLIPPAGE', 'TOKEN_APPROVAL']);
    expect((swap.output.concepts as { id: string; text: string }[]).find(item => item.id === 'SLIPPAGE')!.text).toBe(answerConcept('SLIPPAGE', { language: 'PT' }).text);
    const bridge = await c.callTool('explain_strategy', { strategy: example('bridge-base-arbitrum-one') });
    expect((bridge.output.steps as { keyConcepts: string[] }[])[0]!.keyConcepts).toEqual(['SLIPPAGE', 'BRIDGE', 'TOKEN_APPROVAL']);
    const liquidity = await c.callTool('explain_strategy', { strategy: example('add-liquidity-base') });
    expect((liquidity.output.concepts as { id: string; highlighted: boolean }[]).find(item => item.id === 'IMPERMANENT_LOSS')).toMatchObject({ highlighted: true });
  });

  it('explains every supported action × network: each canonical step described, its concepts applying, every output passing the safety guard', async () => {
    const c = client();
    for (const { id, strategy } of STRATEGY_EXAMPLES) {
      const composed = await c.callTool('compose_strategy', { strategy });
      const explained = await c.callTool('explain_strategy', { strategy, workflowHash: composed.output.workflowHash });
      expect(explained.isError, `${id}: ${explained.text.slice(0, 200)}`).toBe(false);
      expect(explained.output, id).toMatchObject({ ok: true, workflowHash: composed.output.workflowHash, liveData: false });
      const steps = explained.output.steps as { description: string; keyConcepts: string[] }[], concepts = (explained.output.concepts as { id: string }[]).map(item => item.id);
      expect(steps.length, id).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.description, id).toMatch(/\S/);
        for (const key of step.keyConcepts) expect(concepts, `${id} ${key}`).toContain(key);
      }
    }
  }, 30_000);

  it('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: a Batch Payment is explained as its ONE operation, between the steps around it, each line its own step', async () => {
    const c = client(), A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
    const SWAP = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1.5', slippageBps: 100 };
    const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
    type Explained = { stepCount: number; steps: { index: number; workflowStep: number; legs?: number[]; action: string; kind: string; description: string; keyConcepts: string[] }[];
      concepts: { id: string; inWorkflow: string }[]; review: { steps: unknown[] } };
    for (const language of ['EN', 'PT'] as const) {
      const strategy = { version: 2, steps: [SWAP, BATCH, SWAP] };
      const composed = await c.callTool('compose_strategy', { strategy, expectedStepCount: 3 });
      const explained = (await c.callTool('explain_strategy', { strategy, workflowHash: composed.output.workflowHash, language })).output as unknown as Explained;
      // Three operations (the batch once, with every payment), on the legs compose_strategy and the review report (swap 0, payments 1..3, swap 4).
      expect(explained.stepCount).toBe(5);
      expect(explained.review.steps).toHaveLength(5);
      expect(explained.steps.map(s => [s.index, s.workflowStep, s.legs ?? null, s.action, s.kind])).toEqual([[1, 0, null, 'swap', 'SWAP'],
        [2, 1, [1, 3], 'batch_payment', 'BATCH_PAYMENT'], [3, 4, null, 'swap', 'SWAP']]);
      const [first, batch, last] = explained.steps;
      expect(first!.description).toMatch(/^(Swap|Trocar) \(Uniswap v3\) · 1\.5 USDC → WETH · Base/);
      expect(batch!.description).toBe(language === 'EN'
        ? 'Batch Payment · Total 150 USDC · Base · 3 recipients · All or nothing: one wallet authorization · 25 USDC → 0xa1a1…a1a1 · 50 USDC → 0xb2b2…b2b2 · 75 USDC → 0xc3c3…c3c3'
        : 'Pagamento em lote · Total 150 USDC · Base · 3 destinatários · Tudo ou nada: uma só autorização da carteira · 25 USDC → 0xa1a1…a1a1 · 50 USDC → 0xb2b2…b2b2 · 75 USDC → 0xc3c3…c3c3');
      expect(last!.description).toBe(first!.description);
      expect(first!.keyConcepts).toEqual(['SLIPPAGE', 'TOKEN_APPROVAL']);
      expect(batch!.keyConcepts).toEqual([]);
      // The fees concept locates the batch as the one step it is, never one line per payment.
      const fees = explained.concepts.find(item => item.id === 'GAS_FEES')!;
      expect(fees.inWorkflow.match(/Batch Payment|Pagamento em lote/g)).toHaveLength(1);
      expect(`${explained.steps.map(s => s.description).join('\n')}\n${fees.inWorkflow}`).not.toMatch(/Transfer|Transferir/);
    }
    // A lone Batch Payment: one step explained, its legs named, all or nothing said once (by the workflow warning, not again on the card).
    const lone = (await c.callTool('explain_strategy', { strategy: BATCH })).output as unknown as Explained & { warnings: string[] };
    expect(lone.steps.map(s => [s.index, s.workflowStep, s.legs, s.description])).toEqual([[1, 0, [0, 2],
      'Batch Payment · Total 150 USDC · Base · 3 recipients · 25 USDC → 0xa1a1…a1a1 · 50 USDC → 0xb2b2…b2b2 · 75 USDC → 0xc3c3…c3c3']]);
    expect(lone.warnings).toEqual(['REAL_FUNDS', 'BATCH_PAYMENT_ALL_OR_NOTHING']);
    expect(lone.concepts.map(item => item.id)).toContain('GAS_FEES');
  });

  it('refuses an invalid strategy with the same closed codes as compose_strategy, never an explanation', async () => {
    const c = client(), strategy = example('bridge-base-arbitrum-one');
    for (const bad of [{ ...strategy, destinationNetwork: 'base-sepolia' }, { ...strategy, amount: '5 USDC' }, { ...strategy, calldata: '0xa9059cbb' }]) {
      const [composed, explained] = [await c.callTool('compose_strategy', { strategy: bad }), await c.callTool('explain_strategy', { strategy: bad })];
      expect(explained.isError, JSON.stringify(bad)).toBe(true);
      expect(explained.output.code ?? null, JSON.stringify(bad)).toBe(composed.output.code ?? null);
      expect(explained.text).not.toContain('0xa9059cbb');
    }
    const composed = await c.callTool('compose_strategy', { strategy });
    const stale = await c.callTool('explain_strategy', { strategy: { ...strategy, amount: '4' }, workflowHash: composed.output.workflowHash });
    expect(stale).toMatchObject({ isError: true, output: { ok: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH' } });
  });
});

describe('get_platform_help: FloFi\'s platform guide, as MCP may present it', () => {
  it('without a topic or question returns the whole MCP guide: relative FloFi paths, never an APPLY_CHANGE or PREPARE_CHANGE mode', async () => {
    const guide = await client().callTool('get_platform_help', {});
    expect(guide.output).toMatchObject({ ok: true, language: 'EN', websiteUrl: FLOFI_PRODUCTION_ORIGIN, authority: expect.stringMatching(/^NONE/) });
    const topics = guide.output.topics as ReturnType<typeof platformGuide>;
    expect(topics).toEqual(platformGuide('EN', 'MCP'));
    expect(topics.map(t => t.topic)).not.toContain('SAVED_RECIPIENTS');
    for (const topic of topics) {
      expect(topic.modes).not.toContain('APPLY_CHANGE');
      expect(topic.modes).not.toContain('PREPARE_CHANGE');
      if (topic.link) expect(topic.link.path).toMatch(/^\/[a-z]/);
    }
    expect(String(guide.output.changes)).toMatch(/never applies or prepares a change/);
  });

  it('answers one topic, or a question in the user\'s words, exactly as the shared guide does on the MCP surface', async () => {
    const c = client();
    expect((await c.callTool('get_platform_help', { topic: 'AUTOMATIONS', language: 'PT' })).output).toMatchObject({ ok: true, resolvedFrom: 'TOPIC',
      ...platformAnswer('AUTOMATIONS', 'PT', 'MCP') });
    const asked = await c.callTool('get_platform_help', { question: 'How do I connect my Phantom wallet?' });
    expect(asked.output).toMatchObject({ ok: true, resolvedFrom: 'QUESTION', ...platformAnswer('CONNECT_WALLET', 'EN', 'MCP') });
  });

  it('refuses an unknown or web-only question, a web-only topic and topic + question together with closed codes', async () => {
    const c = client();
    for (const question of ['what is the meaning of life', 'where are my saved recipients?'])
      expect((await c.callTool('get_platform_help', { question })).output, question).toMatchObject({ ok: false, code: 'PLATFORM_TOPIC_UNKNOWN',
        topics: platformGuide('EN', 'MCP').map(t => t.topic) });
    expect((await c.callTool('get_platform_help', { topic: 'SAVED_RECIPIENTS' })).isError).toBe(true);
    expect((await c.callTool('get_platform_help', { topic: 'AUTOMATIONS', question: 'where are my automations?' })).output).toMatchObject({ ok: false,
      code: 'PLATFORM_HELP_INPUT_INVALID' });
  });
});

describe('list_automation_types: what automations are, never a way to create one', () => {
  it('lists the three kinds, confirm-each-time execution, retired delegation and the FAQ, in FloFi\'s own words (EN/PT)', async () => {
    const c = client();
    const en = await c.callTool('list_automation_types', {}), pt = await c.callTool('list_automation_types', { language: 'PT' });
    expect(en.output).toMatchObject({ ok: true, language: 'EN', executionMode: { mode: 'CONFIRM_EACH_TIME' }, delegatedExecution: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED' },
      link: { path: '/app/automations' }, authority: expect.stringMatching(/^NONE/) });
    expect((en.output.kinds as { kind: string }[]).map(k => k.kind)).toEqual([...AUTOMATION_KINDS]);
    expect((en.output.kinds as { label: string; description: string }[])[0]).toEqual({ kind: 'SCHEDULED_DCA', label: 'Recurring buy',
      description: 'Prepares a buy of a fixed amount every week or every day.' });
    expect((pt.output.kinds as { label: string; description: string }[])[0]).toEqual({ kind: 'SCHEDULED_DCA', label: 'Compra recorrente',
      description: 'Prepara uma compra de valor fixo toda semana ou todo dia.' });
    expect(en.output.faq).toEqual(AUTOMATION_FAQ_TOPICS.map(topic => ({ topic, answer: automationFaq(topic, 'EN') })));
    expect(pt.output.faq).toEqual(AUTOMATION_FAQ_TOPICS.map(topic => ({ topic, answer: automationFaq(topic, 'PT') })));
    expect(String(en.output.management)).toMatch(/only by its owner in the FloFi app.*cannot create, change, pause, resume, archive or approve/);
    expect(String(pt.output.management)).toMatch(/apenas pelo dono no app da FloFi/);
  });
});

describe('scopes: each tool needs its own scope, and a missing one is a step-up, never a call', () => {
  const oauth = { FLOFI_MCP: 'enabled', ...oauthEnv() };
  const config = readOAuthConfig(oauth) as OAuthConfig, token = newCredential('access');
  const stateWith = (scopes: readonly McpScope[]) => ({
    oauth: { authenticate: async (digest: Buffer) => digest.equals(credentialDigest(config.keys.token, token)) ? { accountId: 'mcpacct_' + 'a'.repeat(26),
      grantId: 'grt_' + 'a'.repeat(26), clientId: 'https://claude.ai/client', clientName: 'Claude', scopes, resource: config.resource, familyId: 'fam_' + 'a'.repeat(26),
      expiresAt: new Date(Date.now() + 3_600_000) } : null, allow: async () => true },
    links: { active: vi.fn(async () => []) }, handoffs: {}, workflowRuns: {},
  } as unknown as McpState);

  it('a grant without flofi.strategy gets 403 insufficient_scope with a step-up challenge for every education tool', async () => {
    for (const [tool, args] of [['explain_concept', { concept: 'SLIPPAGE' }], ['explain_strategy', { strategy: example('swap-base') }], ['get_platform_help', {}],
      ['list_automation_types', {}]] as const) {
      const response = await session({ env: oauth, token, state: stateWith(['flofi.runs']) }).post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
      expect(response.status, tool).toBe(403);
      expect(response.text, tool).toBe(JSON.stringify({ ok: false, code: 'MCP_INSUFFICIENT_SCOPE' }));
      expect(response.headers.get('www-authenticate'), tool).toMatch(/error="insufficient_scope".*scope="flofi\.runs flofi\.strategy"/);
    }
  });

  it('a grant with flofi.strategy calls them without reading any wallet link', async () => {
    const state = stateWith(['flofi.strategy']);
    const result = await session({ env: oauth, token, state }).callTool('explain_concept', { concept: 'LIQUIDATION', language: 'PT' });
    expect(result.output).toMatchObject({ ok: true, id: 'LIQUIDATION', text: answerConcept('LIQUIDATION', { language: 'PT' }).text });
    expect((state.links.active as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
