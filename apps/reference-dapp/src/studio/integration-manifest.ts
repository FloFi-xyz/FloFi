// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { isChecksumAddress } from '@defi-workflow-engine/action-registry';
import { defineIntegrationPackage, type IntegrationCategory, type IntegrationPackage } from '@defi-workflow-engine/developer-sdk';

/** A proposal declares configuration and intent. The execution registry owns financial capabilities. */
export type StudioKind = IntegrationCategory;
type Base = { readonly schemaVersion: 1; readonly slug: string; readonly name: string };
export type NetworkIntegration = Base & { readonly kind: 'network'; readonly chainRef: string };
export type VaultIntegration = Base & { readonly kind: 'vault'; readonly standard: 'ERC-4626';
  readonly chainRef: string; readonly contractAddress: string; readonly underlyingAsset: string };
export type StakingIntegration = Base & { readonly kind: 'staking'; readonly protocol: string;
  readonly chainRef: string; readonly contractAddress: string };
export type CexIntegration = Base & { readonly kind: 'cex'; readonly provider: string;
  readonly access: 'user-scoped'; readonly withdrawals: false };
export type StudioIntegration = NetworkIntegration | VaultIntegration | StakingIntegration | CexIntegration | IntegrationPackage;
type ProbePackage = IntegrationPackage & { readonly chainRef: string; readonly rpcUrl: string;
  readonly adapter: Extract<IntegrationPackage['adapter'], { kind: 'builtin' }> };

export function supportsStudioProbe(manifest: StudioIntegration): manifest is NetworkIntegration | VaultIntegration | ProbePackage {
  if (manifest.schemaVersion === 1) return manifest.kind === 'network' || manifest.kind === 'vault';
  return manifest.adapter.kind === 'builtin' && manifest.chainRef !== undefined && manifest.rpcUrl !== undefined;
}

export function studioManifestDigest(manifest: StudioIntegration): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export interface StakingReadConnector {
  readPosition(manifest: StakingIntegration, walletAddress: string): Promise<readonly {
    readonly asset: string; readonly stakedBaseUnits: string; readonly claimableBaseUnits: string;
  }[]>;
}

/** A future credential broker resolves the opaque connection within this account and grants balances-read access. */
export interface CexReadConnector {
  readBalances(manifest: CexIntegration, scope: {
    readonly tenantId: string; readonly accountId: string; readonly connectionId: string;
  }): Promise<readonly { readonly asset: string; readonly available: string; readonly locked: string }[]>;
}

const SLUG = /^[a-z][a-z0-9-]{1,49}$/;
const CAIP_EVM = /^eip155:[1-9][0-9]{0,9}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .()_-]{1,79}$/u;
const BASE_KEYS = ['schemaVersion', 'kind', 'slug', 'name'];
const invalid = (): never => { throw new Error('STUDIO_MANIFEST_INVALID'); };

function fields(input: Record<string, unknown>, extra: readonly string[]) {
  const keys = [...BASE_KEYS, ...extra];
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) invalid();
}

const text = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : invalid();
const chain = (value: unknown) => text(value, CAIP_EVM);
function address(value: unknown) {
  const raw = text(value, ADDRESS), body = raw.slice(2);
  const normalized = raw.toLowerCase();
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && !isChecksumAddress(raw)) return invalid();
  if (/^0x0{40}$/.test(normalized)) return invalid();
  return normalized;
}

/** The v1 parse and property order remain identical for stored 0035 digests. */
export function parseStudioIntegration(input: unknown): StudioIntegration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const v = input as Record<string, unknown>;
  if (v.schemaVersion === 2) return defineIntegrationPackage(v);
  if (v.schemaVersion !== 1) return invalid();
  const common = { schemaVersion: 1 as const, slug: text(v.slug, SLUG), name: text(v.name, LABEL) };
  switch (v.kind) {
    case 'network':
      fields(v, ['chainRef']);
      return Object.freeze({ ...common, kind: v.kind, chainRef: chain(v.chainRef) });
    case 'vault':
      fields(v, ['standard', 'chainRef', 'contractAddress', 'underlyingAsset']);
      if (v.standard !== 'ERC-4626') return invalid();
      return Object.freeze({ ...common, kind: v.kind, standard: v.standard, chainRef: chain(v.chainRef),
        contractAddress: address(v.contractAddress), underlyingAsset: address(v.underlyingAsset) });
    case 'staking':
      fields(v, ['protocol', 'chainRef', 'contractAddress']);
      return Object.freeze({ ...common, kind: v.kind, protocol: text(v.protocol, LABEL), chainRef: chain(v.chainRef),
        contractAddress: address(v.contractAddress) });
    case 'cex':
      fields(v, ['provider', 'access', 'withdrawals']);
      if (v.access !== 'user-scoped' || v.withdrawals !== false) return invalid();
      return Object.freeze({ ...common, kind: v.kind, provider: text(v.provider, LABEL), access: v.access, withdrawals: false });
    default: return invalid();
  }
}

export const HYPEREVM = Object.freeze({
  chainRef: 'eip155:999', chainId: 999, name: 'HyperEVM', rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
  nativeSymbol: 'HYPE', decimals: 18, explorer: 'https://hyperevmscan.io/',
});

export const SAVINGS_DAI = Object.freeze({
  chainRef: 'eip155:1', contractAddress: '0x83f20f44975d03b1b09e64809b757c47f942beea',
  underlyingAsset: '0x6b175474e89094c44da98b954eedeac495271d0f',
});
