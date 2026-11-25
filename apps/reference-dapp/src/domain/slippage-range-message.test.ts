// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ROUTER_MAXIMUM_SLIPPAGE_BPS, UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS } from '@defi-workflow-engine/workflow-contracts';
import { slippageRangeMessage } from './slippage-policy';
import { portugueseApprovedUxEditor } from '../i18n/pt-approved-ux-editor';

describe('slippage range message (BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001)', () => {
  it.each(['ROUTER_SLIPPAGE_OUT_OF_RANGE', 'UNIVERSAL_SLIPPAGE_OUT_OF_RANGE', 'UNIVERSAL_REQUEST_SLIPPAGE_INVALID', 'SLIPPAGE_OUT_OF_RANGE'])(
    '%s is said as the supported range, never as the code', code => {
      const message = slippageRangeMessage(code, ROUTER_MAXIMUM_SLIPPAGE_BPS)!;
      expect(message).toBe('Enter a max price difference from 0.01% to 5%.');
      expect(message).not.toContain(code);
      // The approved Canvas wording already has its Portuguese translation.
      expect(portugueseApprovedUxEditor[message]).toBe('Informe uma diferença máxima de preço de 0,01% a 5%.');
    });
  it('follows the runtime maximum and ignores every other code', () => {
    expect(slippageRangeMessage('UNIVERSAL_SLIPPAGE_OUT_OF_RANGE', UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS)).toContain('to 5%');
    expect(slippageRangeMessage('ROUTER_SLIPPAGE_OUT_OF_RANGE', 50)).toBe('Enter a max price difference from 0.01% to 0.5%.');
    expect(slippageRangeMessage('ROUTER_INPUT_INVALID', 300)).toBeNull();
    expect(slippageRangeMessage('ROUTER_SLIPPAGE_OUT_OF_RANGE', 0)).toBeNull();
  });
});
