// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: FloFi's global Copilot glossary as a versioned document (`learning_knowledge_versions`, migration 0013). It is
 * language only: each entry maps a validated term to a closed-vocabulary target (`domain/copilot-lexicon.ts`). It is never instructions,
 * never a value, never support for an operation. A document is validated whole on every write and again on every read: a stored document
 * that no longer validates is not served (the Copilot then runs without the glossary).
 */
import { LEXICON_LIMITS, validateLexiconEntry, type LexiconEntry, type LexiconTarget } from '../domain/copilot-lexicon.ts';

export const KNOWLEDGE_SCHEMA = 'flofi.copilot-knowledge.v1';
export const KNOWLEDGE_LANGUAGES = ['EN', 'PT', 'ANY'] as const;
export type KnowledgeLanguage = (typeof KNOWLEDGE_LANGUAGES)[number];
export type KnowledgeEntry = { readonly term: string; readonly target: LexiconTarget; readonly language: KnowledgeLanguage; readonly candidateId: string | null };
export type KnowledgeDocument = { readonly schema: typeof KNOWLEDGE_SCHEMA; readonly entries: readonly KnowledgeEntry[] };
export const KNOWLEDGE_MAX_BYTES = 32_768;
export const CANDIDATE_ID = /^lkc_[a-z2-7]{26}$/;

export class KnowledgeError extends Error {
  constructor(readonly code: string, readonly index: number | null = null) { super(code); }
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Validates a whole document; throws `KnowledgeError` with a closed code (and the entry index) on the first problem. */
export function validateKnowledgeDocument(input: unknown): KnowledgeDocument {
  if (!plain(input) || Object.keys(input).sort().join() !== 'entries,schema' || input.schema !== KNOWLEDGE_SCHEMA || !Array.isArray(input.entries))
    throw new KnowledgeError('KNOWLEDGE_SHAPE_INVALID');
  if (input.entries.length > LEXICON_LIMITS.maxGlobal) throw new KnowledgeError('KNOWLEDGE_TOO_LARGE');
  const seen = new Set<string>(), entries: KnowledgeEntry[] = [];
  for (const [index, raw] of input.entries.entries()) {
    if (!plain(raw) || Object.keys(raw).sort().join() !== 'candidateId,language,target,term') throw new KnowledgeError('KNOWLEDGE_ENTRY_SHAPE_INVALID', index);
    const valid = validateLexiconEntry(raw.term, raw.target);
    if (!valid.ok) throw new KnowledgeError(valid.code, index);
    if (valid.term !== raw.term) throw new KnowledgeError('LEARNING_TERM_INVALID', index); // stored terms are already canonical
    if (!(KNOWLEDGE_LANGUAGES as readonly unknown[]).includes(raw.language)) throw new KnowledgeError('KNOWLEDGE_LANGUAGE_INVALID', index);
    if (raw.candidateId !== null && (typeof raw.candidateId !== 'string' || !CANDIDATE_ID.test(raw.candidateId))) throw new KnowledgeError('KNOWLEDGE_ENTRY_SHAPE_INVALID', index);
    if (seen.has(valid.term)) throw new KnowledgeError('KNOWLEDGE_TERM_DUPLICATE', index);
    seen.add(valid.term);
    entries.push(Object.freeze({ term: valid.term, target: valid.target, language: raw.language as KnowledgeLanguage, candidateId: raw.candidateId as string | null }));
  }
  const document: KnowledgeDocument = Object.freeze({ schema: KNOWLEDGE_SCHEMA, entries: Object.freeze(entries.sort((a, b) => a.term < b.term ? -1 : a.term > b.term ? 1 : 0)) });
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > KNOWLEDGE_MAX_BYTES) throw new KnowledgeError('KNOWLEDGE_TOO_LARGE');
  return document;
}
export const EMPTY_KNOWLEDGE: KnowledgeDocument = Object.freeze({ schema: KNOWLEDGE_SCHEMA, entries: Object.freeze([]) });
/** The document's entries as GLOBAL lexicon entries of `version` (what the engine and the model glossary use). */
export const knowledgeLexicon = (document: KnowledgeDocument | null, version: number | null): LexiconEntry[] =>
  (document?.entries ?? []).map(entry => Object.freeze({ term: entry.term, target: entry.target, source: 'GLOBAL' as const, ...version ? { version } : {} }));

/**
 * A reviewed starter set for Brazil-first, bilingual use (owner-reviewable; loading it only creates PENDING candidates — each must still be
 * approved by an operator and pass the evaluation before any version is published). Test-network abbreviations ground; typos of mainnets only
 * suggest; operation phrases are glossary hints for the interpreter.
 */
export const STARTER_CANDIDATES: readonly { readonly term: string; readonly target: LexiconTarget; readonly language: KnowledgeLanguage }[] = Object.freeze([
  { term: 'arb sepolia', target: 'network:ARBITRUM_SEPOLIA', language: 'ANY' },
  { term: 'arb sep', target: 'network:ARBITRUM_SEPOLIA', language: 'ANY' },
  { term: 'eth sepolia', target: 'network:ETHEREUM_SEPOLIA', language: 'ANY' },
  { term: 'sol devnet', target: 'network:SOLANA_DEVNET', language: 'ANY' },
  { term: 'arbitrun', target: 'network:ARBITRUM', language: 'ANY' },
  { term: 'arbitum', target: 'network:ARBITRUM', language: 'ANY' },
  { term: 'solona', target: 'network:SOLANA', language: 'ANY' },
  { term: 'fazer bridge', target: 'operation:BRIDGE', language: 'PT' },
  { term: 'fazer swap', target: 'operation:SWAP', language: 'PT' },
  { term: 'trocar', target: 'operation:SWAP', language: 'PT' },
  { term: 'converter', target: 'operation:SWAP', language: 'PT' },
  { term: 'depositar', target: 'operation:SUPPLY', language: 'PT' },
  { term: 'pegar emprestado', target: 'operation:BORROW', language: 'PT' },
  { term: 'quitar', target: 'operation:REPAY', language: 'PT' },
  { term: 'sacar', target: 'operation:WITHDRAW', language: 'PT' },
  { term: 'pôr liquidez', target: 'operation:LIQUIDITY', language: 'PT' },
  { term: 'prover liquidez', target: 'operation:LIQUIDITY', language: 'PT' },
  { term: 'cross-chain', target: 'operation:BRIDGE', language: 'EN' },
  { term: 'lend', target: 'operation:SUPPLY', language: 'EN' },
  { term: 'pay back', target: 'operation:REPAY', language: 'EN' },
  { term: 'provide liquidity', target: 'operation:LIQUIDITY', language: 'EN' },
] as const);
