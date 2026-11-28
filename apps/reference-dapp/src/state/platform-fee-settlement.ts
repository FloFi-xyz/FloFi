// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * The owner's payment of the FloFi platform fee of one completed execution. The server opens the collection attempt and composes one reviewed
 * transfer per fee asset (`platformFeeSettle`); each transfer is then signed by the owner's wallet through the EXISTING transfer actions with the
 * same safety checks as the transfer stores (session account and chain equal the reviewed ones, the nonce pre-check, FloFi Wallet binding).
 * A request that may have reached the network is reported UNKNOWN and never resent. Afterwards the ledger status is read (bounded) until it is
 * COLLECTED or COLLECTION_FAILED. FloFi never signs, and nothing here runs without the owner pressing Pay.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { platformFeeSettle, platformFeeStatus, type PlatformFeeStatus, type PlatformFeeTransfer } from '../app/platform-fee-action';
import { transferBegin, transferHandoff, transferReport, transferStatus, transferWalletFailure } from '../app/robinhood-transfer-action';
import { solanaTransferBegin, solanaTransferStatus, solanaTransferSubmit, solanaTransferWalletFailure } from '../app/solana-transfer-action';
import type { TransferWalletDiagnostic } from '../server/robinhood-transfer-service';
import { injected, useOptionalBuild009Wallet } from './build009-wallet-store';
import { useOptionalJupiter } from './jupiter-store';
import { signWithSolanaWallet, type SolanaSession } from '../wallet/solana-wallet';
import { bindFloFiSigning } from '../wallet/flofi-wallet-channel';
import { signingContextOf } from '../wallet/flofi-signing';
import { observeWalletNonce, reviewNonceRefusal } from '../domain/wallet-nonce';
import type { PlatformFeeExecution } from '../domain/platform-fee-execution';

const REFUSALS = [4001, 4100, 4200];
type Result<T> = { ok: true; value: T } | { ok: false; code: string };
const unwrap = <T,>(result: Result<T>): T => { if (!result.ok) throw new Error(result.code); return result.value; };
type EvmWallet = { session(): Promise<{ account: string; chainId: string } | null>; connect(): Promise<{ account: string; chainId: string } | null> };

function errorValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 512) : value ?? null;
  const v = value as { code?: unknown; message?: unknown };
  return { code: typeof v.code === 'number' || typeof v.code === 'string' ? v.code : null, message: typeof v.message === 'string' ? v.message.slice(0, 512) : null };
}
const quantity = (value: unknown): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return BigInt(value);
  throw new Error('TRANSFER_WALLET_NONCE_RESPONSE_INVALID');
};

/** Signs and reports ONE settlement transfer on an EVM chain. Resolves once the hash is reported; throws a closed code otherwise. */
export async function payEvmTransfer(wallet: EvmWallet, transfer: PlatformFeeTransfer): Promise<void> {
  const workflow = transfer.workflow as SemanticWorkflow | undefined;
  const record = unwrap(await transferStatus(transfer.runId));
  // An attempt that already began is only observed (by the server's reconciliation); it is never begun or sent again from here.
  if (record.attempt) return;
  if (!workflow) throw new Error('PLATFORM_FEE_TRANSFER_WORKFLOW_UNAVAILABLE');
  if (record.authorization !== record.review.commitment) throw new Error('TRANSFER_REVIEW_REQUIRED');
  let session = await wallet.session(); if (!session) session = await wallet.connect();
  if (!session) throw new Error('TRANSFER_WALLET_REQUIRED');
  const reviewedChain = record.review.transaction.chainId.toLowerCase();
  if (session.chainId !== reviewedChain || BigInt(reviewedChain) !== BigInt(transfer.chainId.split(':')[1] ?? '-1')) throw new Error('TRANSFER_WRONG_CHAIN');
  if (session.account !== record.review.account) throw new Error('TRANSFER_WRONG_ACCOUNT');
  const provider = injected(); if (!provider) throw new Error('TRANSFER_WALLET_REQUIRED');
  const diagnostic: TransferWalletDiagnostic = { invoked: false, calls: [], code: 'TRANSFER_WALLET_PREFLIGHT' };
  const request = async (method: string, params: unknown[] = []) => {
    const call: TransferWalletDiagnostic['calls'][number] = { method, ...method === 'eth_sendTransaction' ? { submission: true } : {} }; diagnostic.calls.push(call);
    try { const result = await provider.request({ method, ...params.length ? { params } : {} }); call.result = typeof result === 'string' ? result.slice(0, 200) : null; return result; }
    catch (cause) { call.error = errorValue(cause); throw cause; }
  };
  const validateSession = async () => {
    const accounts = await request('eth_accounts'), chain = await request('eth_chainId'), pending = await request('eth_getTransactionCount', [session.account, 'pending']);
    if (injected() !== provider) throw new Error('TRANSFER_WALLET_PROVIDER_CHANGED');
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== session.account) throw new Error('TRANSFER_WRONG_ACCOUNT');
    if (typeof chain !== 'string' || chain.toLowerCase() !== reviewedChain) throw new Error('TRANSFER_WRONG_CHAIN');
    let first: unknown = '0x' + quantity(pending).toString(16);
    const evidence = await observeWalletNonce({ reviewed: BigInt(record.review.nonce), read: async () => { if (first !== undefined) { const value = first; first = undefined; return value; }
      return request('eth_getTransactionCount', [session.account, 'pending']); }, stillCurrent: async () => {
      if (injected() !== provider) throw new Error('TRANSFER_WALLET_PROVIDER_CHANGED');
      const again = await request('eth_accounts'), chainAgain = await request('eth_chainId');
      if (!Array.isArray(again) || typeof again[0] !== 'string' || again[0].toLowerCase() !== session.account) throw new Error('TRANSFER_WRONG_ACCOUNT');
      if (typeof chainAgain !== 'string' || chainAgain.toLowerCase() !== reviewedChain) throw new Error('TRANSFER_WRONG_CHAIN'); } });
    const refusal = reviewNonceRefusal('TRANSFER', evidence, 'RESPONSE_INVALID'); if (refusal) throw new Error(refusal);
  };
  let prepared = false;
  try {
    await validateSession();
    const begin = unwrap(await transferBegin(record.id, session.account, workflow)); prepared = true;
    await validateSession();
    unwrap(await transferHandoff(record.id));
    // As the transfer store: the session and provider are re-checked after the handoff, so a change is a refusal, never an unknown outcome.
    await validateSession();
    diagnostic.invoked = true;
    const { from, to, value, data, chainId, gas, maxFeePerGas, maxPriorityFeePerGas } = begin.transaction;
    bindFloFiSigning(provider, signingContextOf(record.id, transfer.flow));
    const hash = await request('eth_sendTransaction', [{ from, to, value, data, chainId, gas, maxFeePerGas, maxPriorityFeePerGas }]);
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('TRANSFER_SUBMISSION_UNKNOWN');
    unwrap(await transferReport(record.id, { kind: 'HASH', hash: hash.toLowerCase() }));
  } catch (cause) {
    const send = diagnostic.calls.find(c => c.submission), sendError = send?.error as { code?: unknown } | undefined;
    const refused = Boolean(send) && send!.result === undefined && typeof sendError?.code === 'number' && REFUSALS.includes(sendError.code);
    if (refused) diagnostic.rejectionCode = sendError!.code as number;
    diagnostic.code = refused ? 'TRANSFER_REJECTED' : !diagnostic.invoked ? (cause instanceof Error && /^TRANSFER_[A-Z0-9_]+$/.test(cause.message) ? cause.message : 'TRANSFER_RPC_ERROR_BEFORE_WALLET_SUBMISSION') : 'TRANSFER_SUBMISSION_UNKNOWN';
    if (prepared && (!diagnostic.invoked || refused)) {
      await transferWalletFailure(record.id, diagnostic);
      throw new Error(diagnostic.code, { cause });
    }
    if (diagnostic.invoked) {
      // The request may have reached the network: never resend, only report it unknown.
      await transferReport(record.id, { kind: 'UNKNOWN', code: diagnostic.code });
      throw new Error('TRANSFER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', { cause });
    }
    throw cause;
  }
}

const walletCode = (cause: unknown): string => {
  const value = cause as { code?: unknown; name?: unknown; message?: unknown } | null;
  return value && (value.code === 4001 || /reject|declin|denied|cancel/i.test(String(value.name ?? '') + String(value.message ?? ''))) ? 'SOLANA_TRANSFER_WALLET_REJECTED' : 'SOLANA_TRANSFER_WALLET_SIGN_FAILED';
};
/** Signs and submits ONE settlement transfer on Solana mainnet-beta. */
export async function paySolanaTransfer(session: SolanaSession | null, transfer: PlatformFeeTransfer): Promise<void> {
  const workflow = transfer.workflow as SemanticWorkflow | undefined;
  const record = unwrap(await solanaTransferStatus('mainnet', transfer.runId));
  if (record.attempt) return;
  if (!workflow) throw new Error('PLATFORM_FEE_TRANSFER_WORKFLOW_UNAVAILABLE');
  if (record.authorization !== record.review.commitment) throw new Error('SOLANA_TRANSFER_REVIEW_REQUIRED');
  if (!session || session.chain !== 'solana:mainnet') throw new Error('SOLANA_TRANSFER_WRONG_CLUSTER');
  if (session.account.address !== record.review.owner) throw new Error('SOLANA_TRANSFER_WRONG_OWNER');
  const begin = unwrap(await solanaTransferBegin('mainnet', record.id, session.account.address, workflow));
  let signed: string;
  try {
    if (begin.walletChain !== session.chain) throw new Error('SOLANA_TRANSFER_WRONG_CLUSTER');
    bindFloFiSigning(session.wallet, signingContextOf(record.id, 'solana-transfer'));
    signed = await signWithSolanaWallet(session, begin.unsignedTransaction, 'SOLANA_TRANSFER');
  } catch (cause) {
    const failure = cause instanceof Error && /^SOLANA_TRANSFER_[A-Z_]+$/.test(cause.message) ? cause.message : walletCode(cause);
    const bounded = { name: String((cause as { name?: unknown })?.name ?? ''), code: typeof (cause as { code?: unknown })?.code === 'number' ? (cause as { code: number }).code : null,
      message: String((cause as { message?: unknown })?.message ?? cause).slice(0, 500) };
    await solanaTransferWalletFailure('mainnet', record.id, { stage: 'SIGN', code: failure, error: bounded });
    throw new Error(failure, { cause });
  }
  const submitted = unwrap(await solanaTransferSubmit('mainnet', record.id, signed)) as { notSubmitted?: boolean; verdict?: string; error?: string | null };
  // Accepted by the API but not executed (changed bytes, expired Review, fee payer refusal): said, never shown as paid.
  if (submitted.notSubmitted === true || submitted.verdict === 'NOT_EXECUTED') throw new Error(submitted.error && /^[A-Z][A-Z0-9_]{2,80}$/.test(submitted.error) ? submitted.error : 'SOLANA_TRANSFER_NOT_EXECUTED');
}

export type PlatformFeeSettlement = {
  readonly status: PlatformFeeStatus | null; readonly busy: boolean; readonly error: string | null; pay(): Promise<void>;
};
const FINAL = ['COLLECTED', 'COLLECTION_FAILED'];
/** `options`: the bounded read-only follow after payment (tests shorten it). */
export function usePlatformFeeSettlement(execution: PlatformFeeExecution | null, options: { readonly pollMs?: number; readonly maxPolls?: number } = {}): PlatformFeeSettlement {
  const wallet = useOptionalBuild009Wallet(), jupiter = useOptionalJupiter();
  const [status, setStatus] = useState<PlatformFeeStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), busyRef = useRef(false), latest = useRef({ wallet, jupiter }); latest.current = { wallet, jupiter };
  const key = execution ? JSON.stringify(execution) : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = useCallback(async (): Promise<PlatformFeeStatus | null> => {
    if (!key) return null;
    let result = await platformFeeStatus(JSON.parse(key)).catch(() => null);
    if (result && !result.ok && result.code === 'PLATFORM_FEE_EXECUTION_NOT_FOUND') result = await platformFeeStatus(JSON.parse(key), 'solana').catch(() => null);
    const value = result?.ok ? result.value : null;
    if (value && mounted.current) setStatus(value);
    return value;
  }, [key]);
  useEffect(() => { setStatus(null); void read(); }, [read]);
  const pay = useCallback(async () => {
    if (!key || busyRef.current) return; busyRef.current = true; setBusy(true); setError(null);
    try {
      const ref = JSON.parse(key) as PlatformFeeExecution;
      let opened = await platformFeeSettle(ref);
      // A Solana execution, or a workflow paid from the other namespace's wallet: the same request as the Solana session.
      if (!opened.ok && (opened.code === 'PLATFORM_FEE_SETTLEMENT_OTHER_WALLET' || opened.code === 'PLATFORM_FEE_EXECUTION_NOT_FOUND')) opened = await platformFeeSettle(ref, 'solana');
      const settlement = unwrap(opened);
      for (const transfer of settlement.transfers) {
        if (transfer.chainId.startsWith('solana:')) await paySolanaTransfer(latest.current.jupiter?.session ?? null, transfer);
        else if (latest.current.wallet) await payEvmTransfer(latest.current.wallet, transfer);
        else throw new Error('TRANSFER_WALLET_REQUIRED');
      }
      const polls = Math.max(1, options.maxPolls ?? 30);
      for (let i = 0; i < polls && mounted.current; i++) {
        const value = await read();
        if (value?.ledger && FINAL.includes(value.ledger.state)) break;
        if (i < polls - 1) await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 4000));
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'PLATFORM_FEE_PAYMENT_FAILED');
      await read();
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }, [key, read, options.maxPolls, options.pollMs]);
  return { status, busy, error, pay };
}
