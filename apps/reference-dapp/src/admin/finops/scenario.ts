// SPDX-License-Identifier: AGPL-3.0-only

export const SCENARIO_PRESETS = [1_000, 10_000, 50_000, 100_000, 1_000_000];
export const SCENARIO_FIELDS = {
  users: { label: 'Monthly active users', max: 10_000_000, step: 1 },
  chats: { label: 'Chat interactions per user', max: 10_000, step: 0.01 },
  workflows: { label: 'Workflows per user', max: 10_000, step: 0.01 },
  completion: { label: 'Completion rate (%)', max: 100, step: 0.01 },
  eligibleVolume: { label: 'Average fee-eligible volume per completed workflow (USD)', max: 10_000_000, step: 0.01 },
  fee: { label: 'Effective collected fee (%)', max: 100, step: 0.001 },
  ai: { label: 'AI cost per interaction (USD)', max: 10_000, step: 0.000001 },
  workflowCost: { label: 'Other variable cost per initiated workflow (USD)', max: 10_000, step: 0.000001 },
  gas: { label: 'Average FloFi-paid gas sponsorship per initiated workflow (USD)', max: 10_000, step: 0.000001 },
  infrastructure: { label: 'Monthly fixed and shared infrastructure (USD)', max: 100_000_000, step: 0.01 },
} as const;
export type Scenario = Record<keyof typeof SCENARIO_FIELDS, number>;
export const scenarioKeys = Object.keys(SCENARIO_FIELDS) as (keyof Scenario)[];

export function parseScenario(input: Readonly<Record<string, unknown>>): Scenario | null {
  const parsed: Partial<Scenario> = {};
  for (const key of scenarioKeys) {
    const value = input[key];
    if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,6})?$/.test(value)) return null;
    const number = Number(value);
    if (number < 0 || number > SCENARIO_FIELDS[key].max || key === 'users' && !Number.isInteger(number)) return null;
    parsed[key] = number;
  }
  return parsed as Scenario;
}

export function modelScenario(input: Scenario) {
  const chats = input.users * input.chats;
  const workflows = input.users * input.workflows;
  const completed = workflows * input.completion / 100;
  const eligibleVolume = completed * input.eligibleVolume;
  const ai = chats * input.ai;
  const workflow = workflows * input.workflowCost;
  const gas = workflows * input.gas;
  const variable = ai + workflow + gas;
  const total = variable + input.infrastructure;
  const revenue = eligibleVolume * input.fee / 100;
  const contribution = revenue - variable;
  const result = revenue - total;
  const contributionPerUser = input.workflows * input.completion / 100 * input.eligibleVolume * input.fee / 100 -
    input.chats * input.ai - input.workflows * (input.workflowCost + input.gas);
  const needed = input.infrastructure === 0 && contributionPerUser >= 0 ? 0
    : contributionPerUser > 0 ? Math.ceil(input.infrastructure / contributionPerUser) : null;
  const breakEvenUsers = needed !== null && Number.isSafeInteger(needed) ? needed : null;
  return { chats, workflows, completed, eligibleVolume, ai, workflow, gas, variable, total, revenue, contribution, result, breakEvenUsers,
    breakEvenWorkflows: breakEvenUsers === null ? null : breakEvenUsers * input.workflows };
}
