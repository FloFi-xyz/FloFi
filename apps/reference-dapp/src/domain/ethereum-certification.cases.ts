// SPDX-License-Identifier: AGPL-3.0-only
/** Test-only representative intents, never runtime support truth. */
import type { StrategySpec } from '../engine/strategy-spec';
import type { CryptoActionInput } from './crypto-action-picker';
import type { RouterBridgeInput } from './router-authoring';

export const CERTIFICATION_OWNER = '0x1111111111111111111111111111111111111111';
export const CERTIFICATION_RECIPIENT = '0x3333333333333333333333333333333333333333';
type Case = { id: string; text: string; pt: string; sentence: string; action: Record<string, unknown>; strategy: StrategySpec;
  canvas: CryptoActionInput | RouterBridgeInput };
const swap = { type: 'SWAP', network: 'ETHEREUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: null };
const transfer = (asset: string, amount: string) => ({ type: 'TRANSFER', network: 'ETHEREUM', asset, amount, recipient: CERTIFICATION_RECIPIENT });
const bridge = (sourceNetwork: string, destinationNetwork: string) => ({ type: 'BRIDGE', sourceNetwork, destinationNetwork, asset: 'USDC',
  amount: '100', routing: null, slippageBps: null, recipient: null });
const loan = (type: string, amount: string) => ({ type, protocol: 'AAVE_V3', network: 'ETHEREUM', asset: 'USDC', amount, beneficiary: null });
export const ETHEREUM_CERTIFICATION_CASES: readonly Case[] = [
  { id: 'Swap', text: 'Swap 10 USDC for WETH on Ethereum', pt: 'troca 10 USDC por WETH na Ethereum',
    sentence: 'swap 10 USDC to WETH on Ethereum slippage 100 bps', action: swap,
    strategy: { action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 },
    canvas: { selection: { action: 'swap', network: 'Ethereum', from: 'USDC', to: 'WETH' }, amount: '10', slippage: '100' } },
  ...(['ETH', 'USDC'] as const).map(asset => {
    const amount = asset === 'ETH' ? '0.01' : '5';
    return { id: asset === 'ETH' ? 'Native Transfer' : 'ERC20 Transfer', text: 'Send ' + amount + ' ' + asset + ' on Ethereum to ' + CERTIFICATION_RECIPIENT,
      pt: 'mande ' + amount + ' ' + asset + ' na Ethereum para ' + CERTIFICATION_RECIPIENT,
      sentence: 'transfer ' + amount + ' ' + asset + ' on Ethereum to ' + CERTIFICATION_RECIPIENT, action: transfer(asset, amount),
      strategy: { action: 'transfer', network: 'ethereum', asset, amount, recipient: CERTIFICATION_RECIPIENT } as StrategySpec,
      canvas: { selection: { action: 'transfer', network: 'Ethereum', from: asset }, amount, recipient: CERTIFICATION_RECIPIENT, slippage: '50' } as CryptoActionInput };
  }),
  ...(['IN', 'OUT'] as const).map(direction => {
    const incoming = direction === 'IN', source = incoming ? 'Base' : 'Ethereum', destination = incoming ? 'Ethereum' : 'Base';
    return { id: incoming ? 'Bridge Base → Ethereum' : 'Bridge Ethereum → Base',
      text: (incoming ? 'Bridge' : 'Move') + ' 100 USDC from ' + source + ' to ' + destination,
      pt: (incoming ? 'manda' : 'traga') + ' 100 USDC da ' + source + ' para ' + destination,
      sentence: 'bridge 100 USDC from ' + source + ' to ' + destination + ' via auto slippage 100 bps',
      action: bridge(incoming ? 'BASE' : 'ETHEREUM', incoming ? 'ETHEREUM' : 'BASE'),
      strategy: { action: 'bridge', sourceNetwork: incoming ? 'base' : 'ethereum', destinationNetwork: incoming ? 'ethereum' : 'base',
        asset: 'USDC', amount: '100', routing: 'auto', slippageBps: 100 } as StrategySpec,
      canvas: { source, destination, token: 'USDC', amount: '100', recipient: '', routing: 'AUTO', slippage: '100' } as RouterBridgeInput };
  }),
  { id: 'Liquidity', text: 'Provide liquidity with 10 USDC and 0.005 WETH on Ethereum at 0.05% over the full range',
    pt: 'quero adicionar liquidez de 10 USDC e 0,005 WETH na Ethereum com taxa de 0,05% na faixa completa',
    sentence: 'add liquidity 10 USDC and 0.005 WETH on Ethereum fee 0.05% slippage 100 bps',
    action: { type: 'LIQUIDITY', protocol: 'UNISWAP_V3', network: 'ETHEREUM', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }],
      rangeUnit: 'FULL', lower: null, upper: null, feeTier: '0.05', slippageBps: null },
    strategy: { action: 'add_liquidity', network: 'ethereum', maxAmounts: { USDC: '10', WETH: '0.005' }, range: { unit: 'full' }, feeTier: 500, slippageBps: 100 },
    canvas: { selection: { action: 'pool', network: 'Ethereum', from: 'USDC', to: 'WETH' }, amount: '10', secondAmount: '0.005', fee: 500, slippage: '100' } },
  ...(['supply', 'borrow', 'repay', 'withdraw'] as const).map(action => {
    const amount = { supply: '100', borrow: '20', repay: '10', withdraw: '50' }[action];
    const preposition = action === 'supply' || action === 'repay' ? 'to' : 'from';
    return { id: action[0]!.toUpperCase() + action.slice(1), text: action + ' ' + amount + ' USDC ' + (action === 'withdraw' ? 'from Aave ' : '') + 'on Ethereum',
      pt: { supply: 'quero colocar 100 USDC no Aave da Ethereum', borrow: 'quero pegar emprestado 20 USDC no Aave da Ethereum',
        repay: 'quero pagar 10 USDC da dívida no Aave da Ethereum', withdraw: 'quero retirar 50 USDC do Aave da Ethereum' }[action],
      sentence: action + ' ' + amount + ' USDC ' + preposition + ' Aave on Ethereum', action: loan(action.toUpperCase(), amount),
      strategy: action === 'withdraw' ? { action, network: 'ethereum', asset: 'USDC', amount } as StrategySpec
        : { action, network: 'ethereum', asset: 'USDC', amount, beneficiary: CERTIFICATION_OWNER } as StrategySpec,
      canvas: { selection: { action, network: 'Ethereum', from: 'USDC' }, amount, slippage: '50', beneficiary: CERTIFICATION_OWNER } as CryptoActionInput };
  }),
];
