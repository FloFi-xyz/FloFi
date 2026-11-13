// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 (ADR-0009): `/api/gas/paymaster/<chainId>` — FloFi's ERC-7677 paymaster proxy (see `src/gas-sponsorship/http.ts`).
 * Disabled unless the operator configured network-fee sponsorship for that chain.
 */
import { handlePaymasterHttp } from '../../../../../gas-sponsorship/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const POST = (request: Request) => handlePaymasterHttp(request);
export const OPTIONS = (request: Request) => handlePaymasterHttp(request);
