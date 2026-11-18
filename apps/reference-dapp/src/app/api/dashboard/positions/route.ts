// SPDX-License-Identifier: AGPL-3.0-only

import { positionsWalletKey, type PositionWallet } from '../../../../domain/defi-positions';
import { readWalletPositions } from '../../../../server/defi-positions';
import { withFlightAccess } from '../../../../server/flight-access';
import { accountWalletPrincipals } from '../../../../server/history-principals';
import { currentWalletPrincipals } from '../../../../server/session-principal';
import { portfolioAccounts } from '../../../../server/wallet-portfolio';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
const refuse = (code: string, status: number) => Response.json({ ok: false, code }, { status, headers });

/** Discovery returns only this session's linked or proven wallets. A requested account is always re-checked before the wallet cache is read. */
export async function GET(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return refuse('POSITION_CROSS_ORIGIN_REFUSED', 403);
  if (new URL(request.url).search) return refuse('POSITION_REQUEST_INVALID', 400);
  const address = request.headers.get('x-flofi-account');
  let expected: PositionWallet | null = null;
  if (address !== null) {
    try {
      const account = portfolioAccounts(address.startsWith('0x') ? { evm: address } : { solana: address })[0]!;
      expected = { namespace: account.ecosystem === 'evm' ? 'eip155' : 'solana', address: account.address };
    } catch {
      return refuse('POSITION_REQUEST_INVALID', 400);
    }
  }

  try {
    return await withFlightAccess(async () => {
      const [linked, proven] = await Promise.all([accountWalletPrincipals(), currentWalletPrincipals()]);
      const wallets = new Map([...proven, ...linked].map(wallet => [positionsWalletKey(wallet), wallet]));
      if (!expected) return Response.json({ ok: true, value: [...wallets.values()] }, { headers });
      if (!wallets.has(positionsWalletKey(expected))) return refuse('POSITION_WALLET_UNVERIFIED', 403);
      return Response.json({ ok: true, value: await readWalletPositions(expected) }, { headers });
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'POSITION_SCAN_BUSY') return refuse(code, 429);
    if (/^BETA_[A-Z_]+$/.test(code)) return refuse(code, 403);
    return refuse('POSITION_SCAN_UNAVAILABLE', 503);
  }
}
