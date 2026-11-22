// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { changeStudioIntegration } from '../../app/studio-integration-action';
import { HYPEREVM, SAVINGS_DAI, type StudioIntegration } from '../../studio/integration-manifest';
import type { StudioVersion } from '../../studio/integration-store';
import styles from './site.module.css';

const copy = {
  EN: {
    title: 'FloFi Studio', mine: 'My integrations', empty: 'No integrations in this project yet.',
    create: 'New integration', draft: 'Save draft', category: 'Integration category', config: 'Configuration',
    net: 'Network', vault: 'ERC-4626 vault', name: 'Integration name', slug: 'Integration slug', chain: 'Mainnet',
    contract: 'Vault contract', asset: 'Underlying token contract', sample: 'Use Savings Dai configuration',
    status: 'Certification status', version: 'Version', verify: 'Verify', test: 'Test', submit: 'Submit for certification',
    suspend: 'Suspend version', revoke: 'Revoke version', revise: 'Create new version',
    confirmSuspend: 'Invalidate evidence and withdraw this version from review.',
    confirmRevoke: 'Permanently revoke this version and invalidate its evidence.',
    confirmRevise: 'Save a new draft and invalidate any evidence on the previous version.',
    evidence: 'Verification evidence', testEvidence: 'Test evidence', history: 'Previous versions',
    working: 'Working…', saved: 'Saved.', unavailable: 'FloFi Studio is unavailable on this deployment.',
    help: 'Verify and test with mainnet reads. Financial operations require separate certification and wallet approval.',
    pendingHelp: 'Evidence submitted for review. Financial certification and publication require FloFi approval.',
    vaultHelp: 'Previews and limits are recorded for a fixed probe address. A security audit is a separate step.',
    networkHelp: 'The test checks wallet RPC methods and an estimate for a zero-value transfer. Wallet acceptance is a separate step.',
    adapterPending: 'The canonical transfer adapter has no profile for this network yet.',
    expired: 'Verification or test evidence expired. Verify again before submission.',
    failed: 'FloFi Studio could not complete the request.',
    project: 'This project is unavailable.',
    changed: 'This version changed. Refresh the console and try again.',
    invalid: 'Check the name, slug and contract addresses.',
    duplicate: 'This slug is already used in the project.',
    rate: 'Request limit reached. Try again later.',
    rpc: 'The mainnet provider did not return a valid response. Try again later.',
    wrongChain: 'The RPC response did not match the expected chain or a current block.',
    wrongVault: 'The vault or underlying token did not match the configuration or ERC-4626 checks.',
    statuses: { DRAFT: 'Draft', VERIFIED: 'Verified', CERTIFICATION_PENDING: 'Certification pending', CERTIFIED: 'Certified',
      PUBLISHED: 'Published', SUSPENDED: 'Suspended', REVOKED: 'Revoked' },
  },
  PT: {
    title: 'FloFi Studio', mine: 'Minhas integrações', empty: 'Este projeto ainda não tem integrações.',
    create: 'Nova integração', draft: 'Salvar rascunho', category: 'Categoria da integração', config: 'Configuração',
    net: 'Rede', vault: 'Cofre ERC-4626', name: 'Nome da integração', slug: 'Identificador da integração', chain: 'Rede principal',
    contract: 'Contrato do cofre', asset: 'Contrato do token subjacente', sample: 'Usar configuração do Savings Dai',
    status: 'Status da certificação', version: 'Versão', verify: 'Verificar', test: 'Testar', submit: 'Enviar para certificação',
    suspend: 'Suspender versão', revoke: 'Revogar versão', revise: 'Criar nova versão',
    confirmSuspend: 'Invalidar as evidências e retirar esta versão da análise.',
    confirmRevoke: 'Revogar esta versão de forma permanente e invalidar as evidências.',
    confirmRevise: 'Salvar um novo rascunho e invalidar as evidências da versão anterior.',
    evidence: 'Evidência de verificação', testEvidence: 'Evidência de teste', history: 'Versões anteriores',
    working: 'Processando…', saved: 'Alterações salvas.', unavailable: 'O FloFi Studio está indisponível neste ambiente.',
    help: 'Verifique e teste com leituras da rede principal. Operações financeiras exigem certificação e aprovação na carteira.',
    pendingHelp: 'Evidências enviadas para análise. A certificação financeira e a publicação exigem aprovação da FloFi.',
    vaultHelp: 'Prévias e limites são registrados para um endereço de teste fixo. A auditoria do cofre é uma etapa separada.',
    networkHelp: 'O teste consulta métodos RPC usados por carteiras e estima uma transferência de valor zero. A validação com carteira é uma etapa separada.',
    adapterPending: 'O adaptador canônico de transferências ainda não tem um perfil para esta rede.',
    expired: 'A evidência de verificação ou de teste expirou. Verifique novamente antes do envio.',
    failed: 'O FloFi Studio não conseguiu concluir a solicitação.',
    project: 'Este projeto está indisponível.',
    changed: 'Esta versão mudou. Atualize o console e tente novamente.',
    invalid: 'Confira o nome, o identificador e os endereços de contrato.',
    duplicate: 'Este identificador já está em uso no projeto.',
    rate: 'Limite de solicitações atingido. Tente novamente mais tarde.',
    rpc: 'O provedor da rede principal não retornou uma resposta válida. Tente novamente mais tarde.',
    wrongChain: 'A resposta RPC divergiu da rede esperada ou de um bloco recente.',
    wrongVault: 'O cofre ou o token subjacente divergiu da configuração ou das verificações ERC-4626.',
    statuses: { DRAFT: 'Rascunho', VERIFIED: 'Verificada', CERTIFICATION_PENDING: 'Certificação pendente', CERTIFIED: 'Certificada',
      PUBLISHED: 'Publicada', SUSPENDED: 'Suspensa', REVOKED: 'Revogada' },
  },
} as const;

type Language = keyof typeof copy;
type Copy = (typeof copy)[Language];
type Version = Pick<StudioVersion, 'slug' | 'version' | 'generation' | 'manifest' | 'status' | 'verification' | 'test_result'>;
type Operation = 'create' | 'revise' | 'verify' | 'test' | 'submit' | 'suspend' | 'revoke';

function errorMessage(code: string, t: Copy) {
  if (code === 'PROJECT_NOT_ACTIVE') return t.project;
  if (code === 'CONSOLE_UNAVAILABLE') return t.unavailable;
  if (code === 'CONSOLE_RATE_LIMITED') return t.rate;
  if (code === 'STUDIO_MANIFEST_INVALID' || code === 'STUDIO_NETWORK_UNSUPPORTED') return t.invalid;
  if (code === 'STUDIO_SLUG_EXISTS') return t.duplicate;
  if (code === 'STUDIO_VERSION_CHANGED' || code === 'STUDIO_VERSION_NOT_FOUND') return t.changed;
  if (code === 'STUDIO_EVIDENCE_EXPIRED') return t.expired;
  if (code === 'STUDIO_RPC_UNAVAILABLE' || code === 'STUDIO_NETWORK_TEST_FAILED') return t.rpc;
  if (code === 'STUDIO_CHAIN_MISMATCH' || code.startsWith('STUDIO_BLOCK_')) return t.wrongChain;
  if (code.startsWith('STUDIO_VAULT_')) return t.wrongVault;
  return t.failed;
}

function StudioForm({ t, projectId, version, operation, label, children }: {
  t: Copy; projectId: string; version?: Version; operation: Operation; label: string; children?: ReactNode;
}) {
  const [result, action, pending] = useActionState(changeStudioIntegration, null);
  return <form action={action} className={styles.consoleForm}>
    <input type="hidden" name="projectId" value={projectId}/>
    <input type="hidden" name="operation" value={operation}/>
    {version && <>
      <input type="hidden" name="slug" value={version.slug}/>
      <input type="hidden" name="version" value={version.version}/>
      <input type="hidden" name="generation" value={version.generation}/>
    </>}
    {children}
    <button className={styles.pillBlue} type="submit" disabled={pending}>{pending ? t.working : label}</button>
    {!pending && result && (result.ok ? <p role="status">{t.saved}</p> : <p role="alert">{errorMessage(result.code, t)}</p>)}
  </form>;
}

function Config({ t, manifest }: { t: Copy; manifest?: StudioIntegration }) {
  const [kind, setKind] = useState(manifest?.kind === 'vault' ? 'vault' : 'network');
  const [name, setName] = useState(manifest?.name ?? '');
  const [slug, setSlug] = useState('');
  const [contract, setContract] = useState(manifest?.kind === 'vault' ? manifest.contractAddress : '');
  const [asset, setAsset] = useState(manifest?.kind === 'vault' ? manifest.underlyingAsset : '');
  return <fieldset>
    <legend>{t.config}</legend>
    {manifest ? <input type="hidden" name="kind" value={kind}/> : <label>{t.category}
      <select name="kind" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="network">{t.net}</option><option value="vault">{t.vault}</option>
      </select>
    </label>}
    <label>{t.name}<input name="name" required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label>
    {!manifest && <label>{t.slug}<input name="slug" required minLength={2} maxLength={50} pattern={String.raw`[a-z][a-z0-9\-]{1,49}`} spellCheck={false}
      value={slug} onChange={event => setSlug(event.target.value)}/></label>}
    {kind === 'network' ? <p>{HYPEREVM.name} · {HYPEREVM.chainId} · {HYPEREVM.nativeSymbol} · <code>{HYPEREVM.rpcUrl}</code></p> : <>
      <p>{t.chain} · Ethereum (1)</p>
      <label>{t.contract}<input name="contractAddress" required pattern="0x[0-9a-fA-F]{40}" maxLength={42} spellCheck={false}
        value={contract} onChange={event => setContract(event.target.value)}/></label>
      <label>{t.asset}<input name="underlyingAsset" required pattern="0x[0-9a-fA-F]{40}" maxLength={42} spellCheck={false}
        value={asset} onChange={event => setAsset(event.target.value)}/></label>
      <button type="button" onClick={() => { setContract(SAVINGS_DAI.contractAddress); setAsset(SAVINGS_DAI.underlyingAsset); }}>
        {t.sample}
      </button>
    </>}
  </fieldset>;
}

function StudioItem({ version, t, projectId, active, now }: {
  version: Version; t: Copy; projectId: string; active: boolean; now: string;
}) {
  const { manifest, verification, test_result: test, status } = version;
  const withinDay = (at: string) => Date.parse(now) - Date.parse(at) >= 0 && Date.parse(now) - Date.parse(at) <= 86_400_000;
  const allowsDraft = status !== 'CERTIFIED' && status !== 'PUBLISHED' && (manifest.kind === 'network' || manifest.kind === 'vault');
  const currentVerification = verification && withinDay(verification.observedAt);
  const currentTest = test && withinDay(test.observedAt);
  const scope = { t, projectId, version };
  return <article>
    <h4>{manifest.name}</h4>
    <p><code>{version.slug}</code> · {t.version} {version.version} · {t.status} {t.statuses[status]}</p>
    {manifest.kind === 'network' && <p>{HYPEREVM.name} · {HYPEREVM.chainId} · {HYPEREVM.nativeSymbol} · <code>{HYPEREVM.rpcUrl}</code></p>}
    {manifest.kind === 'vault' && <dl>
      <dt>{t.chain}</dt><dd>{manifest.chainRef}</dd>
      <dt>{t.contract}</dt><dd><code>{manifest.contractAddress}</code></dd>
      <dt>{t.asset}</dt><dd><code>{manifest.underlyingAsset}</code></dd>
    </dl>}
    {status === 'CERTIFICATION_PENDING' && <p>{t.pendingHelp}</p>}
    {status === 'VERIFIED' && (!currentVerification || (test && !currentTest)) && <p>{t.expired}</p>}
    {verification && <details><summary>{t.evidence}</summary>
      {verification.facts.canonicalNativeTransferProfile === false && <p>{t.adapterPending}</p>}
      <pre className={styles.consoleOutput} tabIndex={0} aria-label={t.evidence}>{JSON.stringify(verification, null, 2)}</pre>
    </details>}
    {test && <details><summary>{t.testEvidence}</summary>
      <p>{manifest.kind === 'vault' ? t.vaultHelp : t.networkHelp}</p>
      <pre className={styles.consoleOutput} tabIndex={0} aria-label={t.testEvidence}>{JSON.stringify(test, null, 2)}</pre>
    </details>}
    {active && allowsDraft && <>
      {(status === 'DRAFT' || status === 'VERIFIED') && <StudioForm {...scope} operation="verify" label={t.verify}/>}
      {status === 'VERIFIED' && currentVerification && <StudioForm {...scope} operation="test" label={t.test}/>}
      {status === 'VERIFIED' && currentVerification && currentTest && <StudioForm {...scope} operation="submit" label={t.submit}/>}
      {(status === 'VERIFIED' || status === 'CERTIFICATION_PENDING') && <details><summary>{t.suspend}</summary>
        <StudioForm {...scope} operation="suspend" label={t.suspend}>
          <label className={styles.consoleCheck}><input type="checkbox" name="confirm" required/>{t.confirmSuspend}</label>
        </StudioForm>
      </details>}
      {status !== 'REVOKED' && <details><summary>{t.revoke}</summary>
        <StudioForm {...scope} operation="revoke" label={t.revoke}>
          <label className={styles.consoleCheck}><input type="checkbox" name="confirm" required/>{t.confirmRevoke}</label>
        </StudioForm>
      </details>}
      <details><summary>{t.revise}</summary>
        <p>{t.confirmRevise}</p>
        <StudioForm {...scope} operation="revise" label={t.revise}><Config t={t} manifest={manifest}/></StudioForm>
      </details>
    </>}
  </article>;
}

export function DeveloperStudio({ language, projectId, active, versions, now }: {
  language: Language; projectId: string; active: boolean; versions: readonly Version[] | null; now: string;
}) {
  const t = copy[language];
  const groups = Map.groupBy(versions ?? [], version => version.slug);
  return <section aria-labelledby="developer-studio-title">
    <h3 id="developer-studio-title">{t.title}</h3>
    {versions === null ? <p role="status">{t.unavailable}</p> : <>
      <p>{t.help}</p>
      <h4>{t.mine}</h4>
      {!versions.length && <p>{t.empty}</p>}
      {[...groups.entries()].map(([slug, [current, ...history]]) => current && <div key={slug}>
        <StudioItem key={current.version} version={current} t={t} projectId={projectId} active={active} now={now}/>
        {history.length > 0 && <details><summary>{t.history}</summary>
          {history.map(version => <StudioItem key={version.version} version={version} t={t} projectId={projectId} active={false} now={now}/>)}
        </details>}
      </div>)}
      {active && <details open={!versions.length}><summary>{t.create}</summary>
        <StudioForm t={t} projectId={projectId} operation="create" label={t.draft}><Config t={t}/></StudioForm>
      </details>}
    </>}
  </section>;
}
