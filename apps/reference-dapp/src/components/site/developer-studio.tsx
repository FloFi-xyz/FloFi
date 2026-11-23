// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  defineIntegrationPackage, INTEGRATION_ARCHITECTURES, INTEGRATION_CATEGORIES, INTEGRATION_CATEGORY_CAPABILITIES,
  type BuiltinStudioAdapter, type IntegrationArchitecture, type IntegrationCapability, type IntegrationCategory, type IntegrationPackage,
} from '@defi-workflow-engine/developer-sdk';
import { changeStudioIntegration } from '../../app/studio-integration-action';
import type { StudioActivity, StudioVersion } from '../../studio/integration-store';
import styles from './site.module.css';

const tabs = ['overview', 'integrations', 'create', 'certification', 'activity', 'docs'] as const;
type Tab = (typeof tabs)[number];
type Certification = {
  slug: string; version: number; status: 'CERTIFIED' | 'REJECTED' | 'PUBLISHED' | 'SUSPENDED' | 'REVOKED';
  reason: string; visibility: 'PUBLIC' | 'PRIVATE' | null;
};
type Version = Pick<StudioVersion, 'slug' | 'version' | 'generation' | 'manifest' | 'status' | 'verification' | 'test_result' | 'updated_at' | 'manifest_sha256'>
  & { adapter_submitted_at?: Date | null; certification?: Certification };
type Operation = 'create-package' | 'revise-package' | 'verify' | 'test' | 'submit' | 'submit-adapter' | 'suspend' | 'revoke';

const architectureLabels = { evm: 'EVM', svm: 'SVM', move: 'Move', cosmos: 'Cosmos', other: 'Other' };
const copy = {
  EN: {
    nav: ['Overview', 'My Integrations', 'Create Integration', 'Certification', 'Versions & Activity', 'Documentation / SDK'],
    title: 'FloFi Studio', description: 'Propose network, protocol and service integrations for FloFi.',
    empty: 'No integrations in this project yet.', newVersion: 'Create a new version', newVersionHelp: 'Changes are saved as a new version and have their own evidence.',
    overviewHelp: 'Create an integration package, verify its configuration and track its review.',
    categories: {
      network: ['Blockchain', 'Network identity and RPC compatibility'],
      vault: ['Vault', 'Asset deposits, shares and redemptions'],
      staking: ['Staking', 'Stake positions and rewards'],
      lending: ['Lending', 'Lending markets and position management'],
      dex: ['DEX', 'On-chain swaps and routes'],
      cex: ['CEX', 'User-scoped exchange reads'],
      service: ['Service', 'External services and APIs'],
    },
    other: 'Other architecture', adapter: 'Adapter', external: 'External adapter', builtin: 'Built-in verifier',
    adapterHelp: 'External adapters enter a source review queue. Provide the repository, exact commit and source SHA-256. Build and certification are separate stages.',
    builtinHelp: 'The built-in verifier checks the proposal using read-only RPC calls. FloFi review must confirm mainnet identity independently.',
    cexHelp: 'Exchange access is user-scoped. Keep credentials out of the package. Withdrawals are disabled.',
    steps: ['Category', 'Architecture', 'Configuration', 'Capabilities', 'Summary'], chooseCategory: 'Choose an integration category',
    chooseArchitecture: 'Choose the technology family', configure: 'Configure integration', capabilityTitle: 'Declare capabilities', reviewDraft: 'Review your draft',
    configuration: 'Integration configuration', back: 'Back', next: 'Continue', cancel: 'Cancel', draft: 'Save draft', savedDraft: 'Draft saved.',
    name: 'Integration name', slug: 'Integration slug', chain: 'CAIP-2 network ID', environment: 'Network environment',
    mainnet: 'Mainnet', testnet: 'Testnet', provider: 'Provider name', rpc: 'Public HTTPS endpoint',
    rpcHelp: 'Use an endpoint available without credentials. A submitted endpoint can be inspected during verification.',
    deployment: 'Contract or program identifier', contract: 'Vault contract address', asset: 'Underlying token contract',
    checkpoint: 'Checkpoint height (hex)', checkpointHash: 'Checkpoint hash', checkpointHelp: 'Use a network checkpoint published by an independent source.',
    repository: 'GitHub repository', commit: 'Commit SHA', digest: 'Source SHA-256', dependencies: 'Package dependencies (optional)',
    dependenciesHelp: 'One exact slug@version#digest reference per line.',
    declareHelp: 'Select the capabilities you are proposing. Only certified, published capabilities appear in the FloFi catalog.',
    verify: 'Verify', test: 'Test', submit: 'Submit for certification', submitAdapter: 'Submit adapter for review',
    suspend: 'Suspend version', revoke: 'Revoke version', confirmSuspend: 'Withdraw this version from review.',
    confirmRevoke: 'Permanently revoke this version.', evidence: 'Verification evidence', testEvidence: 'Test evidence',
    evidenceSource: 'Evidence source', proposalRpc: 'Proposed RPC', legacyRpc: 'Reviewed mainnet RPC', observed: 'Observed at',
    technical: 'Technical details', block: 'Observed block', manifestDigest: 'Package SHA-256', version: 'Version', historyDetails: 'Version details', activityEmpty: 'Version activity appears here after you save a draft.',
    working: 'Working…', saved: 'Changes saved.', unavailable: 'FloFi Studio is unavailable on this deployment.',
    project: 'This project is unavailable for changes.', listHelp: 'Open a version to run its next check, inspect evidence or see the available actions.',
    certHelp: 'Verification checks identity and configuration. Testing checks adapter compatibility. FloFi reviews submitted evidence before publication.',
    certEmpty: 'Integrations awaiting review and reviewed versions appear here.',
    visibility: 'Visibility', PUBLIC: 'Public', PRIVATE: 'Private', decisionReason: 'Review decision',
    pendingHelp: 'Evidence submitted for review. Publication requires a separate FloFi decision.',
    adapterPending: 'Adapter review pending', adapterPendingHelp: 'The exact source reference was submitted. Compatibility and financial execution await certification.',
    adapterProfileMissing: 'The canonical transfer adapter has no approved profile for this network.',
    testnetHelp: 'Studio can store a testnet proposal. The public FloFi catalog and built-in proposal checks are mainnet-only.',
    expired: 'Verification or test evidence expired. Verify again before submission, or create a new version if this one is already in review.',
    failed: 'FloFi Studio could not complete the request.', invalid: 'Check the integration fields and identifier formats.',
    duplicate: 'This slug is already used in the project.', changed: 'This version changed. Refresh the console and try again.',
    rate: 'Request limit reached. Try again later.', connector: 'This proposal has no compatible built-in verifier.',
    rpcError: 'The provider did not return a valid response. Check the endpoint and try again.',
    wrongChain: 'The RPC response did not match the configured chain or a current block.',
    wrongVault: 'The vault or underlying token did not match the configuration or ERC-4626 checks.',
    docsLead: 'Validate and normalize an integration package with the FloFi TypeScript SDK before submitting a version.',
    sdkGuide: 'TypeScript SDK guide', docsAdapter: 'Adapter submission',
    docsAdapterHelp: 'Use the Console to submit immutable source coordinates. Include a license, test fixtures, dependency lockfile and reproducible build instructions in your repository.',
    statuses: { DRAFT: 'Draft', VERIFIED: 'Verified', TESTED: 'Tested', CERTIFICATION_PENDING: 'Certification pending',
      CERTIFIED: 'Certified', PUBLISHED: 'Published', SUSPENDED: 'Suspended', REVOKED: 'Revoked', REJECTED: 'Rejected',
      VERIFICATION_FAILED: 'Verification failed', TEST_FAILED: 'Testing failed' },
    events: { CREATED: 'Draft created', VERIFIED: 'Identity verified', TESTED: 'Compatibility tested', SUBMITTED: 'Sent for certification',
      INVALIDATED: 'Evidence invalidated', SUSPENDED: 'Version suspended', REVOKED: 'Version revoked', ADAPTER_SUBMITTED: 'Adapter submitted',
      APPROVED: 'Review approved', REJECTED: 'Review rejected', PUBLISHED: 'Version published' },
    capabilities: {
      'network.read': 'Read network identity', 'transfer.native': 'Transfer native currency', 'transfer.token': 'Transfer tokens',
      'vault.read': 'Read vault positions and previews', 'vault.deposit': 'Deposit vault assets', 'vault.redeem': 'Redeem vault shares',
      'staking.read': 'Read stake positions', 'staking.manage': 'Manage stake', 'lending.read': 'Read lending positions',
      'lending.manage': 'Manage lending positions', swap: 'Swap assets', bridge: 'Bridge assets', 'cex.read': 'Read exchange holdings',
      'service.read': 'Read service data',
    },
  },
  PT: {
    nav: ['Visão geral', 'Minhas integrações', 'Criar integração', 'Certificação', 'Versões e atividade', 'Documentação / SDK'],
    title: 'FloFi Studio', description: 'Proponha integrações de redes, protocolos e serviços para a FloFi.',
    empty: 'Este projeto ainda não tem integrações.', newVersion: 'Criar nova versão', newVersionHelp: 'As alterações são salvas em uma nova versão, com evidências próprias.',
    overviewHelp: 'Crie um pacote de integração, verifique sua configuração e acompanhe a análise.',
    categories: {
      network: ['Blockchain', 'Identidade da rede e compatibilidade do RPC'],
      vault: ['Cofre', 'Depósitos de ativos, cotas e resgates'],
      staking: ['Staking', 'Posições em staking e recompensas'],
      lending: ['Empréstimos', 'Mercados de empréstimos e gestão de posições'],
      dex: ['DEX', 'Swaps e rotas on-chain'],
      cex: ['CEX', 'Consultas à corretora por usuário'],
      service: ['Serviço', 'Serviços externos e APIs'],
    },
    other: 'Outra arquitetura', adapter: 'Adaptador', external: 'Adaptador externo', builtin: 'Verificador integrado',
    adapterHelp: 'Adaptadores externos entram em análise de código. Informe o repositório, o commit exato e o SHA-256 do código-fonte. Build e certificação são etapas distintas.',
    builtinHelp: 'O verificador integrado consulta o RPC em modo somente leitura. A FloFi confirma a identidade da rede principal de forma independente durante a análise.',
    cexHelp: 'O acesso à corretora é individual. Mantenha credenciais fora do pacote. Saques ficam desabilitados.',
    steps: ['Categoria', 'Arquitetura', 'Configuração', 'Capacidades', 'Resumo'], chooseCategory: 'Escolha uma categoria de integração',
    chooseArchitecture: 'Escolha a família tecnológica', configure: 'Configure a integração', capabilityTitle: 'Declare as capacidades', reviewDraft: 'Revise o rascunho',
    configuration: 'Configuração da integração', back: 'Voltar', next: 'Continuar', cancel: 'Cancelar', draft: 'Salvar rascunho', savedDraft: 'Rascunho salvo.',
    name: 'Nome da integração', slug: 'Identificador da integração', chain: 'Identificador CAIP-2 da rede', environment: 'Ambiente da rede',
    mainnet: 'Rede principal', testnet: 'Rede de testes', provider: 'Nome do provedor', rpc: 'Endpoint HTTPS público',
    rpcHelp: 'Use um endpoint acessível sem credenciais. O endpoint informado pode ser inspecionado durante a verificação.',
    deployment: 'Identificador do contrato ou programa', contract: 'Endereço do contrato do cofre', asset: 'Contrato do token subjacente',
    checkpoint: 'Altura do checkpoint (hex)', checkpointHash: 'Hash do checkpoint', checkpointHelp: 'Use um checkpoint publicado por uma fonte independente.',
    repository: 'Repositório GitHub', commit: 'SHA do commit', digest: 'SHA-256 do código-fonte', dependencies: 'Dependências do pacote (opcional)',
    dependenciesHelp: 'Uma referência exata no formato identificador@versão#digest por linha.',
    declareHelp: 'Selecione as capacidades que você propõe. Apenas capacidades certificadas e publicadas aparecem no catálogo da FloFi.',
    verify: 'Verificar', test: 'Testar', submit: 'Enviar para certificação', submitAdapter: 'Enviar adaptador para análise',
    suspend: 'Suspender versão', revoke: 'Revogar versão', confirmSuspend: 'Retirar esta versão da análise.',
    confirmRevoke: 'Revogar esta versão permanentemente.', evidence: 'Evidência de verificação', testEvidence: 'Evidência de teste',
    evidenceSource: 'Origem da evidência', proposalRpc: 'RPC proposto', legacyRpc: 'RPC de rede principal revisado', observed: 'Registrada em',
    technical: 'Detalhes técnicos', block: 'Bloco observado', manifestDigest: 'SHA-256 do pacote', version: 'Versão', historyDetails: 'Detalhes da versão', activityEmpty: 'A atividade das versões aparece aqui depois que você salva um rascunho.',
    working: 'Processando…', saved: 'Alterações salvas.', unavailable: 'O FloFi Studio está indisponível neste ambiente.',
    project: 'Este projeto está indisponível para alterações.', listHelp: 'Abra uma versão para executar a próxima verificação, consultar evidências ou ver as ações disponíveis.',
    certHelp: 'A verificação confere identidade e configuração. O teste avalia a compatibilidade do adaptador. A FloFi analisa as evidências antes da publicação.',
    certEmpty: 'Integrações em análise e versões já analisadas aparecem aqui.',
    visibility: 'Visibilidade', PUBLIC: 'Pública', PRIVATE: 'Privada', decisionReason: 'Decisão da análise',
    pendingHelp: 'Evidências enviadas para análise. A publicação exige uma decisão da FloFi.',
    adapterPending: 'Análise do adaptador pendente', adapterPendingHelp: 'A referência exata do código-fonte foi enviada. Compatibilidade e execução financeira aguardam certificação.',
    adapterProfileMissing: 'O adaptador canônico de transferências ainda não tem um perfil aprovado para esta rede.',
    testnetHelp: 'O Studio pode salvar uma proposta para uma rede de testes. O catálogo público e as verificações integradas usam a rede principal.',
    expired: 'A evidência de verificação ou teste expirou. Verifique novamente antes de enviar ou crie uma nova versão se esta já estiver em análise.',
    failed: 'O FloFi Studio não conseguiu concluir a solicitação.', invalid: 'Confira os campos da integração e os formatos dos identificadores.',
    duplicate: 'Este identificador já está em uso no projeto.', changed: 'Esta versão mudou. Atualize o console e tente novamente.',
    rate: 'Limite de solicitações atingido. Tente novamente mais tarde.', connector: 'Esta proposta não tem um verificador integrado compatível.',
    rpcError: 'O provedor não retornou uma resposta válida. Confira o endpoint e tente novamente.',
    wrongChain: 'A resposta RPC divergiu da rede configurada ou de um bloco recente.',
    wrongVault: 'O cofre ou o token subjacente divergiu da configuração ou das verificações ERC-4626.',
    docsLead: 'Valide e normalize um pacote de integração com o SDK TypeScript da FloFi antes de enviar uma versão.',
    sdkGuide: 'Guia do SDK TypeScript', docsAdapter: 'Submissão de adaptadores',
    docsAdapterHelp: 'Use o Console para enviar referências imutáveis ao código-fonte. Inclua licença, dados de teste, lockfile e instruções de build reproduzível no repositório.',
    statuses: { DRAFT: 'Rascunho', VERIFIED: 'Verificada', TESTED: 'Testada', CERTIFICATION_PENDING: 'Certificação pendente',
      CERTIFIED: 'Certificada', PUBLISHED: 'Publicada', SUSPENDED: 'Suspensa', REVOKED: 'Revogada', REJECTED: 'Rejeitada',
      VERIFICATION_FAILED: 'Falha na verificação', TEST_FAILED: 'Falha nos testes' },
    events: { CREATED: 'Rascunho criado', VERIFIED: 'Identidade verificada', TESTED: 'Compatibilidade testada', SUBMITTED: 'Enviada para certificação',
      INVALIDATED: 'Evidência invalidada', SUSPENDED: 'Versão suspensa', REVOKED: 'Versão revogada', ADAPTER_SUBMITTED: 'Adaptador enviado',
      APPROVED: 'Análise aprovada', REJECTED: 'Análise rejeitada', PUBLISHED: 'Versão publicada' },
    capabilities: {
      'network.read': 'Consultar identidade da rede', 'transfer.native': 'Transferir moeda nativa', 'transfer.token': 'Transferir tokens',
      'vault.read': 'Consultar posições e prévias do cofre', 'vault.deposit': 'Depositar ativos no cofre', 'vault.redeem': 'Resgatar cotas do cofre',
      'staking.read': 'Consultar posições em staking', 'staking.manage': 'Gerenciar staking', 'lending.read': 'Consultar posições de empréstimo',
      'lending.manage': 'Gerenciar posições de empréstimo', swap: 'Trocar ativos', bridge: 'Mover ativos entre redes', 'cex.read': 'Consultar saldo na corretora',
      'service.read': 'Consultar dados do serviço',
    },
  },
} as const;

type Language = keyof typeof copy;
type Copy = (typeof copy)[Language];

function errorMessage(code: string, t: Copy) {
  if (code === 'PROJECT_NOT_ACTIVE') return t.project;
  if (code === 'CONSOLE_UNAVAILABLE') return t.unavailable;
  if (code === 'CONSOLE_RATE_LIMITED') return t.rate;
  if (code === 'STUDIO_MANIFEST_INVALID') return t.invalid;
  if (code === 'STUDIO_SLUG_EXISTS') return t.duplicate;
  if (code === 'STUDIO_VERSION_CHANGED' || code === 'STUDIO_VERSION_NOT_FOUND') return t.changed;
  if (code === 'STUDIO_EVIDENCE_EXPIRED') return t.expired;
  if (code === 'STUDIO_CONNECTOR_UNAVAILABLE' || code === 'STUDIO_NETWORK_UNSUPPORTED') return t.connector;
  if (code === 'STUDIO_RPC_UNAVAILABLE' || code === 'STUDIO_NETWORK_TEST_FAILED') return t.rpcError;
  if (code === 'STUDIO_CHAIN_MISMATCH' || code.startsWith('STUDIO_BLOCK_')) return t.wrongChain;
  if (code.startsWith('STUDIO_VAULT_')) return t.wrongVault;
  return t.failed;
}

function StudioForm({ t, projectId, version, operation, label, children, onSuccess, secondary, danger }: {
  t: Copy; projectId: string; version?: Version | undefined; operation: Operation; label: string; children?: ReactNode;
  onSuccess?: () => void; secondary?: ReactNode; danger?: boolean;
}) {
  const [result, action, pending] = useActionState(async (_previous: Awaited<ReturnType<typeof changeStudioIntegration>> | null, data: FormData) => {
    const response = await changeStudioIntegration(null, data);
    if (response.ok) onSuccess?.();
    return response;
  }, null);
  return <form action={action} className={styles.studioForm}>
    <input type="hidden" name="projectId" value={projectId}/>
    <input type="hidden" name="operation" value={operation}/>
    {version && <>
      <input type="hidden" name="slug" value={version.slug}/>
      <input type="hidden" name="version" value={version.version}/>
      <input type="hidden" name="generation" value={version.generation}/>
    </>}
    {children}
    {!pending && result && (result.ok
      ? <p className={styles.studioNotice} data-tone="success" role="status">{t.saved}</p>
      : <p className={styles.studioNotice} data-tone="danger" role="alert">{errorMessage(result.code, t)}</p>)}
    <div className={styles.studioActions}>
      {secondary}
      <button className={danger ? styles.studioDanger : styles.pillBlue} type="submit" disabled={pending}>
        {pending ? t.working : label}
      </button>
    </div>
  </form>;
}

function builtinAdapter(kind: IntegrationCategory, architecture: IntegrationArchitecture): BuiltinStudioAdapter | undefined {
  if (kind === 'vault' && architecture === 'evm') return 'erc4626-read';
  if (kind !== 'network') return undefined;
  if (architecture === 'evm') return 'evm-rpc';
  if (architecture === 'svm') return 'svm-rpc';
  if (architecture === 'cosmos') return 'cosmos-rpc';
  return undefined;
}

type Fields = {
  name: string; slug: string; chainRef: string; environment: 'mainnet' | 'testnet'; rpcUrl: string;
  height: string; hash: string; deploymentRef: string; asset: string; provider: string;
  repository: string; commit: string; sourceSha256: string; dependencies: string;
};

function initialFields(version?: Version): Fields {
  const manifest = version?.manifest;
  const current = manifest?.schemaVersion === 2 ? manifest : undefined;
  return {
    name: manifest?.name ?? '', slug: manifest?.slug ?? '', chainRef: manifest && 'chainRef' in manifest ? manifest.chainRef ?? '' : '',
    environment: current?.environment ?? 'mainnet', rpcUrl: current?.rpcUrl ?? '',
    height: current?.checkpoint?.height ?? '', hash: current?.checkpoint?.hash ?? '',
    deploymentRef: current?.deploymentRef ?? (manifest && 'contractAddress' in manifest ? manifest.contractAddress : ''),
    asset: current?.underlyingAsset ?? (manifest?.schemaVersion === 1 && manifest.kind === 'vault' ? manifest.underlyingAsset : ''),
    provider: current?.provider ?? (manifest && 'provider' in manifest ? manifest.provider ?? '' : ''),
    repository: current?.adapter.kind === 'external' ? current.adapter.repository : '',
    commit: current?.adapter.kind === 'external' ? current.adapter.commit : '',
    sourceSha256: current?.adapter.kind === 'external' ? current.adapter.sourceSha256 : '',
    dependencies: current?.dependencies.join('\n') ?? '',
  };
}

function StudioWizard({ t, projectId, version, onComplete, onCancel }: {
  t: Copy; projectId: string; version?: Version | undefined; onComplete: () => void; onCancel: () => void;
}) {
  const fieldHelpId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(version ? 1 : 0);
  const [kind, setKind] = useState<IntegrationCategory>(version?.manifest.kind ?? 'network');
  const [architecture, setArchitecture] = useState<IntegrationArchitecture>(
    version?.manifest.schemaVersion === 2 ? version.manifest.architecture : 'evm',
  );
  const [external, setExternal] = useState(version?.manifest.schemaVersion === 2 && version.manifest.adapter.kind === 'external');
  const [fields, setFields] = useState(() => initialFields(version));
  const [capabilities, setCapabilities] = useState<readonly IntegrationCapability[]>(
    version?.manifest.schemaVersion === 2 ? version.manifest.capabilities : [],
  );
  const [proposal, setProposal] = useState<IntegrationPackage>();
  const [error, setError] = useState(false);
  const labels = [t.chooseCategory, t.chooseArchitecture, t.configure, t.capabilityTitle, t.reviewDraft];
  const id = external ? undefined : builtinAdapter(kind, architecture);
  const needsCheckpoint = id === 'evm-rpc' || id === 'erc4626-read';
  const hasDeployment = kind === 'vault' || kind === 'staking' || kind === 'lending' || kind === 'dex';
  const onChain = kind !== 'cex' && (kind !== 'service' || fields.chainRef.trim() !== '');
  const change = (key: keyof Fields, value: string) => setFields(current => ({ ...current, [key]: value }));
  function go(next: number) {
    setError(false);
    setStep(next);
  }

  useEffect(() => { heading.current?.focus(); }, [step]);

  function next() {
    if (step !== 3) {
      go(step + 1);
      return;
    }
    try {
      const nextProposal = defineIntegrationPackage({
        schemaVersion: 2, kind, architecture, name: fields.name.trim(), slug: fields.slug.trim(),
        ...(onChain && { chainRef: fields.chainRef.trim(), environment: fields.environment }),
        ...(fields.rpcUrl.trim() && { rpcUrl: fields.rpcUrl.trim() }),
        ...(needsCheckpoint && { checkpoint: { height: fields.height.trim(), hash: fields.hash.trim() } }),
        ...(hasDeployment && { deploymentRef: fields.deploymentRef.trim() }),
        ...(id === 'erc4626-read' && { underlyingAsset: fields.asset.trim() }),
        ...((kind === 'cex' || kind === 'service') && { provider: fields.provider.trim() }),
        capabilities, dependencies: fields.dependencies.split('\n').map(line => line.trim()).filter(Boolean),
        adapter: id ? { kind: 'builtin', id, version: 1 } : {
          kind: 'external', repository: fields.repository.trim(), commit: fields.commit.trim(), sourceSha256: fields.sourceSha256.trim(), sdkVersion: 1,
        },
      });
      setProposal(nextProposal);
      go(4);
    } catch {
      setError(true);
    }
  }

  const back = <button type="button" className={styles.studioQuiet} onClick={() => go(step - 1)}>{t.back}</button>;
  return <div className={styles.studioWizard}>
    <ol className={styles.studioSteps}>
      {t.steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} data-complete={index < step}>
        <span aria-hidden="true">{index + 1}</span>{label}
      </li>)}
    </ol>
    <h5 ref={heading} tabIndex={-1}>{labels[step]}</h5>
    {step === 4 && proposal ? <>
      <ManifestSummary t={t} manifest={proposal}/>
      <StudioForm t={t} projectId={projectId} version={version} operation={version ? 'revise-package' : 'create-package'}
        label={t.draft} onSuccess={onComplete} secondary={back}>
        <input type="hidden" name="package" value={JSON.stringify(proposal)}/>
        {version && <p>{t.newVersionHelp}</p>}
      </StudioForm>
    </> : <form className={styles.studioForm} onSubmit={event => { event.preventDefault(); next(); }}>
      {step === 0 && <fieldset className={styles.studioChoices} aria-label={t.chooseCategory}>
        {INTEGRATION_CATEGORIES.map(category => <label key={category} className={styles.studioChoice}>
          <input name="category" type="radio" checked={category === kind} onChange={() => { setKind(category); setCapabilities([]); }}/>
          <span><strong>{t.categories[category][0]}</strong><small>{t.categories[category][1]}</small></span>
        </label>)}
      </fieldset>}
      {step === 1 && <>
        <fieldset className={styles.studioChoices} aria-label={t.chooseArchitecture}>
          {INTEGRATION_ARCHITECTURES.map(value => <label key={value} className={styles.studioChoice}>
            <input name="architecture" type="radio" checked={architecture === value} onChange={() => { setArchitecture(value); setExternal(false); }}/>
            <span><strong>{value === 'other' ? t.other : architectureLabels[value]}</strong></span>
          </label>)}
        </fieldset>
        {builtinAdapter(kind, architecture) && <label className={styles.consoleCheck}>
          <input type="checkbox" checked={external} onChange={event => setExternal(event.target.checked)}/>{t.external}
        </label>}
        <p className={styles.studioNotice}>{id ? t.builtinHelp : t.adapterHelp}</p>
      </>}
      {step === 2 && <div className={styles.studioFields}>
        <label>{t.name}<input required minLength={2} maxLength={80} value={fields.name} onChange={event => change('name', event.target.value)}/></label>
        <label>{t.slug}<input required pattern={String.raw`[a-z][a-z0-9\-]{1,49}`} maxLength={50} readOnly={Boolean(version)}
          className={styles.studioTechnical} spellCheck={false} value={fields.slug} onChange={event => change('slug', event.target.value)}/></label>
        {kind !== 'cex' && <label>{t.chain}<input required={kind !== 'service'} maxLength={41} spellCheck={false} placeholder="namespace:reference"
          className={styles.studioTechnical} value={fields.chainRef} onChange={event => change('chainRef', event.target.value)}/></label>}
        {onChain && <label>{t.environment}<select value={fields.environment}
          onChange={event => change('environment', event.target.value === 'testnet' ? 'testnet' : 'mainnet')}>
          <option value="mainnet">{t.mainnet}</option><option value="testnet">{t.testnet}</option>
        </select></label>}
        {(kind === 'cex' || kind === 'service') && <label>{t.provider}<input required minLength={2} maxLength={80}
          value={fields.provider} onChange={event => change('provider', event.target.value)}/></label>}
        {kind === 'cex' && <p className={styles.studioNotice}>{t.cexHelp}</p>}
        {hasDeployment && <label>{id === 'erc4626-read' ? t.contract : t.deployment}<input required maxLength={160} spellCheck={false}
          pattern={id === 'erc4626-read' ? '0x[0-9a-f]{40}' : undefined} className={styles.studioTechnical}
          value={fields.deploymentRef} onChange={event => change('deploymentRef', event.target.value)}/></label>}
        {id === 'erc4626-read' && <label>{t.asset}<input required pattern="0x[0-9a-f]{40}" maxLength={42} spellCheck={false}
          className={styles.studioTechnical} value={fields.asset} onChange={event => change('asset', event.target.value)}/></label>}
        <label className={styles.studioWide}>{t.rpc}<input type="url" required={Boolean(id)} maxLength={200} spellCheck={false}
          aria-describedby={fieldHelpId} className={styles.studioTechnical} value={fields.rpcUrl} onChange={event => change('rpcUrl', event.target.value)}/>
          <small id={fieldHelpId}>{t.rpcHelp}</small>
        </label>
        {needsCheckpoint && <>
          <label>{t.checkpoint}<input required placeholder="0x0" pattern="0x(0|[1-9a-f][0-9a-f]{0,63})" maxLength={66} spellCheck={false}
            className={styles.studioTechnical} value={fields.height} onChange={event => change('height', event.target.value)}/></label>
          <label>{t.checkpointHash}<input required pattern="0x[0-9a-f]{64}" maxLength={66} spellCheck={false}
            className={styles.studioTechnical} value={fields.hash} onChange={event => change('hash', event.target.value)}/></label>
          <p className={styles.studioFieldHelp}>{t.checkpointHelp}</p>
        </>}
        {!id && <>
          <label className={styles.studioWide}>{t.repository}<input required type="url" maxLength={160} spellCheck={false}
            className={styles.studioTechnical} value={fields.repository} onChange={event => change('repository', event.target.value)}/></label>
          <label>{t.commit}<input required pattern="[0-9a-f]{40}" maxLength={40} spellCheck={false}
            className={styles.studioTechnical} value={fields.commit} onChange={event => change('commit', event.target.value)}/></label>
          <label>{t.digest}<input required pattern="[0-9a-f]{64}" maxLength={64} spellCheck={false}
            className={styles.studioTechnical} value={fields.sourceSha256} onChange={event => change('sourceSha256', event.target.value)}/></label>
        </>}
      </div>}
      {step === 3 && <>
        <p>{t.declareHelp}</p>
        <fieldset className={styles.studioChoices} aria-label={t.capabilityTitle}>
          {INTEGRATION_CATEGORY_CAPABILITIES[kind].map(capability => <label key={capability} className={styles.studioChoice}>
            <input type="checkbox" checked={capabilities.includes(capability)} onChange={event => setCapabilities(current =>
              event.target.checked ? [...current, capability] : current.filter(item => item !== capability))}/>
            <span><strong>{t.capabilities[capability]}</strong><code>{capability}</code></span>
          </label>)}
        </fieldset>
        <label className={styles.studioField}>{t.dependencies}<textarea rows={2} maxLength={1850} spellCheck={false}
          className={styles.studioTechnical} value={fields.dependencies} onChange={event => change('dependencies', event.target.value)}/>
          <small>{t.dependenciesHelp}</small>
        </label>
      </>}
      {error && <p role="alert" data-tone="danger" className={styles.studioNotice}>{t.invalid}</p>}
      <div className={styles.studioActions}>
        {step > (version ? 1 : 0) ? back : <button type="button" className={styles.studioQuiet} onClick={onCancel}>{t.cancel}</button>}
        <button type="submit" className={styles.pillBlue} disabled={step === 3 && capabilities.length === 0}>{t.next}</button>
      </div>
    </form>}
  </div>;
}

function ManifestSummary({ t, manifest }: { t: Copy; manifest: Version['manifest'] }) {
  const current = manifest.schemaVersion === 2 ? manifest : undefined;
  const chain = 'chainRef' in manifest ? manifest.chainRef : undefined;
  const deployment = current?.deploymentRef ?? ('contractAddress' in manifest ? manifest.contractAddress : undefined);
  const underlying = current?.underlyingAsset ?? (manifest.schemaVersion === 1 && manifest.kind === 'vault' ? manifest.underlyingAsset : undefined);
  const provider = 'provider' in manifest ? manifest.provider : undefined;
  return <dl className={styles.studioFacts}>
    <div><dt>{t.name}</dt><dd>{manifest.name}</dd></div>
    <div><dt>{t.steps[0]}</dt><dd>{t.categories[manifest.kind][0]}</dd></div>
    {current && <div><dt>{t.steps[1]}</dt><dd>{current.architecture === 'other' ? t.other : architectureLabels[current.architecture]}</dd></div>}
    {chain && <div><dt>{t.chain}</dt><dd><code>{chain}</code>{current?.environment && <> · {t[current.environment]}</>}</dd></div>}
    {provider && <div><dt>{t.provider}</dt><dd>{provider}</dd></div>}
    {deployment && <div><dt>{t.deployment}</dt><dd><code>{deployment}</code></dd></div>}
    {underlying && <div><dt>{t.asset}</dt><dd><code>{underlying}</code></dd></div>}
    {current?.rpcUrl && <div><dt>{t.rpc}</dt><dd><code>{current.rpcUrl}</code></dd></div>}
    {current?.checkpoint && <div><dt>{t.checkpoint}</dt><dd><code>{current.checkpoint.height} · {current.checkpoint.hash}</code></dd></div>}
    {current && <div><dt>{t.adapter}</dt><dd>{current.adapter.kind === 'builtin'
      ? <code>{current.adapter.id}@{current.adapter.version}</code> : t.external}</dd></div>}
    {current?.adapter.kind === 'external' && <>
      <div><dt>{t.repository}</dt><dd><code>{current.adapter.repository}</code></dd></div>
      <div><dt>{t.commit}</dt><dd><code>{current.adapter.commit}</code></dd></div>
      <div><dt>{t.digest}</dt><dd><code>{current.adapter.sourceSha256}</code></dd></div>
    </>}
    {current && <div><dt>{t.steps[3]}</dt><dd>{current.capabilities.map(capability => t.capabilities[capability]).join(' · ')}</dd></div>}
    {current && current.dependencies.length > 0 && <div><dt>{t.dependencies}</dt><dd>
      {current.dependencies.map(dependency => <code key={dependency} className={styles.studioDependency}>{dependency}</code>)}
    </dd></div>}
  </dl>;
}

function dateLabel(value: string | Date, language: Language) {
  return new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(new Date(value)) + ' UTC';
}

function Evidence({ evidence, t, language }: {
  evidence: NonNullable<Version['verification']>; t: Copy; language: Language;
}) {
  return <details className={styles.studioDetails}>
    <summary>{evidence.mode === 'verify' ? t.evidence : t.testEvidence}</summary>
    <dl className={styles.studioFacts}>
      <div><dt>{t.evidenceSource}</dt><dd>{evidence.source === 'MAINNET_RPC' ? t.legacyRpc : t.proposalRpc}</dd></div>
      <div><dt>{t.observed}</dt><dd><time dateTime={evidence.observedAt}>{dateLabel(evidence.observedAt, language)}</time></dd></div>
      <div><dt>{t.chain}</dt><dd><code>{evidence.chainRef}</code></dd></div>
      <div><dt>{t.block}</dt><dd><code>{evidence.block.height}</code></dd></div>
      {evidence.schemaVersion === 2 && <div><dt>{t.adapter}</dt><dd><code>{evidence.adapterId}@{evidence.adapterVersion}</code></dd></div>}
    </dl>
    {evidence.facts.canonicalNativeTransferProfile === false && <p>{t.adapterProfileMissing}</p>}
    <details className={styles.studioDetails}>
      <summary>{t.technical}</summary>
      <pre className={styles.consoleOutput} tabIndex={0} aria-label={t.technical}>{JSON.stringify(evidence, null, 2)}</pre>
    </details>
  </details>;
}

function versionStatus(version: Version, t: Copy) {
  if (version.certification) return t.statuses[version.certification.status];
  if (version.status === 'DRAFT' && version.adapter_submitted_at) return t.adapterPending;
  if (version.status === 'VERIFIED' && version.test_result) return t.statuses.TESTED;
  return t.statuses[version.status];
}

function VersionCard({ version, t, language, projectId, active, now, onRevision }: {
  version: Version; t: Copy; language: Language; projectId: string; active: boolean; now: string; onRevision?: (() => void) | undefined;
}) {
  const { manifest, verification, test_result: test, certification } = version;
  const status = certification?.status ?? version.status;
  const fresh = (evidence: Version['verification']) => {
    const age = Date.parse(now) - Date.parse(evidence?.observedAt ?? '');
    return age >= 0 && age <= 86_400_000;
  };
  const scope = { t, projectId, version };
  const current = manifest.schemaVersion === 2 ? manifest : undefined;
  const external = current?.adapter.kind === 'external';
  const canRead = current ? current.adapter.kind === 'builtin' && current.environment === 'mainnet' :
    manifest.kind === 'network' || manifest.kind === 'vault';
  const canVerify = (status === 'DRAFT' || status === 'VERIFIED') && canRead;
  const canTest = status === 'VERIFIED' && canRead && fresh(verification);
  const canSubmit = canTest && fresh(test);
  const canRevoke = !certification && status !== 'REVOKED' && status !== 'CERTIFIED' && status !== 'PUBLISHED';
  const canSuspend = !certification && (status === 'VERIFIED' || status === 'CERTIFICATION_PENDING');
  const hasManagement = active && (canRevoke || canSuspend || onRevision);
  const chain = 'chainRef' in manifest && manifest.chainRef;
  return <article className={styles.studioCard}>
    <div className={styles.studioCardHead}>
      <div>
        <p>{t.categories[manifest.kind][0]} · {t.version} {version.version}</p>
        <h5>{manifest.name}</h5>
        <p><code>{version.slug}</code>{chain && <> · <code>{chain}</code></>}</p>
      </div>
      <span className={styles.studioBadge} data-status={version.adapter_submitted_at && status === 'DRAFT' ? 'CERTIFICATION_PENDING' : status}>
        {versionStatus(version, t)}
      </span>
    </div>
    {certification && <dl className={styles.studioFacts}>
      {certification.visibility && <div><dt>{t.visibility}</dt><dd>{t[certification.visibility]}</dd></div>}
      <div><dt>{t.decisionReason}</dt><dd>{certification.reason}</dd></div>
    </dl>}
    {status === 'CERTIFICATION_PENDING' && <p className={styles.studioNotice} data-tone="warning">{t.pendingHelp}</p>}
    {status === 'DRAFT' && external && <p className={styles.studioNotice} data-tone={version.adapter_submitted_at ? 'warning' : undefined}>
      {version.adapter_submitted_at ? t.adapterPendingHelp : t.adapterHelp}
    </p>}
    {current?.environment === 'testnet' && <p className={styles.studioNotice} data-tone="warning">{t.testnetHelp}</p>}
    {(status === 'VERIFIED' || status === 'CERTIFICATION_PENDING') && (!fresh(verification) || (test && !fresh(test)))
      && <p className={styles.studioNotice} data-tone="warning">{t.expired}</p>}
    <details className={styles.studioDetails}>
      <summary>{t.configuration}</summary>
      <ManifestSummary t={t} manifest={manifest}/>
      <dl className={styles.studioFacts}><div><dt>{t.manifestDigest}</dt><dd><code>{version.manifest_sha256}</code></dd></div></dl>
    </details>
    {verification && <Evidence t={t} evidence={verification} language={language}/>}
    {test && <Evidence t={t} evidence={test} language={language}/>}
    {active && <div className={styles.studioActions}>
      {canSubmit ? <StudioForm {...scope} operation="submit" label={t.submit}/>
        : canTest ? <StudioForm {...scope} operation="test" label={t.test}/>
        : canVerify ? <StudioForm {...scope} operation="verify" label={t.verify}/>
        : status === 'DRAFT' && external && !version.adapter_submitted_at
          ? <StudioForm {...scope} operation="submit-adapter" label={t.submitAdapter}/> : null}
    </div>}
    {hasManagement && <div className={styles.studioManage}>
      {onRevision && <button type="button" className={styles.studioQuiet} onClick={onRevision}>{t.newVersion}</button>}
      {canSuspend && <details className={styles.studioDetails}><summary>{t.suspend}</summary>
        <StudioForm {...scope} operation="suspend" label={t.suspend} danger>
          <label className={styles.consoleCheck}><input type="checkbox" name="confirm" required/>{t.confirmSuspend}</label>
        </StudioForm>
      </details>}
      {canRevoke && <details className={styles.studioDetails}><summary>{t.revoke}</summary>
        <StudioForm {...scope} operation="revoke" label={t.revoke} danger>
          <label className={styles.consoleCheck}><input type="checkbox" name="confirm" required/>{t.confirmRevoke}</label>
        </StudioForm>
      </details>}
    </div>}
  </article>;
}

export function DeveloperStudio({ language, projectId, active, versions, now, activity, certifications }: {
  language: Language; projectId: string; active: boolean; versions: readonly Version[] | null; now: string; activity?: readonly StudioActivity[]; certifications?: readonly Certification[];
}) {
  const t = copy[language];
  const [tab, setTab] = useState<Tab>('overview');
  const [revision, setRevision] = useState<Version>();
  const [saved, setSaved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef(false);
  const decisions = new Map(certifications?.map(decision => [`${decision.slug}:${decision.version}`, decision]));
  const history = (versions ?? []).map<Version>(version => {
    const certification = decisions.get(`${version.slug}:${version.version}`);
    return certification ? { ...version, certification } : version;
  });
  const groups = Map.groupBy(history, version => version.slug);
  const latest = [...groups.values()].flatMap(group => group[0] ?? []);
  const queue = history.filter(version => version.certification || version.adapter_submitted_at ||
    version.status === 'CERTIFICATION_PENDING' || version.status === 'CERTIFIED' || version.status === 'PUBLISHED' ||
    version.status === 'REVOKED' || version.status === 'SUSPENDED');
  const activeTab = tab === 'create' && !active ? 'overview' : tab;

  useEffect(() => {
    if (focus.current) heading.current?.focus();
  }, [activeTab]);

  function navigate(next: Tab) {
    focus.current = true;
    setRevision(undefined);
    setSaved(false);
    setTab(next);
  }

  const createButton = <button type="button" className={styles.pillBlue} onClick={() => navigate('create')}>{t.nav[2]}</button>;
  return <section className={styles.studio} aria-labelledby="developer-studio-title">
    <div className={styles.studioHeader}>
      <h3 id="developer-studio-title">{t.title}</h3>
      <p>{t.description}</p>
    </div>
    {versions === null ? <p className={styles.studioNotice} role="status">{t.unavailable}</p> : <div className={styles.studioLayout}>
      <nav className={styles.studioNav} aria-label={t.title}>
        {tabs.map((item, index) => (active || item !== 'create') && <button type="button" key={item}
          aria-current={activeTab === item ? 'page' : undefined} onClick={() => navigate(item)}>{t.nav[index]}</button>)}
      </nav>
      <div className={styles.studioPane}>
        <h4 tabIndex={-1} ref={heading}>{revision ? t.newVersion : t.nav[tabs.indexOf(activeTab)]}</h4>
        {saved && <p className={styles.studioNotice} data-tone="success" role="status">{t.savedDraft}</p>}
        {activeTab === 'overview' && <>
          <p>{t.overviewHelp}</p>
          <ul className={styles.studioStats}>
            <li><strong>{latest.length}</strong><span>{t.nav[1]}</span></li>
            <li><strong>{latest.filter(version => !version.certification && (version.status === 'CERTIFICATION_PENDING' ||
              (version.status === 'DRAFT' && version.adapter_submitted_at))).length}</strong><span>{t.statuses.CERTIFICATION_PENDING}</span></li>
            <li><strong>{history.filter(version => (version.certification?.status ?? version.status) === 'PUBLISHED').length}</strong><span>{t.statuses.PUBLISHED}</span></li>
          </ul>
          {active && createButton}
        </>}
        {activeTab === 'integrations' && <>
          <p>{latest.length ? t.listHelp : t.empty}</p>
          {!latest.length && active && createButton}
          {latest.map(version => <VersionCard key={version.slug} {...{ version, t, language, projectId, active, now }}
            onRevision={active ? () => {
              navigate('create');
              setRevision(version);
            } : undefined}/>)}
        </>}
        {activeTab === 'create' && <StudioWizard key={revision ? `${revision.slug}:${revision.version}` : projectId}
          t={t} projectId={projectId} version={revision} onCancel={() => navigate('integrations')} onComplete={() => {
            navigate('integrations');
            setSaved(true);
          }}/>}
        {activeTab === 'certification' && <>
          <p>{t.certHelp}</p>
          {!queue.length && <p className={styles.studioNotice}>{t.certEmpty}</p>}
          {queue.map(version => <VersionCard key={`${version.slug}:${version.version}`} {...{ version, t, language, projectId, now }}
            active={active && latest.includes(version)}/>)}
        </>}
        {activeTab === 'activity' && (history.length ? <>
          <ul className={styles.studioActivity}>
            {history.map(version => <li key={`${version.slug}:${version.version}`}>
              <div><strong>{version.manifest.name}</strong><span>{t.version} {version.version} · {versionStatus(version, t)}</span></div>
              <time dateTime={new Date(version.updated_at).toISOString()}>{dateLabel(version.updated_at, language)}</time>
              <details className={`${styles.studioDetails} ${styles.studioActivityDetails}`}>
                <summary>{t.historyDetails}</summary>
                <VersionCard {...{ version, t, language, projectId, now }} active={false}/>
              </details>
            </li>)}
          </ul>
          {activity?.length ? <ul className={styles.studioActivity}>
            {activity.map(event => <li key={`${event.slug}:${event.version}:${event.generation}`}>
              <div><strong>{event.event === 'SUBMITTED' && groups.get(event.slug)?.some(version =>
                version.version === event.version && version.adapter_submitted_at)
                ? t.events.ADAPTER_SUBMITTED : t.events[event.event as keyof Copy['events']] ?? event.event}</strong>
                <span><code>{event.slug}</code> · {t.version} {event.version}</span></div>
              <time dateTime={new Date(event.at).toISOString()}>{dateLabel(event.at, language)}</time>
            </li>)}
          </ul> : null}
        </> : <p>{t.activityEmpty}</p>)}
        {activeTab === 'docs' && <>
          <p>{t.docsLead} <code>defineIntegrationPackage</code></p>
          <Link href="/docs/typescript-sdk#studio-integration-packages">{t.sdkGuide}</Link>
          <h5>{t.docsAdapter}</h5>
          <p>{t.docsAdapterHelp}</p>
        </>}
      </div>
    </div>}
  </section>;
}
