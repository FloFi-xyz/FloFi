// SPDX-License-Identifier: AGPL-3.0-only
/** FloFi Studio proposal schema. A manifest NEVER grants capability or financial authority. */
export type StudioKind = 'network' | 'vault' | 'staking' | 'cex';
type Base = { readonly schemaVersion: 1; readonly slug: string; readonly name: string };
export type NetworkIntegration = Base & { readonly kind: 'network'; readonly chainRef: string;
  readonly rpcUrl: string; readonly nativeSymbol: string; readonly explorerUrl: string };
export type VaultIntegration = Base & { readonly kind: 'vault'; readonly standard: 'ERC-4626';
  readonly chainRef: string; readonly contractAddress: string; readonly underlyingAsset: string };
export type StakingIntegration = Base & { readonly kind: 'staking'; readonly protocol: string;
  readonly chainRef: string; readonly contractAddress: string };
export type CexIntegration = Base & { readonly kind: 'cex'; readonly provider: string;
  readonly access: 'user-scoped'; readonly operations: readonly ('balances' | 'trades')[] };
export type StudioIntegration = NetworkIntegration | VaultIntegration | StakingIntegration | CexIntegration;

const SLUG = /^[a-z][a-z0-9-]{1,49}$/;
const CAIP_EVM = /^eip155:[1-9][0-9]{0,9}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL = /^[A-Z][A-Z0-9]{1,11}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 .()_-]{1,79}$/;
const fail = (): never => { throw new Error('STUDIO_MANIFEST_INVALID'); };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const exact = (v: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(v).some(key => !allowed.includes(key)) || allowed.some(key => !(key in v))) fail();
};
const str = (v: unknown, pattern: RegExp): string =>
  typeof v === 'string' && pattern.test(v) ? v : fail();
const url = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 240) return fail();
  let parsed: URL;
  try { parsed = new URL(v); } catch { return fail(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search ||
    parsed.port || parsed.href !== v || parsed.hostname.endsWith('.')) return fail();
  return v;
};
const baseKeys = ['schemaVersion', 'kind', 'slug', 'name'];
const chain = (v: unknown): string => str(v, CAIP_EVM);
const address = (v: unknown): string => str(v, EVM_ADDRESS);

/** Strict, versioned, closed schema; no keys, headers, URL credentials or execution metadata. */
export function parseStudioIntegration(input: unknown): StudioIntegration {
  const v = record(input);
  if (v.schemaVersion !== 1) fail();
  const slug = str(v.slug, SLUG), name = str(v.name, LABEL);
  const common = { schemaVersion: 1 as const, slug, name };
  switch (v.kind) {
    case 'network':
      exact(v, [...baseKeys, 'chainRef', 'rpcUrl', 'nativeSymbol', 'explorerUrl']);
      return Object.freeze({ ...common, kind: 'network', chainRef: chain(v.chainRef),
        rpcUrl: url(v.rpcUrl), nativeSymbol: str(v.nativeSymbol, SYMBOL), explorerUrl: url(v.explorerUrl) });
    case 'vault':
      exact(v, [...baseKeys, 'standard', 'chainRef', 'contractAddress', 'underlyingAsset']);
      if (v.standard !== 'ERC-4626') fail();
      return Object.freeze({ ...common, kind: 'vault', standard: 'ERC-4626', chainRef: chain(v.chainRef),
        contractAddress: address(v.contractAddress), underlyingAsset: address(v.underlyingAsset) });
    case 'staking':
      exact(v, [...baseKeys, 'protocol', 'chainRef', 'contractAddress']);
      return Object.freeze({ ...common, kind: 'staking', protocol: str(v.protocol, LABEL), chainRef: chain(v.chainRef),
        contractAddress: address(v.contractAddress) });
    case 'cex': {
      exact(v, [...baseKeys, 'provider', 'access', 'operations']);
      if (v.access !== 'user-scoped' || !Array.isArray(v.operations) || v.operations.length === 0 ||
        v.operations.length > 2 || new Set(v.operations).size !== v.operations.length ||
        v.operations.some(item => item !== 'balances' && item !== 'trades')) fail();
      const operations = v.operations as ('balances' | 'trades')[];
      return Object.freeze({ ...common, kind: 'cex', provider: str(v.provider, LABEL),
        access: 'user-scoped', operations: Object.freeze([...operations]) });
    }
    default: return fail();
  }
}
