// SPDX-License-Identifier: AGPL-3.0-only
'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { fixedWindow } from '../platform/fixed-window';
import { DEVELOPER_CONSOLE_PATH, developerConsoleHost } from '../server/developer-console-host';
import { HYPEREVM } from '../studio/integration-manifest';
import { probeStudioIntegration } from '../studio/integration-probe';
import { createStudioStore, studioInstalled } from '../studio/integration-store';

type Result = { ok: true } | { ok: false; code: string };
const studioErrors = new Set([
  'STUDIO_MANIFEST_INVALID', 'STUDIO_VERSION_NOT_FOUND', 'STUDIO_VERSION_CHANGED', 'STUDIO_SLUG_EXISTS', 'STUDIO_VERSION_LIMIT',
  'STUDIO_CONNECTOR_UNAVAILABLE', 'STUDIO_TRANSITION_FORBIDDEN', 'STUDIO_EVIDENCE_EXPIRED', 'STUDIO_EVIDENCE_INVALID',
  'STUDIO_TEST_REQUIRED', 'STUDIO_VAULT_CODE_CHANGED', 'STUDIO_NETWORK_UNSUPPORTED', 'STUDIO_CHAIN_MISMATCH', 'STUDIO_BLOCK_INVALID',
  'STUDIO_BLOCK_STALE', 'STUDIO_BLOCK_CHANGED', 'STUDIO_RPC_UNAVAILABLE', 'STUDIO_NETWORK_TEST_FAILED',
  'STUDIO_VAULT_CODE_MISSING', 'STUDIO_VAULT_ASSET_MISMATCH', 'STUDIO_VAULT_READ_FAILED',
]);

export async function changeStudioIntegration(_previous: Result | null, data: FormData): Promise<Result> {
  try {
    const host = await developerConsoleHost();
    if (host.status !== 'signed-in' || (await headers()).get('origin') !== host.config.origin || !await studioInstalled(host.db)) {
      return { ok: false, code: 'CONSOLE_UNAVAILABLE' };
    }
    const read = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const projectId = read('projectId');
    if ((await host.store.readProject(projectId))?.status !== 'ACTIVE') return { ok: false, code: 'PROJECT_NOT_ACTIVE' };
    const now = new Date();
    const limits = fixedWindow(host.db, host.tenantId);
    if (!await limits.allow(`studio:account:${host.session.accountId}`, 45, 3_600, now)) {
      return { ok: false, code: 'CONSOLE_RATE_LIMITED' };
    }
    const store = createStudioStore(host.db, host.tenantId, host.session.accountId);
    const operation = read('operation'), slug = read('slug'), version = read('version'), generation = read('generation');
    const ref = { slug, version: Number(version), generation: Number(generation) };
    if (operation !== 'create' && operation !== 'create-package'
      && (!/^[1-9][0-9]{0,8}$/.test(version) || !/^(0|[1-9][0-9]{0,8})$/.test(generation))) {
      return { ok: false, code: 'STUDIO_VERSION_NOT_FOUND' };
    }
    switch (operation) {
      case 'create-package':
      case 'revise-package': {
        const input = read('package');
        if (input.length > 12_000) return { ok: false, code: 'STUDIO_MANIFEST_INVALID' };
        let manifest: unknown;
        try { manifest = JSON.parse(input); } catch { return { ok: false, code: 'STUDIO_MANIFEST_INVALID' }; }
        if (!manifest || typeof manifest !== 'object' || !('schemaVersion' in manifest) || manifest.schemaVersion !== 2) {
          return { ok: false, code: 'STUDIO_MANIFEST_INVALID' };
        }
        await store.create(projectId, manifest, now, operation === 'revise-package' ? ref : undefined);
        break;
      }
      case 'create':
      case 'revise': {
        const kind = read('kind');
        if (kind !== 'network' && kind !== 'vault') return { ok: false, code: 'STUDIO_CONNECTOR_UNAVAILABLE' };
        const chainRef = kind === 'network' ? HYPEREVM.chainRef : 'eip155:1';
        await store.create(projectId, { schemaVersion: 1, kind, name: read('name').trim(), slug, chainRef,
          ...(kind === 'vault' ? { standard: 'ERC-4626', contractAddress: read('contractAddress').trim(),
            underlyingAsset: read('underlyingAsset').trim() } : {}) }, now, operation === 'revise' ? ref : undefined);
        break;
      }
      case 'verify':
      case 'test': {
        await store.probe(projectId, ref, operation, () => new Date(), async manifest => {
          if (!await limits.allow('studio:rpc', 2, 60, now)) throw new Error('CONSOLE_RATE_LIMITED');
          return probeStudioIntegration(manifest, operation, now);
        });
        break;
      }
      case 'submit': await store.submit(projectId, ref, now); break;
      case 'submit-adapter': await store.submitAdapter(projectId, ref, now); break;
      case 'suspend':
      case 'revoke':
        if (read('confirm') !== 'on') return { ok: false, code: 'INVALID_REQUEST' };
        await store.deactivate(projectId, ref, operation === 'suspend' ? 'SUSPENDED' : 'REVOKED', now);
        break;
      default: return { ok: false, code: 'INVALID_REQUEST' };
    }
    revalidatePath(DEVELOPER_CONSOLE_PATH);
    return { ok: true };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    if (code === 'CONSOLE_RATE_LIMITED') return { ok: false, code };
    if (code === 'STUDIO_CHAIN_MISMATCH' || code.startsWith('STUDIO_VAULT_')) revalidatePath(DEVELOPER_CONSOLE_PATH);
    return { ok: false, code: studioErrors.has(code) ? code : 'STUDIO_REQUEST_FAILED' };
  }
}
