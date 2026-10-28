// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import type { ExecutionEvidence } from '../domain/execution-evidence';
import type { BridgeStage } from '../domain/bridge-progress';
import { NetworkBrandIcon } from './brand-icon';
import { ExecutionIdentifier } from './execution-identifier';
import { executionExplorer } from '../domain/execution-lifecycle';
import { shellChainLabel } from '../domain/product-shell';

export function BridgeTimeline({ stages, local = false, evidence }: { stages: BridgeStage[]; local?: boolean; evidence?: ExecutionEvidence | undefined }) {
  const { t } = useLocale();
  const current = stages.find(stage => !['Confirmed', 'Submitted'].includes(stage.status));
  return <section className="bridge-progression" aria-label={t('Bridge progress')}>
    <h3>{t('Bridge progress')}</h3>
    <ol>{stages.map(stage => <li key={stage.id} data-status={stage.status} aria-current={current?.id === stage.id ? 'step' : undefined}>
      <span className="bridge-stage-marker" aria-hidden="true">{stage.status === 'Confirmed' ? '✓' : stage.status === 'Failed with evidence' ? '!' : '○'}</span>
      <div><div className="bridge-stage-heading"><strong>{t(stage.label)}</strong><span>{t(stage.status)}</span></div>
        {stage.chain && <small className="bridge-stage-network"><NetworkBrandIcon network={shellChainLabel(stage.chain)}/>{shellChainLabel(stage.chain)}</small>}
        {stage.note && <p>{t(stage.note)}</p>}
        {(stage.id === 'authorization' || stage.id === 'submission') && evidence?.operations[stage.id === 'authorization' ? 'APPROVAL' : 'DEPOSIT']?.fees.map((fee, index) => <p key={index}>{t(fee.label)} · {fee.value}</p>)}
        {stage.id === 'authorization' && evidence?.operations.APPROVAL?.values.map((value, index) => <p key={index}>{t(value.label)} · {t(value.value)}</p>)}
        {stage.hash && <details><summary>{t('View transaction evidence')}</summary><ExecutionIdentifier identifier={{ label: stage.label, value: stage.hash, kind: 'transaction', explorer: stage.chain ? executionExplorer(stage.chain, stage.hash, local) : null }}/></details>}
      </div>
    </li>)}</ol>
  </section>;
}
