// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the unit and PostgreSQL suites certify every engine, test networks included, so they run in the isolated
 * engineering scope (`apps/reference-dapp/src/server/network-scope.ts`; ignored on any hosted deployment). Tests of the public, Mainnet-only
 * product select it explicitly (an explicit scope argument, `setActiveNetworkScope`, or an environment without the opt-in).
 */
export default defineConfig({ test: { env: { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' } } });
