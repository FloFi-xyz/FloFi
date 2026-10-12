// SPDX-License-Identifier: AGPL-3.0-only
/** Shared Canvas/Chat/natural intent engine/actual MCP gateway, deterministic MOCKED authoring. */
import { describe, expect, it } from 'vitest';
import { createCryptoActionNode } from './crypto-action-picker';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { startTurn, finishTurn } from './copilot-conversation';
import { parseLocalCommand } from './commands';
import { editorReducer } from './editor';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { canonicalStrategy } from '../channels/core/strategy';
import { codeCapabilities } from '../engine/capability-catalog';
import { capabilityNetworks, lendingOffers } from './authoring-capabilities';
import { previewPlan, strategyFlow } from '../mcp/simulation';
import { credential, gatewayEnv, session } from '../mcp/gateway.test-harness';
import { lendingProfileFor } from './supply-authoring';
import type { StrategySpec } from '../engine/strategy-spec';

describe('Arbitrum canonical lending authoring parity',()=>{
  it.each([
    ['Supply 100 USDC on Arbitrum','supply','100','EN'],
    ['Deposit 100 USDC into Aave on Arbitrum','supply','100','EN'],
    ['quero colocar 100 USDC no Aave da Arbitrum','supply','100','PT'],
    ['Borrow 20 USDC on Arbitrum','borrow','20','EN'],
    ['Repay 10 USDC on Arbitrum','repay','10','EN'],
    ['Withdraw 50 USDC from Aave on Arbitrum','withdraw','50','EN'],
  ] as const)('Canvas = Chat = Copilot = MCP: %s',async(text,action,amount,language)=>{
    const copilot=new CopilotSession();
    // Invoke the natural-language engine directly even when a sentence also matches deterministic Chat.
    const turn=startTurn(copilot.state,text,copilot.env());expect(turn.kind).toBe('REMOTE');if(turn.kind!=='REMOTE')throw Error('EXPECTED_INTENT_PROVIDER');
    const reply=finishTurn(turn.turn,{ok:true,intent:intent.action(act.lending(action.toUpperCase(),{network:'ARBITRUM',asset:'USDC',amount}),language)},copilot.env()).reply;
    expect(reply.kind).toBe('PROPOSAL');expect(reply.command).toBeDefined();
    const chat=parseLocalCommand(text,copilot.workflow,copilot.context,copilot.wallet);expect(reply.command).toEqual(chat);
    const workflow=editorReducer({workflow:copilot.workflow,error:null},chat,copilot.context).workflow,node=workflow.nodes.at(-1)!;
    expect(createCryptoActionNode(node.nodeId,{selection:{action,network:'Arbitrum One',from:'USDC'},amount,slippage:'50',beneficiary:copilot.wallet!})).toEqual(node);
    expect(node).toMatchObject({chainId:'eip155:42161',actionType:action,requiredCapabilities:[`aave-v3.${action}`]});
    const strategy:StrategySpec=action==='withdraw'?{action,network:'arbitrum-one',asset:'USDC',amount}:{action,network:'arbitrum-one',asset:'USDC',amount,beneficiary:copilot.wallet!};
    const composed=composeStrategy(strategy);expect(composed.ok).toBe(true);if(!composed.ok)throw Error(composed.code);
    expect(composed.workflow).toEqual(workflow);expect(composed.workflowHash).toBe(semanticWorkflowHash(workflow));expect(canonicalStrategy(chat)).toMatchObject({ok:true,workflowHash:composed.workflowHash});
    const token=credential(),client=session({env:gatewayEnv([{principal:'lending-owner',token}]),token});
    const result=await client.callTool('compose_strategy',{strategy});expect(result.isError).toBe(false);expect(result.output).toMatchObject({ok:true,workflowHash:composed.workflowHash});
    expect(previewPlan(strategy)).toEqual({flow:'arbitrum-aave',subject:'EVM'});expect(strategyFlow(strategy)).toBe('arbitrum-aave');
  });
  it('all actions derive support from the registered one-reserve profile, with no demonstrated public execution',()=>{
    for(const action of ['supply','borrow','repay','withdraw'] as const){
      expect(lendingOffers(action).find(offer=>offer.network.chain==='eip155:42161')?.asset).toBe('USDC');
      expect(capabilityNetworks(action).some(n=>n.key==='arbitrum-one')).toBe(true);
      expect(codeCapabilities().find(c=>c.network==='arbitrum-one'&&c.action===action)).toMatchObject({ownerWalletExecutionImplemented:true,demonstratedEvidence:null});
    }
    expect(()=>lendingProfileFor('Arbitrum One','WBTC')).toThrow('UNSUPPORTED');
    expect(()=>lendingProfileFor('Arbitrum Sepolia','USDC')).toThrow('UNSUPPORTED');
    expect(composeStrategy({action:'borrow',network:'arbitrum-one',asset:'WBTC',amount:'1',beneficiary:'0x'+'1'.repeat(40)})).toMatchObject({ok:false});
  });
});
