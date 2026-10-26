// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORKS, readUniversalBridgeNode, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { composeStrategy } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { universalBridgeDetails, universalCanvasPair, universalCanvasInput, UNIVERSAL_CANVAS_LABEL } from './universal-bridge-authoring';
import { parseCopilotIntentV2, COPILOT_OUTPUT_SCHEMA_V2 } from './copilot-intent-v2';
import { parseCopilotIntent } from './copilot-intent';
import { editorReducer } from './editor';
import { networkIdentity } from './network-registry';

beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterAll(resetNetworkCatalogs);
const stable = (key: UniversalNetworkKey) => key === 'robinhood' ? 'USDG' : 'USDC';
const native = (key: UniversalNetworkKey) => UNIVERSAL_NETWORKS[key].native.symbol;
const id = (key: UniversalNetworkKey) => networkIdentity(UNIVERSAL_NETWORKS[key].chain)!.copilot;
const variants = ['stable-stable', 'native-native', 'stable-native', 'native-stable'] as const;

describe('universal Bridge P0: 20 directions × 4 asset kinds × PT/EN', () => {
  it('covers exactly 20 different directed network pairs', () => {
    expect(UNIVERSAL_DIRECTED_PAIRS).toHaveLength(20);
    expect(new Set(UNIVERSAL_DIRECTED_PAIRS.map(p => `${p.source}:${p.destination}`)).size).toBe(20);
  });
  for (const { source, destination } of UNIVERSAL_DIRECTED_PAIRS) for (const variant of variants) {
    const asset = variant.startsWith('stable') ? stable(source) : native(source);
    const outputAsset = variant.endsWith('stable') ? stable(destination) : native(destination);
    const src = UNIVERSAL_NETWORKS[source].name, dst = UNIVERSAL_NETWORKS[destination].name;
    it(`${source} → ${destination}, ${asset} → ${outputAsset}: canonical IR and hash across Canvas, Copilot, MCP and channel adapter`, () => {
      const composed = composeStrategy({ action: 'bridge', sourceNetwork: source, destinationNetwork: destination, asset, outputAsset, amount: '1' });
      expect(composed).toMatchObject({ ok: true });
      if (!composed.ok) return;
      for (const language of ['PT', 'EN'] as const) {
        const session = new CopilotSession();
        const text = language === 'PT' ? `quero uma bridge de 1 ${asset} na ${src} para ${outputAsset} na ${dst}`
          : `I want to bridge 1 ${asset} on ${src} to ${outputAsset} on ${dst}`;
        const reply = session.say(text, intent.action(act.bridge({ sourceNetwork: id(source), destinationNetwork: id(destination), asset, outputAsset, amount: '1' }), language));
        expect(reply, text).toMatchObject({ kind: 'PROPOSAL' });
        if (!reply?.command) return;
        const channel = canonicalStrategy(reply.command);
        expect(channel, text).toMatchObject({ ok: true, workflowHash: composed.workflowHash });
        expect(editorReducer({ workflow: session.workflow, error: null }, reply.command, session.context).workflow).toEqual(composed.workflow);
        const pair = universalCanvasPair({ source: UNIVERSAL_CANVAS_LABEL[source], destination: UNIVERSAL_CANVAS_LABEL[destination], inputAsset: asset, outputAsset });
        if (pair) {
          const canvas = { ...reply.command, type: 'ADD_UNIVERSAL_BRIDGE' as const, input: universalCanvasInput(pair, '1', { inputAsset: asset, outputAsset }) };
          expect(editorReducer({ workflow: session.workflow, error: null }, canvas, session.context).workflow).toEqual(composed.workflow);
          expect(readUniversalBridgeNode(JSON.parse(JSON.stringify(composed.workflow.nodes[0]!)))).toMatchObject({ amount: asset === 'SOL' ? '1000000000' : asset === 'ETH' ? '1000000000000000000' : '1000000', slippageBps: 100 });
        } else expect(composed.command.type).toBe('ADD_ROUTER_BRIDGE');
      }
    });
  }
});

it('mandatory request: Base USDC → Arbitrum WETH, no implicit USDC destination; independent source and destination edits', () => {
  const session = new CopilotSession();
  const request = 'quero uma bridge de 1 USDC na Base para WETH na Arbitrum';
  const reply = session.say(request, intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'WETH', amount: '1' }), 'PT'));
  expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippage: '100' } } });
  session.apply();
  const original = universalBridgeDetails(session.workflow.nodes[0]!)!;
  expect(original.fields).toMatchObject({ inputAsset: { kind: 'TOKEN', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
    outputAsset: { kind: 'TOKEN', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 }, amount: '1000000' });
  expect(session.say('mude o destino da bridge para ETH', intent.edit({ outputAsset: 'ETH' }, { step: 'BRIDGE' }, 'PT'))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_UNIVERSAL_BRIDGE' } });
  session.apply();
  let edited = universalBridgeDetails(session.workflow.nodes[0]!)!;
  expect(edited.fields.inputAsset).toEqual(original.fields.inputAsset);
  expect(edited.fields.outputAsset.kind).toBe('NATIVE');
  expect(session.say('change the source token of the bridge to WETH', intent.edit({ inputAsset: 'WETH' }, { step: 'BRIDGE' }))).toMatchObject({ kind: 'PROPOSAL' });
  session.apply(); edited = universalBridgeDetails(session.workflow.nodes[0]!)!;
  expect(edited.inputSymbol).toBe('WETH'); expect(edited.outputSymbol).toBe('ETH'); expect(edited.amount).toBe('1');
});

it('V2 has an independently required nullable output field, accepts recorded V2 without it and keeps V1 frozen', () => {
  const action = act.bridge({ asset: 'USDC', amount: '1', sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM' });
  expect(parseCopilotIntentV2(intent.action(action))).toMatchObject({ action });
  expect(parseCopilotIntentV2(intent.action({ ...action, outputAsset: 'WETH' }))).toMatchObject({ action: { outputAsset: 'WETH' } });
  expect(() => parseCopilotIntent({ version: '1', kind: 'ACTION', action: { ...action, outputAsset: 'WETH' } })).toThrow();
  expect(JSON.stringify(COPILOT_OUTPUT_SCHEMA_V2)).toContain('Destination token exactly');
  expect(() => parseCopilotIntentV2(intent.action({ ...action, outputAsset: 42 }))).toThrow();
});

it('ungrounded destination assets are never accepted; Mayan-only bridges remain representable in every channel', () => {
  expect(new CopilotSession().say('bridge my 1 USDC from Base to Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'WETH', amount: '1' }))))
    .toMatchObject({ kind: 'CLARIFICATION' });
  const session = new CopilotSession();
  const reply = session.say('please bridge 1 USDC from Solana to Base using Mayan', intent.action(act.bridge({ sourceNetwork: 'SOLANA', destinationNetwork: 'BASE', asset: 'USDC', amount: '1', routing: 'MAYAN' })));
  expect(reply).toMatchObject({ kind: 'PROPOSAL' });
  expect(canonicalStrategy(reply!.command!)).toMatchObject({ ok: true });
});

it('validated SPL catalog symbols and names retain the exact mint and decimals across Copilot, Canvas and MCP', async () => {
  const { parseJupiterVerifiedCatalog, registerSolanaDisplayCatalog, clearSolanaDisplayCatalog } = await import('./solana-asset-catalog');
  const mint = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';
  const catalog = parseJupiterVerifiedCatalog(JSON.stringify([{ id: mint, symbol: 'SPLX', name: 'Sample SPL', decimals: 9, isVerified: true,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }]), '2026-10-26T12:00:00Z');
  registerSolanaDisplayCatalog(catalog);
  try {
    const session = new CopilotSession();
    const reply = session.say('I want a bridge of 1 Sample SPL from Solana to ETH on Ethereum', intent.action(act.bridge({ sourceNetwork: 'SOLANA', destinationNetwork: 'ETHEREUM', asset: 'Sample SPL', outputAsset: 'ETH', amount: '1' })));
    expect(reply).toMatchObject({ kind: 'PROPOSAL' });
    const mcp = composeStrategy({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'ethereum', asset: 'SPLX', outputAsset: 'ETH', amount: '1' });
    expect(mcp).toMatchObject({ ok: true });
    expect(canonicalStrategy(reply!.command!)).toMatchObject({ ok: true, workflowHash: mcp.ok ? mcp.workflowHash : '' });
    if (mcp.ok) expect(readUniversalBridgeNode(JSON.parse(JSON.stringify(mcp.workflow.nodes[0]!)))).toMatchObject({ inputAsset: { address: mint, decimals: 9 }, amount: '1000000000' });
  } finally { clearSolanaDisplayCatalog(); }
});


it('recorded V2 intent without outputAsset cannot erase an explicit PT/EN destination token', () => {
  for (const text of ['quero uma bridge de 1 USDC na Base para WETH na Arbitrum', 'I want to bridge 1 USDC on Base to WETH on Arbitrum']) {
    const action = act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '1' });
    expect(new CopilotSession().say(text, intent.action(action))).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: 'WETH' } } });
    expect(new CopilotSession().say(text, intent.action({ ...action, outputAsset: 'USDC' }))).toMatchObject({ kind: 'CLARIFICATION' });
  }
});


it('canonical token references from an existing IR retain parity with catalog symbols, including certified legacy routing', () => {
  const base = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '1' };
  for (const output of ['USDC', 'WETH']) {
    const symbolic = composeStrategy({ ...base, outputAsset: output });
    const explicit = composeStrategy({ ...base, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@6',
      outputAsset: output === 'USDC' ? '0xaf88d065e77c8cc2239327c5edb3a432268e5831@6' : '0x82af49447d8a07e3bd95bd0d56f35241523fbab1@18' });
    expect(symbolic).toMatchObject({ ok: true }); expect(explicit).toMatchObject({ ok: true });
    if (symbolic.ok && explicit.ok) expect(explicit.workflowHash).toBe(symbolic.workflowHash);
  }
});
