// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: which approvals a conversation can have signed natively (the owner's Phantom or Solflare app, through its
 * official encrypted deeplinks, with the Review in the conversation): one step on a flow that asks the owner's wallet for exactly one signature over
 * FloFi's exact reviewed Solana transaction and then broadcasts those verified bytes itself. Every other plan keeps FloFi's signing page.
 */
import type { HandoffRecord } from './handoff-store.ts';

export const NATIVE_SIGNING_FLOWS = Object.freeze(['solana-transfer', 'solana-devnet-transfer', 'jupiter-swap'] as const);
export type NativeSigningFlow = (typeof NATIVE_SIGNING_FLOWS)[number];
export const NATIVE_SIGNING_WALLETS = Object.freeze(['phantom', 'solflare'] as const);
export type NativeSigningWallet = (typeof NATIVE_SIGNING_WALLETS)[number];
export const isNativeSigningFlow = (flow: unknown): flow is NativeSigningFlow => (NATIVE_SIGNING_FLOWS as readonly unknown[]).includes(flow);
export const nativeSigningEligible = (h: Pick<HandoffRecord, 'plan'>): boolean => h.plan.kind === 'SINGLE_FLOW' && isNativeSigningFlow(h.plan.flow);
