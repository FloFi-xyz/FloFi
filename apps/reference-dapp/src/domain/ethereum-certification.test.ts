// SPDX-License-Identifier: AGPL-3.0-only
/** MOCKED authoring parity. No financial authority or public execution evidence. */
import { afterEach, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { ETHEREUM_CERTIFICATION_CASES as cases, CERTIFICATION_OWNER } from './ethereum-certification.cases';
import { CopilotSession, intent } from './copilot-session.test-harness';
import { finishTurn, startTurn } from './copilot-conversation';
import { parseLocalCommand, type Command } from './commands';
import { editorReducer, initialEditor } from './editor';
import { familyCounterpart } from './network-registry';
import { resetNetworkCatalogs } from './asset-catalogs';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';

afterEach(resetNetworkCatalogs);
describe('Ethereum Canvas, Chat, natural Copilot, channel and MCP parity', () => {
  it.each(cases)('$id preserves exact IR and hash across all authoring surfaces, with both English and Portuguese grounding', async c => {
    const composed = composeStrategy(c.strategy); expect(composed.ok).toBe(true); if (!composed.ok) throw Error(composed.code);
    const ctx = createBaseSepoliaReviewContext();
    const command: Command = 'selection' in c.canvas ? { type: 'ADD_CRYPTO_ACTION', input: c.canvas, source: 'CANVAS', baseRevision: 0 }
      : { type: 'ADD_ROUTER_BRIDGE', input: c.canvas, source: 'CANVAS', baseRevision: 0 };
    expect(editorReducer(initialEditor(), command, ctx).workflow).toEqual(composed.workflow);
    const chat = parseLocalCommand(c.sentence, initialEditor().workflow, ctx, CERTIFICATION_OWNER);
    expect(canonicalStrategy(chat)).toMatchObject({ ok: true, workflowHash: composed.workflowHash });
    for (const [text, language] of [[c.text, 'EN'], [c.pt, 'PT']] as const) {
      const copilot = new CopilotSession([], CERTIFICATION_OWNER), turn = startTurn(copilot.state, text, copilot.env());
      expect(turn.kind).toBe('REMOTE'); if (turn.kind !== 'REMOTE') throw Error('EXPECTED_REMOTE');
      const { reply } = finishTurn(turn.turn, { ok: true, intent: intent.action(c.action, language) }, copilot.env());
      expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: c.sentence });
      expect(semanticWorkflowHash(editorReducer(initialEditor(), reply.command!, copilot.context).workflow)).toBe(composed.workflowHash);
    }
    const token = credential(), mcp = session({ env: gatewayEnv([{ principal: 'ethereum-certification', token }]), token });
    const result = await mcp.callTool('compose_strategy', { strategy: c.strategy });
    expect(result.isError).toBe(false); expect(result.output).toMatchObject({ ok: true, workflowHash: composed.workflowHash });
  });
  it('selects the exact family counterpart without treating testnet signatures or assets as mainnet authority', () => {
    expect(familyCounterpart('eip155:1', 'TESTNET')?.chain).toBe('eip155:11155111');
    expect(familyCounterpart('eip155:11155111', 'MAINNET')?.chain).toBe('eip155:1');
  });
});
