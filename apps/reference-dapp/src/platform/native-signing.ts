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
/** The platform execution-log namespace of native signing sessions (one journal per session, named `<approval>.nsg_<id>.jsonl`). */
export const NATIVE_SIGNING_NAMESPACE = 'native-signing';
/** The log-name prefix of one approval's native signing sessions. */
export const nativeSessionPrefix = (handoffId: string) => `${handoffId}.nsg_`;
/** The deployment's kill switch: on when `FLOFI_NATIVE_SIGNING` is unset or `enabled`; any other value (a typo included) turns it off (fail closed). */
export const nativeSigningSwitch = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.FLOFI_NATIVE_SIGNING === undefined || env.FLOFI_NATIVE_SIGNING === '' || env.FLOFI_NATIVE_SIGNING === 'enabled';
