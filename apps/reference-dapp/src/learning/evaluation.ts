// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the deterministic, offline evaluation that gates every global glossary version. No model, no network, no state:
 * the real Copilot engine (`domain/copilot-conversation.ts`), the real exact grammar and editor, and scripted interpreter answers.
 *
 *   1. the candidate document must validate (closed targets, reserved vocabulary, environment rules, size);
 *   2. the labeled corpus (`eval-corpus.ts`) runs three times — no glossary (baseline), the active version, the candidate — and every case must
 *      pass with the candidate; a case that passes with the active version and fails with the candidate is a regression;
 *   3. every turn is checked against absolute safety invariants (a mainnet in a proposal was named by the user or their own saved meaning,
 *      never by the glossary; every number in a proposal is the user's; no reply after a memory statement carries a command);
 *   4. generated probes per entry measure effectiveness (a test-network term now grounds; a mainnet term is offered first, never proposed;
 *      a token term never grounds) and safety (a mainnet term followed by test wording never yields a mainnet proposal).
 *
 * Passing requires zero document errors, zero corpus failures, zero regressions, zero safety violations and zero failed probes. Repetition by
 * users is not an input: only an operator's approval and this evaluation publish a version. Model weights are never trained here.
 */
import { describeProposal } from '../domain/proposal.ts';
import { editorReducer, initialEditor } from '../domain/editor.ts';
import type { Command } from '../domain/commands.ts';
import { buildCopilotFacts } from '../domain/copilot-answers.ts';
import { amountReadings, canonicalDecimal, mentionedNetworks } from '../domain/copilot-authoring.ts';
import { emptyConversation, finishTurn, startTurn, type CopilotConversation, type CopilotEnvironment, type CopilotLearning,
  type CopilotReply } from '../domain/copilot-conversation.ts';
import { glossaryEntries, parseLexicon, parseMemoryStatement, statedSource, targetEnvironment, targetKind, targetNetwork, type LexiconEntry } from '../domain/copilot-lexicon.ts';
import { copilotNetworksMentioned, networkOfCopilot, type CopilotNetworkId } from '../domain/network-registry.ts';
import { reviewContextOf } from '../engine/strategy-engine.ts';
import { LEARNING_CORPUS_ID, LEARNING_EVAL_CASES, scripted, type EvalReplyKind, type LearningEvalCase, type LearningEvalTurn } from './eval-corpus.ts';
import { knowledgeLexicon, KnowledgeError, validateKnowledgeDocument, type KnowledgeDocument } from './knowledge.ts';

const EVAL_WALLET = '0x1111111111111111111111111111111111111111';
const MAX_LISTED = 20;
type Outcome = { readonly kind: EvalReplyKind; readonly reply: CopilotReply | null };
export type CaseResult = { readonly id: string; readonly passed: boolean; readonly failure: string | null; readonly violations: readonly string[] };
export type ProbeResult = { readonly term: string; readonly probe: string; readonly passed: boolean; readonly effective: boolean | null; readonly detail: string | null };
export type EvaluationResult = {
  readonly corpus: string; readonly passed: boolean; readonly entries: number;
  readonly document: { readonly code: string | null; readonly index: number | null };
  readonly cases: { readonly total: number; readonly baseline: number; readonly active: number; readonly candidate: number; readonly failed: readonly string[] };
  readonly metrics: Readonly<Record<string, { readonly passed: number; readonly total: number }>>;
  readonly byLanguage: Readonly<Record<string, { readonly passed: number; readonly total: number }>>;
  readonly regressions: readonly string[];
  readonly safetyViolations: readonly string[];
  readonly probes: { readonly total: number; readonly passed: number; readonly effective: number; readonly hintOnly: number; readonly failed: readonly string[] };
};

/** One conversation through the real engine, as the web chat drives it: exact grammar first, then the engine with the scripted answer. */
function converse(turns: readonly LearningEvalTurn[], learning: CopilotLearning): Outcome[] {
  // The evaluation never applies a proposal (only a user's click does): the workflow stays the editor's initial one.
  const workflow = initialEditor().workflow;
  let pending: { command: Command; diff: readonly string[] } | null = null, state: CopilotConversation = emptyConversation();
  const env = (): CopilotEnvironment => {
    const context = reviewContextOf(workflow);
    return { workflow, context, wallet: EVAL_WALLET, walletChainId: 'eip155:84532', pending, facts: buildCopilotFacts({ workflow, context, pending }), learning };
  };
  const out: Outcome[] = [];
  for (const turn of turns) {
    const start = startTurn(state, turn.user, env());
    let reply: CopilotReply;
    if (start.kind === 'LOCAL') { reply = start.reply; state = start.next; }
    else {
      const finished = finishTurn(start.turn, turn.model ? { ok: true, intent: turn.model } : { ok: false, code: 'COPILOT_REPLAY_MISS' }, env());
      reply = finished.reply; state = finished.next;
    }
    if (reply.command) {
      const before = { workflow, error: null }, context = reviewContextOf(workflow);
      pending = { command: reply.command, diff: describeProposal(before, editorReducer(before, reply.command, context), reply.command, context) };
    }
    out.push({ kind: reply.kind, reply });
  }
  return out;
}

const readings = (text: string) => new Set([...text.replace(/0x[0-9a-fA-F]+/g, ' ').matchAll(/(?<![A-Za-z0-9_.])\d(?:[\d.,]*\d)?/g)]
  .flatMap(match => [...amountReadings(match[0]), canonicalDecimal(match[0].replace(/,/g, ''))]));
/** The absolute rules every evaluated turn must keep, whatever the glossary says. */
function violations(turns: readonly LearningEvalTurn[], outcomes: readonly Outcome[], own: readonly LexiconEntry[]): string[] {
  const out: string[] = [], said: string[] = [];
  outcomes.forEach((outcome, index) => {
    const user = turns[index]!.user, reply = outcome.reply;
    said.push(user);
    if (!reply) return;
    if (parseMemoryStatement(user) && reply.command) out.push(`memory statement produced a command (turn ${index + 1})`);
    if (!reply.command || !reply.sentence) return;
    const text = said.join('\n');
    // Every mainnet in a proposal was named by the user, carried from their own step, or by their own STATED (session/saved) meaning — never by the
    // glossary, and (BUILD-CHAT-LEARNING-002) never by a meaning FloFi inferred from the user's answers or corrections (adapted or learned).
    const userNamed = new Set<CopilotNetworkId>([...mentionedNetworks(text),
      ...(reply.learning?.used ?? []).filter(entry => statedSource(entry.source)).flatMap(entry => targetNetwork(entry.target) ?? []), ...own.flatMap(e => targetNetwork(e.target) ?? [])]);
    for (const network of copilotNetworksMentioned(reply.sentence))
      if (networkOfCopilot(network).environment === 'MAINNET' && !userNamed.has(network)) out.push(`mainnet ${network} proposed without the user naming it (turn ${index + 1})`);
    if ((reply.learning?.used ?? []).some(entry => !statedSource(entry.source) && targetEnvironment(entry.target) !== 'TESTNET'))
      out.push(`an inferred or global entry grounded a real-funds value (turn ${index + 1})`);
    const allowed = new Set([...readings(text), '50', '100']);
    const numbers = [...readings(reply.sentence.replace(/0x[0-9a-fA-F]{40}/g, ' '))].filter(value => !allowed.has(value));
    if (numbers.length) out.push(`ungrounded number ${numbers.join(',')} (turn ${index + 1})`);
  });
  return out;
}
function check(turn: LearningEvalTurn, outcome: Outcome): string | null {
  const expected = turn.expect, kinds = (Array.isArray(expected.kind) ? expected.kind : [expected.kind]) as readonly EvalReplyKind[], reply = outcome.reply;
  if (!kinds.includes(outcome.kind)) return `expected ${kinds.join('|')}, got ${outcome.kind}`;
  if (expected.sentence !== undefined && reply?.sentence !== expected.sentence) return `sentence ${reply?.sentence ?? 'none'}`;
  if (expected.note !== undefined && !(reply?.notes ?? []).some(note => note.includes(expected.note!))) return `missing note “${expected.note}”`;
  if (expected.memory === null && reply?.memory) return `unexpected memory action ${reply.memory.op}`;
  if (typeof expected.memory === 'string' && reply?.memory?.op !== expected.memory) return `missing memory action ${expected.memory}`;
  if (expected.firstOption && !copilotNetworksMentioned(reply?.options[0] ?? '').includes(expected.firstOption)) return `first option ${reply?.options[0] ?? 'none'}`;
  return null;
}
const learningFor = (c: { readonly private?: LearningEvalCase['private']; readonly memory?: LearningEvalCase['memory'] }, global: readonly LexiconEntry[],
  version: number | null): CopilotLearning => ({ memory: c.memory ?? 'ANONYMOUS', owner: c.memory === 'AVAILABLE' ? { EN: 'your account', PT: 'sua conta' } : null,
    private: parseLexicon((c.private ?? []).map(e => ({ ...e })), 'PRIVATE'), global, globalVersion: version, language: null });
function runCase(c: LearningEvalCase, global: readonly LexiconEntry[], version: number | null): CaseResult {
  const learning = learningFor(c, global, version), outcomes = converse(c.turns, learning);
  const failure = c.turns.map((turn, index) => { const problem = check(turn, outcomes[index]!); return problem ? `#${index + 1} ${problem}` : null; }).find(Boolean) ?? null;
  return { id: c.id, passed: failure === null, failure, violations: violations(c.turns, outcomes, learning.private) };
}

// ── Probes generated per entry ──────────────────────────────────────────────────────────────────────────────────────────────────────
const { action, swap, bridge } = scripted;
type Probe = { readonly name: string; readonly turn: LearningEvalTurn; readonly expect: 'GROUNDS' | 'SUGGESTS' | 'NEVER_MAINNET' | 'NEVER_GROUNDS' };
function probesFor(entry: LexiconEntry): Probe[] | 'HINT_ONLY' {
  const network = targetNetwork(entry.target), kind = targetKind(entry.target), term = entry.term;
  if (kind === 'operation') return 'HINT_ONLY';
  if (kind === 'asset') {
    const asset = entry.target.slice('asset:'.length);
    if (asset === 'DEVUSDC') return [{ name: 'token-never-grounds', expect: 'NEVER_GROUNDS', turn: { user: `Swap 0.1 SOL to ${term} on Solana Devnet`,
      model: action(swap({ network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: 'DEVUSDC', amount: '0.1' })), expect: { kind: 'CLARIFICATION' } } }];
    return [{ name: 'token-never-grounds', expect: 'NEVER_GROUNDS', turn: { user: `Swap 5 ${term} to WETH on Base Sepolia`,
      model: action(swap({ network: 'BASE_SEPOLIA', inputAsset: asset, outputAsset: asset === 'WETH' ? 'USDC' : 'WETH', amount: '5' })), expect: { kind: 'CLARIFICATION' } } }];
  }
  const id = network!;
  if (networkOfCopilot(id).environment === 'TESTNET') {
    const user = id === 'ARBITRUM_SEPOLIA' ? `Bridge 1 USDC from Base Sepolia to ${term}` : id === 'SOLANA_DEVNET' ? `Swap 0.1 SOL to USDC on ${term}`
      : `Swap 0.001 WETH to USDC on ${term}`;
    const model = id === 'ARBITRUM_SEPOLIA' ? action(bridge({ sourceNetwork: 'BASE_SEPOLIA', destinationNetwork: null, asset: 'USDC', amount: '1' }))
      : id === 'SOLANA_DEVNET' ? action(swap({ network: null, inputAsset: 'SOL', outputAsset: 'USDC', amount: '0.1' }))
      : action(swap({ network: id, inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' }));
    return [{ name: 'test-network-grounds', expect: 'GROUNDS', turn: { user, model, expect: { kind: 'PROPOSAL', note: `“${term}”` } } }];
  }
  const mainnet = id === 'ARBITRUM' ? { user: `Bridge 10 USDC from Base to ${term}`, model: action(bridge({ sourceNetwork: 'BASE', destinationNetwork: id, asset: 'USDC', amount: '10' })) }
    : id === 'SOLANA' ? { user: `Swap 1 SOL to USDC on ${term}`, model: action(swap({ network: id, inputAsset: 'SOL', outputAsset: 'USDC', amount: '1' })) }
    : { user: `Swap 10 USDC to WETH on ${term}`, model: action(swap({ network: id, inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' })) };
  return [
    { name: 'mainnet-suggests', expect: 'SUGGESTS', turn: { ...mainnet, expect: { kind: ['CLARIFICATION', 'UNSUPPORTED', 'FAILED'] } } },
    { name: 'mainnet-never-before-test-wording', expect: 'NEVER_MAINNET', turn: { user: `${mainnet.user} sepolia`, model: mainnet.model,
      expect: { kind: ['CLARIFICATION', 'UNSUPPORTED', 'FAILED', 'PROPOSAL'] } } },
  ];
}
function runProbe(entry: LexiconEntry, probe: Probe, global: readonly LexiconEntry[], version: number | null): ProbeResult {
  const context = { memory: 'ANONYMOUS' as const };
  const [outcome] = converse([probe.turn], learningFor(context, global, version)), reply = outcome!.reply;
  const [without] = converse([probe.turn], learningFor(context, global.filter(e => e.term !== entry.term), version));
  const fail = (detail: string): ProbeResult => ({ term: entry.term, probe: probe.name, passed: false, effective: false, detail });
  const problem = check(probe.turn, outcome!);
  const listed = glossaryEntries(probe.turn.user, global).some(e => e.term === entry.term);
  if (!listed && probe.expect !== 'NEVER_MAINNET') return fail('not selected for the interpreter glossary');
  const mainnetProposed = !!reply?.sentence && copilotNetworksMentioned(reply.sentence).some(n => networkOfCopilot(n).environment === 'MAINNET');
  switch (probe.expect) {
    case 'GROUNDS': return problem ? fail(problem) : { term: entry.term, probe: probe.name, passed: true, effective: without!.kind !== 'PROPOSAL', detail: null };
    case 'SUGGESTS': {
      if (problem || outcome!.kind === 'PROPOSAL') return fail(problem ?? 'a glossary term for real funds produced a proposal');
      const first = reply?.options[0] ?? '';
      return { term: entry.term, probe: probe.name, passed: true, effective: copilotNetworksMentioned(first).includes(targetNetwork(entry.target)!), detail: null };
    }
    case 'NEVER_MAINNET': return mainnetProposed ? fail('a mainnet proposal next to test-network wording') : { term: entry.term, probe: probe.name, passed: true, effective: null, detail: null };
    case 'NEVER_GROUNDS': return problem ? fail(problem) : { term: entry.term, probe: probe.name, passed: true, effective: null, detail: null };
  }
}

const tally = (results: readonly CaseResult[], cases: readonly LearningEvalCase[], key: (c: LearningEvalCase) => string) => {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const [index, c] of cases.entries()) { const bucket = out[key(c)] ??= { passed: 0, total: 0 }; bucket.total += 1; if (results[index]!.passed) bucket.passed += 1; }
  return out;
};
/**
 * Evaluates `candidate` (an untrusted document) against the active document. `active` may be null (no version, or a disabled one).
 * `cases` is injectable for tests; production always uses the shipped corpus.
 */
export function evaluateKnowledge(candidate: unknown, active: KnowledgeDocument | null, options: { readonly cases?: readonly LearningEvalCase[]; readonly version?: number } = {}):
  EvaluationResult {
  const cases = options.cases ?? LEARNING_EVAL_CASES, version = options.version ?? null;
  let document: KnowledgeDocument | null = null, documentError: { code: string | null; index: number | null } = { code: null, index: null };
  try { document = validateKnowledgeDocument(candidate); }
  catch (error) { documentError = error instanceof KnowledgeError ? { code: error.code, index: error.index } : { code: 'KNOWLEDGE_SHAPE_INVALID', index: null }; }
  const candidateLexicon = knowledgeLexicon(document, version), activeLexicon = knowledgeLexicon(active, version);
  const baseline = cases.map(c => runCase(c, [], null)), current = cases.map(c => runCase(c, activeLexicon, version)), next = cases.map(c => runCase(c, candidateLexicon, version));
  const regressions = cases.filter((_, index) => current[index]!.passed && !next[index]!.passed).map(c => c.id);
  const safetyViolations = next.flatMap(result => result.violations.map(v => `${result.id}: ${v}`));
  const probes: ProbeResult[] = [];
  let hintOnly = 0;
  for (const entry of candidateLexicon) {
    const generated = probesFor(entry);
    if (generated === 'HINT_ONLY') {
      hintOnly += 1;
      if (!glossaryEntries(`${entry.term} 1 USDC`, candidateLexicon).some(e => e.term === entry.term))
        probes.push({ term: entry.term, probe: 'glossary-selection', passed: false, effective: false, detail: 'not selected for the interpreter glossary' });
      continue;
    }
    for (const probe of generated) probes.push(runProbe(entry, probe, candidateLexicon, version));
  }
  const failedCases = next.filter(result => !result.passed).map(result => `${result.id}: ${result.failure}`);
  const failedProbes = probes.filter(probe => !probe.passed).map(probe => `${probe.term} ${probe.probe}: ${probe.detail}`);
  const passed = documentError.code === null && failedCases.length === 0 && regressions.length === 0 && safetyViolations.length === 0 && failedProbes.length === 0;
  return {
    corpus: LEARNING_CORPUS_ID, passed, entries: document?.entries.length ?? 0, document: documentError,
    cases: { total: cases.length, baseline: baseline.filter(r => r.passed).length, active: current.filter(r => r.passed).length, candidate: next.filter(r => r.passed).length,
      failed: failedCases.slice(0, MAX_LISTED) },
    metrics: tally(next, cases, c => c.category), byLanguage: tally(next, cases, c => c.language),
    regressions: regressions.slice(0, MAX_LISTED), safetyViolations: safetyViolations.slice(0, MAX_LISTED),
    probes: { total: probes.length, passed: probes.filter(p => p.passed).length, effective: probes.filter(p => p.effective === true).length, hintOnly,
      failed: failedProbes.slice(0, MAX_LISTED) },
  };
}
