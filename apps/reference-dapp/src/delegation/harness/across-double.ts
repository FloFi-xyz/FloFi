// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1) test double: the Across Swap API (`/swap/approval`) and deposit status for ONE certified router profile, answered in process and
 * normalized by the Router's own provider adapter (`server/router-providers.ts` normalizeAcrossRoute: calldata decoded and cross-checked), so the
 * user-funded batch accepts exactly what the Router would. Paired with the EVM double's Across SpokePool model (`evm-double.ts`, `across`) on
 * both chains, whose runtime code the pins below name. MOCKED and in-process only: no endpoint, no network, no key.
 */
import { createHash } from 'node:crypto';
import type { RouterProfile } from '@defi-workflow-engine/action-registry';
import { encodeAcrossDeposit } from '@defi-workflow-engine/reference-compiler';
import type { CanonicalRoute } from '@defi-workflow-engine/workflow-contracts';
import { normalizeAcrossRoute, type RouteRequest, type TransferHint } from '../../server/router-providers.ts';
import type { AcrossRoute } from '../../user-funded/bridge-calls.ts';

/** The runtime code the EVM double serves at a modelled SpokePool, and at any modelled token (`0x6080`). */
export const ACROSS_DOUBLE_SPOKE_CODE = '0x60806040a5a5', ACROSS_DOUBLE_TOKEN_CODE = '0x6080';
const sha = (code: string) => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
/** The pins of the doubles' code (MOCKED only: a public deployment always verifies the profile's own pins). */
export const ACROSS_DOUBLE_PINS: RouterProfile['codeSha256'] = Object.freeze({ baseSpokePool: sha(ACROSS_DOUBLE_SPOKE_CODE), baseUsdc: sha(ACROSS_DOUBLE_TOKEN_CODE),
  arbitrumSpokePool: sha(ACROSS_DOUBLE_SPOKE_CODE), arbitrumUsdc: sha(ACROSS_DOUBLE_TOKEN_CODE), baseLifiDiamond: '', baseLifiFeeForwarder: '' });
const ZERO = '0x' + '0'.repeat(40);

export type AcrossDoubleControls = {
  /** Relayer capital + destination gas fee (source units) charged on every quote (default 1,000 + 7,777). */
  fee: bigint;
  /** Seconds from the quote time to the fill deadline (default 7,200) and to the quote's expiry (default 3,400). */
  fillDeadlineSeconds: number; expirySeconds: number;
  /** Forge the next quote: another recipient in the calldata, an exclusivity window past the fill deadline, the provider down. */
  forge: 'NONE' | 'RECIPIENT' | 'EXCLUSIVITY' | 'DOWN';
  /** The deposit status the provider reports per source transaction (a hint only; e.g. a refund to verify). */
  status: Map<string, TransferHint>;
  quotes: number;
};
/** An in-process Across route for `profile`: quotes from the clock (unix seconds), normalized exactly as the Router's adapter does. */
export function acrossDouble(profile: RouterProfile, clock: () => number): { readonly route: AcrossRoute; readonly controls: AcrossDoubleControls } {
  const SRC = profile.source, DST = profile.destination;
  const controls: AcrossDoubleControls = { fee: 8_777n, fillDeadlineSeconds: 7_200, expirySeconds: 3_400, forge: 'NONE', status: new Map(), quotes: 0 };
  const t = (chainId: number, address: string) => ({ decimals: chainId === SRC.chainId ? SRC.decimals : DST.decimals, symbol: SRC.symbol, address, name: SRC.symbol, chainId });
  const quote = async (request: RouteRequest): Promise<CanonicalRoute> => {
    if (controls.forge === 'DOWN') throw new Error('ROUTER_PROVIDER_HTTP_503');
    controls.quotes++;
    const amount = BigInt(request.amount), time = clock(), output = amount - controls.fee;
    const recipient = controls.forge === 'RECIPIENT' ? '0x' + '66'.repeat(20) : request.recipient.toLowerCase();
    const exclusivityParameter = controls.forge === 'EXCLUSIVITY' ? time + controls.fillDeadlineSeconds + 60 : 0;
    const data = encodeAcrossDeposit({ depositor: request.owner.toLowerCase(), recipient, inputToken: SRC.token, outputToken: DST.token, inputAmount: amount, outputAmount: output,
      destinationChainId: BigInt(DST.chainId), exclusiveRelayer: ZERO, quoteTimestamp: time, fillDeadline: time + controls.fillDeadlineSeconds, exclusivityParameter,
      message: '0x', trailer: '0x73c0de' });
    const amt = (value: bigint) => ({ amount: value.toString(), token: t(SRC.chainId, SRC.token) });
    const capital = controls.fee > 7_777n ? controls.fee - 7_777n : 0n, gas = controls.fee - capital;
    const raw = { crossSwapType: 'bridgeableToBridgeable', amountType: 'exactInput',
      checks: { allowance: { token: SRC.token, spender: SRC.spokePool, actual: '0', expected: amount.toString() }, balance: { token: SRC.token, actual: '0', expected: amount.toString() } },
      steps: { bridge: { inputAmount: amount.toString(), outputAmount: output.toString(), tokenIn: t(SRC.chainId, SRC.token), tokenOut: t(DST.chainId, DST.token),
        fees: { ...amt(controls.fee), details: { type: 'across', relayerCapital: amt(capital), destinationGas: amt(gas), lp: amt(0n) } }, provider: 'across' } },
      inputToken: t(SRC.chainId, SRC.token), outputToken: t(DST.chainId, DST.token), refundToken: t(SRC.chainId, SRC.token),
      fees: { total: amt(controls.fee) }, inputAmount: amount.toString(), maxInputAmount: amount.toString(), expectedOutputAmount: output.toString(),
      minOutputAmount: output.toString(), expectedFillTime: 2, swapTx: { ecosystem: 'evm', simulationSuccess: false, chainId: SRC.chainId, to: SRC.spokePool, data, gas: '0' },
      quoteExpiryTimestamp: time + controls.expirySeconds, id: `mock-${controls.quotes}` };
    // The Router's own adapter: a recipient other than the one asked fails ACROSS_CALLDATA_MISMATCH right here, exactly as on a real answer.
    return normalizeAcrossRoute(raw, { ...request, nowMs: time * 1000 }, profile);
  };
  const status = async (hash: string): Promise<TransferHint> => controls.status.get(hash.toLowerCase())
    ?? { source: 'across.deposit-status', status: 'PENDING', destinationTxHash: null, refundTxHash: null, rawHash: '0x' + '0'.repeat(64) };
  return { route: { profile, pins: ACROSS_DOUBLE_PINS, quote, status }, controls };
}
