// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useWorkflow } from '../state/workflow-store';
import { composerSummary } from '../domain/composer-presentation';

type Contributions = NonNullable<ReturnType<typeof composerSummary>['liquidityValues']>;
type ContributionInputs = { read(nodeId: string): Contributions | null; edit(nodeId: string, index: number, amount: string): void };
const ContributionsContext = createContext<ContributionInputs | null>(null);

/**
 * Canvas editing state only (pool contribution drafts). BUILD-RH-002: the Stocks card is no longer local state; it is a canonical
 * Robinhood Chain swap authored through the shared action setup, Review and Apply.
 */
export function CanvasCardInputsProvider({ children }: { children: ReactNode }) {
  const { state, context, pending, dismissProposal, actionSetup, editPoolSetup, cryptoSelections, editCanvasAmount } = useWorkflow();
  const [amounts, setAmounts] = useState<Record<string, { revision: number; values: Contributions }>>({});
  function read(nodeId: string) {
    if (actionSetup?.id === nodeId && actionSetup.action === 'pool') return [
      { amount: actionSetup.input.maxUsdc, token: actionSetup.cryptoSelection?.from ?? 'USDC' }, { amount: actionSetup.input.maxWeth, token: actionSetup.cryptoSelection?.to ?? 'WETH' }];
    const node = state.workflow.nodes.find(node => node.nodeId === nodeId);
    if (!node) return null;
    const entry = amounts[nodeId];
    const values = entry?.revision === state.workflow.revision ? entry.values : composerSummary(state.workflow, node, context).liquidityValues ?? null;
    const selection = cryptoSelections[nodeId];
    return values && selection ? values.map((value, index) => ({ ...value, token: index ? selection.to! : selection.from })) : values;
  }
  return <ContributionsContext.Provider value={{ read,
    edit(nodeId, index, amount) {
      const values = read(nodeId);
      if (!values?.[index]) return;
      if (actionSetup?.id === nodeId && actionSetup.action === 'pool') {
        editPoolSetup(nodeId, { ...actionSetup.input, [index === 0 ? 'maxUsdc' : 'maxWeth']: amount });
        return;
      }
      if (cryptoSelections[nodeId] && index === 0) editCanvasAmount(nodeId, amount);
      setAmounts(current => ({ ...current, [nodeId]: { revision: state.workflow.revision,
        values: values.map((value, slot) => slot === index ? { ...value, amount } : value) } }));
      if (pending && 'nodeId' in pending.command && pending.command.nodeId === nodeId) dismissProposal();
    },
  }}>{children}</ContributionsContext.Provider>;
}

export function usePoolContributionInputs(nodeId?: string) {
  const context = useContext(ContributionsContext);
  return { values: nodeId ? context?.read(nodeId) ?? null : null,
    edit(index: number, amount: string) { if (nodeId) context?.edit(nodeId, index, amount); } };
}
