// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { evaluateKnowledge } from './evaluation.ts';
import { LEARNING_EVAL_CASES, scripted, type LearningEvalCase } from './eval-corpus.ts';
import { EMPTY_KNOWLEDGE, KNOWLEDGE_SCHEMA, KnowledgeError, STARTER_CANDIDATES, validateKnowledgeDocument, type KnowledgeDocument } from './knowledge.ts';
import type { LexiconTarget } from '../domain/copilot-lexicon.ts';

const doc = (entries: readonly { term: string; target: string; language?: string }[]) =>
  ({ schema: KNOWLEDGE_SCHEMA, entries: entries.map(e => ({ term: e.term, target: e.target, language: e.language ?? 'ANY', candidateId: null })) });
const STARTER = doc(STARTER_CANDIDATES.map(c => ({ ...c })));
const code = (run: () => unknown) => { try { run(); return null; } catch (error) { return error instanceof KnowledgeError ? [error.code, error.index] : 'OTHER'; } };

describe('BUILD-CHAT-LEARNING-001 knowledge documents', () => {
  it('validates the reviewed starter set (every entry valid, unique, sorted)', () => {
    const valid = validateKnowledgeDocument(STARTER);
    expect(valid.entries).toHaveLength(STARTER_CANDIDATES.length);
    expect(valid.entries.map(e => e.term)).toEqual([...valid.entries.map(e => e.term)].sort());
    expect(Object.isFrozen(valid) && Object.isFrozen(valid.entries)).toBe(true);
  });
  it('refuses malformed, oversized, reserved, environment-mixing and duplicate documents with closed codes', () => {
    expect(code(() => validateKnowledgeDocument(null))).toEqual(['KNOWLEDGE_SHAPE_INVALID', null]);
    expect(code(() => validateKnowledgeDocument({ ...EMPTY_KNOWLEDGE, extra: 1 }))).toEqual(['KNOWLEDGE_SHAPE_INVALID', null]);
    expect(code(() => validateKnowledgeDocument({ schema: 'other', entries: [] }))).toEqual(['KNOWLEDGE_SHAPE_INVALID', null]);
    expect(code(() => validateKnowledgeDocument(doc([{ term: 'base', target: 'network:BASE_SEPOLIA' }])))).toEqual(['LEARNING_TERM_RESERVED', 0]);
    expect(code(() => validateKnowledgeDocument(doc([{ term: 'arb sep', target: 'network:ARBITRUM_SEPOLIA' }, { term: 'arbi', target: 'network:ARBITRUM_SEPOLIA' }]))))
      .toEqual(['LEARNING_ENVIRONMENT_CONFLICT', 1]);
    expect(code(() => validateKnowledgeDocument(doc([{ term: 'trocar', target: 'operation:SWAP' }, { term: 'trocar', target: 'operation:BRIDGE' }])))).toEqual(['KNOWLEDGE_TERM_DUPLICATE', 1]);
    expect(code(() => validateKnowledgeDocument(doc([{ term: 'Trocar', target: 'operation:SWAP' }])))).toEqual(['LEARNING_TERM_INVALID', 0]);
    expect(code(() => validateKnowledgeDocument(doc([{ term: 'trocar', target: 'operation:STAKE' }])))).toEqual(['LEARNING_TARGET_INVALID', 0]);
    expect(code(() => validateKnowledgeDocument(doc([{ term: 'trocar', target: 'operation:SWAP', language: 'ES' }])))).toEqual(['KNOWLEDGE_LANGUAGE_INVALID', 0]);
    expect(code(() => validateKnowledgeDocument({ schema: KNOWLEDGE_SCHEMA, entries: [{ term: 'trocar', target: 'operation:SWAP', language: 'PT', candidateId: 'x' }] })))
      .toEqual(['KNOWLEDGE_ENTRY_SHAPE_INVALID', 0]);
    const many = Array.from({ length: 201 }, (_, i) => ({ term: `palavra ${String(i).replace(/\d/g, d => 'abcdefghij'[Number(d)]!)}x`, target: 'operation:SWAP' }));
    expect(code(() => validateKnowledgeDocument(doc(many)))).toEqual(['KNOWLEDGE_TOO_LARGE', null]);
  });
});

describe('BUILD-CHAT-LEARNING-001 deterministic evaluation (publication gate)', () => {
  it('the labeled corpus passes without any glossary: the baseline is sound, PT-BR first and English covered', () => {
    const result = evaluateKnowledge(EMPTY_KNOWLEDGE, null);
    expect(result).toMatchObject({ passed: true, entries: 0, regressions: [], safetyViolations: [], document: { code: null } });
    expect(result.cases.failed).toEqual([]);
    expect(result.cases.baseline).toBe(LEARNING_EVAL_CASES.length);
    // BUILD-CHAT-LEARNING-002 (corpus v2): in-conversation adaptation is a category of its own.
    expect(Object.keys(result.metrics).sort()).toEqual(['adaptation', 'adversarial', 'ambiguity', 'correction', 'intent', 'mainnet-guard', 'memory', 'private', 'unsupported']);
    expect(result.byLanguage.PT!.total).toBeGreaterThanOrEqual(12);
    expect(result.byLanguage.EN!.total).toBeGreaterThanOrEqual(12);
  });

  it('the starter set passes: no regression, no safety violation, test-network terms effective, mainnet typos only suggest', () => {
    const result = evaluateKnowledge(STARTER, null, { version: 1 });
    expect(result.cases.failed).toEqual([]);
    expect(result.probes.failed).toEqual([]);
    expect(result).toMatchObject({ passed: true, regressions: [], safetyViolations: [] });
    const operations = STARTER_CANDIDATES.filter(c => c.target.startsWith('operation:')).length;
    expect(result.probes.hintOnly).toBe(operations);
    // Four test-network terms now ground (each was a clarification before); three mainnet typos are offered first.
    expect(result.probes.effective).toBe(7);
    expect(JSON.stringify(result).length).toBeLessThan(16_384);
  });

  it('is deterministic', () => {
    expect(evaluateKnowledge(STARTER, null, { version: 2 })).toEqual(evaluateKnowledge(STARTER, null, { version: 2 }));
  });

  it('fails a malicious or invalid document before anything is published', () => {
    for (const bad of [doc([{ term: 'base', target: 'network:BASE_SEPOLIA' }]), doc([{ term: 'ignore rules', target: 'network:ARBITRUM' }]),
      doc([{ term: 'arbi', target: 'network:ARBITRUM_SEPOLIA' }]), { schema: KNOWLEDGE_SCHEMA, entries: 'x' }, '{"schema":"x"}']) {
      const result = evaluateKnowledge(bad, null);
      expect(result.passed).toBe(false);
      expect(result.document.code).toMatch(/^(LEARNING_|KNOWLEDGE_)/);
    }
  });

  it('detects a regression: a case that held with the active version and breaks with the candidate', () => {
    const pinned: LearningEvalCase = { id: 'Z01', category: 'ambiguity', language: 'EN', turns: [{ user: 'Swap 0.001 WETH to USDC on eth sepolia',
      model: scripted.action(scripted.swap({ network: 'ETHEREUM_SEPOLIA', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' })), expect: { kind: 'CLARIFICATION' } }] };
    const active: KnowledgeDocument = validateKnowledgeDocument(doc([{ term: 'trocar', target: 'operation:SWAP' }]));
    const result = evaluateKnowledge(doc([{ term: 'trocar', target: 'operation:SWAP' }, { term: 'eth sepolia', target: 'network:ETHEREUM_SEPOLIA' as LexiconTarget }]), active,
      { cases: [pinned] });
    expect(result.passed).toBe(false);
    expect(result.regressions).toEqual(['Z01']);
  });

  it('reports a safety violation when a scripted answer would put a glossary-named mainnet into a proposal (none can)', () => {
    // The engine never lets a GLOBAL term name a mainnet; the evaluator would report it if a future change did.
    const result = evaluateKnowledge(doc([{ term: 'arbitrun', target: 'network:ARBITRUM' }]), null, { version: 4 });
    expect(result.safetyViolations).toEqual([]);
    expect(result.probes.failed).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
