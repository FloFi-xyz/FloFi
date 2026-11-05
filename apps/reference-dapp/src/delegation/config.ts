// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: delegated-execution configuration — server-only, fail closed. Any malformed value disables the feature; nothing
 * falls back to another mode, transport or signer.
 *
 *   FLOFI_DELEGATION                 enabled | disabled (default): passkeys, execution Credentials and DELEGATED_WITH_LIMITS automations
 *                                    (owner operations; they authorize nothing without an executor)
 *   FLOFI_DELEGATION_HARNESS         MOCKED_LOOPBACK_ONLY: every chain is the loopback chain double at FLOFI_DELEGATION_HARNESS_URL (tests and
 *                                    local rehearsals only; refused on a hosted deployment). Without it: production mode.
 *   FLOFI_DELEGATION_HARNESS_URL     http://127.0.0.1:<port> (loopback only)
 *   FLOFI_DELEGATION_RPC_<chainId>   per EVM chain read/submit JSON-RPC in production mode (https; e.g. FLOFI_DELEGATION_RPC_84532)
 *   FLOFI_PASSKEY_ORIGIN             the origin passkeys are registered for and assert (default FLOFI_PUBLIC_ORIGIN); its host is the RP id
 *   FLOFI_DELEGATED_SIGNER           none (default) | aws-kms | local-disposable | memory — the session-signer provider of this process.
 *                                    `aws-kms` (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001) is the production provider: a non-exportable
 *                                    ECC_SECG_P256K1 key in AWS KMS, never with a harness. `memory` and `local-disposable` are refused on
 *                                    hosted deployments. Without a signer, delegated signing is DELEGATED_SIGNER_UNAVAILABLE.
 *   FLOFI_KMS_REGION                 aws-kms only: the key's AWS region (e.g. us-east-1)
 *   FLOFI_KMS_EVM_KEY_ARN            aws-kms only: the key ARN or alias ARN (arn:aws:kms:<region>:<account>:key/<id> | alias/<name>) of
 *                                    the deployment's executor key; its region must equal FLOFI_KMS_REGION. The standard AWS_ACCESS_KEY_ID /
 *                                    AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) secrets must be present; their values are never read here.
 *   FLOFI_DELEGATED_SIGNER_DIR       local-disposable only: an absolute directory below /tmp
 *   FLOFI_DELEGATED_EXECUTION        enabled: this process runs the delegated executor (needs a signer provider)
 *   FLOFI_DELEGATION_MAINNET_CHAINS  BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: comma-separated public mainnets on which delegated templates may
 *                                    run (`eip155:1`, `eip155:8453`, `eip155:42161`: Ethereum, Base, Arbitrum One). Unset (default): every mainnet step stays
 *                                    MAINNET_DELEGATION_DISABLED. It is the only way delegation is enabled in the public Mainnet-only product,
 *                                    where it never enables a harness, and signing there still needs a production signer provider.
 */
import { isHostedDeployment, publicOrigin, deploymentTenant } from '../server/deployment.ts';
import { networkScope } from '../server/network-scope.ts';
import type { CapabilityMode } from './capabilities.ts';
import { MAINNET_DELEGATION_CHAINS } from './profiles.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type SignerChoice = { readonly kind: 'none' } | { readonly kind: 'memory' } | { readonly kind: 'local-disposable'; readonly directory: string }
  | { readonly kind: 'aws-kms'; readonly region: string; readonly evmKeyArn: string };
const KMS_KEY_ARN = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):(?:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|alias\/[A-Za-z0-9/_-]{1,250})$/;
export type DelegationConfig = {
  readonly enabled: true; readonly tenantId: string; readonly mode: CapabilityMode; readonly harnessUrl: string | null;
  readonly rpc: Readonly<Record<string, string>>; readonly passkeyOrigin: string; readonly signer: SignerChoice; readonly executor: boolean; readonly hosted: boolean;
  /** Public mainnets opted into delegated execution (FLOFI_DELEGATION_MAINNET_CHAINS); empty: none. */
  readonly mainnetChains: readonly string[];
};
export type DelegationConfigResult = DelegationConfig | { readonly enabled: false; readonly code: 'DELEGATION_NOT_ENABLED' | 'DELEGATION_CONFIGURATION_INVALID'; readonly reason?: string };
const invalid = (reason: string) => ({ enabled: false, code: 'DELEGATION_CONFIGURATION_INVALID', reason } as const);
const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{3,4}$/;

export function readDelegationConfig(env: Env): DelegationConfigResult {
  const flag = env.FLOFI_DELEGATION ?? 'disabled';
  if (flag === 'disabled' || flag === '') return { enabled: false, code: 'DELEGATION_NOT_ENABLED' };
  if (flag !== 'enabled') return invalid('FLOFI_DELEGATION');
  // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the public mainnets explicitly opted into delegated templates (fail closed on anything else).
  const mainnetChains = (env.FLOFI_DELEGATION_MAINNET_CHAINS ?? '').split(',').map(chain => chain.trim()).filter(Boolean);
  if (mainnetChains.some(chain => !MAINNET_DELEGATION_CHAINS.includes(chain)) || new Set(mainnetChains).size !== mainnetChains.length) return invalid('FLOFI_DELEGATION_MAINNET_CHAINS');
  // BUILD-FLOFI-MAINNET-PRODUCT-001: delegated execution exists only on test networks (mainnet delegation is disabled and production custody
  // does not exist), so the Mainnet-only public product has none; engineering certification keeps it. A deployment that explicitly opts a
  // mainnet into delegated templates (above) gets delegation in the public product too, never with a harness.
  if (networkScope(env) !== 'ENGINEERING' && !mainnetChains.length) return { enabled: false, code: 'DELEGATION_NOT_ENABLED', reason: 'MAINNET_ONLY_PRODUCT' };
  const hosted = isHostedDeployment(env);
  const harness = env.FLOFI_DELEGATION_HARNESS;
  if (networkScope(env) !== 'ENGINEERING' && harness) return invalid('FLOFI_DELEGATION_HARNESS_PUBLIC_PRODUCT');
  if (mainnetChains.length && harness) return invalid('FLOFI_DELEGATION_HARNESS_WITH_MAINNET');
  if (harness !== undefined && harness !== '' && harness !== 'MOCKED_LOOPBACK_ONLY') return invalid('FLOFI_DELEGATION_HARNESS');
  const mocked = harness === 'MOCKED_LOOPBACK_ONLY';
  if (mocked && hosted) return invalid('FLOFI_DELEGATION_HARNESS_HOSTED');
  const harnessUrl = mocked ? env.FLOFI_DELEGATION_HARNESS_URL ?? '' : null;
  if (mocked && !LOOPBACK_URL.test(harnessUrl!)) return invalid('FLOFI_DELEGATION_HARNESS_URL');
  const rpc: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^FLOFI_DELEGATION_RPC_([1-9][0-9]{0,18})$/.exec(key);
    if (!match || !value) continue;
    try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) return invalid(key); rpc[`eip155:${match[1]}`] = url.toString(); }
    catch { return invalid(key); }
  }
  let passkeyOrigin: string;
  try {
    passkeyOrigin = new URL(env.FLOFI_PASSKEY_ORIGIN || publicOrigin(env) || '').origin;
    if (hosted && !passkeyOrigin.startsWith('https://')) return invalid('FLOFI_PASSKEY_ORIGIN');
  } catch { return invalid('FLOFI_PASSKEY_ORIGIN'); }
  const signerKind = env.FLOFI_DELEGATED_SIGNER ?? 'none';
  let signer: SignerChoice;
  if (signerKind === 'none' || signerKind === '') signer = { kind: 'none' };
  else if (signerKind === 'memory' || signerKind === 'local-disposable') {
    // Neither is production custody: refused wherever real users could rely on it.
    if (hosted) return invalid('FLOFI_DELEGATED_SIGNER_HOSTED');
    if (signerKind === 'memory') signer = { kind: 'memory' };
    else {
      const directory = env.FLOFI_DELEGATED_SIGNER_DIR ?? '';
      if (!directory.startsWith('/tmp/') || directory.includes('..')) return invalid('FLOFI_DELEGATED_SIGNER_DIR');
      signer = { kind: 'local-disposable', directory };
    }
  } else if (signerKind === 'aws-kms') {
    // Production custody: never together with a harness, the key ARN bound to its region, and the AWS credential secrets present.
    if (mocked) return invalid('FLOFI_DELEGATED_SIGNER_WITH_HARNESS');
    const region = env.FLOFI_KMS_REGION ?? '', evmKeyArn = env.FLOFI_KMS_EVM_KEY_ARN ?? '', arn = KMS_KEY_ARN.exec(evmKeyArn);
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) return invalid('FLOFI_KMS_REGION');
    if (!arn || arn[1] !== region) return invalid('FLOFI_KMS_EVM_KEY_ARN');
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return invalid('AWS_CREDENTIALS_MISSING');
    signer = { kind: 'aws-kms', region, evmKeyArn };
  } else return invalid('FLOFI_DELEGATED_SIGNER');
  const executor = env.FLOFI_DELEGATED_EXECUTION === 'enabled';
  if (env.FLOFI_DELEGATED_EXECUTION && !['enabled', 'disabled'].includes(env.FLOFI_DELEGATED_EXECUTION)) return invalid('FLOFI_DELEGATED_EXECUTION');
  if (executor && signer.kind === 'none') return invalid('FLOFI_DELEGATED_EXECUTION_WITHOUT_SIGNER');
  let tenantId: string;
  try { tenantId = deploymentTenant(env); } catch { return invalid('TENANT_ID'); }
  return { enabled: true, tenantId, mode: mocked ? 'MOCKED_HARNESS' : 'PRODUCTION', harnessUrl, rpc, passkeyOrigin, signer, executor, hosted, mainnetChains };
}
/**
 * Why delegated execution cannot run on this deployment (null: it can). A hosted deployment signs only with the AWS KMS provider; a local
 * deployment may rehearse with a disposable signer. Each step still needs a step driver for its chain and mode.
 */
export function executionAvailability(config: DelegationConfig): string | null {
  return config.signer.kind === 'none' ? 'DELEGATED_SIGNER_UNAVAILABLE' : null;
}
