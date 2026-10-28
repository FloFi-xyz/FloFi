// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { translate } from './locale';
import { portugueseCaioUx } from './pt-caio-ux';
it('preserves PT-BR and EN parity for every final Caio message, including shared keys', () => {
  for (const [key, value] of Object.entries(portugueseCaioUx)) {
    expect(translate('EN', key)).toBe(key); expect(translate('PT', key), key).toBe(value);
  }
});
