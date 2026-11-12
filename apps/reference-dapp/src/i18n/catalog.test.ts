// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { portuguese } from './pt';
import { translate } from './locale';
import { preservedValues } from './preserved-values';
import { financialObservationMessage, type FinancialObservation } from '../domain/financial-observation';
import { portugueseFinancialExecution } from './pt-financial-execution';
import { EXECUTION_PHASES, EXECUTION_PHASE_LABEL } from '../domain/execution-phase';
import { conversationCopy } from '../domain/conversation-copy';
import { COPILOT_TOOL_NOTES } from '../platform/copilot-tools';
import { evmWalletErrorMessage, evmWalletNotice, solanaWalletNotice, walletNoticeText } from '../wallet/wallet-errors';

/**
 * P0 hotfix (locale contract): every literal message handed to the catalog in the product — `t(...)` / `tr(...)` in components, and
 * `translate(language, ...)` in components, state, domain, server actions, presentation libraries and wallet copy — including the fallbacks of
 * `a ?? 'b'`, `a || 'b'` and conditionals. Tests, harnesses and the deliberate literal inventory are excluded.
 */
const SCANNED = ['components', 'state', 'domain', 'app', 'lib', 'wallet'] as const;
function sourceFiles(dir: string) {
  const root = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
  return (readdirSync(root, { recursive: true }).filter(file => typeof file === 'string' && /\.tsx?$/.test(file) && !/\.test\.tsx?$|test-harness|\.d\.ts$/.test(file)) as string[])
    .map(file => ({ name: `${dir}/${file}`, src: ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) }));
}
function productMessages() {
  const keys = new Map<string, string>();
  for (const dir of SCANNED) for (const { name, src } of sourceFiles(dir)) {
    function argument(node: ts.Node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) keys.set(node.text.trim(), name);
      else if (ts.isTemplateExpression(node)) keys.set((node.head.text + node.templateSpans.map((span, i) => `{${i}}${span.literal.text}`).join('')).trim(), name);
      else if (ts.isConditionalExpression(node)) { argument(node.whenTrue); argument(node.whenFalse); }
      else if (ts.isParenthesizedExpression(node)) argument(node.expression);
      else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) { argument(node.left); argument(node.right); }
    }
    function scan(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(src);
        if (/^(tr|t)$/.test(callee) && node.arguments[0] && name.startsWith('components/')) argument(node.arguments[0]);
        if (callee === 'translate' && node.arguments[1]) argument(node.arguments[1]);
      }
      ts.forEachChild(node, scan);
    }
    scan(src);
  }
  return [...keys].filter(([key]) => Boolean(key));
}
/**
 * Code → message and state → label tables (`Record<…, string>`) whose values are sentences or labels a person reads. Excluded: the admin console
 * (English only by decision, `language.ts`), tables that are themselves Portuguese (`*_PT`) and provider/protocol name tables (preserved values).
 */
const copyLike = (text: string) => (/^[A-Za-z][a-z’']/.test(text) && /\s/.test(text) || /^[A-Z][a-z]+$/.test(text)) && !/^(?:https?:|eip155:|solana:)/.test(text);
function copyTables() {
  const values = new Map<string, string>();
  for (const dir of ['components', 'state', 'domain', 'lib'] as const) for (const { name, src } of sourceFiles(dir)) {
    if (/(^|\/)admin\//.test(name)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.type && /Record<[^>]*,\s*string>/.test(node.type.getText(src)) && node.initializer && !/_PT$/.test(node.name.getText(src))) {
        let init: ts.Node = node.initializer;
        if (ts.isCallExpression(init) && init.arguments[0]) init = init.arguments[0];
        if (ts.isObjectLiteralExpression(init)) for (const property of init.properties) {
          if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)) && copyLike(property.initializer.text.trim()))
            values.set(property.initializer.text.trim(), `${name} ${node.name.getText(src)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return [...values];
}
/** The sentences a code → message function returns (`simulationError`, `simulationUnavailableReason`). */
function returnedCopy(file: string, fn: string) {
  const src = ts.createSourceFile(file, readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node, inside: boolean) => {
    const here = inside || ts.isFunctionDeclaration(node) && node.name?.text === fn;
    if (here && ts.isReturnStatement(node) && node.expression) {
      const collect = (value: ts.Node) => { if (ts.isStringLiteral(value)) found.push(value.text.trim()); else if (ts.isConditionalExpression(value)) { collect(value.whenTrue); collect(value.whenFalse); } };
      collect(node.expression);
    }
    ts.forEachChild(node, child => visit(child, here));
  };
  visit(src, false);
  return found;
}
const missing = (keys: readonly string[]) => keys.filter(key => !Object.hasOwn(portuguese, key) && !preservedValues.has(key));
describe('central product locale catalog', () => {
  it('translates every dynamic financial observation and blocker through the active EN/PT-BR catalog', () => {
    const outcomes: FinancialObservation['outcome'][] = ['CONFIRMED', 'APPROVAL_CONFIRMED', 'DESTINATION_OBSERVED', 'REFUND_OBSERVED', 'PENDING', 'REVERTED', 'NOT_SUBMITTED', 'UNDETERMINED', 'TEMPORARY_FAILURE', 'RECONCILED'];
    const messages = outcomes.map(outcome => financialObservationMessage({ outcome, checkedAt: '2026-10-28T00:00:00Z', reason: 'TEST' }));
    for (const message of new Set([...messages, ...Object.keys(portugueseFinancialExecution)])) {
      expect(translate('EN', message)).toBe(message);
      expect(translate('PT', message), message).toBe(portuguese[message]);
      expect(translate('PT', message), message).not.toBe(message);
    }
    expect(translate('PT', financialObservationMessage({ outcome: 'UNDETERMINED', checkedAt: '', reason: 'NO_MATCH' }))).toContain('Ainda pode haver um envio atrasado');
    expect(translate('PT', 'You rejected this wallet request. Earlier confirmed transactions and costs remain recorded.')).toContain('Você recusou');
  });
  it('covers every explicit product translation call or a reviewed literal value (components, state, domain, actions, libraries, wallet copy)', () => {
    const calls = productMessages();
    // The scan reaches the domain and state layers (not only components), and the fallbacks of `??` / `||`.
    expect(new Set(calls.map(([, file]) => file.split('/')[0]))).toEqual(expect.objectContaining(new Set(['components', 'state', 'domain'])));
    expect(calls.filter(([key]) => missing([key]).length).map(([key, file]) => `${file}: ${key}`)).toEqual([]);
  });
  // P0 hotfix (locale contract): a code → message table never gains an English sentence without its Portuguese.
  it('covers every code → message and state → label table in the product', () => {
    const tables = copyTables();
    expect(tables.length).toBeGreaterThan(300);
    expect(tables.filter(([key]) => missing([key]).length).map(([key, where]) => `${where}: ${key}`)).toEqual([]);
  });
  it('covers every message the closed code maps return (simulation, availability)', () => {
    for (const [file, fn] of [['domain/simulation-presentation.ts', 'simulationError'], ['domain/simulation-unavailable.ts', 'simulationUnavailableReason']] as const) {
      const returned = returnedCopy(file, fn);
      expect(returned.length, fn).toBeGreaterThan(3);
      expect(missing(returned), fn).toEqual([]);
    }
  });
  it('the shared execution phases, the chat\'s lifecycle copy and FloFi\'s own tool notes exist in both languages', () => {
    for (const phase of EXECUTION_PHASES) {
      const label = EXECUTION_PHASE_LABEL[phase];
      expect(Object.hasOwn(portuguese, label), label).toBe(true);
      expect(translate('PT', label), label).not.toBe(label);
    }
    // The Portuguese chat copy has every key of the English one, and none of its sentences is left in English.
    const en = conversationCopy('EN') as unknown as Record<string, unknown>, pt = conversationCopy('PT') as unknown as Record<string, unknown>;
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) if (typeof value === 'string') expect(pt[key], key).not.toBe(value);
    for (const key of Object.keys(COPILOT_TOOL_NOTES.EN) as (keyof typeof COPILOT_TOOL_NOTES.EN)[]) expect(COPILOT_TOOL_NOTES.PT[key], key).not.toBe(COPILOT_TOOL_NOTES.EN[key]);
  });
  it('FloFi\'s wallet notices read entirely in Portuguese on a Portuguese screen (named and unnamed wallets)', () => {
    const causes = [{ code: 4001 }, { code: -32002 }, { code: 4100 }, { code: 4900 }, { code: 4902 }, new Error('WALLET_DID_NOT_SWITCH'), new Error('OTHER')];
    const notices = [...causes.flatMap(cause => [null, 'MetaMask'].flatMap(name => (['connect', 'switch'] as const).map(request => evmWalletNotice(cause, name, request)))),
      ...['USER_REJECTED', 'X_BUSY', 'X_SOLANA_WALLET_AMBIGUOUS', 'X_WALLET_CHANGED', 'X_SOLANA_WALLET_NOT_AUTHORIZED', 'X_SOLANA_WALLET_REQUIRED', 'X_SOLANA_SIGN_MESSAGE_UNSUPPORTED', 'OTHER']
        .flatMap(code => [null, 'Phantom'].flatMap(name => ['solana:mainnet', 'solana:devnet'].map(cluster => solanaWalletNotice(new Error(code), name, cluster))))];
    for (const notice of notices) {
      // A catalog message with explicit values: its template has Portuguese, and the only value is the wallet's own name (or a network name).
      expect(Object.hasOwn(portuguese, notice[0]), notice[0]).toBe(true);
      const shown = translate('PT', ...notice), english = walletNoticeText(notice);
      expect(shown, english).not.toBe(english);
      expect(shown, english).not.toMatch(/\b(?:your wallet|Choose|try again|declined|Could not|switched|stayed)\b/);
      for (const value of notice.slice(1)) expect(['MetaMask', 'Phantom', 'Solana', 'Solana Devnet'], english).toContain(value);
    }
    // The English sentence is unchanged by the notice form.
    expect(evmWalletErrorMessage({ code: 4001 }, 'MetaMask', 'connect')).toBe('You declined the connection in MetaMask. Choose Connect Wallet to try again.');
    expect(evmWalletErrorMessage({ code: -32002 }, null, 'connect')).toBe('Your wallet already has a request waiting. Open your wallet to approve or reject it, then try again.');
  });
  it('preserves placeholders in every translated message', () => {
    for (const [key, value] of Object.entries(portuguese)) {
      expect(value.trim(), key).not.toBe('');
      expect([...new Set(value.match(/\{\d+\}/g) ?? [])].sort(), key).toEqual([...new Set(key.match(/\{\d+\}/g) ?? [])].sort());
    }
  });
  it('preserves network, asset, protocol and technical values across languages', () => {
    for (const value of ['USDC', 'WETH', 'SOL', 'Base', 'Ethereum Mainnet', 'Arbitrum One', 'Solana mainnet-beta', 'Uniswap V3', 'Jupiter', '0x' + 'a'.repeat(40), '0x' + 'b'.repeat(64), 'eip155:8453', 'multicall(exactInputSingle)']) expect(translate('PT', value)).toBe(value);
    expect(translate('PT', 'Source amount ({0})', 'USDC')).toBe('Valor de origem (USDC)');
  });
});
