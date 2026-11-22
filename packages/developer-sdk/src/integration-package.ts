// SPDX-License-Identifier: Apache-2.0
export const INTEGRATION_CATEGORIES = ['network', 'vault', 'staking', 'lending', 'dex', 'cex', 'service'] as const;
export const INTEGRATION_ARCHITECTURES = ['evm', 'svm', 'move', 'cosmos', 'other'] as const;
export const INTEGRATION_CAPABILITIES = [
  'network.read', 'transfer.native', 'transfer.token', 'vault.read', 'vault.deposit', 'vault.redeem',
  'staking.read', 'staking.manage', 'lending.read', 'lending.manage', 'swap', 'bridge', 'cex.read', 'service.read',
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];
export type IntegrationArchitecture = (typeof INTEGRATION_ARCHITECTURES)[number];
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];
export type BuiltinStudioAdapter = 'evm-rpc' | 'erc4626-read' | 'svm-rpc' | 'cosmos-rpc';
export type IntegrationAdapter =
  | { readonly kind: 'builtin'; readonly id: BuiltinStudioAdapter; readonly version: 1 }
  | { readonly kind: 'external'; readonly repository: string; readonly commit: string; readonly sourceSha256: string; readonly sdkVersion: 1 };

export type IntegrationPackage = {
  readonly schemaVersion: 2;
  readonly kind: IntegrationCategory;
  readonly slug: string;
  readonly name: string;
  readonly architecture: IntegrationArchitecture;
  readonly chainRef?: string;
  readonly environment?: 'mainnet' | 'testnet';
  readonly rpcUrl?: string;
  readonly checkpoint?: { readonly height: string; readonly hash: string };
  readonly deploymentRef?: string;
  readonly underlyingAsset?: string;
  readonly provider?: string;
  readonly capabilities: readonly IntegrationCapability[];
  readonly dependencies: readonly string[];
  readonly adapter: IntegrationAdapter;
};

export const INTEGRATION_CATEGORY_CAPABILITIES = {
  network: ['network.read', 'transfer.native', 'transfer.token'],
  vault: ['vault.read', 'vault.deposit', 'vault.redeem'],
  staking: ['staking.read', 'staking.manage'],
  lending: ['lending.read', 'lending.manage'],
  dex: ['swap', 'bridge'],
  cex: ['cex.read'],
  service: ['service.read', 'bridge'],
} as const satisfies Record<IntegrationCategory, readonly IntegrationCapability[]>;

const SLUG = /^[a-z][a-z0-9-]{1,49}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .()_-]{1,79}$/u;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const EVM_REF = /^eip155:[1-9][0-9]{0,31}$/;
const SVM_REF = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const BUILTIN_ADAPTERS = {
  'evm-rpc': { architecture: 'evm', kind: 'network' },
  'erc4626-read': { architecture: 'evm', kind: 'vault' },
  'svm-rpc': { architecture: 'svm', kind: 'network' },
  'cosmos-rpc': { architecture: 'cosmos', kind: 'network' },
} as const;

function invalid(): never { throw new Error('STUDIO_MANIFEST_INVALID'); }

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value;
}

function text(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : invalid();
}

function oneOf<T extends string>(value: unknown, items: readonly T[]): T {
  return typeof value === 'string' && items.includes(value as T) ? value as T : invalid();
}

function listOf<T extends string>(value: unknown, check: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > 16) return invalid();
  const entries = value.map(check);
  if (new Set(entries).size !== entries.length) return invalid();
  return Object.freeze(entries.sort());
}

/** Public, unauthenticated HTTPS endpoint syntax. Network callers must also use a pinned public-IP transport. */
export function integrationEndpoint(value: unknown): string {
  const input = text(value, /^https:\/\/[a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9._~/-]*)?$/);
  if (input.length > 200) return invalid();
  const url = new URL(input);
  const labels = url.hostname.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z]{2,63}$/.test(labels.at(-1)!) || /(?:^|\.)localhost$/.test(url.hostname)
    || input.slice('https://'.length).split('/').some(part => part === '.' || part === '..')) return invalid();
  return url.href;
}

function packageAdapter(input: unknown, kind: IntegrationCategory, architecture: IntegrationArchitecture): IntegrationAdapter {
  const value = record(input, ['kind', 'id', 'version', 'repository', 'commit', 'sourceSha256', 'sdkVersion']);
  if (value.kind === 'builtin') {
    record(value, ['kind', 'id', 'version']);
    const id = oneOf(value.id, Object.keys(BUILTIN_ADAPTERS) as BuiltinStudioAdapter[]);
    if (value.version !== 1 || BUILTIN_ADAPTERS[id].architecture !== architecture || BUILTIN_ADAPTERS[id].kind !== kind) return invalid();
    return Object.freeze({ kind: 'builtin', id, version: 1 });
  }
  if (value.kind !== 'external' || value.sdkVersion !== 1) return invalid();
  record(value, ['kind', 'repository', 'commit', 'sourceSha256', 'sdkVersion']);
  const repository = text(value.repository, /^https:\/\/github\.com\/[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9_.-]{1,100}$/);
  if (repository.endsWith('/.') || repository.endsWith('/..')) return invalid();
  return Object.freeze({ kind: 'external', repository, commit: text(value.commit, /^[0-9a-f]{40}$/),
    sourceSha256: text(value.sourceSha256, /^[0-9a-f]{64}$/), sdkVersion: 1 });
}

/** Validates and canonicalizes the proposal. Only the FloFi server can attach verification or certification evidence. */
export function defineIntegrationPackage(input: unknown): IntegrationPackage {
  const v = record(input, ['schemaVersion', 'kind', 'slug', 'name', 'architecture', 'chainRef', 'environment', 'rpcUrl',
    'checkpoint', 'deploymentRef', 'underlyingAsset', 'provider', 'capabilities', 'dependencies', 'adapter']);
  if (v.schemaVersion !== 2) return invalid();
  const kind = oneOf(v.kind, INTEGRATION_CATEGORIES);
  const architecture = oneOf(v.architecture, INTEGRATION_ARCHITECTURES);
  const onChain = kind !== 'cex' && (kind !== 'service' || v.chainRef !== undefined);
  const chainPattern = architecture === 'evm' ? EVM_REF : architecture === 'svm' ? SVM_REF :
    architecture === 'cosmos' ? /^cosmos:[-_a-zA-Z0-9]{1,32}$/ : CAIP2;
  const chainRef = onChain ? text(v.chainRef, chainPattern) : undefined;
  const environment = onChain ? oneOf(v.environment, ['mainnet', 'testnet']) : undefined;
  if (!onChain && (v.chainRef !== undefined || v.environment !== undefined)) return invalid();
  const adapter = packageAdapter(v.adapter, kind, architecture);
  const rpcUrl = v.rpcUrl === undefined ? undefined : integrationEndpoint(v.rpcUrl);
  if (adapter.kind === 'builtin' && rpcUrl === undefined) return invalid();
  const evmBuiltin = adapter.kind === 'builtin' && architecture === 'evm';
  let checkpoint: IntegrationPackage['checkpoint'];
  if (evmBuiltin) {
    const raw = record(v.checkpoint, ['height', 'hash']);
    checkpoint = Object.freeze({ height: text(raw.height, /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/),
      hash: text(raw.hash, /^0x[0-9a-f]{64}$/) });
  } else if (v.checkpoint !== undefined) return invalid();
  const erc4626 = adapter.kind === 'builtin' && adapter.id === 'erc4626-read';
  const deploymentRef = ['vault', 'dex', 'staking', 'lending'].includes(kind)
    ? text(v.deploymentRef, erc4626 ? EVM_ADDRESS : /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/)
    : undefined;
  const underlyingAsset = erc4626 ? text(v.underlyingAsset, EVM_ADDRESS) : undefined;
  if ((v.deploymentRef !== undefined && deploymentRef === undefined) || (v.underlyingAsset !== undefined && underlyingAsset === undefined)
    || deploymentRef === '0x' + '0'.repeat(40) || underlyingAsset === '0x' + '0'.repeat(40) || (erc4626 && deploymentRef === underlyingAsset)) return invalid();
  const provider = kind === 'service' || kind === 'cex' ? text(v.provider, LABEL) : undefined;
  if (provider === undefined && v.provider !== undefined) return invalid();
  const capabilities = listOf(v.capabilities, item => oneOf(item, INTEGRATION_CATEGORY_CAPABILITIES[kind]));
  if (capabilities.length === 0) return invalid();
  const dependencies = listOf(v.dependencies, item => text(item, /^[a-z][a-z0-9-]{1,49}@[1-9][0-9]{0,8}#[a-f0-9]{64}$/));
  return Object.freeze({
    schemaVersion: 2, kind, slug: text(v.slug, SLUG), name: text(v.name, LABEL), architecture,
    ...(chainRef !== undefined && environment !== undefined ? { chainRef, environment } : {}),
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(deploymentRef !== undefined ? { deploymentRef } : {}),
    ...(underlyingAsset !== undefined ? { underlyingAsset } : {}),
    ...(provider !== undefined ? { provider } : {}),
    capabilities, dependencies, adapter,
  });
}
