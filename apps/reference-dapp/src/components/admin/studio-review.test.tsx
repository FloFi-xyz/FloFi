// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StudioReviewRow } from '../../studio/certification-store';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
const { StudioReview } = await import('./studio-review');

const observedAt = '2026-11-22T20:00:00.000Z';
const row = (patch: Partial<StudioReviewRow> = {}): StudioReviewRow => ({
  project_id: 'prj_' + 'a'.repeat(26), slug: 'aurora-partner', version: 2, generation: 3, latest_version: 2,
  manifest: { schemaVersion: 2, kind: 'network', slug: 'aurora-partner', name: 'Aurora Partner Network', architecture: 'evm', chainRef: 'eip155:924001',
    rpcUrl: 'https://aurora.rpc.example.org/v2/secret-path', checkpoint: { height: '0x10', hash: '0x' + 'b'.repeat(64) },
    adapter: { kind: 'builtin', id: 'evm-rpc', version: 1 } },
  manifest_sha256: 'c'.repeat(64), verification: { observedAt }, test_result: { observedAt }, status: 'CERTIFICATION_PENDING',
  catalog_revision: '0', published_version: null, decision_reason: null, published_visibility: null, published_suspended: false, ...patch,
});
const render = (value: StudioReviewRow, pt = false, canWrite = true) =>
  renderToStaticMarkup(createElement(StudioReview, { row: value, pt, csrf: 'csrf', canWrite, now: '2026-11-22T21:00:00.000Z' }));

describe('BUILD-FLOFI-STUDIO-UNIVERSAL-002 Studio certification card', () => {
  it('summarizes the evidence the decision rests on and shows the RPC host only, never its path', () => {
    const html = render(row());
    expect(html).toContain('<dl class="admin-dl">');
    for (const text of ['Awaiting review', 'eip155:924001', 'evm-rpc v1', 'aurora.rpc.example.org', 'Evidence valid until', 'Current publication', 'None'])
      expect(html).toContain(text);
    expect(html.replace(/<pre[\s\S]*?<\/pre>/, '')).not.toContain('secret-path');
    expect(html).toMatch(/<label for="[^"]+-decision">Decision<\/label><select id="[^"]+-decision"/);
    expect(html).toContain('Certify metadata');
    expect(html).not.toContain('window.confirm');
  });

  it('marks expired evidence, a superseded version and the current publication', () => {
    expect(render(row(), false).includes('(expired)')).toBe(false);
    const stale = renderToStaticMarkup(createElement(StudioReview, { row: row(), pt: false, csrf: 'csrf', canWrite: true, now: '2026-11-24T00:00:00.000Z' }));
    expect(stale).toContain('(expired)');
    expect(render(row({ version: 1, latest_version: 2 }))).toContain('A newer version of this package supersedes this one.');
    expect(render(row({ status: 'PUBLISHED', published_version: 2, published_visibility: 'PRIVATE' }))).toContain('v2 · Private');
    expect(render(row({ status: 'SUSPENDED', published_version: 2, published_suspended: true }))).toContain('v2 · suspended');
  });

  it('speaks Brazilian Portuguese, and offers no decision to a read-only role', () => {
    const html = render(row({ status: 'REVOKED', decision_reason: 'Certificação retirada' }), true);
    for (const text of ['Revogada', 'Motivo da decisão', 'Certificação retirada', 'Registros de configuração e evidências']) expect(html).toContain(text);
    expect(html).not.toContain('<select');
    const viewer = render(row(), false, false);
    expect(viewer).not.toContain('<select');
    expect(viewer).toContain('Your role is read-only');
  });
});
