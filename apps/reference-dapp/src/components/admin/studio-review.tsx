// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { StudioReviewRow } from '../../studio/certification-store';
import { adminPost } from './admin-client';
import { Status, TechnicalDetails } from './admin-ui';

const actionsEn = { approve: 'Certify metadata', reject: 'Reject', publish: 'Publish', rollback: 'Restore publication', suspend: 'Suspend', revoke: 'Revoke' };
const actionsPt: typeof actionsEn = { approve: 'Certificar metadados', reject: 'Rejeitar', publish: 'Publicar', rollback: 'Restaurar publicação', suspend: 'Suspender', revoke: 'Revogar' };
type Action = keyof typeof actionsEn;
const statusPt: Record<StudioReviewRow['status'], string> = { CERTIFICATION_PENDING: 'Revisão pendente', ADAPTER_SUBMITTED: 'Adaptador submetido',
  CERTIFIED: 'Certificada', REJECTED: 'Rejeitada', PUBLISHED: 'Publicada', SUSPENDED: 'Suspensa', REVOKED: 'Revogada' };
const statusEn: Record<StudioReviewRow['status'], string> = { CERTIFICATION_PENDING: 'Awaiting review', ADAPTER_SUBMITTED: 'Adapter submitted',
  CERTIFIED: 'Certified', REJECTED: 'Rejected', PUBLISHED: 'Published', SUSPENDED: 'Suspended', REVOKED: 'Revoked' };

function actionsFor(row: StudioReviewRow): Action[] {
  const latest = row.version === row.latest_version;
  switch (row.status) {
    case 'CERTIFICATION_PENDING': return latest && row.manifest.schemaVersion === 2 ? ['approve', 'reject'] : [];
    case 'ADAPTER_SUBMITTED': return latest ? ['reject'] : [];
    case 'CERTIFIED':
    case 'SUSPENDED':
      return [...latest ? ['publish' as const] : [], ...(row.published_version ?? 0) > row.version ? ['rollback' as const] : [], 'revoke'];
    case 'PUBLISHED': return [...latest ? ['publish' as const] : [], 'suspend', 'revoke'];
    default: return [];
  }
}

export function StudioReview({ row, pt, csrf, canWrite }: { row: StudioReviewRow; pt: boolean; csrf: string; canWrite: boolean }) {
  const router = useRouter();
  const labels = pt ? actionsPt : actionsEn;
  const available = canWrite ? actionsFor(row) : [];
  const [selected, choose] = useState<Action | ''>('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const publishing = selected === 'publish' || selected === 'rollback';
  const name = typeof row.manifest.name === 'string' ? row.manifest.name : row.slug;
  const chain = typeof row.manifest.chainRef === 'string' ? row.manifest.chainRef : null;
  const displayStatus = pt ? statusPt : statusEn;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !available.includes(selected) || busy) return;
    const values = new FormData(event.currentTarget);
    const value = (key: string) => String(values.get(key) ?? '').trim();
    if (['reject', 'rollback', 'suspend', 'revoke'].includes(selected)
      && !window.confirm(pt ? `Confirma a ação «${labels[selected]}»?` : `Confirm “${labels[selected]}”?`)) return;
    setBusy(true);
    setResult(null);
    const response = await adminPost('/admin/api/studio', {
      action: selected, projectId: row.project_id, slug: row.slug, version: row.version, generation: row.generation,
      catalogRevision: row.catalog_revision, reason: value('reason'),
      ...(selected === 'approve' ? { reference: value('reference'), rpcUrl: value('rpcUrl') } : {}),
      ...(publishing ? { visibility, audience: visibility === 'PRIVATE' ? value('audience').split(/[\s,]+/).filter(Boolean) : [] } : {}),
    }, csrf);
    setBusy(false);
    setResult(response.ok ? { ok: true, text: pt ? 'Decisão registrada.' : 'Decision recorded.' } : { ok: false, text: response.code });
    if (response.ok) {
      choose('');
      router.refresh();
    }
  }

  return <article className="admin-card">
    <h3>{name} <code>v{row.version}</code> <Status tone={row.status === 'PUBLISHED' ? 'ok' : 'neutral'}>{displayStatus[row.status]}</Status></h3>
    <p className="admin-hint"><code>{row.project_id}/{row.slug}</code>{chain ? <> · <code>{chain}</code></> : null}</p>
    {row.decision_reason ? <p>{row.decision_reason}</p> : null}
    <TechnicalDetails summary={pt ? 'Configuração e evidências' : 'Configuration and evidence'}>
      <p><code>{row.manifest_sha256}</code></p>
      <pre className="admin-diff">{JSON.stringify({ manifest: row.manifest, verification: row.verification, tests: row.test_result }, null, 2)}</pre>
    </TechnicalDetails>
    {available.length ? <form className="admin-form" onSubmit={submit}>
      <label>{pt ? 'Decisão' : 'Decision'}
        <select value={selected} disabled={busy} onChange={event => choose(event.target.value as Action | '')} required>
          <option value="">{pt ? 'Escolha uma ação' : 'Choose an action'}</option>
          {available.map(action => <option value={action} key={action}>{labels[action]}</option>)}
        </select>
      </label>
      {selected ? <label>{pt ? 'Motivo da decisão, visível ao proprietário' : 'Decision reason, visible to the owner'}<input name="reason" required maxLength={500} disabled={busy}/></label> : null}
      {selected === 'approve' ? <>
        <label>{pt ? 'Referência oficial de mainnet' : 'Official mainnet reference'}<input name="reference" type="url" required maxLength={200} disabled={busy}/></label>
        <label>{pt ? 'RPC independente' : 'Independent RPC'}<input name="rpcUrl" type="url" required maxLength={200} disabled={busy}/></label>
        <p className="admin-hint">{pt ? 'Confirme a identidade e o ponto de controle em uma fonte oficial antes de registrar a decisão.'
          : 'Confirm the identity and checkpoint against an official source before recording the decision.'}</p>
      </> : null}
      {publishing ? <>
        <label>{pt ? 'Visibilidade' : 'Visibility'}
          <select value={visibility} disabled={busy} onChange={event => setVisibility(event.target.value === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC')}>
            <option value="PUBLIC">{pt ? 'Pública' : 'Public'}</option><option value="PRIVATE">{pt ? 'Privada' : 'Private'}</option>
          </select>
        </label>
        {visibility === 'PRIVATE' ? <label>{pt ? 'Contas e projetos autorizados' : 'Authorized accounts and projects'}
          <input name="audience" placeholder="account:acct_… project:prj_…" maxLength={700} required disabled={busy}/>
        </label> : null}
      </> : null}
      {selected ? <button className="admin-button" type="submit" disabled={busy}>{busy ? (pt ? 'A processar…' : 'Processing…') : labels[selected]}</button> : null}
    </form> : null}
    {result ? <p role={result.ok ? 'status' : 'alert'}>{result.text}</p> : null}
  </article>;
}
