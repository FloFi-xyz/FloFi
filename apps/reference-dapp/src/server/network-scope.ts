// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the deployment's network scope (`domain/network-scope.ts`). Every deployment is the public, Mainnet-only
 * product. Test networks stay reachable only for isolated CI, QA and engineering certification: a local (never hosted) server that sets
 * `FLOFI_NETWORK_SCOPE=ENGINEERING_TESTNETS`. A hosted deployment (Vercel, Railway, `FLOFI_DEPLOYMENT=hosted`) ignores the variable, so no
 * production, preview or development deployment can expose a test network, whatever its configuration says.
 */
import { isHostedDeployment } from './deployment.ts';
import type { NetworkScope } from '../domain/network-scope';

type Env = Readonly<Record<string, string | undefined>>;
export const ENGINEERING_TESTNETS = 'ENGINEERING_TESTNETS';
export function networkScope(env: Env = process.env): NetworkScope {
  return !isHostedDeployment(env) && env.FLOFI_NETWORK_SCOPE === ENGINEERING_TESTNETS ? 'ENGINEERING' : 'PUBLIC_MAINNET';
}
