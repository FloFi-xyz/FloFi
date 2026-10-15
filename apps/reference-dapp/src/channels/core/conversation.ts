// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: one conversational turn of a channel — the same semantics as FloFi's own chat, server-side.
 *
 *   1. opt-out, secrets and unsupported content are handled before anything else (a secret never reaches this code as text);
 *   2. local commands (HELP, STATUS, NEW/CANCEL, LINK, STOP/START), EN and PT, with no model;
 *   3. "yes", "confirm", "execute"… that answer no open FloFi question get the zero-authority notice and change nothing;
 *   4. the exact grammar first (`parseLocalCommand`, no default beneficiary);
 *   5. otherwise the Copilot conversation engine (`copilot-conversation.ts`) with the model as an untrusted interpreter — the same
 *      grounding, clarifications, corrections and FloFi-written answers as the DApp. With the interpreter disabled, nothing reaches a
 *      model and only exact commands are understood.
 *
 * BUILD-CHAT-LEARNING-001: with learning enabled for the deployment, the turn receives the sender's learning context (their own saved meanings,
 * the global glossary; `learning`), MEMORY / MEMORY OFF / MEMORY ON are local commands, and a memory action the user confirmed is returned
 * for the service to perform on the sender's own channel identity. Without it, nothing here changes.
 * BUILD-CHAT-LEARNING-002: no offer to remember; the engine adapts the conversation to the sender's answers and corrections and returns its
 * observations (stored by the service only when permitted). MEMORY commands remain the channel's privacy controls where anything can be stored.
 *
 * The channel never has a canvas: its environment is the editor's initial workflow plus, as the visible pending proposal, the
 * channel's current authoring command. A correction of that proposal is therefore a revision producing a fresh authoring command,
 * exactly as in the DApp. A decision only DESCRIBES what to do (propose, cancel, status…); the service performs it through the shared
 * platform. Nothing here can approve, sign or execute, and no message is ever treated as authorization.
 */
import { parseLocalCommand, type Command } from '../../domain/commands';
import { buildCopilotFacts } from '../../domain/copilot-answers';
import { COPILOT_AUTHORING_COMMANDS } from '../../domain/copilot-authoring';
import { closeSegment, emptyConversation, failureText, finishTurn, recordProposal, startTurn, type CopilotConversation, type CopilotEnvironment,
  type CopilotLearning, type CopilotReply, type CopilotRequestV2, type CopilotResultV2, type MemoryAction } from '../../domain/copilot-conversation';
import { parseLexicon, type LexiconEntry } from '../../domain/copilot-lexicon';
import { editorReducer, initialEditor } from '../../domain/editor';
import type { Workflow } from '../../domain/initial-workflow';
import { describeProposal } from '../../domain/proposal';
import { dappReviewContext } from '../../engine/strategy-engine';
import type { ChannelLanguage } from './config.ts';
import { channelCopy } from './copy.ts';
import { channelLearningCopy } from './learning-copy.ts';
import type { ChannelReply, InboundContent, ReplyChoice } from './types.ts';

/**
 * The untrusted interpreter: one bounded Copilot V2 request in, a structured result (or a closed failure code) out. BUILD-CHAT-LEARNING-001:
 * a turn passes this conversation's own `aliases` (a hint the service re-validates); the service passes the interpreter the rendered `glossary`
 * data for the request (`server/copilot-glossary.ts`). Both are optional: without them the request is exactly as before.
 */
export type ChannelInterpreter = (request: CopilotRequestV2, options?: { readonly glossary?: string | null; readonly aliases?: readonly LexiconEntry[];
  /** BUILD-CHAT-LEARNING-002: this conversation's adapted meanings (a hint the service re-validates). */ readonly adapted?: readonly LexiconEntry[] }) =>
  Promise<CopilotResultV2>;
export type TurnInterpreter = ChannelInterpreter;
/** Bounded, encrypted at rest, erased after 30 minutes of inactivity. */
export type ChannelState = {
  readonly v: 1; readonly language: ChannelLanguage;
  /** The Copilot conversation (bounded transcript, open request, FloFi's open question, referents), snapshots encoded by marker. */
  readonly copilot: unknown;
  /** The channel's pending proposal: an authoring command of the editor's initial state. */
  readonly pending: Command | null;
  /** The live approval handoff of the pending proposal, and the most recent one (for STATUS). Ids only. */
  readonly approvalId: string | null; readonly lastApprovalId: string | null;
  /** The choices FloFi offered last (answerable by number or by tapping). */
  readonly choices: readonly ReplyChoice[];
  readonly greeted: boolean;
  /** BUILD-CHAT-LEARNING-002: how many Copilot requests this conversation made (an observation counts once per request). */
  readonly requests?: number;
};
export const freshState = (language: ChannelLanguage): ChannelState =>
  ({ v: 1, language, copilot: null, pending: null, approvalId: null, lastApprovalId: null, choices: [], greeted: false });
export const MAX_STATE_BYTES = 32_768;

export type TurnContent = InboundContent | { readonly kind: 'SECRET'; readonly language: ChannelLanguage };
export type TurnAction = 'REPLY' | 'PROPOSE' | 'CANCEL' | 'LINK' | 'STATUS' | 'OPT_OUT' | 'OPT_IN' | 'IGNORE' | 'SUBSCRIBE' | 'MEMORY';
export type TurnDecision = { readonly action: TurnAction; readonly command: Command | null; readonly aiInterpreted: boolean; readonly replies: readonly ChannelReply[];
  readonly notes: readonly string[]; readonly outcome: string; readonly state: ChannelState;
  /** BUILD-AUTOMATION-001: the one-time code of a SUBSCRIBE turn (`automations ABCD-EFGH-JKLM`), handed to the subscription hook. */
  readonly subscribeCode?: string;
  /** BUILD-CHAT-LEARNING-001: a memory action the user confirmed (performed by the service on the sender's own identity), a MEMORY command,
   *  and the learned entries / content-free signals of the reply. */
  readonly memory?: MemoryAction; readonly memoryCommand?: 'SHOW' | 'OFF' | 'ON'; readonly learning?: CopilotReply['learning'] };
export type TurnInput = { readonly content: TurnContent; readonly state: ChannelState; readonly optedOut: boolean; readonly interpret: TurnInterpreter | null;
  readonly support: string; readonly privacy: string;
  /** BUILD-BASE-001: registers the validated catalogs of the catalog networks a text (and an untrusted intent) names; none = pinned assets only. */
  readonly catalogs?: ((text: string, intent?: unknown) => Promise<void>) | null;
  /** BUILD-CHAT-LEARNING-001: the sender's learning context; absent = learning off (the turn behaves exactly as before). */
  readonly learning?: CopilotLearning | null };

const BASE: Workflow = initialEditor().workflow;
const CONTEXT = dappReviewContext();
const AUTHORING: ReadonlySet<string> = new Set(COPILOT_AUTHORING_COMMANDS.filter(command => command !== 'ADD_SOLANA_COMPOSITION')); // DApp-only composition; no channel StrategySpec.
const text = (value: string): ChannelReply => ({ text: value, choices: [], link: null });

const words = (value: string) => value.trim().toLowerCase().replace(/[.!?¡¿]+$/g, '').replace(/\s+/g, ' ');
const COMMANDS: readonly (readonly [Exclude<TurnAction, 'REPLY' | 'PROPOSE' | 'IGNORE'> | 'HELP', RegExp, ChannelLanguage | null])[] = [
  ['HELP', /^(?:help|menu|\?)$/, 'EN'], ['HELP', /^(?:ajuda)$/, 'PT'],
  ['STATUS', /^(?:status)$/, null], ['STATUS', /^(?:estado|situa[cç][aã]o)$/, 'PT'],
  ['CANCEL', /^(?:new|cancel|reset|start over)$/, 'EN'], ['CANCEL', /^(?:novo|nova|cancelar|recome[cç]ar)$/, 'PT'],
  ['LINK', /^(?:link|new link)$/, null], ['LINK', /^(?:novo link)$/, 'PT'],
  ['OPT_OUT', /^(?:stop|unsubscribe)$/, 'EN'], ['OPT_OUT', /^(?:parar|pare|sair|descadastrar)$/, 'PT'],
  ['OPT_IN', /^(?:start)$/, 'EN'], ['OPT_IN', /^(?:voltar|iniciar)$/, 'PT'],
  // BUILD-AUTOMATION-001: link this chat to an owner's automation notifications with the one-time code shown in FloFi. Never authority.
  ['SUBSCRIBE', /^(?:automations?|notifications?) ([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/, 'EN'],
  ['SUBSCRIBE', /^(?:automa[cç](?:[oõ]es|[aã]o)|notifica[cç](?:[oõ]es|[aã]o)) ([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/, 'PT'],
];
/** Messages that sound like an authorization. In a channel they never are one. */
// A confirmation — alone or chained ("yes, execute it", "sim, pode executar agora") — is answered with the zero-authority notice.
const CONFIRMATION = '(?:yes|yeah|yep|ok|okay|confirm|confirmed|i confirm|execute|execute it|run it|go|go ahead|approve|approved|sign|sign it|do it|send it|sim|s|'
  + 'confirmo|confirmar|confirma|executar|executa|aprovar|aprovo|aprova|assinar|assina|manda|pode mandar|vai|pode executar)';
const AUTHORIZATION = new RegExp(`^${CONFIRMATION}(?:[ ,;.!]+(?:${CONFIRMATION}|please|now|it|this|por favor|agora|isso|já|ja))*$`);
/** BUILD-CHAT-LEARNING-001: memory commands, recognized only when learning is enabled (otherwise these words reach the interpreter as before). */
const MEMORY_COMMANDS: readonly (readonly ['SHOW' | 'OFF' | 'ON', RegExp, ChannelLanguage])[] = [
  ['SHOW', /^(?:memory|my memory|\/memory)$/, 'EN'], ['SHOW', /^(?:mem[oó]ria|minha mem[oó]ria)$/, 'PT'],
  ['OFF', /^(?:memory off|pause memory)$/, 'EN'], ['OFF', /^(?:mem[oó]ria off|pausar mem[oó]ria|desativar mem[oó]ria)$/, 'PT'],
  ['ON', /^(?:memory on|resume memory)$/, 'EN'], ['ON', /^(?:mem[oó]ria on|ativar mem[oó]ria|retomar mem[oó]ria)$/, 'PT'],
];
const PORTUGUESE = /\b(?:coloca|quero|faz|fazer|empresta|emprestar|troca|trocar|muda|mudar|na|no|para|com|de|da|do|em|sim|não|nao)\b/i;

// ── The Copilot conversation, persisted ────────────────────────────────────────────────────────────────────────────────
// The engine compares context snapshots by identity. Persisted drafts reference the channel's two context objects by marker and are
// rehydrated to the live objects; anything that no longer matches becomes a fresh object, which the engine treats as stale.
const BASE_MARK = '$flofi:base', PENDING_MARK = '$flofi:pending', STALE_MARK = '$flofi:stale';
function encodeCopilot(conversation: CopilotConversation, env: CopilotEnvironment): unknown {
  return JSON.parse(JSON.stringify(conversation, (key, value: unknown) => {
    if (key !== 'snapshot' || !value || typeof value !== 'object') return value;
    const s = value as { workflow: unknown; pending: unknown };
    return { ...s, workflow: s.workflow === env.workflow ? BASE_MARK : STALE_MARK, pending: s.pending === null ? null : s.pending === env.pending ? PENDING_MARK : STALE_MARK };
  }));
}
function decodeCopilot(raw: unknown, env: CopilotEnvironment): CopilotConversation {
  const c = raw as Partial<CopilotConversation> | null;
  if (!c || !Array.isArray(c.transcript) || !Array.isArray(c.segment) || !Array.isArray(c.referents) || typeof c.clarifications !== 'number') return emptyConversation();
  const conversation = structuredClone(c) as unknown as CopilotConversation;
  // BUILD-CHAT-LEARNING-001: this conversation's own aliases are re-validated (they are only ever a hint and a session meaning).
  if (conversation.aliases !== undefined) (conversation as { aliases?: readonly LexiconEntry[] }).aliases = parseLexicon(conversation.aliases, 'SESSION');
  const snapshot = (conversation as unknown as { draft: { snapshot?: Record<string, unknown> } | null }).draft?.snapshot;
  if (snapshot) {
    snapshot.workflow = snapshot.workflow === BASE_MARK ? env.workflow : { stale: true };
    snapshot.pending = snapshot.pending === null ? null : snapshot.pending === PENDING_MARK && env.pending ? env.pending : { stale: true };
  }
  return conversation;
}
function environment(pending: Command | null, learning: CopilotLearning | null = null): CopilotEnvironment {
  const before = { workflow: BASE, error: null };
  const visible = pending ? { command: pending, diff: describeProposal(before, editorReducer(before, pending, CONTEXT), pending, CONTEXT) } : null;
  return { workflow: BASE, context: CONTEXT, wallet: null, walletChainId: null, pending: visible, facts: buildCopilotFacts({ workflow: BASE, context: CONTEXT, pending: visible }),
    ...learning ? { learning } : {} };
}
/** The state with the conversation encoded and bounded: past the size bound the transcript restarts, never the pending proposal. */
function withCopilot(state: ChannelState, conversation: CopilotConversation, env: CopilotEnvironment, patch: Partial<ChannelState> = {}): ChannelState {
  const next: ChannelState = { ...state, ...patch, copilot: encodeCopilot(conversation, env), language: conversation.language };
  return Buffer.byteLength(JSON.stringify(next), 'utf8') <= MAX_STATE_BYTES ? next : { ...next, copilot: null, choices: [] };
}
const choicesOf = (options: readonly string[]): ReplyChoice[] => options.slice(0, 4).map((label, i) => ({ id: `c${i + 1}`, label }));

/** One turn. `interpret` is called at most once, only when the engine asks for the model, and never for a local or exact command. */
export async function decideTurn(input: TurnInput): Promise<TurnDecision> {
  const { content, optedOut } = input;
  let state = input.state;
  const decision = (action: TurnAction, outcome: string, replies: readonly ChannelReply[], next: ChannelState = state, extra: Partial<TurnDecision> = {}): TurnDecision =>
    ({ action, command: null, aiInterpreted: false, notes: [], replies, outcome, state: next, ...extra });
  if (content.kind === 'SECRET') return decision('REPLY', 'SECRET_REFUSED', [text(channelCopy(content.language).secret)], { ...state, choices: [] });
  // The user stopped the conversation on the provider's side (e.g. blocked the bot): honoured as STOP, and nothing is sent back.
  if (content.kind === 'PROVIDER_OPT_OUT') return optedOut ? decision('IGNORE', 'IGNORED_OPTED_OUT', []) : decision('OPT_OUT', 'OPTED_OUT_BY_PROVIDER', [], freshState(state.language));
  if (content.kind === 'UNSUPPORTED') return optedOut ? decision('IGNORE', 'IGNORED_OPTED_OUT', []) : decision('REPLY', 'UNSUPPORTED_MESSAGE', [text(channelCopy(state.language).unsupported)]);
  // A tapped choice or a bare number answers FloFi's own last question with the label FloFi offered.
  let raw = content.kind === 'CHOICE' ? state.choices.find(c => c.id === content.id)?.label ?? content.label : content.text;
  const numbered = /^\s*([1-9])\s*$/.exec(raw);
  if (numbered && state.choices[Number(numbered[1]) - 1]) raw = state.choices[Number(numbered[1]) - 1]!.label;
  const normalized = words(raw), local = COMMANDS.find(([, pattern]) => pattern.test(normalized));
  // BUILD-CHAT-LEARNING-002: where nothing can be stored (session-only adaptation), MEMORY words are ordinary text.
  const storable = !!input.learning && input.learning.memory !== 'SESSION';
  const memoryCommand = storable && !local ? MEMORY_COMMANDS.find(([, pattern]) => pattern.test(normalized)) : undefined;
  if (local?.[2]) state = { ...state, language: local[2] };
  if (memoryCommand) state = { ...state, language: memoryCommand[2] };
  const m = channelCopy(state.language), greet = (replies: ChannelReply[]) => state.greeted ? replies : [text(m.firstContact(input.support, input.privacy)), ...replies];
  if (optedOut) return local?.[0] === 'OPT_IN' ? decision('OPT_IN', 'OPTED_IN', [text(m.optedIn), text(m.help(input.support, input.privacy))], { ...freshState(state.language), greeted: true })
    : decision('IGNORE', 'IGNORED_OPTED_OUT', []);
  const greeted = { ...state, greeted: true, choices: [] };
  if (local) {
    const [kind] = local;
    // HELP and START answer with the help text, preceded by the first-contact notice when this is the conversation's first exchange
    // (Telegram's /start is how every Telegram conversation begins).
    if (kind === 'HELP' || kind === 'OPT_IN') return decision('REPLY', 'HELP', greet([text(storable
      ? `${m.help(input.support, input.privacy)}\n${channelLearningCopy(state.language).help}` : m.help(input.support, input.privacy))]), greeted);
    if (kind === 'OPT_OUT') return decision('OPT_OUT', 'OPTED_OUT', [text(m.optedOut)], freshState(state.language));
    // NEW/CANCEL also forgets the open question; the service revokes the live approval link.
    if (kind === 'CANCEL') return decision('CANCEL', 'CANCELLED', greet([]), { ...greeted, pending: null, approvalId: null, copilot: null });
    if (kind === 'SUBSCRIBE') return decision('SUBSCRIBE', 'SUBSCRIBE', greet([]), greeted, { subscribeCode: local[1].exec(normalized)![1]!.toUpperCase() });
    return decision(kind, kind === 'STATUS' ? 'STATUS' : 'LINK', greet([]), greeted);
  }
  if (memoryCommand) return decision('MEMORY', `MEMORY_${memoryCommand[0]}`, greet([]), greeted, { memoryCommand: memoryCommand[0] });
  const learning = input.learning ?? null;
  const pending = state.pending, env = environment(pending, learning), conversation = decodeCopilot(state.copilot, env);
  const openQuestion = conversation.draft !== null || state.choices.length > 0;
  if (!openQuestion && AUTHORIZATION.test(normalized)) return decision('REPLY', 'AUTHORIZATION_REFUSED', greet([text(m.authority)]), greeted);
  // Catalog-network symbols resolve only in validated catalogs, registered for the networks this request names (where the deployment enables them).
  await input.catalogs?.([...conversation.segment, raw].join('\n'));
  // The exact grammar first: exactly what a user could type in FloFi's chat, with no default beneficiary.
  try {
    const command = parseLocalCommand(raw, BASE, CONTEXT, null);
    if (AUTHORING.has(command.type)) {
      const next = withCopilot(greeted, recordProposal(closeSegment(conversation), environment(command, learning), command), environment(command, learning), { pending: command });
      return decision('PROPOSE', 'PROPOSED_EXACT', greet([]), next, { command });
    }
  } catch { /* not an exact authoring command: the interpreter decides */ }
  if (!input.interpret) return decision('REPLY', 'NOT_UNDERSTOOD', greet([text(m.grammarOnly)]), greeted);
  const languageHint = PORTUGUESE.test(raw) ? 'PT' : state.language;
  const start = startTurn(conversation.language === languageHint ? conversation : { ...conversation, language: languageHint }, raw, env);
  let reply, next: CopilotConversation;
  if (start.kind === 'LOCAL') ({ reply, next } = start);
  else {
    let result: CopilotResultV2;
    try { result = await input.interpret(start.request, { aliases: start.turn.state.aliases ?? [], adapted: start.turn.state.adapted ?? [] }); }
    catch { result = { ok: false, code: 'COPILOT_UNAVAILABLE' }; }
    if (result.ok) await input.catalogs?.([...conversation.segment, raw].join('\n'), result.intent);
    ({ reply, next } = finishTurn(start.turn, result, env));
  }
  const lm = channelCopy(next.language), learned = reply.learning ? { learning: reply.learning } : {}, requests = (state.requests ?? 0) + 1;
  if (reply.command && AUTHORING.has(reply.command.type)) {
    const proposed = withCopilot({ ...greeted, language: next.language, requests }, next, environment(reply.command, learning), { pending: reply.command });
    return decision('PROPOSE', 'PROPOSED_INTERPRETED', [], proposed, { command: reply.command, aiInterpreted: true, notes: reply.notes, ...learned });
  }
  // BUILD-CHAT-LEARNING-001: FloFi's memory offer is answered like its questions (buttons, or the number of the choice).
  const choices = reply.kind === 'CLARIFICATION' || reply.kind === 'MEMORY' ? choicesOf(reply.options) : [];
  const body = [reply.text, ...reply.notes].filter(Boolean).join('\n') || failureText('COPILOT_UNAVAILABLE', next.language);
  const after = withCopilot({ ...greeted, language: next.language, choices, requests }, next, env);
  const replies = [{ text: body, choices, link: null }];
  return decision('REPLY', `COPILOT_${reply.kind}`, state.greeted ? replies : [text(lm.firstContact(input.support, input.privacy)), ...replies], after,
    { ...reply.memory ? { memory: reply.memory } : {}, ...learned });
}

/** The persisted state, or a fresh one when it is absent or unreadable (never a guess). */
export function parseState(json: string | null, language: ChannelLanguage): ChannelState {
  if (!json) return freshState(language);
  try {
    const s = JSON.parse(json) as Partial<ChannelState>;
    if (s.v !== 1 || (s.language !== 'EN' && s.language !== 'PT') || !Array.isArray(s.choices)) return freshState(language);
    return { ...freshState(s.language), ...s } as ChannelState;
  } catch { return freshState(language); }
}
