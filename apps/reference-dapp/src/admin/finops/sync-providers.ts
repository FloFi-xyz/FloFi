// SPDX-License-Identifier: AGPL-3.0-only
import { aiFinancialAdapters } from './sync-ai-providers.ts';
import { circleCiFinancialAdapter } from './sync-circleci.ts';
import { infraFinancialAdapters } from './sync-infra-providers.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';

export const financialAdapters: readonly FinancialSyncAdapter[] = [...infraFinancialAdapters, ...aiFinancialAdapters, circleCiFinancialAdapter];
