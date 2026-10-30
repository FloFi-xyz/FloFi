// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the closed vocabulary of a goal (what the user wants to do with the asset, and an optional routing preference),
 * shared by the model contract (`domain/copilot-intent-v2.ts`), the planner and MCP. Dependency-free on purpose.
 */
export const GOAL_USES = ['HOLD', 'SUPPLY', 'LIQUIDITY'] as const;
export const GOAL_PREFERENCES = ['LOWEST_COST', 'FASTEST', 'CERTIFIED_ROUTE'] as const;
export type GoalUse = (typeof GOAL_USES)[number];
export type GoalPreference = (typeof GOAL_PREFERENCES)[number];
