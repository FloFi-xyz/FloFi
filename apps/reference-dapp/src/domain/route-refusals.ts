// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-POST-257-HOTFIX-001 (P1-5): why the certified Router found no route, without changing its error contract.
 *
 * `ROUTER_NO_EXECUTABLE_ROUTE` stays the code every consumer reads (the web Router panel, Simulate and build-estimate wording, API and MCP
 * clients, tests). The error additionally carries each provider's own closed refusal code, so MCP can say why ("LI.FI: no route", "every
 * provider unavailable") instead of only "no route". An outage is never its HTTP status (no 401/403 detail reaches a person): it is
 * `ROUTER_PROVIDER_UNAVAILABLE`. Closed codes only, at most eight entries, never provider text.
 */
export type ProviderRefusal = { readonly provider: string; readonly outcome: 'REFUSED' | 'UNAVAILABLE'; readonly code: string };

const CODE = /^[A-Z][A-Z0-9_]{2,80}$/, PROVIDER = /^[a-z][a-z0-9-]{1,23}$/;
export const MAX_PROVIDER_REFUSALS = 8;
export const PROVIDER_UNAVAILABLE = 'ROUTER_PROVIDER_UNAVAILABLE';

/** A no-route failure: the message is the unchanged contract code; `providerRefusals` says why per provider. */
export class NoExecutableRouteError extends Error {
  readonly providerRefusals: readonly ProviderRefusal[];
  constructor(code: string, providerRefusals: readonly ProviderRefusal[]) {
    super(code);
    this.name = 'NoExecutableRouteError';
    this.providerRefusals = Object.freeze(providerRefusals.slice(0, MAX_PROVIDER_REFUSALS).map(r => Object.freeze({ ...r })));
  }
}

/** One provider's refusal as it may leave the Router: an outage collapses to ROUTER_PROVIDER_UNAVAILABLE. */
export function providerRefusal(provider: string, outcome: 'REFUSED' | 'UNAVAILABLE', code: string | null): ProviderRefusal {
  return Object.freeze({ provider, outcome, code: outcome === 'UNAVAILABLE' || !code || !CODE.test(code) ? PROVIDER_UNAVAILABLE : code });
}

/** The code a no-route failure keeps, and the only one that may carry provider refusals. */
export const NO_EXECUTABLE_ROUTE = 'ROUTER_NO_EXECUTABLE_ROUTE';
/**
 * The validated refusals a value carries (an error, or an API body's `refusals`), or null. Anything malformed is dropped whole; an outage is
 * always ROUTER_PROVIDER_UNAVAILABLE, whatever a (forged or faulty) body says (flofi-security review).
 */
export function providerRefusalsOf(value: unknown): readonly ProviderRefusal[] | null {
  const list = value instanceof NoExecutableRouteError ? value.providerRefusals : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROVIDER_REFUSALS) return null;
  const valid = list.every(entry => entry && typeof entry === 'object' && PROVIDER.test((entry as ProviderRefusal).provider)
    && ((entry as ProviderRefusal).outcome === 'REFUSED' || (entry as ProviderRefusal).outcome === 'UNAVAILABLE') && CODE.test((entry as ProviderRefusal).code));
  return valid ? Object.freeze((list as ProviderRefusal[]).map(({ provider, outcome, code }) => providerRefusal(provider, outcome, code))) : null;
}
/** Refusals only ever accompany the no-route code: on any other code they are ignored (a mismatched body never rewords another failure). */
export function routeRefusalsFor(code: string, value: unknown): readonly ProviderRefusal[] | null {
  return code === NO_EXECUTABLE_ROUTE ? providerRefusalsOf(value) : null;
}

/** The single reason a person hears: the first definitive refusal, or ROUTER_PROVIDER_UNAVAILABLE when every provider was out. */
export function refusalReason(refusals: readonly ProviderRefusal[]): string {
  return refusals.find(r => r.outcome === 'REFUSED' && r.code !== 'ROUTER_PROVIDER_FAILED')?.code ?? PROVIDER_UNAVAILABLE;
}
