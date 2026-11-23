// SPDX-License-Identifier: AGPL-3.0-only
'use client';

/**
 * BUILD-FLOFI-STUDIO-UNIVERSAL-002: one submitted Studio package in the operator's certification queue. The evidence the decision rests on
 * is summarized first (identity, checkpoint, observations and their freshness, current publication); the raw records stay in Technical
 * details. Every decision is confirmed in place with its consequence, and the server rechecks all of it inside the decision transaction.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { StudioReviewRow } from '../../studio/certification-store';
import { adminPost } from './admin-client';
import { Status, TechnicalDetails, type Tone } from './admin-ui';

type Action = 'approve' | 'reject' | 'publish' | 'rollback' | 'suspend' | 'revoke';
type Visibility = 'PUBLIC' | 'PRIVATE';
type Copy = {
  actions: Record<Action, string>; status: Record<StudioReviewRow['status'], string>; messages: Record<string, string>;
  consequence: (action: Action, visibility: Visibility | '', version: number, published: number | null) => string;
  decision: string; choose: string; reason: string; reference: string; rpc: string; approveHint: string; visibility: string; chooseVisibility: string;
  public: string; private: string; audience: string; audienceHint: string; reviewed: string; processing: string; cancel: string; recorded: string;
  uncertain: (code: string) => string; refused: (code: string) => string; superseded: string; readOnly: string; technical: string;
  labels: { kind: string; adapter: string; network: string; deployment: string; checkpoint: string; rpc: string; verified: string; tested: string;
    validUntil: string; expired: string; source: string; publication: string; reasonShown: string; none: string; suspended: string };
};

const EN: Copy = {
  actions: { approve: 'Certify metadata', reject: 'Reject', publish: 'Publish', rollback: 'Restore publication', suspend: 'Suspend', revoke: 'Revoke' },
  status: { CERTIFICATION_PENDING: 'Awaiting review', ADAPTER_SUBMITTED: 'Adapter submitted', CERTIFIED: 'Certified', REJECTED: 'Rejected',
    PUBLISHED: 'Published', SUSPENDED: 'Suspended', REVOKED: 'Revoked' },
  messages: {
    STUDIO_CERTIFICATION_VERSION_CHANGED: 'The package or its publication changed since this page loaded. The queue was refreshed: review it again.',
    STUDIO_CERTIFICATION_VERSION_UNAVAILABLE: 'This version is no longer the latest, or its project is inactive. The queue was refreshed.',
    STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN: 'That decision does not apply to the current state. Nothing was changed.',
    STUDIO_CERTIFICATION_OPERATOR_REQUIRED: 'An active OPERATOR session is required. Sign in again.',
    STUDIO_CERTIFICATION_REVIEWER_UNBOUND: 'Your admin wallet is not linked to a FloFi account. Link it to your own account, then try again.',
    STUDIO_CERTIFICATION_SELF_REVIEW: 'You cannot review a package owned by your own FloFi account.',
    STUDIO_CERTIFICATION_REFERENCE_NOT_INDEPENDENT: 'Use a reference and an RPC on hosts other than the proposal\'s RPC.',
    STUDIO_CERTIFICATION_EVIDENCE_EXPIRED: 'The proposal\'s observations are older than 24 hours. The owner must verify and test again.',
    STUDIO_CERTIFICATION_EVIDENCE_INVALID: 'The independent observation did not match the proposal (chain, checkpoint or adapter). Nothing was certified.',
    STUDIO_CERTIFICATION_VAULT_CHANGED: 'The vault or asset code observed independently differs from the proposal. Nothing was certified.',
    STUDIO_CERTIFICATION_UNSUPPORTED: 'This package cannot be certified: only mainnet metadata with a built-in adapter, for a network FloFi does not already support.',
    STUDIO_CERTIFICATION_CATALOG_CONFLICT: 'Another package is already published for this chain or deployment. Suspend or revoke it first.',
    STUDIO_CERTIFICATION_AUDIENCE_UNAVAILABLE: 'Every audience entry must be an existing account (account:acct_…) or an active project (project:prj_…).',
    STUDIO_CERTIFICATION_REQUEST_INVALID: 'Check the reason (1–500 characters, no control characters) and the fields for this decision.',
    STUDIO_MANIFEST_INVALID: 'The stored package does not match its digest. It cannot be certified.',
    STUDIO_RPC_UNAVAILABLE: 'The independent RPC did not answer within its limits. Nothing was certified.',
    STUDIO_CHAIN_MISMATCH: 'The independent RPC reports another chain or checkpoint. Nothing was certified.',
    STUDIO_CERTIFICATION_NOT_INSTALLED: 'Certification requires migration 0036.',
    CONSOLE_RATE_LIMITED: 'Too many certification checks in the last minute. Try again shortly.',
    ADMIN_ROLE_INSUFFICIENT: 'Your role is read-only.', ADMIN_CSRF_INVALID: 'Your session token is stale. Reload the page.',
    ADMIN_SESSION_REQUIRED: 'Your admin session ended. Sign in again.',
  },
  consequence: (action, visibility, version, published) => ({
    approve: 'Certification binds this exact version, its adapter and the evidence shown above. It grants read metadata only.',
    reject: 'Rejection is final for this version. The owner sees your reason.',
    publish: visibility === 'PRIVATE' ? 'Only the listed accounts and projects will see this metadata.'
      : visibility === 'PUBLIC' ? 'Every FloFi user and project will see this metadata.' : 'Choose a visibility first.',
    rollback: `Version ${version} replaces version ${published ?? '—'} in every catalog.`,
    suspend: 'Suspension removes the package from every catalog until it is restored or published again.',
    revoke: 'Revocation is permanent: this version can never be published again.',
  })[action],
  decision: 'Decision', choose: 'Choose a decision', reason: 'Reason (visible to the owner)', reference: 'Official mainnet reference',
  rpc: 'Independent RPC (a different host)', approveHint: 'Confirm the chain identity and checkpoint against the official reference before certifying.',
  visibility: 'Visibility', chooseVisibility: 'Choose visibility', public: 'Public', private: 'Private', audience: 'Authorized accounts and projects',
  audienceHint: 'Separate entries with spaces or commas: account:acct_… or project:prj_…', reviewed: 'I reviewed this decision.',
  processing: 'Processing…', cancel: 'Cancel', recorded: 'Decision recorded.',
  uncertain: code => `The request did not complete (${code}). It may or may not have been applied: reload the queue before retrying.`,
  refused: code => `Refused (${code}).`, superseded: 'A newer version of this package supersedes this one.',
  readOnly: 'Your role is read-only: an OPERATOR records decisions.', technical: 'Configuration and evidence records',
  labels: { kind: 'Kind', adapter: 'Adapter', network: 'Network', deployment: 'Deployment', checkpoint: 'Checkpoint', rpc: 'Proposal RPC host',
    verified: 'Verified', tested: 'Tested', validUntil: 'Evidence valid until', expired: 'expired', source: 'Adapter source',
    publication: 'Current publication', reasonShown: 'Decision reason', none: 'None', suspended: 'suspended' },
};

const PT: Copy = {
  actions: { approve: 'Certificar metadados', reject: 'Rejeitar', publish: 'Publicar', rollback: 'Restaurar publicação', suspend: 'Suspender', revoke: 'Revogar' },
  status: { CERTIFICATION_PENDING: 'Revisão pendente', ADAPTER_SUBMITTED: 'Adaptador submetido', CERTIFIED: 'Certificada', REJECTED: 'Rejeitada',
    PUBLISHED: 'Publicada', SUSPENDED: 'Suspensa', REVOKED: 'Revogada' },
  messages: {
    STUDIO_CERTIFICATION_VERSION_CHANGED: 'O pacote ou a publicação mudou desde que a página foi carregada. A fila foi atualizada: revise novamente.',
    STUDIO_CERTIFICATION_VERSION_UNAVAILABLE: 'Esta versão não é mais a mais recente, ou o projeto está inativo. A fila foi atualizada.',
    STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN: 'Essa decisão não se aplica ao estado atual. Nada foi alterado.',
    STUDIO_CERTIFICATION_OPERATOR_REQUIRED: 'É necessária uma sessão ativa de OPERATOR. Entre novamente.',
    STUDIO_CERTIFICATION_REVIEWER_UNBOUND: 'Sua carteira de admin não está vinculada a uma conta FloFi. Vincule-a à sua própria conta e tente de novo.',
    STUDIO_CERTIFICATION_SELF_REVIEW: 'Você não pode revisar um pacote da sua própria conta FloFi.',
    STUDIO_CERTIFICATION_REFERENCE_NOT_INDEPENDENT: 'Use uma referência e um RPC em hosts diferentes do RPC da proposta.',
    STUDIO_CERTIFICATION_EVIDENCE_EXPIRED: 'As observações da proposta têm mais de 24 horas. O proprietário precisa verificar e testar novamente.',
    STUDIO_CERTIFICATION_EVIDENCE_INVALID: 'A observação independente não confere com a proposta (rede, checkpoint ou adaptador). Nada foi certificado.',
    STUDIO_CERTIFICATION_VAULT_CHANGED: 'O código do cofre ou do ativo observado de forma independente difere da proposta. Nada foi certificado.',
    STUDIO_CERTIFICATION_UNSUPPORTED: 'Este pacote não pode ser certificado: apenas metadados de mainnet com adaptador nativo, para uma rede que a FloFi ainda não suporta.',
    STUDIO_CERTIFICATION_CATALOG_CONFLICT: 'Já existe outro pacote publicado para esta rede ou implantação. Suspenda ou revogue-o antes.',
    STUDIO_CERTIFICATION_AUDIENCE_UNAVAILABLE: 'Cada entrada deve ser uma conta existente (account:acct_…) ou um projeto ativo (project:prj_…).',
    STUDIO_CERTIFICATION_REQUEST_INVALID: 'Confira o motivo (1–500 caracteres, sem caracteres de controle) e os campos desta decisão.',
    STUDIO_MANIFEST_INVALID: 'O pacote armazenado não confere com o seu digest. Ele não pode ser certificado.',
    STUDIO_RPC_UNAVAILABLE: 'O RPC independente não respondeu dentro dos limites. Nada foi certificado.',
    STUDIO_CHAIN_MISMATCH: 'O RPC independente informa outra rede ou checkpoint. Nada foi certificado.',
    STUDIO_CERTIFICATION_NOT_INSTALLED: 'A certificação requer a migração 0036.',
    CONSOLE_RATE_LIMITED: 'Muitas verificações de certificação no último minuto. Tente novamente em instantes.',
    ADMIN_ROLE_INSUFFICIENT: 'Seu perfil é somente leitura.', ADMIN_CSRF_INVALID: 'O token da sessão expirou. Recarregue a página.',
    ADMIN_SESSION_REQUIRED: 'Sua sessão de admin terminou. Entre novamente.',
  },
  consequence: (action, visibility, version, published) => ({
    approve: 'A certificação vincula exatamente esta versão, o adaptador e as evidências acima. Ela concede apenas metadados de leitura.',
    reject: 'A rejeição é definitiva para esta versão. O proprietário verá o seu motivo.',
    publish: visibility === 'PRIVATE' ? 'Somente as contas e os projetos listados verão estes metadados.'
      : visibility === 'PUBLIC' ? 'Todos os usuários e projetos da FloFi verão estes metadados.' : 'Escolha uma visibilidade primeiro.',
    rollback: `A versão ${version} substitui a versão ${published ?? '—'} em todos os catálogos.`,
    suspend: 'A suspensão remove o pacote de todos os catálogos até que seja restaurado ou publicado novamente.',
    revoke: 'A revogação é permanente: esta versão nunca mais poderá ser publicada.',
  })[action],
  decision: 'Decisão', choose: 'Escolha uma decisão', reason: 'Motivo (visível ao proprietário)', reference: 'Referência oficial de mainnet',
  rpc: 'RPC independente (outro host)', approveHint: 'Confirme a identidade da rede e o checkpoint na referência oficial antes de certificar.',
  visibility: 'Visibilidade', chooseVisibility: 'Escolha a visibilidade', public: 'Pública', private: 'Privada', audience: 'Contas e projetos autorizados',
  audienceHint: 'Separe as entradas com espaços ou vírgulas: account:acct_… ou project:prj_…', reviewed: 'Revisei esta decisão.',
  processing: 'Processando…', cancel: 'Cancelar', recorded: 'Decisão registrada.',
  uncertain: code => `A solicitação não foi concluída (${code}). Ela pode ou não ter sido aplicada: recarregue a fila antes de tentar de novo.`,
  refused: code => `Recusado (${code}).`, superseded: 'Uma versão mais recente deste pacote substitui esta.',
  readOnly: 'Seu perfil é somente leitura: um OPERATOR registra as decisões.', technical: 'Registros de configuração e evidências',
  labels: { kind: 'Tipo', adapter: 'Adaptador', network: 'Rede', deployment: 'Implantação', checkpoint: 'Checkpoint', rpc: 'Host do RPC da proposta',
    verified: 'Verificada', tested: 'Testada', validUntil: 'Evidências válidas até', expired: 'expiradas', source: 'Código do adaptador',
    publication: 'Publicação atual', reasonShown: 'Motivo da decisão', none: 'Nenhuma', suspended: 'suspensa' },
};

const UNCERTAIN = new Set(['ADMIN_REQUEST_FAILED', 'ADMIN_RESPONSE_INVALID']);
const REFRESH = new Set(['STUDIO_CERTIFICATION_VERSION_CHANGED', 'STUDIO_CERTIFICATION_VERSION_UNAVAILABLE', 'STUDIO_CERTIFICATION_TRANSITION_FORBIDDEN']);
const DANGER = new Set<Action>(['reject', 'suspend', 'revoke']);
const EVIDENCE_TTL = 86_400_000;
const TONE: Record<StudioReviewRow['status'], Tone> = { CERTIFICATION_PENDING: 'warn', ADAPTER_SUBMITTED: 'warn', CERTIFIED: 'info', REJECTED: 'bad',
  PUBLISHED: 'ok', SUSPENDED: 'warn', REVOKED: 'bad' };

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

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' && value ? value : null;
const origin = (value: unknown) => { try { return text(value) ? new URL(value as string).host : null; } catch { return null; } };
const short = (value: string) => value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;

export function StudioReview({ row, pt, csrf, canWrite, now }: { row: StudioReviewRow; pt: boolean; csrf: string; canWrite: boolean; now: string }) {
  const router = useRouter();
  const t = pt ? PT : EN;
  const id = useId();
  const available = canWrite ? actionsFor(row) : [];
  const [selected, choose] = useState<Action | ''>('');
  const [visibility, setVisibility] = useState<Visibility | ''>('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const resultBox = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (result) resultBox.current?.focus(); }, [result]);
  const publishing = selected === 'publish' || selected === 'rollback';

  const manifest = record(row.manifest), adapter = record(manifest.adapter), checkpoint = record(manifest.checkpoint);
  const verify = record(row.verification), test = record(row.test_result);
  const name = text(manifest.name) ?? row.slug, chain = text(manifest.chainRef), deployment = text(manifest.deploymentRef);
  const observed = [text(verify.observedAt), text(test.observedAt)].filter((value): value is string => value !== null).map(value => Date.parse(value));
  const validUntil = observed.length === 2 && observed.every(Number.isFinite) ? Math.min(...observed) + EVIDENCE_TTL : null;
  const locale = pt ? 'pt-BR' : 'en';
  const when = (value: number | string | null) => value === null ? t.labels.none
    : new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  const publication = row.published_version === null ? t.labels.none
    : `v${row.published_version} · ${row.published_suspended ? t.labels.suspended : row.published_visibility === 'PRIVATE' ? t.private : t.public}`;
  const message = (code: string) => t.messages[code] ?? (UNCERTAIN.has(code) ? t.uncertain(code) : t.refused(code));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !available.includes(selected) || busy || !reviewed || (publishing && !visibility)) return;
    const values = new FormData(event.currentTarget);
    const value = (key: string) => String(values.get(key) ?? '').trim();
    setBusy(true);
    setResult(null);
    setAnnounce(t.processing);
    const response = await adminPost('/admin/api/studio', {
      action: selected, projectId: row.project_id, slug: row.slug, version: row.version, generation: row.generation,
      catalogRevision: row.catalog_revision, reason: value('reason'),
      ...(selected === 'approve' ? { reference: value('reference'), rpcUrl: value('rpcUrl') } : {}),
      ...(publishing ? { visibility, audience: visibility === 'PRIVATE' ? value('audience').split(/[\s,]+/).filter(Boolean) : [] } : {}),
    }, csrf);
    setBusy(false);
    const outcome = response.ok ? { ok: true, text: t.recorded } : { ok: false, text: message(response.code) };
    setResult(outcome);
    setAnnounce(outcome.text);
    if (response.ok) { choose(''); setReviewed(false); setVisibility(''); }
    if (response.ok || REFRESH.has(response.code)) router.refresh();
  }

  return <article className="admin-studio-review" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{name} <code>v{row.version}</code> <Status tone={TONE[row.status]}>{t.status[row.status]}</Status></h3>
    <p className="admin-hint"><code>{row.project_id}/{row.slug}</code></p>
    {row.version < row.latest_version && (row.status === 'CERTIFICATION_PENDING' || row.status === 'ADAPTER_SUBMITTED')
      ? <p className="admin-hint">{t.superseded}</p> : null}
    <dl className="admin-dl">
      <dt>{t.labels.kind}</dt><dd>{[text(manifest.kind), text(manifest.architecture)?.toUpperCase()].filter(Boolean).join(' · ')}</dd>
      {chain ? <><dt>{t.labels.network}</dt><dd><code>{chain}</code></dd></> : null}
      {deployment ? <><dt>{t.labels.deployment}</dt><dd><code>{deployment}</code></dd></> : null}
      <dt>{t.labels.adapter}</dt><dd>{text(adapter.id) ? <code>{`${text(adapter.id)} v${String(adapter.version ?? '')}`}</code> : text(adapter.kind) ?? t.labels.none}</dd>
      {text(checkpoint.hash) ? <><dt>{t.labels.checkpoint}</dt><dd><code title={text(checkpoint.hash)!}>{`${text(checkpoint.height) ?? ''} ${short(text(checkpoint.hash)!)}`.trim()}</code></dd></> : null}
      {origin(manifest.rpcUrl) ? <><dt>{t.labels.rpc}</dt><dd><code>{origin(manifest.rpcUrl)}</code></dd></> : null}
      {row.status !== 'ADAPTER_SUBMITTED' ? <>
        <dt>{t.labels.verified}</dt><dd>{when(text(verify.observedAt))}</dd>
        <dt>{t.labels.tested}</dt><dd>{when(text(test.observedAt))}</dd>
      </> : <><dt>{t.labels.source}</dt><dd>{t.status.ADAPTER_SUBMITTED}</dd></>}
      {validUntil !== null && row.status === 'CERTIFICATION_PENDING'
        ? <><dt>{t.labels.validUntil}</dt><dd>{when(validUntil)}{validUntil <= Date.parse(now) ? ` (${t.labels.expired})` : ''}</dd></> : null}
      <dt>{t.labels.publication}</dt><dd>{publication}</dd>
      {row.decision_reason ? <><dt>{t.labels.reasonShown}</dt><dd>{row.decision_reason}</dd></> : null}
    </dl>
    <TechnicalDetails summary={t.technical} className="admin-studio-records">
      <p><code>{row.manifest_sha256}</code></p>
      <pre className="admin-diff">{JSON.stringify({ manifest: row.manifest, verification: row.verification, tests: row.test_result }, null, 2)}</pre>
    </TechnicalDetails>
    {!canWrite && actionsFor(row).length ? <p className="admin-hint">{t.readOnly}</p> : null}
    {available.length ? <form className="admin-form" onSubmit={submit}>
      <div className="admin-field">
        <label htmlFor={`${id}-decision`}>{t.decision}</label>
        <select id={`${id}-decision`} value={selected} disabled={busy} required
          onChange={event => { choose(event.target.value as Action | ''); setReviewed(false); setResult(null); }}>
          <option value="">{t.choose}</option>
          {available.map(action => <option value={action} key={action}>{t.actions[action]}</option>)}
        </select>
      </div>
      {selected ? <div className="admin-confirm" role="group" aria-label={`${t.actions[selected]}: ${name} v${row.version}`}>
        <div className="admin-field">
          <label htmlFor={`${id}-reason`}>{t.reason}</label>
          <input id={`${id}-reason`} name="reason" type="text" required maxLength={500} disabled={busy}/>
        </div>
        {selected === 'approve' ? <>
          <div className="admin-field">
            <label htmlFor={`${id}-reference`}>{t.reference}</label>
            <input id={`${id}-reference`} name="reference" type="text" inputMode="url" autoComplete="off" required maxLength={200} disabled={busy}/>
          </div>
          <div className="admin-field">
            <label htmlFor={`${id}-rpc`}>{t.rpc}</label>
            <input id={`${id}-rpc`} name="rpcUrl" type="text" inputMode="url" autoComplete="off" required maxLength={200} disabled={busy}/>
          </div>
          <p className="admin-hint">{t.approveHint}</p>
        </> : null}
        {publishing ? <>
          <div className="admin-field">
            <label htmlFor={`${id}-visibility`}>{t.visibility}</label>
            <select id={`${id}-visibility`} value={visibility} disabled={busy} required
              onChange={event => setVisibility(event.target.value === 'PRIVATE' ? 'PRIVATE' : event.target.value === 'PUBLIC' ? 'PUBLIC' : '')}>
              <option value="">{t.chooseVisibility}</option><option value="PUBLIC">{t.public}</option><option value="PRIVATE">{t.private}</option>
            </select>
          </div>
          {visibility === 'PRIVATE' ? <div className="admin-field">
            <label htmlFor={`${id}-audience`}>{t.audience}</label>
            <input id={`${id}-audience`} name="audience" type="text" aria-describedby={`${id}-audience-hint`} placeholder="account:acct_… project:prj_…"
              maxLength={700} required disabled={busy}/>
            <span className="admin-hint" id={`${id}-audience-hint`}>{t.audienceHint}</span>
          </div> : null}
        </> : null}
        <p id={`${id}-consequence`}>{t.consequence(selected, visibility, row.version, row.published_version)}</p>
        <label><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)}
          aria-describedby={`${id}-consequence`}/> {t.reviewed}</label>
        <div className="admin-actions">
          <button className="admin-button" type="submit" data-variant={DANGER.has(selected) ? 'danger' : 'primary'}
            disabled={busy || !reviewed || (publishing && !visibility)} aria-describedby={`${id}-consequence`}>
            {busy ? t.processing : t.actions[selected]}
          </button>
          <button className="admin-button" type="button" disabled={busy} onClick={() => { choose(''); setReviewed(false); }}>{t.cancel}</button>
        </div>
      </div> : null}
    </form> : null}
    {result ? <p ref={resultBox} tabIndex={-1} className="admin-alert" data-tone={result.ok ? 'ok' : 'bad'}>{result.text}</p> : null}
    <p className="admin-sr" role="status" aria-live="polite">{announce}</p>
  </article>;
}
