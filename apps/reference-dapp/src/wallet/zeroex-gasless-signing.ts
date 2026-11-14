// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): the browser side of a reviewed 0x Gasless swap. Before the owner's wallet is asked,
 * the page re-checks that the typed data the server handed back is exactly what the owner reviewed (same content, EIP-712 digest recomputed
 * here, the reviewed owner and manifest); then it asks for `eth_signTypedData_v4`, one prompt per payload, approval first. A signature only
 * goes back to FloFi's server, which verifies it again and relays it to 0x once. Nothing here talks to 0x or holds a key.
 */
import { eip712 } from '@defi-workflow-engine/reference-compiler';
import type { PublicGaslessBegin, PublicQuote } from '../server/public-testnet-service';
import type { EvmProvider } from './evm-discovery';

const fail = (code: string): never => { throw new Error(code); };
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;
const content = (data: eip712.TypedData) => JSON.stringify(sorted({ ...data, types: Object.fromEntries(Object.entries(data.types).filter(([name]) => name !== 'EIP712Domain')) }));
const sameTyped = (a: eip712.TypedData, b: eip712.TypedData, hash: string) => {
  try { return content(a) === content(b) && eip712.hashTypedData(a) === hash; } catch { return false; }
};
/** Whether the begun gasless request is exactly the reviewed one: the attempt binds this Review and owner, each payload equals the reviewed one. */
export function gaslessRequestMatches(quote: PublicQuote, begun: PublicGaslessBegin, account: string): boolean {
  const binding = quote.gas?.mechanism === 'ZEROX_GASLESS_SWAP' ? quote.gas.zeroEx : null;
  if (!binding) return false;
  const owner = account.toLowerCase(), attempt = begun.attempt;
  if (attempt.executionId !== quote.executionId || attempt.manifestHash !== quote.manifestHash || attempt.account !== owner || binding.taker !== owner ||
      attempt.tradeHash !== binding.trade.hash || attempt.approvalHash !== (binding.approval?.hash ?? null)) return false;
  if (!sameTyped(begun.trade, binding.trade.eip712, binding.trade.hash)) return false;
  return binding.approval ? begun.approval !== null && sameTyped(begun.approval, binding.approval.eip712, binding.approval.hash) : begun.approval === null;
}
/** The payload as wallets expect it for `eth_signTypedData_v4`: `types` declare `EIP712Domain` (derived from the domain when 0x omitted it). */
export function walletTypedData(data: eip712.TypedData): eip712.TypedData {
  return data.types.EIP712Domain ? data : { ...data, types: { EIP712Domain: eip712.domainFields(data.domain), ...data.types } };
}
/** One `eth_signTypedData_v4` prompt for `account`; the answer must be a 65-byte signature by that account of exactly this digest. */
export async function signGaslessTypedData(provider: EvmProvider, account: string, data: eip712.TypedData): Promise<string> {
  const answer = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(walletTypedData(data))] });
  const signature = typeof answer === 'string' ? answer.toLowerCase() : '';
  if (!/^0x[0-9a-f]{130}$/.test(signature)) fail('ZEROX_SIGNATURE_INVALID');
  let signer: string;
  try { signer = eip712.recoverTypedDataSigner(eip712.hashTypedData(data), signature); } catch { return fail('ZEROX_SIGNATURE_INVALID'); }
  if (signer !== account.toLowerCase()) fail('ZEROX_SIGNER_MISMATCH');
  return signature;
}
