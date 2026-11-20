// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002: what each closed coverage code and synchronization error means for an administrator.
 * Client-safe data only. Every label is translated in `components/admin/finops-copy.ts` (enforced by economics.test.ts).
 */
export const FINANCIAL_LIMITATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  FINOPS_PROVIDER_NO_DATA: 'The provider returned no data for this period.',
  NEON_LIST_PRICE_2026_11: 'Neon amounts are estimates from the November 2026 public list prices.',
  NEON_INVOICE_AND_OBJECT_STORAGE_UNAVAILABLE: 'Neon invoices and object storage are not available from the usage API.',
  NEON_BRANCH_METERS_OVERLAP_PROJECT_TOTALS: 'Branch measurements are part of the project totals and are not added again.',
  NEON_PROJECT_METRICS_UNAVAILABLE: 'Neon project measurements were unavailable.',
  NEON_BRANCH_COVERAGE_PARTIAL: 'Some Neon branch measurements are missing.',
  NEON_PROJECT_COVERAGE_PARTIAL: 'Some FloFi Neon projects returned no measurements.',
  NEON_MONTHLY_BRANCH_ESTIMATE_EXCLUDED: 'Extra branch charges are not estimated from monthly totals.',
  RAILWAY_LIST_PRICE_CLI_5_49_1: 'Railway amounts are estimates from public list prices.',
  RAILWAY_WORKSPACE_BILLING_UNALLOCATED: 'The Railway plan fee, included usage and invoice adjustments are not allocated.',
  VERCEL_PROJECT_FOCUS_ONLY: 'Only Vercel charges attributed to the FloFi project are included.',
  VERCEL_UNALLOCATED_CHARGES_EXCLUDED: 'Vercel team charges without a FloFi project attribution are excluded.',
  VERCEL_ESTIMATED_ALLOCATIONS_EXCLUDED: 'Vercel estimated cost allocations are shown separately and not recorded as costs.',
  VERCEL_NON_DAILY_CHARGES_EXCLUDED: 'Vercel charges that span more than one day are excluded.',
  OPENAI_COSTS_PROJECT_SCOPE: 'OpenAI costs are limited to the FloFi project.',
  OPENAI_USAGE_CATEGORY_UNAVAILABLE: 'One or more OpenAI usage categories were unavailable.',
  OPENAI_USAGE_FIELDS_PARTIAL: 'Some OpenAI usage fields were not reported.',
  ANTHROPIC_COSTS_BEFORE_CREDITS: 'Anthropic costs are after discounts and before credits.',
  ANTHROPIC_UNATTRIBUTED_WORKSPACE_EXCLUDED: 'Anthropic usage outside the FloFi workspace is excluded.',
  ANTHROPIC_NON_API_PRODUCTS_EXCLUDED: 'Anthropic usage outside the API products is excluded.',
  ANTHROPIC_DAYS_AFTER_EXPORT_WATERMARK_EXCLUDED: 'Days not yet fully exported by Anthropic are excluded until the next synchronization.',
  ANTHROPIC_CLOSED_DAY_COVERAGE_PARTIAL: 'Some closed days have no Anthropic cost.',
  CIRCLECI_CREDITS_WITHOUT_INVOICED_COST: 'CircleCI reports credits for the FloFi project, not invoiced amounts.',
  ALCHEMY_APP_USAGE_ONLY: 'Alchemy reports compute units for the configured apps only.',
  ALCHEMY_UNALLOCATED_ACCOUNT_CHARGES_EXCLUDED: 'Alchemy plan charges are not allocated.',
  ALCHEMY_PLAN_RETENTION_PARTIAL: 'Part of this period is older than the Alchemy plan retains.',
});

export const FINANCIAL_SYNC_ERROR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  FINOPS_SYNC_SCHEMA_REQUIRED: 'Automatic synchronization is awaiting database activation.',
  FINOPS_PROVIDER_NOT_CONFIGURED: 'The provider credential is not configured on the worker.',
  FINOPS_PROVIDER_FORBIDDEN: 'The provider refused access. Check the billing permission.',
  FINOPS_PROVIDER_NOT_ENTITLED: 'The current plan or account does not provide access to this billing export.',
  FINOPS_PROVIDER_ACCESS_DENIED: 'The provider denied this credential access to billing data.',
  FINOPS_PROVIDER_RATE_LIMITED: 'The provider limited requests. FloFi will retry.',
  FINOPS_PROVIDER_RETRY_LATER: 'The provider asked FloFi to wait. FloFi will retry.',
  FINOPS_PROVIDER_UNAVAILABLE: 'The provider was unavailable. FloFi will retry.',
  FINOPS_PROVIDER_TIMEOUT: 'The provider did not answer in time. FloFi will retry.',
  FINOPS_PROVIDER_RESPONSE_INVALID: 'The provider returned data FloFi could not verify.',
  FINOPS_PROVIDER_SCOPE_MISMATCH: 'The provider returned data for a project outside FloFi. Nothing was recorded.',
  FINOPS_PROVIDER_NO_DATA: 'The provider returned no data for this period.',
  FINOPS_PROVIDER_POLL_LIMIT: 'The provider export did not finish in time. FloFi will start a new export at the next synchronization.',
  FINOPS_PROVIDER_EXPORT_FAILED: 'The provider export failed. FloFi will start a new export at the next synchronization.',
  FINOPS_PROVIDER_AUTH_REQUIRED: 'The provider requires a valid billing credential on the worker.',
  FINOPS_PROVIDER_PERIOD_UNAVAILABLE: 'The provider does not offer data for this period.',
  FINOPS_SYNC_SUPERSEDED: 'A newer synchronization for this period finished first. Refresh to view its records.',
  FINOPS_SYNC_STORE_UNAVAILABLE: 'The financial records could not be saved. FloFi will retry.',
  FINOPS_PERIOD_CONFLICT: 'A conflicting record overlaps this period. Review the manual records.',
  FINOPS_SYNC_AUTOMATIC: 'Automatic synchronization is active. The worker synchronizes providers; use Sync now.',
});

/** Providers with no authoritative billing or usage API: their costs are recorded through manual invoice imports only. */
export const MANUAL_ONLY_FINANCIAL_PROVIDERS: readonly string[] = Object.freeze(['resend']);

export const FINANCIAL_CONNECTION_LABELS = {
  SYNCHRONIZING: 'Synchronizing', MANUAL_ONLY: 'Manual records only', UNCONFIGURED: 'Not configured',
  NOT_ENTITLED: 'Not entitled', ERROR: 'Needs attention', STALE: 'Stale', AWAITING_SYNC: 'Billing credential configured',
  USAGE_SYNCHRONIZED: 'Usage synchronized', SYNCHRONIZED: 'Connected',
} as const;

export type FinancialConnection = keyof typeof FINANCIAL_CONNECTION_LABELS;

export function financialConnection(provider: {
  id: string; active: boolean; configured: boolean; errorCode: string | null; lastSuccess: string | null;
  nextSync: string | null; coverage: readonly { quality: string; meterCount: number }[];
}, cost: string | null, now: Date): FinancialConnection {
  if (MANUAL_ONLY_FINANCIAL_PROVIDERS.includes(provider.id)) return 'MANUAL_ONLY';
  if (!provider.configured) return 'UNCONFIGURED';
  if (provider.active) return 'SYNCHRONIZING';
  if (provider.errorCode === 'FINOPS_PROVIDER_NOT_ENTITLED') return 'NOT_ENTITLED';
  if (provider.errorCode) return 'ERROR';
  if (provider.lastSuccess && provider.nextSync && Date.parse(provider.nextSync) < now.getTime()) return 'STALE';
  if (cost === null && provider.coverage.some(period => period.quality !== 'UNAVAILABLE' && period.meterCount > 0)) return 'USAGE_SYNCHRONIZED';
  if (!provider.lastSuccess) return 'AWAITING_SYNC';
  return 'SYNCHRONIZED';
}

export const FINANCIAL_CONNECTION_GUIDANCE: Readonly<Record<string, string>> = {
  anthropic: 'Use a Console organization with workspace-level Admin Analytics access.',
  neon: 'Verify consumption access for the inventoried Neon projects.',
  railway: 'Verify billing access to the FloFi project with the Railway workspace owner.',
  vercel: 'Confirm project-attributed FOCUS export access with the Vercel team owner.',
  openai: 'Use a billing credential with Costs and Usage access for the FloFi project.',
  circleci: 'Use an organization admin credential for project credit exports.',
  alchemy: 'Confirm exact FloFi app scope and plan access before enabling usage.',
  resend: 'Record a scoped invoice when a charge is available.',
};

export const FINANCIAL_INTEGRATION_COPY = Object.freeze([
  'Financial integrations', 'Sync all', 'Sync now', '{0} queued, {1} already scheduled or in progress.', 'Coverage limitations',
  '{0} synchronized periods', '{0} usage measurements', 'No synchronized period', 'Automatic synchronization is awaiting database activation.',
  'Provider', 'Connection', 'Current-period cost', 'Last successful sync', 'Next scheduled sync', 'Data quality', 'Historical coverage', 'Actions',
  'Metered usage and estimates are shown separately from recorded costs.',
  ...Object.values(FINANCIAL_CONNECTION_LABELS), ...Object.values(FINANCIAL_CONNECTION_GUIDANCE),
] as const);
