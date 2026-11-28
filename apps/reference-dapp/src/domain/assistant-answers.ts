// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A04/A05/A08): FloFi's deterministic answers to read-only questions about the current workflow and the
 * CURRENT revision's simulation — its status, quote validity, expected and minimum outputs, costs, FloFi's fee and whether an operation is worth its
 * costs. The facts come from `assistant-facts.ts` (the web chat's own projections of the selected runtime's simulation); this module only reads
 * them, so the conversation engine and every channel can share it. Nothing here estimates, converts or prices anything: a cost in another asset is
 * named in that asset, and a retired or expired simulation is never presented as current. Pure; nothing here proposes, changes, signs or executes.
 *
 *   readOnlyQuestion(text)                     a question about the simulation, costs, expected output, economics or the workflow itself, or null
 *   answerReadOnly(question, facts, steps, l)  FloFi's short answer, then the next action
 */
import { amountReadings } from './copilot-authoring';
import { stepSentence, stepSummary } from './copilot-answers';
import type { CopilotTarget } from './copilot-intent-v2';
import { findStepReference, pickStep, readStepEdit } from './step-reference';
import { displayAmountText } from './token-amount-display';
import { translate } from '../i18n/translate';
import type { WorkflowStep } from './workflow-steps';

type ConversationLanguage = 'EN' | 'PT';
// ── Facts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type SimulationStatus = 'CURRENT' | 'EXPIRED' | 'CHANGED' | 'RUNNING' | 'BLOCKED' | 'NONE';
export type AssistantSimulationStep = { readonly number: number; readonly kind: WorkflowStep['kind'] | null; readonly action: string; readonly input: string;
  readonly output: string | null; readonly outputLabel: string; readonly minimum: string | null; readonly provider: string | null };
export type AssistantCost = { readonly label: string; readonly value: string; readonly treatment: string | null };
export type PlatformFeeFacts = {
  /** "0.80%": the canonical rate. */ readonly rate: string;
  readonly status: 'FEEABLE' | 'NOT_APPLICABLE' | 'UNSUPPORTED';
  /** Per asset, "<amount> <symbol>" (the policy's floor of 0.80% of the principal the owner introduces). */ readonly amounts: readonly string[];
  /** The fee line the current simulation itself records (a route's own obligation), when it has one: shown instead of the estimate. */
  readonly recorded: string | null;
};
export type AssistantSimulation = {
  readonly workflowId: string; readonly revision: number; readonly status: SimulationStatus;
  /** CURRENT only: when the quote stops being valid (epoch ms), or null when the runtime gives no wall-clock expiry. */ readonly expiresAt: number | null;
  /** CURRENT only (empty otherwise): the figures of the simulation of exactly this revision. */
  readonly steps: readonly AssistantSimulationStep[]; readonly costs: readonly AssistantCost[];
  /** CURRENT only: exact per-asset sums of what is paid on top of the amount sent, of the maximums, and the costs the simulation does not provide. */
  readonly additional: readonly string[]; readonly ceilings: readonly string[]; readonly missing: readonly string[];
  readonly platformFee: PlatformFeeFacts;
  /** BLOCKED: the simulation's own reason (an English catalog message). */ readonly problem: string | null;
  /** The workflow has at least one action (an empty draft has nothing to simulate). */ readonly actionable: boolean;
};

// ── Exact decimal arithmetic on "<number> <symbol>" values ──────────────────────────────────────────────────────────────────────────────
type Amount = { readonly units: bigint; readonly scale: number; readonly symbol: string };
function amountOf(value: string | null | undefined): Amount | null {
  const match = /^(?:[≈~]\s*)?(\d+)(?:\.(\d+))? (\S+)$/.exec((value ?? '').trim());
  return match ? { units: BigInt(match[1]! + (match[2] ?? '')), scale: (match[2] ?? '').length, symbol: match[3]! } : null;
}
const align = (a: Amount, scale: number) => a.units * 10n ** BigInt(scale - a.scale);
const sum = (values: readonly Amount[]): Amount | null => {
  if (!values.length) return null;
  const scale = Math.max(...values.map(value => value.scale));
  return { units: values.reduce((total, value) => total + align(value, scale), 0n), scale, symbol: values[0]!.symbol };
};
const text = (a: Amount): string => { const padded = a.units.toString().padStart(a.scale + 1, '0'), whole = a.scale ? padded.slice(0, -a.scale) : padded;
  const fraction = a.scale ? padded.slice(-a.scale).replace(/0+$/, '') : ''; return `${whole}${fraction ? `.${fraction}` : ''} ${a.symbol}`; };
/** `part` as a percentage of `whole` (same asset), with one decimal under 10% and none above; null when it cannot be computed. */
function share(part: Amount, whole: Amount, language: ConversationLanguage): string | null {
  if (whole.units === 0n) return null;
  const scale = Math.max(part.scale, whole.scale), tenths = (align(part, scale) * 1000n + align(whole, scale) / 2n) / align(whole, scale);
  const shown = tenths >= 100n ? `${(tenths + 5n) / 10n}` : `${tenths / 10n}.${tenths % 10n}`.replace(/\.0$/, '');
  return `${language === 'PT' ? shown.replace('.', ',') : shown}%`;
}

// ── Read-only questions ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ReadOnlyKind = 'SIMULATION' | 'COSTS' | 'OUTPUT' | 'WORTH' | 'WORKFLOW' | 'STEP';
export type ReadOnlyQuestion = { readonly kind: ReadOnlyKind; readonly target: CopilotTarget | null; readonly amount: Amount | null };
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, ' ').replace(/[?!.,;:¿¡]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
const WORTH = /(?:^|\s)(?:compensa|compensaria|vale a pena|valeria a pena|faz sentido|e caro|esta caro|sai caro|fica caro|e barato|sai barato|worth it|is it worth|would it be worth|is this worth|is that worth|does it make sense|is it expensive|is it too expensive|is it cheap|too expensive)(?:\s|$)/;
const COSTS = /(?:^|\s)(?:quanto (?:vai |iria |vou |eu vou )?(?:custa|custar|custaria|pagar|pago|sai|sair)|quais (?:sao )?(?:as |os )?(?:taxas|custos|tarifas)|qual (?:e )?(?:a |o )?(?:taxa|custo|tarifa)|custo total|taxa da flofi|how much (?:does it|will it|would it|is it going to|does this|will this) cost|what (?:are|is|s) the (?:fees?|costs?)|how much are the fees|what will i pay|how much will i pay|what does it cost|flofi fee|what fees)(?:\s|$)/;
const OUTPUT = /(?:^|\s)(?:quanto (?:eu )?(?:vou receber|recebo|receberia|chega|vai chegar|vou ganhar)|qual (?:e )?o (?:minimo|valor minimo)|recebo quanto|how much (?:will|would|do) i (?:get|receive)|what will i (?:get|receive)|what s the minimum|what is the minimum|minimum (?:output|received|i get))(?:\s|$)/;
const SIMULATION = /(?:^|\s)(?:(?:a |minha |essa |esta )?simulacao (?:esta|e|ainda|continua|vale)|tem (?:uma )?simulacao|ha (?:uma )?simulacao|existe (?:uma )?simulacao|resultado da simulacao|o que a simulacao|a cotacao (?:ainda )?(?:esta|e) valida|quando (?:a cotacao |a simulacao )?expira|validade da (?:cotacao|simulacao)|is (?:the|my|this) (?:simulation|quote) (?:still )?(?:valid|current|up to date)|when does (?:the|my|this) (?:quote|simulation) expire|what did the simulation|simulation result|is there a simulation|do i have a simulation|has it been simulated|foi simulad[oa])(?:\s|$)/;
const WORKFLOW = /(?:^|\s)(?:o que tem no (?:meu |seu |este |esse )?(?:fluxo|workflow)|quais (?:sao )?as etapas|quantas etapas|o que (?:o |esse |este |meu )(?:fluxo|workflow) faz|what s in my workflow|what is in my workflow|what are the steps|how many steps|what does (?:my|this) workflow do|list (?:the|my) steps)(?:\s|$)/;
const STEP_QUESTION = /(?:^|\s)(?:o que (?:faz|e|sera)|qual (?:e )?|como (?:esta|e)|what (?:does|is)|explain|explique|describe|descreva|show me|mostre)(?:\s|$)/;
const MUTATION = /^(?:(?:por favor|please|pode|can you|could you|quero|i want to)\s+)?(?:altere|alterar|mude|mudar|troque|trocar|faca|faz|adicione|adicionar|remova|remover|envie|enviar|mande|crie|criar|change|set|update|add|remove|delete|create|swap|bridge|supply|send|transfer|deposit|borrow|repay|withdraw|make|put|do)\s/;
/** A read-only question FloFi answers from its own facts, or null (an action request or edit is never one). */
export function readOnlyQuestion(raw: string): ReadOnlyQuestion | null {
  if (typeof raw !== 'string' || raw.length > 240 || /0x[0-9a-f]{6}/i.test(raw) || readStepEdit(raw)) return null;
  const folded = fold(raw), question = /\?\s*$/.test(raw.trim());
  if (MUTATION.test(folded) && !question) return null;
  const target = findStepReference(raw);
  // The amount the question names ("uma bridge de 0,1 USDC"), only when it reads exactly one way.
  const written = /(\d(?:[\d.,]*\d)?)\s*([A-Za-z][A-Za-z0-9.]{1,11})/.exec(raw), readings = written ? amountReadings(written[1]!) : [];
  const amount = written && readings.length === 1 ? amountOf(`${readings[0]!} ${written[2]!}`) : null;
  if (WORTH.test(folded)) return { kind: 'WORTH', target, amount };
  if (COSTS.test(folded)) return { kind: 'COSTS', target, amount: null };
  if (OUTPUT.test(folded)) return { kind: 'OUTPUT', target, amount: null };
  if (SIMULATION.test(folded) && (question || /^(?:is|when|what|do|has|tem|ha|existe|quando|qual|a simulacao|minha simulacao|resultado)/.test(folded))) return { kind: 'SIMULATION', target: null, amount: null };
  if (WORKFLOW.test(folded)) return { kind: 'WORKFLOW', target: null, amount: null };
  // "O que faz a segunda etapa?" (an ordinal), "o que faz o supply do meu fluxo?": a step of this workflow. "O que é supply?" is a concept question.
  if (target && STEP_QUESTION.test(folded) && (target.ordinal !== null || /(?:^|\s)(?:faz|does|do meu|in my|no meu|meu|my)(?:\s|$)/.test(folded))) return { kind: 'STEP', target, amount: null };
  return null;
}

// ── Answers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Copy = {
  readonly current: (minutes: number | null) => string; readonly expired: string; readonly changed: string; readonly running: string; readonly blocked: (reason: string) => string;
  readonly none: string; readonly empty: string;
  readonly stepFigure: (step: number, action: string, input: string, output: string | null, minimum: string | null) => string;
  readonly costsIntro: string; readonly costLine: (label: string, value: string) => string; readonly noCosts: string; readonly missing: (what: string) => string;
  readonly fee: (rate: string, amounts: string | null) => string; readonly feeRecorded: (value: string) => string; readonly feeUnknown: (rate: string) => string;
  readonly worthNeedsSimulation: string; readonly worthNoStep: (operation: string) => string; readonly worthOtherAmount: (simulated: string, asked: string) => string;
  readonly worth: (operation: string, input: string, output: string | null, cost: string, ratio: string) => string; readonly worthNoSameAsset: (operation: string, input: string) => string;
  readonly elsewhere: (costs: string) => string; readonly low: string; readonly moderate: string; readonly high: string;
  readonly workflow: (count: number, lines: string) => string; readonly step: (number: number, sentence: string) => string; readonly noStep: string; readonly whichStep: (lines: string) => string;
};
const EN: Copy = {
  current: minutes => minutes === null ? 'There is a current simulation for this version of the workflow.' : minutes < 1 ? 'The current simulation is valid for less than a minute.'
    : `The current simulation is valid for about ${minutes} more min.`,
  expired: 'The last simulation expired, so its figures no longer apply. Do you want to simulate again?',
  changed: 'The workflow changed after the last simulation, so its figures no longer apply. Do you want to simulate again?',
  running: 'The simulation is running. Its figures appear as soon as it finishes.',
  blocked: reason => `The last simulation cannot be used: ${reason}`,
  none: 'There is no simulation of this workflow yet. Do you want to simulate it now?',
  empty: 'Your workflow has no actions yet. Add one, then simulate it.',
  stepFigure: (step, action, input, output, minimum) => `Step ${step} (${action} ${input}): ${output ? `about ${output}` : 'no estimated output'}${minimum ? `, at least ${minimum}` : ''}.`,
  costsIntro: 'Estimated costs in the current simulation:', costLine: (label, value) => `${label}: ${value}`, noCosts: 'The current simulation lists no cost lines.',
  missing: what => `Not provided by the simulation: ${what}.`,
  fee: (rate, amounts) => `FloFi fee: ${rate}${amounts ? ` (${amounts})` : ''}, not charged at this time.`,
  feeRecorded: value => `FloFi fee recorded for this route: ${value}, not charged at this time.`,
  feeUnknown: rate => `FloFi fee: ${rate} of the amount you introduce, not charged at this time.`,
  worthNeedsSimulation: 'To compare the amount with its costs I need a current simulation. Do you want to simulate now?',
  worthNoStep: operation => `This workflow has no ${operation} yet. Add it and simulate to see its costs.`,
  worthOtherAmount: (simulated, asked) => `The current simulation is for ${simulated}, not ${asked}. Change the amount and simulate again to compare.`,
  worth: (operation, input, output, cost, ratio) => `In the current simulation, the ${operation} of ${input}${output ? ` delivers about ${output}` : ''}: costs are ${cost}, about ${ratio} of the amount.`,
  worthNoSameAsset: (operation, input) => `The current simulation of the ${operation} of ${input} lists no cost in the same asset, so I cannot give a percentage without a price.`,
  elsewhere: costs => `Paid separately: ${costs}.`,
  low: 'That is a low cost for this amount.', moderate: 'That is a moderate cost for this amount.',
  high: 'Costs weigh a lot on this amount; with a larger amount the share drops. It is still your call.',
  workflow: (count, lines) => `Your workflow has ${count} step${count === 1 ? '' : 's'}: ${lines}`,
  step: (number, sentence) => `Step ${number}: ${sentence}`, noStep: 'Your workflow has no such step.', whichStep: lines => `Which step do you mean? ${lines}`,
};
const PT: Copy = {
  current: minutes => minutes === null ? 'Há uma simulação atual desta versão do fluxo.' : minutes < 1 ? 'A simulação atual vale por menos de um minuto.'
    : `A simulação atual vale por mais cerca de ${minutes} min.`,
  expired: 'A última simulação expirou, então os números dela não valem mais. Quer simular de novo?',
  changed: 'O fluxo mudou depois da última simulação, então os números dela não valem mais. Quer simular de novo?',
  running: 'A simulação está em andamento. Os números aparecem assim que ela terminar.',
  blocked: reason => `A última simulação não pode ser usada: ${reason}`,
  none: 'Ainda não há simulação deste fluxo. Quer simular agora?',
  empty: 'Seu fluxo ainda não tem ações. Adicione uma e depois simule.',
  stepFigure: (step, action, input, output, minimum) => `Etapa ${step} (${action} ${input}): ${output ? `cerca de ${output}` : 'sem resultado estimado'}${minimum ? `, no mínimo ${minimum}` : ''}.`,
  costsIntro: 'Custos estimados na simulação atual:', costLine: (label, value) => `${label}: ${value}`, noCosts: 'A simulação atual não lista custos.',
  missing: what => `A simulação não informa: ${what}.`,
  fee: (rate, amounts) => `Taxa da FloFi: ${rate}${amounts ? ` (${amounts})` : ''}, não cobrada no momento.`,
  feeRecorded: value => `Taxa da FloFi registrada para esta rota: ${value}, não cobrada no momento.`,
  feeUnknown: rate => `Taxa da FloFi: ${rate} do valor que você coloca, não cobrada no momento.`,
  worthNeedsSimulation: 'Para comparar o valor com os custos, preciso de uma simulação atual. Quer simular agora?',
  worthNoStep: operation => `Este fluxo ainda não tem ${operation}. Adicione e simule para ver os custos.`,
  worthOtherAmount: (simulated, asked) => `A simulação atual é de ${simulated}, não de ${asked}. Altere o valor e simule de novo para comparar.`,
  worth: (operation, input, output, cost, ratio) => `Na simulação atual, ${operation} de ${input}${output ? ` entrega cerca de ${output}` : ''}: os custos são ${cost}, cerca de ${ratio} do valor.`,
  worthNoSameAsset: (operation, input) => `A simulação atual de ${operation} de ${input} não lista custo no mesmo ativo, então não consigo dar uma porcentagem sem um preço.`,
  elsewhere: costs => `Pago à parte: ${costs}.`,
  low: 'É um custo baixo para esse valor.', moderate: 'É um custo moderado para esse valor.',
  high: 'Os custos pesam bastante nesse valor; com um valor maior, a proporção cai. A decisão é sua.',
  workflow: (count, lines) => `Seu fluxo tem ${count} etapa${count === 1 ? '' : 's'}: ${lines}`,
  step: (number, sentence) => `Etapa ${number}: ${sentence}`, noStep: 'Seu fluxo não tem essa etapa.', whichStep: lines => `Qual etapa? ${lines}`,
};
/** The name of an operation in a sentence ("the bridge" / "a bridge"). */
const OPERATION: Readonly<Record<ConversationLanguage, Partial<Record<string, string>>>> = {
  EN: { SWAP: 'swap', BRIDGE: 'bridge', SUPPLY: 'supply', BORROW: 'borrow', REPAY: 'repay', WITHDRAW: 'withdrawal', LIQUIDITY: 'liquidity', TRANSFER: 'transfer', BATCH_PAYMENT: 'Batch Payment' },
  PT: { SWAP: 'o swap', BRIDGE: 'a bridge', SUPPLY: 'o supply', BORROW: 'o empréstimo', REPAY: 'o repay', WITHDRAW: 'o saque', LIQUIDITY: 'a liquidez', TRANSFER: 'a transferência', BATCH_PAYMENT: 'o pagamento em lote' },
};
const OPERATION_NO_ARTICLE: Readonly<Record<ConversationLanguage, Partial<Record<string, string>>>> = {
  EN: { SWAP: 'a swap', BRIDGE: 'a bridge', SUPPLY: 'a supply', BORROW: 'a borrow', REPAY: 'a repay', WITHDRAW: 'a withdrawal', LIQUIDITY: 'a liquidity step', TRANSFER: 'a transfer' },
  PT: { SWAP: 'um swap', BRIDGE: 'uma bridge', SUPPLY: 'um supply', BORROW: 'um empréstimo', REPAY: 'um repay', WITHDRAW: 'um saque', LIQUIDITY: 'uma etapa de liquidez', TRANSFER: 'uma transferência' },
};
export const assistantFactsCopy = (language: ConversationLanguage): Copy => language === 'PT' ? PT : EN;
const shown = (value: string, language: ConversationLanguage, rounding: 'down' | 'up' | 'nearest' = 'nearest') =>
  displayAmountText(value, { language, rounding, marker: false })?.text ?? value;

export type ReadOnlyAnswer = { readonly text: string; readonly notes: readonly string[];
  /** Offer the existing Review workflow answer (it simulates): no current simulation, an expired or a changed one. */ readonly offerSimulation: boolean };
/** FloFi's answer to a read-only question, from these facts only: the answer first, then the next action. */
export function answerReadOnly(question: ReadOnlyQuestion, facts: AssistantSimulation, steps: readonly WorkflowStep[], language: ConversationLanguage, now = Date.now()): ReadOnlyAnswer {
  const c = assistantFactsCopy(language), answer = (text: string, notes: readonly string[] = [], offerSimulation = false): ReadOnlyAnswer => ({ text, notes, offerSimulation });
  const actions = steps.filter(step => step.kind !== 'TEMPLATE');
  if (question.kind === 'WORKFLOW') return actions.length ? answer(c.workflow(actions.length, actions.map((step, at) => `${at + 1}. ${stepSummary(step, language)}`).join('; ') + '.')) : answer(c.empty);
  if (question.kind === 'STEP') {
    const picked = pickStep(question.target!, actions);
    if (picked.step) return answer(c.step(actions.indexOf(picked.step) + 1, stepSentence(picked.step, language)));
    return picked.candidates.length > 1 ? answer(c.whichStep(picked.candidates.map(step => `${actions.indexOf(step) + 1}. ${stepSummary(step, language)}`).join('; ') + '.')) : answer(c.noStep);
  }
  if (!facts.actionable) return answer(c.empty);
  const unavailable = (): ReadOnlyAnswer | null => facts.status === 'CURRENT' ? null : facts.status === 'EXPIRED' ? answer(c.expired, [], true) : facts.status === 'CHANGED' ? answer(c.changed, [], true)
    : facts.status === 'RUNNING' ? answer(c.running) : facts.status === 'BLOCKED' ? answer(c.blocked(translate(language, facts.problem ?? '')), [], true) : answer(c.none, [], true);
  const rate = language === 'PT' ? facts.platformFee.rate.replace('.', ',') : facts.platformFee.rate;
  const feeLine = () => facts.platformFee.recorded ? c.feeRecorded(shown(facts.platformFee.recorded, language, 'up'))
    : facts.platformFee.status === 'FEEABLE' ? c.fee(rate, facts.platformFee.amounts.map(value => shown(value, language, 'down')).join(' + ')) : c.feeUnknown(rate);
  const figures = () => facts.steps.map(step => c.stepFigure(step.number, translate(language, step.action), shown(step.input, language),
    step.output ? shown(step.output, language) : null, step.minimum ? shown(step.minimum, language, 'down') : null));
  const minutes = facts.expiresAt === null ? null : Math.max(0, Math.ceil((facts.expiresAt - now) / 60_000));
  switch (question.kind) {
    case 'SIMULATION': return unavailable() ?? answer([c.current(minutes), ...figures()].join(' '));
    case 'OUTPUT': return unavailable() ?? answer(figures().join(' ') || c.current(minutes));
    case 'COSTS': {
      const lines = facts.costs.map(line => c.costLine(translate(language, line.label), shown(line.value, language, 'up')));
      const missing = facts.missing.length ? [c.missing(facts.missing.map(item => translate(language, item).toLowerCase()).join(', '))] : [];
      const blocked = unavailable();
      if (blocked) return { ...blocked, text: `${blocked.text} ${feeLine()}` };
      return answer(lines.length ? `${c.costsIntro} ${lines.join('; ')}. ${feeLine()}` : `${c.noCosts} ${feeLine()}`, missing);
    }
    case 'WORTH': {
      const kind = question.target?.step ?? null;
      const operation = kind ? OPERATION_NO_ARTICLE[language][kind] ?? kind.toLowerCase() : null;
      if (kind && !actions.some(step => step.kind === kind || kind === 'TRANSFER' && step.kind === 'BATCH_PAYMENT')) return answer(c.worthNoStep(operation!));
      const blocked = unavailable();
      if (blocked) return facts.status === 'RUNNING' ? blocked : answer(c.worthNeedsSimulation, [], true);
      const simulated = facts.steps.find(step => !kind || step.kind === kind) ?? facts.steps[0];
      if (!simulated) return answer(c.worthNeedsSimulation, [], true);
      const input = amountOf(simulated.input), output = amountOf(simulated.output), asked = question.amount;
      if (asked && input && asked.symbol.toUpperCase() === input.symbol.toUpperCase() && align(asked, Math.max(asked.scale, input.scale)) !== align(input, Math.max(asked.scale, input.scale)))
        return answer(c.worthOtherAmount(shown(simulated.input, language), shown(text(asked), language)));
      const name = OPERATION[language][simulated.kind ?? ''] ?? translate(language, simulated.action).toLowerCase();
      const values = facts.costs.map(line => ({ line, amount: amountOf(line.value) }));
      const same = input ? values.filter(item => item.amount && item.amount.symbol === input.symbol && item.line.treatment !== 'CEILING').map(item => item.amount!) : [];
      // A cost already deducted from the output of a same-asset route (a bridge of USDC to USDC) is what does not arrive: input minus the quoted output.
      const deducted = input && output && output.symbol === input.symbol && !same.length && align(input, Math.max(input.scale, output.scale)) > align(output, Math.max(input.scale, output.scale))
        ? [{ units: align(input, Math.max(input.scale, output.scale)) - align(output, Math.max(input.scale, output.scale)), scale: Math.max(input.scale, output.scale), symbol: input.symbol }] : [];
      const total = sum([...same, ...deducted]);
      const others = values.filter(item => !item.amount || !input || item.amount.symbol !== input.symbol || item.line.treatment === 'CEILING')
        .map(item => `${translate(language, item.line.label).toLowerCase()} ${shown(item.line.value, language, 'up')}`);
      const elsewhere = others.length ? [c.elsewhere(others.join(', '))] : [];
      if (!total || !input) return answer([c.worthNoSameAsset(name, shown(simulated.input, language)), ...elsewhere].join(' '));
      const ratio = share(total, input, language)!, tenths = Number(ratio.replace(',', '.').replace('%', ''));
      return answer([c.worth(name, shown(simulated.input, language), simulated.output ? shown(simulated.output, language) : null, shown(text(total), language, 'up'), ratio),
        ...elsewhere, tenths < 1 ? c.low : tenths < 5 ? c.moderate : c.high].join(' '));
    }
  }
}
