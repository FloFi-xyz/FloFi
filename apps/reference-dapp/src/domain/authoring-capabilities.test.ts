// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001 (owner addendum): Canvas, deterministic Chat, the natural-language Copilot and MCP consume one capability truth.
 *  - The capability list (`authoring-capabilities.ts`, from MCP's canonical examples) agrees with the profile registries the Canvas pickers,
 *    the Aave engine and the Router read.
 *  - Every canonical MCP example, said in normal language to the Copilot, becomes the same platform workflow (same hash) as MCP composes.
 *  - The Copilot's in-app capability answer and the model instructions are generated from that truth and name every network and route.
 * Nothing here quotes, simulates, signs or executes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AAVE_V3_LENDING_PROFILES } from '@defi-workflow-engine/action-registry';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import type { StrategySpec } from '../engine/strategy-spec';
import { composeWorkflowOrRefuse } from '../platform/strategy';
import { canonicalStrategy } from '../channels/core/strategy';
import { COPILOT_INSTRUCTIONS_V2 } from '../server/copilot-service';
import { copilotSupportsSection } from '../server/copilot-capabilities';
import { AUTHORING_CAPABILITIES, bridgeOffers, capabilityNetworks, capabilityText, catalogCapabilityNetworks, copilotCapabilityNetworks, copilotNetworksFor, lendingOffers } from './authoring-capabilities';
import { agentRolloutAllows, PENDING_AGENT_CAPABILITIES } from './agent-rollout';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { cryptoProfiles, type CryptoAction } from './crypto-action-picker';
import { copilotCopy } from './copilot-messages';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { COPILOT_NETWORK_IDS, NETWORKS, networkIdentity, networkOfCopilot } from './network-registry';
import { ROUTER_NETWORK_OPTIONS } from './router-authoring';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';

beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterAll(() => resetNetworkCatalogs());
const EXAMPLE_ACCOUNT = '0x0000000000000000000000000000000000000001';
const names = (networks: readonly { name: string }[]) => networks.map(network => network.name).sort();
const canvasNetworks = (action: CryptoAction) => [...new Set(cryptoProfiles(action).map(profile => networkIdentity(profile.network)?.name ?? profile.network))].sort();
/** How the model reports a token the user wrote (V2: as written; devUSDC is DEVUSDC). */
const reported = (symbol: string) => symbol === 'devUSDC' ? 'DEVUSDC' : symbol;
const FEE = { 100: '0.01', 500: '0.05', 3000: '0.3', 10000: '1' } as Record<number, string>;

/** One canonical MCP example said in normal language, and what a model would report for it. */
function naturalTurn(strategy: StrategySpec): { text: string; model: Record<string, unknown> } {
  const s = strategy as StrategySpec & Record<string, unknown>, on = (key: unknown) => networkIdentity(key as string)!;
  switch (strategy.action) {
    case 'swap': return { text: `Please swap ${s.amount} ${s.inputAsset} for ${s.outputAsset} on ${on(s.network).name}`,
      model: intent.action(act.swap({ network: on(s.network).copilot, inputAsset: reported(s.inputAsset as string), outputAsset: reported(s.outputAsset as string), amount: s.amount })) };
    case 'bridge': return { text: `Please move ${s.amount} ${s.asset} from ${on(s.sourceNetwork).name} over to ${on(s.destinationNetwork).name}`,
      model: intent.action(act.bridge({ sourceNetwork: on(s.sourceNetwork).copilot, destinationNetwork: on(s.destinationNetwork).copilot, asset: s.asset, amount: s.amount })) };
    case 'supply': case 'borrow': case 'repay': return { text: `Please ${strategy.action} ${s.amount} ${s.asset} on Aave on ${on(s.network).name} for ${s.beneficiary}`,
      model: intent.action(act.lending(strategy.action.toUpperCase(), { network: on(s.network).copilot, asset: s.asset, amount: s.amount, beneficiary: s.beneficiary })) };
    case 'withdraw': return { text: `Please withdraw ${s.amount} ${s.asset} from Aave on ${on(s.network).name}`,
      model: intent.action(act.lending('WITHDRAW', { network: on(s.network).copilot, asset: s.asset, amount: s.amount })) };
    case 'add_liquidity': {
      const [[a, x], [b, y]] = Object.entries(s.maxAmounts as Record<string, string>) as [[string, string], [string, string]];
      const deposits = [{ asset: reported(a), maxAmount: x }, { asset: reported(b), maxAmount: y }], range = s.range as { unit: string; lower?: string; upper?: string };
      if (range.unit === 'full') return { text: `Please add liquidity with ${x} ${a} and ${y} ${b} on ${on(s.network).name} at ${FEE[s.feeTier as number]}% over the full range`,
        model: intent.action(act.catalogLiquidity({ network: on(s.network).copilot, deposits, rangeUnit: 'FULL', feeTier: FEE[s.feeTier as number] })) };
      return { text: `Please add liquidity with ${x} ${a} and ${y} ${b} on ${on(s.network).name} between ticks ${range.lower} and ${range.upper}`,
        model: intent.action(act.liquidity({ network: on(s.network).copilot, deposits, rangeUnit: 'TICK', lower: range.lower, upper: range.upper })) };
    }
    // A Solana transfer names its exact destination (FloFi never substitutes the signing wallet); EVM examples send to the owner.
    case 'transfer': return s.recipient
      ? { text: `Please send ${s.amount} ${s.asset} on ${on(s.network).name} to the wallet ${s.recipient}`,
        model: intent.action(act.transfer({ network: on(s.network).copilot, asset: s.asset, amount: s.amount, recipient: s.recipient })) }
      : { text: `Please send ${s.amount} ${s.asset} on ${on(s.network).name} to my own wallet`,
        model: intent.action(act.transfer({ network: on(s.network).copilot, asset: s.asset, amount: s.amount })) };
    case 'lending_composition': return { text: `On ${on(s.network).name}, supply ${s.supplyAmount} ${s.asset} to Aave, borrow ${s.borrowAmount} ${s.asset} and swap it to ${s.outputAsset}`,
      model: intent.composition([act.lending('SUPPLY', { network: on(s.network).copilot, asset: s.asset, amount: s.supplyAmount }),
        act.lending('BORROW', { network: on(s.network).copilot, asset: s.asset, amount: s.borrowAmount }),
        act.swap({ network: on(s.network).copilot, inputAsset: s.asset, outputAsset: s.outputAsset, amount: s.borrowAmount })]) };
  }
}

describe('BUILD-BASE-001 one capability truth for Canvas, Chat, Copilot and MCP', () => {
  it('is the canonical examples over the network registry: every network is registered, and every Copilot network identifier has one entry', () => {
    for (const capability of AUTHORING_CAPABILITIES) for (const network of [capability.network, capability.destination].filter(Boolean))
      expect(NETWORKS, `${capability.action} ${network!.key}`).toContain(network);
    for (const id of COPILOT_NETWORK_IDS) {
      expect(NETWORKS.filter(network => network.copilot === id)).toHaveLength(1);
      expect(networkOfCopilot(id).mention!.test(networkOfCopilot(id).name)).toBe(true);
    }
    expect(names(catalogCapabilityNetworks())).toEqual(['Arbitrum One', 'Base', 'Ethereum', 'Robinhood Chain']);
  });
  it('agrees with the Aave and Router registries the engine executes', () => {
    for (const action of ['supply', 'borrow', 'repay', 'withdraw'] as const)
      expect(lendingOffers(action).map(offer => `${offer.network.chain}|${offer.asset}`)).toEqual(AAVE_V3_LENDING_PROFILES.map(profile => `${profile.chain}|${profile.symbol}`));
    const routes = Object.values(ROUTER_NETWORK_OPTIONS).map(option => `${networkIdentity(option.sourceLabel)!.key}>${networkIdentity(option.destinationLabel)!.key}|${option.pair.source.symbol}`);
    expect(bridgeOffers().map(route => `${route.source.key}>${route.destination.key}|${route.asset}`).sort()).toEqual(routes.sort());
  });
  it('agrees with the Canvas pickers', () => {
    expect(names(capabilityNetworks('swap'))).toEqual(canvasNetworks('swap'));
    // BUILD-SOLANA-MAINNET-001 kept Orca liquidity on Solana mainnet-beta Canvas-only pending owner review. BUILD-SOLANA-TRANSFER-UX-001 implements it
    // for the Copilot and MCP through a canonical strategy example (solana-transfer-integration.test.ts), so the capability truth matches every Canvas
    // pool network; its agent rollout stays gated until the owner approves it (audit A9, `agent-rollout.ts`).
    expect(names(capabilityNetworks('add_liquidity'))).toEqual(canvasNetworks('pool'));
    for (const action of ['supply', 'borrow', 'repay', 'withdraw'] as const) expect(names(capabilityNetworks(action))).toEqual(canvasNetworks(action));
    // BUILD-SOLANA-TRANSFER-UX-001: the Ethereum Sepolia and Robinhood Chain Testnet native self-transfers are implemented for chat and handoff too.
    expect(names(capabilityNetworks('transfer'))).toEqual(canvasNetworks('transfer'));
    // Audit A9: until the owner approves these agent rollouts, the Copilot offers neither (the Canvas keeps its own controls).
    expect(names(copilotCapabilityNetworks('add_liquidity'))).toEqual(canvasNetworks('pool').filter(name => name !== 'Solana'));
    expect(names(copilotCapabilityNetworks('transfer'))).toEqual(canvasNetworks('transfer').filter(name => !['Ethereum Sepolia', 'Robinhood Chain Testnet'].includes(name)));
    expect(names(copilotCapabilityNetworks('transfer', PENDING_AGENT_CAPABILITIES))).toEqual(canvasNetworks('transfer'));
  });
  it.each(STRATEGY_EXAMPLES.map(example => [example.id, example.strategy] as const))('%s: said in normal language, the Copilot authors the MCP workflow (same platform hash)',
    (_, strategy) => {
      const { text, model } = naturalTurn(strategy);
      const session = new CopilotSession([], EXAMPLE_ACCOUNT);
      // Parity of the preserved implementation, including the agent rollouts awaiting owner approval (audit A9).
      session.agentRollout = PENDING_AGENT_CAPABILITIES;
      const reply = session.say(text, model);
      const command = reply === null ? session.pending!.command : reply.command;
      expect(reply === null || reply.kind === 'PROPOSAL', `${text}: ${reply?.text}`).toBe(true);
      const copilot = canonicalStrategy(command!);
      expect(copilot, text).toMatchObject({ ok: true });
      expect(copilot.ok && copilot.workflowHash).toBe(composeWorkflowOrRefuse(strategy, undefined).workflowHash);
    });
  it('is pure data like the Copilot modules that read it: the canonical examples and registries only, no state, server, wallet or network', () => {
    const text = readFileSync(join(__dirname, 'authoring-capabilities.ts'), 'utf8');
    expect([...text.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort()).toEqual(['../engine/strategy-examples', '../engine/strategy-spec', './agent-rollout', './network-registry', '@defi-workflow-engine/action-registry']);
    expect(text).not.toMatch(/\bfetch\(|window\.|localStorage|sessionStorage|eth_sendTransaction|eth_sign|personal_sign|signTransaction|sendTransaction|process\.env/);
    const examples = readFileSync(join(__dirname, '../engine/strategy-examples.ts'), 'utf8');
    expect([...examples.matchAll(/^import (?!type )/gm)]).toEqual([]);
  });
  it('lists every network and route in the Copilot answer (EN/PT) and the model instructions, generated rather than written', () => {
    const OFFERED = AUTHORING_CAPABILITIES.filter(capability => agentRolloutAllows(capability.action, capability.network.key));
    for (const language of ['EN', 'PT'] as const) {
      const text = copilotCopy(language).capabilities;
      expect(text).toBe(capabilityText(language));
      for (const capability of OFFERED) expect(text).toContain(capability.network.name);
      for (const route of bridgeOffers()) expect(text).toContain(`${route.source.name} → ${route.destination.name}`);
      // Audit A9: a network only an unreleased agent rollout offers is not advertised.
      expect(text).not.toContain('Robinhood Chain Testnet');
    }
    expect(COPILOT_INSTRUCTIONS_V2).toContain(copilotSupportsSection());
    const supports = copilotSupportsSection();
    for (const capability of OFFERED) expect(supports).toContain(capability.network.name);
    expect(supports).not.toContain('Robinhood Chain Testnet');
    for (const route of bridgeOffers()) expect(supports).toContain(`from ${route.source.name} to ${route.destination.name}`);
    for (const id of copilotNetworksFor('swap')) expect(COPILOT_INSTRUCTIONS_V2).toContain(`${id} (${networkOfCopilot(id).name})`);
  });
});
