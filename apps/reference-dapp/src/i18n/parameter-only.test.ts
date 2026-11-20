// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (flofi-frontend-ux review): parameter-only messages never act as the catalog's fallback patterns. */
import { expect, it } from 'vitest';
import { translate } from './translate';
import { portugueseUxRefinementParameterized } from './pt-ux-refinement';

it('translates parameter-only messages with their parameters, and never rewrites an unrelated string or an owner\'s name through them', () => {
  expect(translate('PT', 'Swap {0} for {1} on {2}.', '3 USDC', 'WETH', 'Base')).toBe('Trocar 3 USDC por WETH na rede Base.');
  expect(translate('PT', '{0} of {1}', '1', '3')).toBe('1 de 3');
  expect(translate('PT', 'Copy {0}', 'Wallet')).toBe('Copiar Wallet');
  // A pre-existing key keeps its approved translation.
  expect(translate('PT', 'Step {0}: {1}', '1', 'Swap')).toBe('Passo 1: Swap');
  // Without parameters, text that merely looks like one of these keys is never rewritten through them (an owner's workflow name, a provider label).
  for (const [text, rewritten] of [['Rebalance 50 on Base.', 'Rebalance 50 na rede Base.'], ['Move funds from A to B.', 'Move funds da rede A para a rede B.'],
    ['Pool: USDC on Base.', 'Pool: USDC na rede Base.'], ['Page 2 of 5', 'Page 2 de 5'], ['Copy trading', 'Copiar trading']].filter(([a, b]) => a !== b))
    expect(translate('PT', text)).not.toBe(rewritten);
  for (const key of Object.keys(portugueseUxRefinementParameterized)) expect(key).toMatch(/\{0\}/);
});
