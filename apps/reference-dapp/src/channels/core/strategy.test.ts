// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: a channel proposal is exactly what every other FloFi surface produces. For every supported action and network,
 * the command FloFi's own chat authors for a sentence becomes a StrategySpec whose shared-platform composition reproduces the same
 * command, the same canonical IR (byte-identical) and the same workflow hash as the platform, MCP and the DApp chat. Anything that
 * does not round-trip is refused, never approximated.
 */
import { describe, expect, it } from 'vitest';
import { parseLocalCommand, type Command } from '../../domain/commands';
import { editorReducer, initialEditor } from '../../domain/editor';
import { composeWorkflow, dappReviewContext, semanticWorkflowHash } from '../../engine/strategy-engine';
import { STRATEGY_EXAMPLES } from '../../engine/strategy-examples';
import { composeWorkflowOrRefuse } from '../../platform/index.ts';
import { canonicalStrategy, intendedWalletOf, sameCommand, strategyOfCommand } from './strategy.ts';

const OWNER = '0x0000000000000000000000000000000000000001';
/** The DApp chat sentence of every capability example (the engine's own parity table). */
const SENTENCES: Readonly<Record<string, string>> = {
  'bridge-base-sepolia-arbitrum-sepolia': 'bridge 5 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps',
  'bridge-base-arbitrum-one': 'bridge 5 USDC from Base to Arbitrum via auto slippage 50 bps',
  'swap-base': 'swap 2 USDC to WETH on Base slippage 50 bps',
  'swap-base-sepolia': 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps',
  'swap-ethereum-sepolia': 'swap 1 USDC to WETH on Ethereum Sepolia slippage 50 bps',
  'swap-solana': 'swap 1 USDC to SOL on Solana slippage 50 bps',
  'swap-solana-devnet': 'swap 1 devUSDC to SOL on Solana Devnet slippage 50 bps',
  'supply-base-sepolia': `supply 1 USDC to Aave on Base Sepolia beneficiary ${OWNER}`,
  'supply-ethereum-sepolia': `supply 0.001 WBTC to Aave on Ethereum Sepolia beneficiary ${OWNER}`,
  'borrow-base-sepolia': `borrow 1 USDC from Aave on Base Sepolia beneficiary ${OWNER}`,
  'borrow-ethereum-sepolia': `borrow 0.001 WBTC from Aave on Ethereum Sepolia beneficiary ${OWNER}`,
  'repay-base-sepolia': `repay 1 USDC to Aave on Base Sepolia beneficiary ${OWNER}`,
  'repay-ethereum-sepolia': `repay 0.001 WBTC to Aave on Ethereum Sepolia beneficiary ${OWNER}`,
  'withdraw-base-sepolia': 'withdraw 1 USDC from Aave on Base Sepolia',
  'withdraw-ethereum-sepolia': 'withdraw 0.001 WBTC from Aave on Ethereum Sepolia',
  'add-liquidity-base-sepolia': 'add liquidity 10 USDC and 0.005 WETH ticks 189960 to 200040 on Base Sepolia slippage 100 bps',
  'add-liquidity-ethereum-sepolia': 'add liquidity 10 USDC and 0.005 WETH ticks 189960 to 200040 on Ethereum Sepolia slippage 100 bps',
  'add-liquidity-solana-devnet': 'add liquidity 0.01 SOL and 0.3 devUSDC ticks -29952 to -25600 on Solana Devnet slippage 100 bps',
  'lending-composition-base-sepolia': `compose supply 10 USDC to Aave then borrow 2 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner ${OWNER}`,
  // BUILD-RH-002: Robinhood Chain (real funds).
  'bridge-base-robinhood': 'bridge 5 USDC from Base to Robinhood via auto slippage 50 bps',
  'bridge-robinhood-base': 'bridge 5 USDG from Robinhood to Base via auto slippage 50 bps',
  'bridge-arbitrum-robinhood': 'bridge 5 USDC from Arbitrum to Robinhood via auto slippage 50 bps',
  'bridge-robinhood-arbitrum': 'bridge 5 USDG from Robinhood to Arbitrum via auto slippage 50 bps',
  'swap-robinhood': 'swap 10 USDG for WETH on Robinhood slippage 50 bps',
  'add-liquidity-robinhood': 'add liquidity 10 USDG and 0.003 WETH on Robinhood fee 0.01% full range slippage 100 bps',
  'transfer-robinhood': 'transfer 1 USDG on Robinhood',
  // BUILD-BASE-001: Base mainnet (real funds) as a catalog network, and the Router's Arbitrum One → Base route.
  'bridge-arbitrum-base': 'bridge 5 USDC from Arbitrum to Base via auto slippage 50 bps',
  'add-liquidity-base': 'add liquidity 10 USDC and 0.003 WETH on Base fee 0.05% full range slippage 100 bps',
  'transfer-base': 'transfer 1 USDC on Base',
  'supply-base': `supply 1 USDC to Aave on Base beneficiary ${OWNER}`,
  'borrow-base': `borrow 1 USDC from Aave on Base beneficiary ${OWNER}`,
  'repay-base': `repay 1 USDC to Aave on Base beneficiary ${OWNER}`,
  'withdraw-base': 'withdraw 1 USDC from Aave on Base',
  // BUILD-ARB-001 Phase 6: append the seven completed canonical examples; previous sentences remain unchanged.
  'swap-arbitrum': 'swap 10 USDC to WETH on Arbitrum One slippage 50 bps',
  'transfer-arbitrum': 'transfer 5 USDC on Arbitrum One',
  'add-liquidity-arbitrum': 'add liquidity 10 USDC and 0.003 WETH on Arbitrum One fee 0.05% full range slippage 100 bps',
      'supply-ethereum': 'supply 1 USDC to Aave on Ethereum beneficiary 0x0000000000000000000000000000000000000001',
      'borrow-ethereum': 'borrow 1 USDC from Aave on Ethereum beneficiary 0x0000000000000000000000000000000000000001',
      'repay-ethereum': 'repay 1 USDC to Aave on Ethereum beneficiary 0x0000000000000000000000000000000000000001',
      'withdraw-ethereum': 'withdraw 1 USDC from Aave on Ethereum',
      'swap-ethereum': 'swap 10 USDC to WETH on Ethereum slippage 50 bps',
      'transfer-ethereum': 'transfer 5 USDC on Ethereum',
      'add-liquidity-ethereum': 'add liquidity 10 USDC and 0.003 WETH on Ethereum fee 0.05% slippage 100 bps',
      'bridge-ethereum-base': 'bridge 5 USDC from Ethereum to Base via auto slippage 50 bps',
      'bridge-base-ethereum': 'bridge 5 USDC from Base to Ethereum via auto slippage 50 bps',
      'bridge-ethereum-arbitrum': 'bridge 5 USDC from Ethereum to Arbitrum via auto slippage 50 bps',
      'bridge-arbitrum-ethereum': 'bridge 5 USDC from Arbitrum to Ethereum via auto slippage 50 bps',
      'bridge-ethereum-robinhood': 'bridge 5 USDC from Ethereum to Robinhood Chain via auto slippage 50 bps',
      'bridge-robinhood-ethereum': 'bridge 5 USDG from Robinhood Chain to Ethereum via auto slippage 50 bps',
  'supply-arbitrum': 'supply 1 USDC to Aave on Arbitrum One beneficiary 0x0000000000000000000000000000000000000001',
  'borrow-arbitrum': 'borrow 1 USDC from Aave on Arbitrum One beneficiary 0x0000000000000000000000000000000000000001',
  'repay-arbitrum': 'repay 1 USDC to Aave on Arbitrum One beneficiary 0x0000000000000000000000000000000000000001',
  'withdraw-arbitrum': 'withdraw 1 USDC from Aave on Arbitrum One',
};
const base = initialEditor().workflow, context = dappReviewContext();
const chat = (sentence: string) => parseLocalCommand(sentence, base, context, null);
const dappWorkflow = (command: Command) => {
  const after = editorReducer({ workflow: base, error: null }, command, context);
  if (after.error) throw new Error(after.error);
  return after.workflow;
};

describe('BUILD-CHANNELS-001 canonical strategy parity', () => {
  it('covers every capability example', () => {
    expect(Object.keys(SENTENCES).sort()).toEqual(STRATEGY_EXAMPLES.map(e => e.id).sort());
  });

  for (const example of STRATEGY_EXAMPLES) {
    it(`${example.id}: channel command → StrategySpec → platform = the same command, IR and hash as MCP and the DApp chat`, () => {
      const command = chat(SENTENCES[example.id]!), result = canonicalStrategy(command);
      if (!result.ok) throw new Error(result.code);
      const platform = composeWorkflowOrRefuse(example.strategy, undefined), mcp = composeWorkflow(example.strategy);
      if (!mcp.ok) throw new Error(mcp.code);
      expect(result.workflowHash).toBe(platform.workflowHash);
      expect(result.workflowHash).toBe(mcp.workflowHash);
      expect(result.workflowHash).toBe(semanticWorkflowHash(dappWorkflow(command)));
      expect(JSON.stringify(platform.steps[0]!.workflow)).toBe(JSON.stringify(dappWorkflow(command)));
      expect(result.spec).toEqual(platform.strategy);
      expect(sameCommand(result.command, command)).toBe(true);
    });
  }

  it('maps every authoring command type and refuses anything else', () => {
    const types = new Set(Object.values(SENTENCES).map(s => chat(s).type));
    // BUILD-RH-002: Robinhood Chain catalog swaps and positions (ADD_CRYPTO_ACTION) and transfers (ADD_RH_TRANSFER).
    expect([...types].sort()).toEqual(['ADD_BORROW', 'ADD_CRYPTO_ACTION', 'ADD_ETHEREUM_SEPOLIA_SWAP', 'ADD_REPAY', 'ADD_RH_TRANSFER', 'ADD_ROUTER_BRIDGE', 'ADD_SOLANA_LIQUIDITY',
      'ADD_SOLANA_SWAP', 'ADD_SUPPLY', 'ADD_SWAP', 'ADD_TESTNET_SWAP', 'ADD_UNISWAP_LIQUIDITY', 'ADD_WITHDRAW', 'AUTHOR_LENDING']);
    expect(strategyOfCommand({ type: 'ADD', kind: 'read', source: 'CHAT', baseRevision: 0 } as Command)).toBeNull();
    expect(canonicalStrategy({ type: 'REMOVE', nodeId: 'node-002', source: 'CHAT', baseRevision: 0 } as Command)).toEqual({ ok: false, code: 'CHANNEL_COMMAND_NOT_AUTHORING' });
  });

  it('fails closed when the platform would not reproduce the command', () => {
    const command = chat(SENTENCES['supply-base-sepolia']!) as Command & { input: Record<string, string> };
    // A command the grammar never produces (an amount the canonical decimal grammar refuses) is not approximated.
    expect(canonicalStrategy({ ...command, input: { ...command.input, amount: '01' } } as Command)).toMatchObject({ ok: false, code: 'STRATEGY_SCHEMA_INVALID' });
    // An edit-style command at another revision is not an authoring proposal of the initial state.
    expect(canonicalStrategy({ ...command, baseRevision: 3 } as Command)).toEqual({ ok: false, code: 'CHANNEL_STRATEGY_PARITY_FAILED' });
  });

  it('treats a mixed-case typed address as the same strategy, stored lower-case', () => {
    const mixed = '0xAbCdEf0123456789abcdef0123456789ABCDEF01', result = canonicalStrategy(chat(`supply 1 USDC to Aave on Base Sepolia beneficiary ${mixed}`));
    if (!result.ok) throw new Error(result.code);
    expect(result.spec).toMatchObject({ beneficiary: mixed.toLowerCase() });
    expect(result.intendedWallet).toEqual({ namespace: 'eip155', address: mixed.toLowerCase() });
  });

  it('names the intended wallet only for strategies that name an address', () => {
    const intended = (id: string) => { const r = canonicalStrategy(chat(SENTENCES[id]!)); if (!r.ok) throw new Error(r.code); return intendedWalletOf(r.spec); };
    expect(intended('lending-composition-base-sepolia')).toEqual({ namespace: 'eip155', address: OWNER });
    expect(intended('borrow-base-sepolia')).toEqual({ namespace: 'eip155', address: OWNER });
    expect(intended('swap-base-sepolia')).toBeNull();
    expect(intended('bridge-base-sepolia-arbitrum-sepolia')).toBeNull();
    expect(intended('withdraw-base-sepolia')).toBeNull();
  });
});
