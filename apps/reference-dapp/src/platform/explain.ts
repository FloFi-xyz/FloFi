// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FloFi's explanations for any surface (MCP `explain_concept` / `explain_strategy` today): the shared concept catalog
 * (`domain/intelligence/concepts.ts`) and a composed workflow read back in FloFi's own words — the shared presentation text of its steps
 * (`workflow-visual-layout.ts`), its deterministic Strategy Review findings and the concepts that apply to its steps.
 *
 * General knowledge, never live data: nothing here reads a chain, a price, a rate, a balance or a position, and nothing states a health factor,
 * LTV, price, APY or fee of any real position — those come only from FloFi's Simulation and the owner's Review. Explaining proposes, changes,
 * signs and authorizes nothing.
 */
import { answerConcept, CONCEPT_IDS, conceptCatalog, conceptInWorkflow, conceptName, conceptProtocols, conceptsForSteps, matchConcept, type ConceptId,
  type ConceptLevel, type ConceptProtocol } from '../domain/intelligence/concepts';
import type { WorkflowStep } from '../domain/workflow-steps';
import { operationSteps, type WorkflowComposition } from '../engine/strategy-engine';
import { refuse } from './refusal.ts';
import { reviewWorkflow } from './strategy.ts';
import { workflowVisualModel } from './workflow-visual.ts';
import { workflowVisualText } from './workflow-visual-layout.ts';

export type ExplainLanguage = 'EN' | 'PT';
/** What every explanation says about live values (it gives none). */
export const LIVE_VALUES_NOTE: Readonly<Record<ExplainLanguage, string>> = Object.freeze({
  EN: 'General knowledge, not live data. Live values — prices, rates and APY, balances, fees, health factor and LTV — come only from FloFi\'s Simulation and the owner\'s Review in FloFi.',
  PT: 'Conhecimento geral, não dados ao vivo. Valores ao vivo — preços, taxas e APY, saldos, custos de rede, health factor e LTV — vêm apenas da Simulação da FloFi e da Review do dono na FloFi.',
});
const STRATEGY_NOTE: Readonly<Record<ExplainLanguage, string>> = Object.freeze({
  EN: 'No live health factor, LTV, price or APY is given here: this explanation reads only the composed workflow and FloFi\'s deterministic review. Those values come only from FloFi\'s Simulation and the owner\'s Review.',
  PT: 'Nenhum health factor, LTV, preço ou APY ao vivo é informado aqui: esta explicação lê apenas o workflow composto e a revisão determinística da FloFi. Esses valores vêm apenas da Simulação da FloFi e da Review do dono.',
});

export type ConceptRequest = { readonly concept?: ConceptId | undefined; readonly term?: string | undefined; readonly level?: ConceptLevel | undefined;
  readonly protocol?: ConceptProtocol | undefined; readonly language?: ExplainLanguage | undefined };
/**
 * FloFi's explanation of one concept, named by its catalog id or by a term in the user's words (EN/PT aliases, small typos tolerated). Exactly one of
 * `concept` / `term`; a term FloFi does not know is `CONCEPT_UNKNOWN` with the catalog ids (the term itself is never echoed).
 */
export function explainConcept(request: ConceptRequest) {
  const language = request.language ?? 'EN';
  if ((request.concept === undefined) === (request.term === undefined)) refuse('CONCEPT_INPUT_INVALID', { issues: [{ path: '/', rule: 'exactlyOne(concept, term)' }] });
  const id = request.concept ?? matchConcept(request.term ?? '') ?? refuse('CONCEPT_UNKNOWN', { concepts: [...CONCEPT_IDS] });
  const answer = answerConcept(id, { level: request.level ?? 'STANDARD', protocol: request.protocol ?? null, language });
  return { id, name: conceptName(id, language), resolvedFrom: request.concept === undefined ? 'TERM' as const : 'CONCEPT' as const, level: answer.state.level,
    protocol: answer.state.protocol, language, text: answer.text, notes: answer.notes, related: conceptCatalog(language).find(entry => entry.id === id)!.related,
    protocols: conceptProtocols(id), generalKnowledge: true as const, liveData: false as const, liveValues: LIVE_VALUES_NOTE[language] };
}

/**
 * The concepts a step makes most important to understand before the owner reviews it: collateral, health factor and liquidation for a borrow, slippage
 * for a swap or bridge, token approvals where an EVM step spends a token, impermanent loss for liquidity. A subset of `conceptsForSteps([step])`.
 */
function focusOf(step: WorkflowStep): readonly ConceptId[] {
  const d = step.detail;
  const focus: readonly ConceptId[] = (() => {
    switch (d.type) {
      case 'AAVE': return d.operation === 'BORROW' ? ['COLLATERAL', 'HEALTH_FACTOR', 'LIQUIDATION', 'LTV'] : d.operation === 'SUPPLY' ? ['COLLATERAL', 'TOKEN_APPROVAL']
        : ['HEALTH_FACTOR', 'TOKEN_APPROVAL'];
      case 'AAVE_WITHDRAW': return ['HEALTH_FACTOR', 'LIQUIDATION'];
      case 'LENDING_COMPOSITION': return d.role === 'BORROW' ? ['COLLATERAL', 'HEALTH_FACTOR', 'LIQUIDATION', 'LTV'] : d.role === 'SUPPLY' ? ['COLLATERAL', 'TOKEN_APPROVAL']
        : ['SLIPPAGE', 'TOKEN_APPROVAL'];
      case 'EVM_SWAP': return ['SLIPPAGE', 'TOKEN_APPROVAL'];
      case 'CATALOG_SWAP': return d.from === 'ETH' ? ['SLIPPAGE'] : ['SLIPPAGE', 'TOKEN_APPROVAL'];
      // Solana has no ERC-20 allowances.
      case 'SOLANA_SWAP': return ['SLIPPAGE'];
      case 'ROUTER': return ['SLIPPAGE', 'BRIDGE', 'TOKEN_APPROVAL'];
      case 'UNIVERSAL_BRIDGE': return d.input.source === 'solana' ? ['SLIPPAGE', 'BRIDGE'] : ['SLIPPAGE', 'BRIDGE', 'TOKEN_APPROVAL'];
      case 'UNISWAP_LIQUIDITY': case 'CATALOG_LIQUIDITY': return ['IMPERMANENT_LOSS', 'CONCENTRATED_LIQUIDITY', 'TOKEN_APPROVAL'];
      case 'ORCA_LIQUIDITY': return ['IMPERMANENT_LOSS', 'CONCENTRATED_LIQUIDITY'];
      default: return [];
    }
  })();
  const applies = new Set(conceptsForSteps([step]));
  return focus.filter(id => applies.has(id));
}

/**
 * A composed workflow explained: each canonical step in FloFi's shared presentation words with the concepts most relevant to it, the deterministic
 * Strategy Review (BLOCK / WARNING / INFORMATION), and FloFi's explanation of every concept that applies to the steps — those most relevant to a step
 * first (`highlighted`), each also located in this workflow. Live values are never part of it (`liveData: false`).
 */
export function explainWorkflow(workflow: WorkflowComposition, language: ExplainLanguage = 'EN') {
  const reviewed = reviewWorkflow(workflow), model = workflowVisualModel(workflow), text = workflowVisualText(model, language);
  // The presentation model shows every operation's canonical steps in order except the editor's authoring-only template (`workflow-visual.ts`): a Batch
  // Payment is its one operation (`operationSteps`), never its legs. `workflowStep` stays the index in `workflow.steps` (the legs `review.steps` and
  // compose_strategy's `workflowSteps` use): a Batch Payment's first leg, and `legs` names all of them.
  let leg = 0;
  const canonical = operationSteps(workflow).flatMap(composition => {
    const step = leg, batch = (workflow.batches ?? []).find(b => b.composition === composition) ?? null;
    leg = batch ? batch.to + 1 : leg + 1;
    return composition.steps.filter(s => s.detail.type !== 'TEMPLATE').map(s => ({ step, action: composition.strategy.action, canonical: s, batch }));
  });
  const words = new Map<WorkflowStep, string>(canonical.map((entry, i) => [entry.canonical, (text.lines[i] ?? '').replace(/^\d+\.\s*/, '')]));
  // A Batch Payment's concepts are those of the transfers it executes (gas and network fees, which the owner's wallet pays): its first leg's step stands
  // for them, described as the batch itself (one line, never one per payment). Every other step is its own.
  const conceptStep = (entry: (typeof canonical)[number]) => {
    const transfer = entry.batch ? workflow.steps[entry.batch.from]?.steps.find(s => s.detail.type !== 'TEMPLATE') : undefined;
    if (transfer) words.set(transfer, words.get(entry.canonical) ?? entry.canonical.kind);
    return transfer ?? entry.canonical;
  };
  const describe = (step: WorkflowStep) => words.get(step) ?? step.kind;
  const steps = canonical.map(conceptStep), applies = conceptsForSteps(steps);
  const highlighted = new Set(canonical.flatMap(entry => focusOf(entry.canonical)));
  const ordered = [...applies.filter(id => highlighted.has(id)), ...applies.filter(id => !highlighted.has(id))];
  return {
    workflowHash: workflow.workflowHash, fundsClass: workflow.fundsClass, stepCount: workflow.steps.length, language, title: text.title, summary: text.summary,
    steps: canonical.map((entry, i) => ({ index: i + 1, workflowStep: entry.step, ...entry.batch ? { legs: [entry.batch.from, entry.batch.to] as const } : {},
      action: entry.action, kind: entry.canonical.kind, protocol: entry.canonical.protocol,
      network: entry.canonical.network, description: describe(entry.canonical), keyConcepts: focusOf(entry.canonical) })),
    warnings: model.warnings,
    review: { kind: 'DETERMINISTIC_STRATEGY_REVIEW' as const, summary: reviewed.summary,
      steps: reviewed.steps.map(r => ({ index: r.index, workflowHash: r.workflowHash, summary: r.summary, findings: r.findings })) },
    concepts: ordered.map(id => {
      const answer = answerConcept(id, { language }), located = conceptInWorkflow(id, steps, language, describe);
      return { id, name: conceptName(id, language), highlighted: highlighted.has(id), text: answer.text, inWorkflow: located.text, notes: answer.notes };
    }),
    generalKnowledge: true as const, liveData: false as const, liveValues: STRATEGY_NOTE[language],
  };
}
