// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: what the AI Learning page shows — aggregates only. Counts of private memories (never a term, a target or an identity
 * of a private memory), content-free feedback rates, the generalized candidates of the global glossary with their pseudonymous support, the
 * published versions and every evaluation. No message, transcript, address or subject is ever read here.
 */
import { learningConfig } from '../learning/config.ts';
import { LEARNING_RETENTION, createLearningStore, type Candidate, type EvaluationRow, type KnowledgeVersion, type LearningMetrics } from '../learning/store.ts';
import { validateKnowledgeDocument } from '../learning/knowledge.ts';
import type { AdminHost } from './host.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const LEARNING_WINDOW_DAYS = 30;
export type Rate = { readonly count: number; readonly of: number; readonly rate: number | null };
export type LearningAdminView = {
  readonly deployment: { readonly enabled: boolean; readonly reason: string | null; readonly global: boolean };
  readonly storeError: string | null; readonly since: string;
  readonly memory: { readonly entries: number; readonly subjects: number; readonly walletSubjects: number; readonly channelSubjects: number; readonly contributors: number };
  readonly turns: { readonly total: number; readonly proposals: Rate; readonly answers: Rate; readonly clarifications: Rate; readonly refusals: Rate; readonly failures: Rate;
    readonly memoryTurns: Rate; readonly byScope: Readonly<Record<string, number>> };
  readonly corrections: Rate; readonly clarificationAnswers: number; readonly repeatedFailures: number;
  readonly proposals: { readonly applied: number; readonly dismissed: number; readonly revised: number };
  readonly suggestions: { readonly confirmed: number; readonly rejected: number };
  readonly interpreter: { readonly ok: number; readonly failed: number; readonly failures: readonly { readonly code: string; readonly n: number }[] };
  readonly usage: { readonly memoryUsed: number; readonly knowledgeUsed: number };
  readonly candidates: { readonly pending: readonly Candidate[]; readonly approved: readonly Candidate[]; readonly rejected: readonly Candidate[];
    readonly counts: LearningMetrics['candidates'] };
  readonly active: { readonly version: number; readonly entries: number | null; readonly disabled: boolean; readonly restoredFrom: number | null; readonly invalid: boolean } | null;
  readonly history: readonly (Omit<KnowledgeVersion, 'document'> & { readonly entries: number | null; readonly terms: readonly string[] })[];
  readonly evaluations: readonly (Omit<EvaluationRow, 'result'> & { readonly summary: EvaluationSummary })[];
  readonly retention: typeof LEARNING_RETENTION;
};
export type EvaluationSummary = { readonly entries: number | null; readonly cases: string | null; readonly regressions: number | null; readonly safetyViolations: number | null;
  readonly probes: string | null; readonly effective: number | null; readonly hintOnly: number | null; readonly documentCode: string | null; readonly failures: readonly string[] };

const rate = (count: number, of: number): Rate => ({ count, of, rate: of > 0 ? count / of : null });
function summarize(result: unknown): EvaluationSummary {
  const r = (result ?? {}) as { entries?: number; cases?: { total?: number; candidate?: number; failed?: string[] }; regressions?: string[]; safetyViolations?: string[];
    probes?: { total?: number; passed?: number; effective?: number; hintOnly?: number; failed?: string[] }; document?: { code?: string | null } };
  const n = (value: unknown) => typeof value === 'number' ? value : null;
  return { entries: n(r.entries), cases: r.cases ? `${r.cases.candidate ?? 0}/${r.cases.total ?? 0}` : null, regressions: Array.isArray(r.regressions) ? r.regressions.length : null,
    safetyViolations: Array.isArray(r.safetyViolations) ? r.safetyViolations.length : null, probes: r.probes ? `${r.probes.passed ?? 0}/${r.probes.total ?? 0}` : null,
    effective: n(r.probes?.effective), hintOnly: n(r.probes?.hintOnly), documentCode: r.document?.code ?? null,
    failures: [...r.regressions ?? [], ...r.safetyViolations ?? [], ...r.cases?.failed ?? [], ...r.probes?.failed ?? []].filter(v => typeof v === 'string').slice(0, 8) };
}

export async function learningAdminView(env: Env, host: AdminHost, now: Date): Promise<LearningAdminView> {
  const config = learningConfig(env), since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000), store = createLearningStore(host.db, host.tenantId);
  const deployment = { enabled: config.enabled, reason: config.enabled ? null : config.reason, global: config.enabled ? config.global : true };
  const empty: LearningAdminView = { deployment, storeError: null, since: since.toISOString(),
    memory: { entries: 0, subjects: 0, walletSubjects: 0, channelSubjects: 0, contributors: 0 },
    turns: { total: 0, proposals: rate(0, 0), answers: rate(0, 0), clarifications: rate(0, 0), refusals: rate(0, 0), failures: rate(0, 0), memoryTurns: rate(0, 0), byScope: {} },
    corrections: rate(0, 0), clarificationAnswers: 0, repeatedFailures: 0, proposals: { applied: 0, dismissed: 0, revised: 0 }, suggestions: { confirmed: 0, rejected: 0 },
    interpreter: { ok: 0, failed: 0, failures: [] }, usage: { memoryUsed: 0, knowledgeUsed: 0 }, candidates: { pending: [], approved: [], rejected: [], counts: {} },
    active: null, history: [], evaluations: [], retention: LEARNING_RETENTION };
  let metrics: LearningMetrics, pending: Candidate[], approved: Candidate[], rejected: Candidate[], history: KnowledgeVersion[], evaluations: EvaluationRow[];
  try {
    [metrics, pending, approved, rejected, history, evaluations] = await Promise.all([store.metrics(since), store.candidates('PENDING', 50), store.candidates('APPROVED', 200),
      store.candidates('REJECTED', 50), store.knowledgeHistory(25), store.evaluations(25)]);
  } catch { return { ...empty, storeError: 'LEARNING_STORE_UNAVAILABLE' }; }
  const events = (kind: string, outcome?: string) => metrics.events.filter(e => e.kind === kind && (outcome === undefined || e.outcome === outcome)).reduce((t, e) => t + e.n, 0);
  // TURN outcomes are reply kinds on every scope (the web reports them; Channel Core maps its turn outcomes to them).
  const turns = events('TURN'), proposals = events('TURN', 'PROPOSAL') + events('TURN', 'AUTOMATION_PROPOSAL');
  const byScope: Record<string, number> = {};
  for (const e of metrics.events.filter(e => e.kind === 'TURN')) byScope[e.scope] = (byScope[e.scope] ?? 0) + e.n;
  const turnOutcome = (code: string) => events('TURN', code);
  const interpreted = metrics.events.filter(e => e.kind === 'INTERPRETED');
  const failures = interpreted.filter(e => e.outcome !== 'OK');
  const failureCodes = new Map<string, number>();
  for (const e of failures) failureCodes.set(e.outcome ?? 'UNKNOWN', (failureCodes.get(e.outcome ?? 'UNKNOWN') ?? 0) + e.n);
  const versionView = (row: KnowledgeVersion) => {
    let entries: number | null = null, terms: string[] = [];
    if (row.document !== null) try { const doc = validateKnowledgeDocument(row.document); entries = doc.entries.length; terms = doc.entries.map(e => `${e.term} → ${e.target}`); } catch { /* invalid */ }
    const { document: _document, ...rest } = row; void _document;
    return { ...rest, entries, terms };
  };
  const latest = history[0];
  return { ...empty,
    memory: { entries: metrics.memories.n, subjects: metrics.subjects.reduce((t, s) => t + s.memory, 0),
      walletSubjects: metrics.subjects.find(s => s.kind === 'WALLET')?.memory ?? 0, channelSubjects: metrics.subjects.find(s => s.kind === 'CHANNEL')?.memory ?? 0,
      contributors: metrics.subjects.reduce((t, s) => t + s.contribute, 0) },
    turns: { total: turns, proposals: rate(proposals, turns), answers: rate(turnOutcome('ANSWER'), turns), clarifications: rate(turnOutcome('CLARIFICATION'), turns),
      refusals: rate(turnOutcome('UNSUPPORTED'), turns), failures: rate(turnOutcome('FAILED'), turns), memoryTurns: rate(turnOutcome('MEMORY'), turns), byScope },
    corrections: rate(events('CORRECTION'), proposals), clarificationAnswers: events('CLARIFICATION_ANSWERED'), repeatedFailures: events('REPEATED_FAILURE'),
    proposals: { applied: events('PROPOSAL_APPLIED'), dismissed: events('PROPOSAL_DISMISSED'), revised: events('PROPOSAL_REVISED') },
    suggestions: { confirmed: events('SUGGESTION_CONFIRMED'), rejected: events('SUGGESTION_REJECTED') },
    interpreter: { ok: interpreted.filter(e => e.outcome === 'OK').reduce((t, e) => t + e.n, 0), failed: failures.reduce((t, e) => t + e.n, 0),
      failures: [...failureCodes].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n).slice(0, 8) },
    usage: { memoryUsed: events('MEMORY_USED'), knowledgeUsed: events('KNOWLEDGE_USED') },
    candidates: { pending, approved, rejected, counts: metrics.candidates },
    active: latest ? { version: latest.version, entries: versionView(latest).entries, disabled: latest.document === null, restoredFrom: latest.restoredFrom,
      invalid: latest.document !== null && versionView(latest).entries === null } : null,
    history: history.map(versionView),
    evaluations: evaluations.map(row => { const { result, ...rest } = row; return { ...rest, summary: summarize(result) }; }) };
}
