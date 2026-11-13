// SPDX-License-Identifier: AGPL-3.0-only
/** Product projections of existing records. No quoting, fee aggregation or execution decisions. */
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { useSupply } from '../state/supply-store';
import type { useLending } from '../state/lending-store';
import type { useRouter } from '../state/router-store';
import type { useUniversalRouter } from '../state/universal-router-store';
import type { usePublicTestnet } from '../state/public-testnet-store';
import type { useJupiter } from '../state/jupiter-store';
import type { useSolanaLiquidity } from '../state/solana-liquidity-store';
import type { useSolanaComposition } from '../state/solana-composition-store';
import type { useUniswapLiquidity } from '../state/uniswap-liquidity-store';
import type { useRobinhoodTransfer } from '../state/robinhood-transfer-store';
import type { useSolanaTransfer } from '../state/solana-transfer-store';
import type { useModeA } from '../state/mode-a-store';
import type { useModeB } from '../state/mode-b-store';
import type { useComposition } from '../state/composition-store';
import type { useLiquidity } from '../state/liquidity-store';
import type { useAcross } from '../state/across-store';
import type { Workflow } from './initial-workflow';
import { composerActions, composerSummary } from './composer-presentation';
import { boundRecipientOwned } from './destination-wallet';
import { quoteDecimals } from './public-testnet-swap';
import { resolveNetworkAsset } from './asset-catalogs';
import { flofiFeeAmount } from '../server/universal-router/fee-obligation.ts';
import { floFiWalletMessage } from '../wallet/flofi-signing';
import { flightRefusalMessage, flightRefusalTitleOf } from './flight-refusal';
import { gaslessUnavailableReason, INCLUDED_NETWORK_FEE_LABEL, SIGNATURES_LABEL, ZEROX_FEE_LABEL } from './gas-payment';

/** 0.1% of the route input, for Review disclosure (obligation; not collected here). */
const flofiFeeUnits = (inputAmount: string): string => flofiFeeAmount(inputAmount);

type Snapshot<T> = Pick<T, Extract<keyof T, 'record' | 'run' | 'prepared' | 'status' | 'info' | 'retired' | 'recoveryOnly' | 'busy' | 'error' | 'available' | 'verifyError' | 'verified' | 'quoteExpired'>>;
export type SimulationSource =
  | { kind: 'supply'; state: Snapshot<ReturnType<typeof useSupply>> }
  | { kind: 'lending'; state: Snapshot<ReturnType<typeof useLending>> }
  | { kind: 'router'; state: Snapshot<ReturnType<typeof useRouter>> }
  | { kind: 'universal'; state: Snapshot<ReturnType<typeof useUniversalRouter>> }
  | { kind: 'public'; state: Snapshot<ReturnType<typeof usePublicTestnet>> }
  | { kind: 'solana-swap'; state: Snapshot<ReturnType<typeof useJupiter>> }
  | { kind: 'solana-pool'; state: Snapshot<ReturnType<typeof useSolanaLiquidity>> }
  | { kind: 'solana-composition'; state: Snapshot<ReturnType<typeof useSolanaComposition>> }
  | { kind: 'uniswap-pool'; state: Snapshot<ReturnType<typeof useUniswapLiquidity>> }
  | { kind: 'transfer'; state: Snapshot<ReturnType<typeof useRobinhoodTransfer>> }
  | { kind: 'solana-transfer'; state: Snapshot<ReturnType<typeof useSolanaTransfer>> }
  | { kind: 'fork-swap'; state: Snapshot<ReturnType<typeof useModeA>> }
  | { kind: 'delegated-swap'; state: Snapshot<ReturnType<typeof useModeB>> }
  | { kind: 'composition'; state: Snapshot<ReturnType<typeof useComposition>> }
  | { kind: 'fork-pool'; state: Snapshot<ReturnType<typeof useLiquidity>> }
  | { kind: 'across'; state: Snapshot<ReturnType<typeof useAcross>> }
  | { kind: 'unavailable'; state: { error: string | null; busy: boolean | string | null } };
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: how a cost line counts. `ADDITIONAL`: an estimate paid on top of the input; `CEILING`: a maximum (never also an
 * estimate); `INCLUDED`: already deducted from the quoted output (never paid again); `COMPONENT`: one part of an included total (informative);
 * `OBLIGATION`: FloFi's fee as recorded (not collected on-chain). Totals add only ADDITIONAL lines of one asset; nothing else is ever summed.
 */
export type FeeTreatment = 'ADDITIONAL' | 'CEILING' | 'INCLUDED' | 'COMPONENT' | 'OBLIGATION';
export type SimulationLine = { label: string; value: string; note?: string; treatment?: FeeTreatment };
/** BUILD-FLOFI-MAINNET-EXEC-002: `technical` marks an evidence-limit caveat (what a simulation cannot prove) shown under Technical details in the
 * compact chat Review; permission, recipient, cost and risk warnings never carry it and stay visible. */
export type SimulationWarning = { severity: 'info' | 'attention' | 'blocking'; message: string; technical?: true };
export type SimulationStep = {
  id: string; number: number; action: string; input: string; networks: string[]; pair: string | null;
  result: string | null; resultLabel: string; provider: string | null; minimum: string | null;
  configuredSlippage: string | null; slippage: string | null; priceImpact: string | null; details: SimulationLine[];
  /** BUILD-FLOFI-MAINNET-EXEC-002: the full destination address the reviewed step pays (bridges and transfers); absent elsewhere. */
  destination?: string | null;
  /** Review round 2: the destination is one of the owner's own wallets (bound by the Review as such), not an address typed for someone else. */
  destinationOwned?: boolean;
};
export type SimulationPresentation = {
  status: 'ready' | 'attention' | 'blocked'; message: string; expiresAt: number | null;
  steps: SimulationStep[]; fees: SimulationLine[]; warnings: SimulationWarning[];
};

/** Labels and visual emphasis only. The existing projection remains the readiness source. */
export function simulationStatusPresentation(view: SimulationPresentation, invalidWorkflow = false, busy?: boolean | string | null) {
  if (invalidWorkflow) return { label: 'Check workflow', message: 'Check the workflow configuration on the Canvas before continuing.', tone: 'blocked' };
  // P0: a Flight Beta refusal is named ("Wallet not linked to your FloFi account"), never shown as a failed simulation.
  const flight = flightRefusalTitleOf(view.message);
  if (flight) return { label: flight, message: view.message, tone: 'blocked' };
  if (!view.steps.length && view.status !== 'blocked') return { label: 'No workflow', message: 'Create a workflow in the Editor first.', tone: 'neutral' };
  if (view.message === 'Updating the simulation…') return { label: typeof busy === 'string' && /review/i.test(busy) ? 'Preparing authorization…' : 'Simulating workflow…', message: 'Checking the current workflow before continuing.', tone: 'neutral' };
  if (view.message === 'Run a simulation to see the expected result.') return { label: 'No simulation yet', message: 'Run a simulation to see expected execution.', tone: 'neutral' };
  if (/expired/i.test(view.message)) return { label: 'Simulation expired', message: 'Simulate again to refresh the result before authorization.', tone: 'blocked' };
  if (/changed/i.test(view.message)) return { label: 'Review required again', message: view.message, tone: 'blocked' };
  if (/balance.*low|Add funds for the network fee/i.test(view.message)) return { label: 'Insufficient balance', message: view.message, tone: 'blocked' };
  if (/Simulation is (?:currently unavailable|not available)/i.test(view.message)) return { label: 'Simulation unavailable', message: view.message, tone: 'blocked' };
  if (/could not complete this simulation|rejected this transaction in simulation/i.test(view.message)) return { label: 'Simulation failed', message: view.message, tone: 'blocked' };
  if (/Connect the wallet that will sign/i.test(view.message)) return { label: 'Connect your wallet', message: view.message, tone: 'blocked' };
  if (/destination address|token details do not match|token feature FloFi cannot verify|Check the amount/i.test(view.message)) return { label: 'Check the workflow', message: view.message, tone: 'blocked' };
  if (/route is not available/i.test(view.message)) return { label: 'Route unavailable', message: view.message, tone: 'blocked' };
  if (/below the bridge provider’s minimum/.test(view.message)) return { label: 'Below the provider minimum', message: view.message, tone: 'blocked' };
  if (/No bridge route that FloFi can verify and execute/.test(view.message)) return { label: 'No executable bridge route', message: view.message, tone: 'blocked' };
  if (/does not have enough liquidity/.test(view.message)) return { label: 'Liquidity unavailable', message: view.message, tone: 'blocked' };
  return { label: view.status === 'ready' ? 'Ready' : view.status === 'blocked' ? 'Cannot proceed' : 'Needs attention', message: view.message, tone: view.status };
}

/** Preserve token precision and very small fees; unknown and invalid quantities stay absent. */
export function simulationAmount(units: string | null | undefined, decimals: number, symbol = ''): string | null {
  if (typeof units !== 'string' || !/^(0|[1-9][0-9]*)$/.test(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const padded = units.padStart(decimals + 1, '0');
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''}${symbol ? ` ${symbol}` : ''}`;
}
const bps = (value: number) => Number.isSafeInteger(value) && value >= 0 ? `${(value / 100).toFixed(2)}%` : null;
/** Jupiter stores a fraction; Orca stores a percentage. Shift decimal digits without rounding to zero. */
export function simulationPriceImpact(value: string, fractional: boolean): string | null {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const digits = `${whole}${fraction.padEnd(2, '0')}`;
  const scaled = fractional ? simulationAmount(digits.replace(/^0+(?=\d)/, ''), Math.max(0, fraction.length - 2)) : value.replace(/^-/, '');
  return scaled === null ? null : `${negative ? '-' : ''}${scaled}%`;
}
const providerNames: Record<string, string> = {
  lifi: 'LI.FI', 'lifi.rest': 'LI.FI', across: 'Across', 'across.direct': 'Across',
  'across-v3': 'Across', ACROSS: 'Across', UNISWAP_V3: 'Uniswap V3', 'uniswap-v3': 'Uniswap V3',
  'Uniswap V3': 'Uniswap V3', 'Orca Whirlpools': 'Orca Whirlpools', 'Orca Whirlpool': 'Orca Whirlpools', Orca: 'Orca',
  Raydium: 'Raydium', 'Raydium CLMM': 'Raydium CLMM', Meteora: 'Meteora', 'Meteora DLMM': 'Meteora DLMM', Phoenix: 'Phoenix', Lifinity: 'Lifinity',
};
export const simulationProvider = (id: string) => providerNames[id] ?? null;
/** Only known error meanings reach the primary UI; never echo provider responses or validation paths. */
/** Why a bridge was re-quoted in place, said once: the original refusal's reason, then what the owner does now. */
export function requotedMessage(code: string): string {
  if (/L1_FEES_CHANGED|FEES_CHANGED|GAS_CHANGED/.test(code)) return 'The network fee moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.';
  if (/REVIEW_EXPIRED|QUOTE_EXPIRED/.test(code)) return 'Your Review expired before the wallet request, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.';
  return 'The quote moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.';
}
/** ADR-0010 §4: what the owner does when the network fee cannot be paid in USDC/USDT through Pimlico's Kora fee payer (closed `KORA_*` codes). */
function koraMessage(error: string): string | null {
  if (error === 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED') return 'How the network fee is paid changed since your Review, so nothing was sent. Review it again.';
  if (error === 'KORA_FEE_TOKEN_BALANCE_INSUFFICIENT') return 'Your wallet has too little SOL for the network fee and too little USDC or USDT to pay it instead. Add SOL, USDC or USDT, then simulate again.';
  if (error === 'KORA_PAYMENT_INSUFFICIENT') return 'The network fee in USDC or USDT rose before your transaction was sent, so nothing was sent. Simulate again to review the new fee.';
  if (error === 'KORA_OPERATION_UNSUPPORTED') return 'This step cannot pay its network fee in USDC or USDT. Add SOL for the network fee, then simulate again.';
  if (/^KORA_(PROVIDER_UNAVAILABLE|UNREACHABLE|RATE_LIMITED|ERROR_UNKNOWN|RESPONSE_INVALID)$/.test(error))
    return 'Paying the network fee in USDC or USDT is unavailable right now, so nothing was sent. Try again later, or add SOL for the network fee.';
  if (/^KORA_(NOT_ENABLED|CONFIGURATION_INVALID|SIGNER_MISMATCH)$/.test(error))
    return 'Paying the network fee in USDC or USDT is not available right now, so nothing was sent. Add SOL for the network fee, then simulate again.';
  return 'The network fee could not be paid in USDC or USDT for this step, so nothing was sent. Add SOL for the network fee, then simulate again.';
}
export function simulationError(error: string): string {
  // P0 (owner test 2026-11-12): a Flight Beta refusal (e.g. BETA_WALLET_NOT_LINKED) says what to do; it used to fall through to "Simulation failed".
  const flight = flightRefusalMessage(error);
  if (flight) return flight;
  // BUILD-FLOFI-E2E-RELIABILITY-001: FloFi Wallet (Privy) refusals keep their own sentence, as on the Canvas.
  const floFiWallet = /^FLOFI_WALLET_/.test(error) ? floFiWalletMessage(error) : null;
  if (floFiWallet) return floFiWallet;
  // ADR-0010 §4: paying the Solana network fee in USDC/USDT through Pimlico (only offered when the wallet's SOL cannot pay it).
  const kora = /^KORA_/.test(error) || error === 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED' ? koraMessage(error) : null;
  if (kora) return kora;
  // BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a 0x Gasless swap's own refusals and outcomes (a changed mechanism is worded above).
  if (error === 'TOKEN_GAS_MECHANISM_MISMATCH') return 'How the network fee is paid changed since your Review (your ETH balance moved), so nothing was signed or sent. Review the updated swap.';
  if (/^ZEROX_(?:SIGNER_MISMATCH|SIGNATURE_INVALID|SIGNATURE_REFUSED)$/.test(error)) return 'The signature did not match the reviewed swap, so nothing was submitted. Authorize again with the reviewed wallet.';
  if (/^ZEROX_(?:OWNER_NOT_EOA|SMART_WALLET_NOT_SUPPORTED)$/.test(error)) return 'Paying the network fee in tokens needs a standard wallet account, and this one is a smart account. Add ETH for the network fee instead. Nothing was signed.';
  if (/^ZEROX_(?:TRADE_REVERTED|TRADE_FAILED|TRADE_SIMULATION_FAILED|TRADE_NOT_EXECUTED|MARKET_MAKER_DECLINED|TRADE_REFUSED|APPROVAL_REFUSED|PENDING_TRADE_EXISTS)$/.test(error)) return 'The swap through 0x did not go through, and none of your tokens moved. Simulate again for a fresh quote.';
  if (/^ZEROX_TRADE_ALREADY_CLAIMED$/.test(error)) return 'This signed swap is already handled by another FloFi execution, which keeps tracking it. Simulate again for a fresh, separate swap.';
  if (/^ZEROX_PROVIDER_/.test(error)) return 'The 0x service did not answer, so nothing was signed or submitted. Try again shortly.';
  if (error === 'GASLESS_SIGNATURE_NOT_RECEIVED') return 'Your wallet did not return the signatures, so nothing was submitted. Authorize again when ready.';
  // P0 (2026-11-12): a provider's liquidity and minimum answers before the balance rules (`RELAY_INSUFFICIENT_LIQUIDITY` read "your balance is too
  // low", `RELAY_AMOUNT_TOO_LOW` the generic failure), bridge provider codes only (a lending BORROW_/WITHDRAW_INSUFFICIENT_LIQUIDITY keeps its own
  // wording below). Only refusals before this step was prepared: delivery outcomes such as
  // ROUTER_FILL_BELOW_MINIMUM / UNIVERSAL_DELIVERY_BELOW_MINIMUM are reconciliation results and never match here.
  if (/^(?:BRIDGE_|RELAY_|LIFI_|ACROSS_|MAYAN_|ROUTER_|UNIVERSAL_)?INSUFFICIENT_LIQUIDITY$/.test(error)) return 'The bridge provider does not have enough liquidity for this amount right now, so this step was not simulated or sent. Try a smaller amount or try again later.';
  if (/^(?:BRIDGE_|RELAY_|LIFI_|ACROSS_|MAYAN_|ROUTER_|UNIVERSAL_)?AMOUNT_TOO_LOW$|^(?:BRIDGE_)?BELOW_MINIMUM$/.test(error)) return 'The amount is below the bridge provider’s minimum for this route, so this step was not simulated or sent. Choose a larger amount, then simulate again.';
  // P0 hotfix (FIX 3, 2026-11-13): Relay answers a WETH bridge with a native-ETH order through its own router contracts, which FloFi does not verify.
  if (error === 'RELAY_WRAPPED_NATIVE_INPUT_UNSUPPORTED') return 'FloFi cannot bridge WETH on this route: the bridge provider converts it to native ETH through contracts FloFi does not verify, so this step was not simulated or sent. Bridge ETH (unwrap the WETH first) or USDC instead.';
  if (/^(?:BRIDGE_|RELAY_|LIFI_|ACROSS_|MAYAN_|ROUTER_|UNIVERSAL_)?NO_EXECUTABLE_ROUTE$/.test(error)) return 'No bridge route that FloFi can verify and execute is available for this amount right now, so this step was not simulated or sent. Try again later or change the amount.';
  // An Aave reserve short of liquidity (or collateral) is not the owner's balance: it keeps the lending sentence, before the balance rule.
  if (/^(?:BORROW|WITHDRAW)_INSUFFICIENT_LIQUIDITY$|LIQUIDITY_(?:UNAVAILABLE|INSUFFICIENT)|INSUFFICIENT_COLLATERAL/i.test(error)) return 'The available collateral or liquidity cannot support this action.';
  if (/INSUFFICIENT.*(ETH|SOL|NATIVE|GAS)|INSUFFICIENT_GAS/i.test(error)) return 'Add funds for the network fee, then simulate again.';
  if (/INSUFFICIENT|BALANCE_TOO_LOW|exceeds.*balance/i.test(error)) return 'Your available balance is too low for this workflow.';
  if (/HEALTH_FACTOR|UNSAFE_HEALTH|UNSAFE_POSITION/i.test(error)) return 'This action would leave the lending position below its required safety limit.';
  // P0 hotfix (execution continuity): the approval is confirmed but its allowance read-back is not in yet; the swap's fresh Review waits for it.
  if (error === 'APPROVAL_NOT_RECONCILED') return 'The approval is confirmed. FloFi is still reading its allowance on the network before preparing the swap. Nothing new was sent; try again in a moment.';
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a refusal at the execution boundary names what happened instead of the generic fallback below.
  if (/SUBMISSION_UNKNOWN|SUBMISSION_RESULT_UNKNOWN|OBSERVE_EXISTING|DEPOSIT_MAY_EXIST|RELAYED_EXECUTION_PENDING/i.test(error)) return 'Your wallet may already have sent this request. FloFi never sends it again; it keeps checking the network for its result.';
  if (/ROUTE_REVALIDATION_UNAVAILABLE/i.test(error)) return 'FloFi could not re-check the route with the provider just before your wallet request, so nothing was sent. Try again in a moment.';
  // BUILD-FLOFI-MAINNET-EXEC-002: the run was re-quoted in place after the quote or fee moved; the fresh Review waits for a new authorization.
  if (/_REQUOTED_REVIEW_REQUIRED$/.test(error)) return 'The quote moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.';
  // BUILD-FLOFI-MAINNET-EXEC-002: the network fee now exceeds the maximum the owner authorized (the reviewed request was not sent).
  if (/FEES_CHANGED/i.test(error)) return 'The network fee rose above the maximum in your Review, so nothing was sent. Get a fresh quote and review it again.';
  if (/ROUTE_CHANGED|QUOTE_CHANGED|REQUOTE|STATE_CHANGED|GAS_CHANGED|REVIEW_CHANGED|STOCK_MULTIPLIER_CHANGED/i.test(error)) return 'The provider quote or the on-chain state changed after your Review, so nothing was sent. Get a fresh quote and review it again.';
  // BUILD-FLOFI-E2E-RELIABILITY-001: the swap engine's own refusals at the execution boundary (they reached the owner as the generic fallback).
  if (/RECONCILIATION_MISMATCH|DIVERGENT/i.test(error)) return 'The observed on-chain result does not match the reviewed bounds, so FloFi stopped and keeps this run for review. Nothing is retried automatically.';
  if (/WALLET_AUTHORIZATION_REJECTED/i.test(error)) return 'You declined this request in your wallet, so it was not signed or sent. Earlier confirmed requests stay recorded.';
  if (/WALLET_NOT_FOUND|WALLET_CONNECTION_REJECTED/i.test(error)) return 'Connect the wallet that will sign this workflow, then simulate again.';
  if (/OWNER_REVIEW_MISMATCH/i.test(error)) return 'The connected wallet is not the wallet this Review was prepared for, so nothing was sent. Reconnect that wallet, or simulate again with this one.';
  if (/HANDOFF_NOT_AUTHORIZED/i.test(error)) return 'The reviewed request was no longer authorized when FloFi was about to open your wallet, so nothing was sent. Review it again.';
  if (/NONCE_MISMATCH|NONCE_CHANGED/i.test(error)) return 'Another transaction from this wallet took the next transaction slot (nonce), so nothing was sent. Review it again.';
  if (/SEMANTIC_REVISION_CHANGED|SEMANTIC_EDIT|TRANSACTION_ARTIFACT_CHANGED/i.test(error)) return 'The workflow or its reviewed transaction changed before your wallet was asked, so nothing was sent. Review it again.';
  if (/WALLET_PROVIDER_CHANGED|WALLET_CHANGED/i.test(error)) return 'Your wallet connection changed, so nothing was sent. Reconnect the reviewed wallet and review again.';
  if (/WALLET_UNAUTHORIZED/i.test(error)) return 'Your wallet did not authorize FloFi for this account. Reconnect the wallet, then try again.';
  if (/WALLET_METHOD_UNSUPPORTED/i.test(error)) return 'This wallet cannot send this kind of request. Use another wallet, then try again.';
  // A chain head that lagged or reorganised is the network's answer, not an expired result.
  if (/STALE_CHAIN_HEAD|QUOTE_BLOCK_REORG/i.test(error)) return 'The network did not answer FloFi\'s reads, so nothing was simulated or sent. This is not a liquidity problem; try again shortly.';
  if (/EXPIRED|STALE|quote.*expired/i.test(error)) return 'This result has expired. Refresh the simulation before continuing.';
  // Issue #149 (quoter): a read the network never answered is not a missing pool, and a missing pool is not an outage.
  if (/PUBLIC_RPC_UNAVAILABLE|RPC_HISTORY_UNAVAILABLE/i.test(error)) return 'The network did not answer FloFi\'s reads, so nothing was simulated or sent. This is not a liquidity problem; try again shortly.';
  if (/POOL_UNUSABLE|NO_LIQUID_POOL/i.test(error)) return 'No pool for this pair has usable liquidity for this amount right now, so nothing was simulated or sent. Try a smaller amount or another pair.';
  if (/SERVICE_UNAVAILABLE|STORAGE_NOT_CONFIGURED|RPC_(?:ERROR|RATE_LIMITED|UNAVAILABLE)|_OFF$|_RATE_LIMITED$/i.test(error)) return 'Simulation is currently unavailable. Try again before continuing.';
  // BUILD-SOLANA-TRANSFER-UX-001: specific meanings before the broad route and fallback messages (nothing here echoes provider text).
  if (/WALLET_SELECTION_REQUIRED|_WALLET_REQUIRED$|WALLET_NOT_CONNECTED|OWNER_REQUIRED|WALLET_PROOF_REQUIRED/i.test(error)) return 'Connect the wallet that will sign this workflow, then simulate again.';
  if (/RECIPIENT_(?:REQUIRED|INVALID|NOT_EOA|NOT_WALLET|IS_TOKEN_ACCOUNT|IS_PROGRAM|OFF_CURVE|IS_SENDER|UNSUPPORTED)/i.test(error)) return 'Check the destination address. It must be a valid wallet address on this network, not a token or program account.';
  if (/EXTENSION/i.test(error)) return 'This token uses a token feature FloFi cannot verify safely. Nothing was simulated or sent.';
  if (/MINT_(?:MISMATCH|NOT_FOUND|INVALID)|DECIMALS_MISMATCH|TOKEN_(?:METADATA|IDENTITY|PROGRAM)_MISMATCH|ASSET_IDENTITY|TOKEN_ACCOUNT_(?:MISMATCH|FROZEN)/i.test(error)) return 'The token details do not match what is on the network. Check the token on the Canvas and simulate again.';
  if (/AMOUNT_(?:TOO_SMALL|OUT_OF_RANGE|INVALID|BELOW_RENT)|BELOW_RENT_EXEMPT/i.test(error)) return 'Check the amount. It is outside what this network or token accepts.';
  if (/PARTIAL_DEBT_REQUIRED|NO_DEBT|DEBT_TOO_LOW/i.test(error)) return 'Your current debt is lower than this repayment. Reduce the amount and simulate again.';
  // HOTFIX-WORKFLOW-CONCURRENCY-001: no wallet-wide block remains; these refusals concern one transaction identity only.
  if (/DUPLICATE_TRANSACTION/i.test(error)) return 'This exact transaction is already handled by another FloFi execution, which keeps tracking it. Simulate again for a fresh, separate transaction.';
  if (/EXISTING_ATTEMPT|ATTEMPT_ACTIVE|ATTEMPT_ALREADY_ACTIVE|ALREADY_ATTEMPTED/i.test(error)) return 'This execution already has a transaction, and FloFi keeps tracking it; it is never sent twice. Simulate again to start a separate execution.';
  if (/NONCE_IN_USE|NONCE_ALREADY_RESERVED/i.test(error)) return 'An earlier request from this wallet is still waiting in your wallet, or its result is still being checked, and it holds the next transaction slot (nonce). Confirm or reject it in your wallet; FloFi keeps tracking it. Then simulate again.';
  if (/DEPOSIT_IDENTITY_IN_FLIGHT/i.test(error)) return 'This exact deposit (the same quote) is already handled by another FloFi execution, which keeps tracking it. Get a new route for a separate deposit.';
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: account-specific owner refusals. MetaMask Smart Accounts (EIP-7702, reviewed delegate) swap normally.
  if (/OWNER_DELEGATION_UNVERIFIED/i.test(error)) return 'This account is upgraded to a smart account (EIP-7702) whose code FloFi has not verified, and that code could act on funds this workflow sends to it. Use a standard account or a MetaMask Smart Account. Nothing was simulated or sent.';
  if (/TRANSFER_OWNER_NOT_EOA/i.test(error)) return 'Transfers need a standard wallet account. This account carries smart-account code (a contract wallet, or an EIP-7702 upgrade such as a MetaMask Smart Account), which FloFi does not use for transfers yet. Nothing was simulated or sent.';
  if (/OWNER_NOT_EOA/i.test(error)) return 'This address is a smart contract wallet (for example a Safe), so it cannot sign this transaction itself. Use a standard account or a MetaMask Smart Account. Nothing was simulated or sent.';
  if (/EXECUTION_NOT_ENABLED|NETWORK_UNAVAILABLE|NETWORK_UNSUPPORTED|PROFILE_UNSUPPORTED|_NOT_ENABLED$/i.test(error)) return 'This action is not available on this FloFi server right now. Nothing was simulated or sent.';
  if (/NO_ROUTE|ROUTE_UNAVAILABLE|ROUTE_REFUSED|UNSUPPORTED/i.test(error)) return 'A route is not available for this workflow. Check its tokens and networks on the Canvas.';
  if (/APPROVAL|ALLOWANCE/i.test(error)) return 'The required token approval could not be verified. Simulate again before continuing.';
  if (/CAPACITY_EXCEEDED|INSUFFICIENT_COLLATERAL|NO_COLLATERAL|BORROW_CAPACITY|COLLATERAL_REQUIRED|RESERVE_(PAUSED|INACTIVE|FROZEN|UNAVAILABLE)|LIQUIDITY_(UNAVAILABLE|INSUFFICIENT)|INSUFFICIENT_LIQUIDITY/i.test(error)) return 'The available collateral or liquidity cannot support this action.';
  if (/WRONG_CHAIN|WRONG_CLUSTER|WRONG_WALLET|WRONG_OWNER|WALLET_MISMATCH/i.test(error)) return 'Reconnect the wallet used for this workflow and simulate again.';
  if (/REJECTED|CANCELLED|USER_REFUSAL/i.test(error)) return 'The wallet request was cancelled. Try again when ready.';
  if (/SIMULATION_FAILED|SIMULATION_UNEXPECTED|SIMULATED_[A-Z_]*MISMATCH|SIMULATED_[A-Z_]*BELOW|SIMULATION_INVALID/i.test(error)) return 'The network rejected this transaction in simulation, so nothing was sent. Check the amounts and your balances, then simulate again.';
  return 'FloFi could not complete this simulation, and nothing was sent. Check the workflow on the Canvas, then simulate again.';
}
const iso = (value: string) => Date.parse(value);
const seconds = (value: string | number) => Number(value) * 1000;
const live = (provenance: string) => ['PUBLIC_MAINNET', 'PUBLIC_TESTNET', 'PUBLIC_DEVNET', 'FORK_REPRODUCED', 'LIVE_READ_ONLY'].includes(provenance);
const decimals = (symbol: string) => symbol === 'USDC' ? 6 : 18;
const solanaSymbol = (symbol: string, cluster: string) => cluster === 'devnet' && symbol === 'USDC' ? 'devUSDC' : symbol;

export function projectSimulation(workflow: Workflow, context: ReviewContext, source?: SimulationSource, now = Date.now()): SimulationPresentation {
  const steps: SimulationStep[] = composerActions(workflow).map((node, index) => {
    const card = composerSummary(workflow, node, context);
    const constraint = node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
    return { id: node.nodeId, number: index + 1, action: card.action,
      input: card.amount === 'Amount not available' ? '—' : card.amount, networks: card.chain.split(' → ').filter(name => !/^(eip155:|solana:|mock:)/.test(name) && !/mock/i.test(name)), pair: card.bridgePair ?? card.detail ?? null,
      result: null, resultLabel: 'Expected output', provider: null, minimum: null,
      configuredSlippage: constraint?.kind === 'MAXIMUM_SLIPPAGE_BPS' ? bps(constraint.maximumBps) : null,
      slippage: null, priceImpact: null, details: [] };
  });
  const view: SimulationPresentation = { status: 'attention', message: 'Run a simulation to see the expected result.', expiresAt: null, steps, fees: [], warnings: [] };
  if (!source) return view;
  const warn = (severity: SimulationWarning['severity'], message: string, technical = false) => view.warnings.push({ severity, message, ...technical ? { technical: true as const } : {} });
  const stop = (message: string) => { view.status = 'blocked'; view.message = message; warn('blocking', message); return view; };
  if (source.state.busy) { view.message = 'Updating the simulation…'; return view; }
  if (source.state.error) return stop(simulationError(source.state.error));
  // BUILD-FLOFI-MAINNET-EXEC-002 (review P1): a bridge re-quoted in place after a refusal shows its fresh, authorizable Review — with why the earlier
  // one could not run (visible, never technical) — instead of blocking it.
  const requoted = 'requoted' in source.state ? (source.state as { readonly requoted?: { readonly code: string } | null }).requoted : null;
  if (requoted) warn('attention', requotedMessage(requoted.code));
  if ('retired' in source.state && source.state.retired) return stop('The workflow or wallet has changed. Simulate again before continuing.');
  if ('recoveryOnly' in source.state && source.state.recoveryOnly) return stop('A previous run needs attention before a new simulation can proceed.');
  if (steps.length && (('available' in source.state && source.state.available === false) ||
    ('info' in source.state && source.state.info?.available === false))) return stop('Simulation is not available for this workflow on the current network.');
  if ('record' in source.state && source.state.record) {
    const record = source.state.record;
    if ('verdict' in record && ['DIVERGENT', 'FAILED', 'INCONCLUSIVE', 'NOT_EXECUTED', 'REFUNDED'].includes(record.verdict)) return stop('The previous result cannot be used to continue. Simulate again before continuing.');
    if ('status' in record && ['FAILED', 'RECOVERY_REQUIRED', 'PAUSED', 'PARTIALLY_COMPLETED'].includes(record.status)) return stop('The previous run needs attention before continuing.');
  }
  if (source.kind === 'unavailable') return view;
  const same = (saved: SemanticWorkflow) => {
    try { return hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(saved))) ===
      hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))); }
    catch { return false; }
  };
  const boundHash = (hash: string, revision: number) => {
    try { return revision === workflow.revision && hash === hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))); }
    catch { return false; }
  };
  const guard = (bound: boolean, provenance: string, expiry: number, error?: string | null, chainTime = false): boolean => {
    if (!bound) { stop('The workflow has changed. Simulate again before continuing.'); return false; }
    if (error) { stop(simulationError(error)); return false; }
    if (!live(provenance)) return false;
    view.expiresAt = !chainTime && Number.isFinite(expiry) ? expiry : null;
    if (!Number.isFinite(expiry) || !chainTime && now >= expiry) { stop('This result has expired. Refresh the simulation before continuing.'); return false; }
    view.status = 'ready'; view.message = 'Current simulation. Checks run again before continuing.';
    if (chainTime) warn('attention', 'Validity is checked against the current local-fork block before continuing.');
    return true;
  };
  const step = (id?: string) => id ? steps.find(s => s.id === id) : steps.length === 1 ? steps[0] : undefined;
  const result = (s: SimulationStep | undefined, input: string | null, output: string | null, provider: string, minimum?: string | null, slippage?: number) => {
    if (!s) return;
    s.input = input ?? s.input; s.result = output; s.provider = provider; s.minimum = minimum ?? null;
    if (slippage !== undefined) s.slippage = bps(slippage);
  };
  const fee = (label: string, units: string | null, decimalPlaces: number, symbol: string, note: string | undefined, treatment: FeeTreatment) => {
    const value = simulationAmount(units, decimalPlaces, symbol);
    if (value !== null) view.fees.push({ label, value, ...(note ? { note } : {}), treatment });
  };
  /**
   * ADR-0010 §4 (Pimlico Kora): who pays, in which token — "Network fee, at most 0.0031 USDC · Paid from your USDC to Pimlico." The fee payer and
   * the payment address are protocol details: under Technical details (non-material step details), never a banner.
   */
  const koraFee = (s: SimulationStep | undefined, gas: { amount: string; feePayer: string; paymentAddress: string; token: { symbol: string; decimals: number } }) => {
    fee('Network fee', gas.amount, gas.token.decimals, gas.token.symbol, `Paid from your ${gas.token.symbol} to Pimlico.`, 'CEILING');
    if (s) s.details.push({ label: 'Network fee payer (Pimlico)', value: gas.feePayer }, { label: 'Network fee payment address', value: gas.paymentAddress });
  };
  const approvals = (required: boolean) => { if (required) warn('info', 'Token approval is required before execution.'); };
  const networkFees = (f: { totalUpperBoundWei: string | null; executionFeeUpperBoundWei: string; l1FeeUpperBoundWei: string | null }) => {
    if (f.totalUpperBoundWei !== null) fee('Maximum network fee', f.totalUpperBoundWei, 18, 'ETH', 'Includes execution and L1 data fees.', 'CEILING');
    else { fee('Maximum execution fee', f.executionFeeUpperBoundWei, 18, 'ETH', undefined, 'CEILING'); warn('attention', 'The L1 data fee is not available; the network fee total is incomplete.'); }
  };
  const health = (s: SimulationStep | undefined, value: string | undefined) => {
    if (!s || value === undefined) return;
    const formatted = value === ((1n << 256n) - 1n).toString() ? '∞' : simulationAmount(value, 18);
    if (formatted !== null) s.details.push({ label: 'Health factor after', value: formatted });
  };
  const range = (s: SimulationStep | undefined, r: { lowerPrice: string; upperPrice: string; state: string }, unit: string) => {
    if (!s) return;
    if (/^\d+(\.\d+)?$/.test(r.lowerPrice) && /^\d+(\.\d+)?$/.test(r.upperPrice)) s.details.push({ label: 'Price range', value: `${r.lowerPrice}–${r.upperPrice} ${unit}` });
    if (r.state !== 'IN_RANGE') warn('attention', 'The position starts outside the active price range.');
  };
  switch (source.kind) {
    case 'supply': {
      const r = source.state.record; if (!r) break;
      const q = r.review;
      if (!guard(same(q.workflow), r.provenance, iso(q.expiresAt), r.error)) break;
      const s = step(), amount = simulationAmount(q.amount, 6, 'USDC');
      result(s, amount, amount ? `${s?.action ?? 'Supply'} ${amount}` : null, 'Aave V3');
      if (s) s.resultLabel = 'Expected action';
      for (const budget of q.manifest.gasBudgets) if ('nativeId' in budget.asset && budget.asset.nativeId === 'ETH') fee('Maximum network fee', budget.maximumAmount, budget.asset.decimals, 'ETH', undefined, 'CEILING');
      health(s, q.borrow?.expectedPostHealthFactor ?? q.repay?.expectedPostHealthFactor ?? q.withdraw?.expectedPostHealthFactor);
      approvals(q.approvalRequired);
      if (q.borrow) warn('attention', 'Borrowing creates variable-rate debt and changes your collateral risk.');
      break;
    }
    case 'lending': {
      const r = source.state.record, q = r?.reviews.at(-1); if (!r || !q) break;
      if (!guard(same(q.workflow), r.provenance, iso(q.expiresAt), r.error)) break;
      const supply = steps.find(s => s.action === 'Supply'), borrow = steps.find(s => s.action === 'Borrow'), swap = steps.find(s => s.action === 'Swap');
      const supplied = simulationAmount(q.fields.supplyAmount, 6, 'USDC'), borrowed = simulationAmount(q.fields.borrowAmount, 6, 'USDC');
      result(supply, supplied, supplied ? `Supply ${supplied}` : null, 'Aave V3');
      result(borrow, borrowed, borrowed ? `Borrow ${borrowed}` : null, 'Aave V3');
      if (supply) supply.resultLabel = 'Expected action'; if (borrow) borrow.resultLabel = 'Expected action';
      result(swap, borrowed, simulationAmount(q.route.expectedOut, 18, 'WETH'), 'Uniswap V3', simulationAmount(q.route.minimumOut, 18, 'WETH'), q.fields.slippageBps);
      health(borrow, q.projected.afterBorrow.aave.borrow?.healthFactor);
      for (const [s, id] of [[supply, 'SUPPLY'], [borrow, 'BORROW'], [swap, 'SWAP']] as const) {
        if (s && q.completed.includes(id)) s.details.push({ label: 'Step status', value: 'Already completed' });
      }
      for (const budget of q.manifest.gasBudgets) if ('nativeId' in budget.asset && budget.asset.nativeId === 'ETH') fee('Maximum network fee', budget.maximumAmount, budget.asset.decimals, 'ETH', 'Workflow ceiling, including L1 data fees.', 'CEILING');
      approvals(q.calls.some(c => c.id === 'POOL_APPROVAL' || c.id === 'ROUTER_APPROVAL'));
      warn('attention', 'Borrowing creates variable-rate debt. Completed steps are not automatically reversed if a later step fails.');
      for (const uncertainty of q.simulation.uncertainty) {
        if (uncertainty.code === 'NON_ATOMIC_LENDING') warn('attention', 'Debt remains if the swap fails. The simulated health factor does not protect against future liquidation.');
        if (uncertainty.code === 'VARIABLE_INTEREST_AND_L1_FEES') warn('attention', 'Future borrowing interest is not capped. Network fees may differ from these estimates.');
      }
      break;
    }
    case 'router': {
      const r = source.state.record; if (!r) break; const q = r.review;
      if (!guard(same(r.workflow) && boundHash(q.workflowHash, q.revision), r.provenance, Math.min(iso(q.expiresAt), iso(q.quote.expiresAt), q.deadlines.depositMustLandBy * 1000), r.error ?? (r.requote ? 'REQUOTE' : null))) break;
      const route = q.route, s = step(q.nodeId);
      const chosen = [simulationProvider(q.selection.selected), simulationProvider(route.underlyingProtocol)].filter((name, i, all) => name && all.indexOf(name) === i).join(' · ');
      result(s, simulationAmount(route.inputAmount, route.inputToken.decimals, route.inputToken.symbol), simulationAmount(q.quote.expectedOutput, route.outputToken.decimals, route.outputToken.symbol), chosen || '—', simulationAmount(q.quote.minimumOutput, route.outputToken.decimals, route.outputToken.symbol), route.slippageBps);
      if (s) s.resultLabel = 'Quoted destination output';
      networkFees(q.fees);
      const feeLabels = { INTEGRATOR: 'Provider fee', BRIDGE_RELAYER_CAPITAL: 'Bridge relayer fee', BRIDGE_DESTINATION_GAS: 'Destination delivery fee', BRIDGE_LP: 'Bridge liquidity fee', BRIDGE_OTHER: 'Bridge fee' };
      for (const f of route.fees) if (f.chainId === route.inputToken.chainId && f.token.toLowerCase() === route.inputToken.address.toLowerCase() && BigInt(f.amount) > 0n) {
        fee(feeLabels[f.kind], f.amount, route.inputToken.decimals, route.inputToken.symbol, 'Included in the route fee total.', 'COMPONENT');
      }
      fee('Route fee total', q.quote.feeTotal, route.inputToken.decimals, route.inputToken.symbol, 'Included in the quoted output; network fees are separate.', 'INCLUDED'); approvals(q.approvals.some(a => a.required));
      if (s) s.destination = q.recipient;
      warn('attention', 'Destination delivery is quoted. The simulation checks the source transactions; delivery and refunds are not simulated.', true);
      break;
    }
    case 'universal': {
      // BUILD-CROSSCHAIN-UNIVERSAL-001: the reviewed route; the provider order guarantees the minimum, delivery and refunds are not simulated.
      const r = source.state.record; if (!r) break; const q = r.review, route = q.route;
      if (!guard(same(r.workflow) && boundHash(q.workflowHash, q.revision), r.provenance, Math.min(iso(q.expiresAt), iso(route.quote.expiresAt)), r.error ?? (r.requote ? 'REQUOTE' : null))) break;
      const s = step(q.nodeId), provider = { relay: 'Relay', lifi: 'LI.FI', mayan: 'Mayan', across: 'Across' }[route.provider] ?? route.provider;
      result(s, simulationAmount(route.inputAmount, route.inputToken.decimals, route.inputToken.symbol), simulationAmount(route.expectedOutput, route.outputToken.decimals, route.outputToken.symbol),
        provider, simulationAmount(route.minimumOutput, route.outputToken.decimals, route.outputToken.symbol), route.slippageBps);
      if (s) s.resultLabel = 'Quoted destination output';
      fee('Maximum network fee', q.feePolicy.networkFeeUpperBound, q.feePolicy.networkFeeDecimals, q.feePolicy.networkFeeSymbol, 'Paid on the source network, separate from the route.', 'CEILING');
      for (const f of route.fees) if (f.included && BigInt(f.amount) > 0n) fee(f.label, f.amount, f.decimals, f.symbol, 'Included in the quoted output.', 'INCLUDED');
      fee('FloFi fee (0.1% obligation)', flofiFeeUnits(route.inputAmount), route.inputToken.decimals, route.inputToken.symbol,
        '0.1% of the completed workflow input. Recorded as an obligation when the run reconciles; not charged at this time. Waived if the workflow fails or refunds.', 'OBLIGATION');
      approvals(q.source.ecosystem === 'EVM' && q.source.approvals.some(a => a.required));
      // BUILD-FLOFI-MAINNET-EXEC-002: the owner's asset identity changes on the way (material, always visible): WETH is unwrapped 1:1 into ETH first.
      const unwrapping = route.source.ecosystem === 'EVM' && route.source.unwrap !== undefined;
      if (unwrapping) warn('attention', 'The provider is paid in ETH: your {0} is first unwrapped 1:1 into ETH in your wallet (its own wallet request), then deposited. A refund, if any, arrives as ETH.'
        .replace('{0}', route.inputToken.symbol));
      else if (q.authorizations.sourceSignatures > 1) warn('info', 'This bridge needs two wallet signatures on the source network: an exact approval, then the deposit.');
      // Review round 2: the Review bound the recipient as the owner's own wallet (connected owner, or their destination wallet) or as an explicit address.
      // Review round 3: a destination wallet counts as the owner's only when it is connected in this session or on the FloFi account; one resolved
      // from the device's saved Credentials addresses is shown in full without that claim (the bridge panel asks the owner to check it).
      if (s) {
        const own = 'ownDestinations' in source.state ? (source.state as { readonly ownDestinations?: readonly string[] }).ownDestinations ?? [] : [];
        s.destination = q.recipient; s.destinationOwned = boundRecipientOwned(q.recipientKind, q.recipient, own);
      }
      warn('attention', 'Destination delivery is guaranteed by the provider order and proven on chain after it lands. The simulation checks the source transaction; delivery and refunds are not simulated.', true);
      break;
    }
    case 'public': {
      const r = source.state.run; if (!r) break; const q = r.quote;
      // BUILD-RH-002: a catalog quote carries its own provenance (PUBLIC_MAINNET, or MOCKED for the loopback harness) and decimals.
      if (!guard(same(r.workflow) && boundHash(q.workflowHash, q.revision), q.provenance ?? 'PUBLIC_TESTNET', iso(q.expiresAt))) break;
      const s = step(q.nodeId), din = quoteDecimals(q, 'input'), dout = quoteDecimals(q, 'output');
      // BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a Review that binds 0x Gasless shows 0x's amounts (net of every fee), who pays the
      // network fee and in which token, and the signatures; 0x's Settler, route, trade hash and approval go under Technical details.
      const zx = q.gas?.mechanism === 'ZEROX_GASLESS_SWAP' ? q.gas.zeroEx : null;
      if (zx) {
        result(s, simulationAmount(q.amountIn, din, q.inputSymbol), simulationAmount(q.expectedOut, dout, q.outputSymbol), '0x', simulationAmount(q.minimumOut, dout, q.outputSymbol), q.slippageBps);
        const side = (token: string) => token === q.inputToken ? { decimals: din, symbol: q.inputSymbol } : { decimals: dout, symbol: q.outputSymbol };
        const gasSide = side(zx.gasFee.token);
        fee(INCLUDED_NETWORK_FEE_LABEL, zx.gasFee.amount, gasSide.decimals, gasSide.symbol, `Paid from your ${gasSide.symbol}: 0x takes it out of the swap, so no ETH is needed. The amounts you receive are after this fee.`, 'INCLUDED');
        if (zx.zeroExFee) { const feeSide = side(zx.zeroExFee.token); fee(ZEROX_FEE_LABEL, zx.zeroExFee.amount, feeSide.decimals, feeSide.symbol, 'The provider\'s own fee, taken out of the swap.', 'INCLUDED'); }
        if (s) {
          s.resultLabel = 'Quoted output';
          if (zx.approval) s.details.push({ label: SIGNATURES_LABEL, value: '2 (token approval, then the trade)' });
          s.details.push({ label: 'Executed by', value: `0x Settler ${zx.settler}` }, { label: 'Route sources', value: zx.sources.join(', ') || '0x' },
            { label: 'Trade hash', value: zx.trade.hash }, { label: 'Signed trade valid until', value: new Date(zx.trade.deadline * 1000).toISOString() });
          if (zx.approval) s.details.push({ label: 'Token approval by signature', value: zx.approval.unlimited ? `Permit2 ${zx.permit2} may spend any amount of ${q.inputSymbol}`
            : `Permit2 ${zx.permit2} may spend at most ${simulationAmount(zx.approval.value, din, q.inputSymbol)}` });
        }
        for (const stock of q.stocks ?? []) warn('attention', `${stock.symbol}: ${simulationAmount(stock.multiplierWad, 18)} underlying shares per token (Robinhood corporate-action multiplier).`);
        if (q.stocks?.length) warn('attention', 'Stock Tokens are not offered to US persons or in restricted jurisdictions.');
        if (zx.approval?.unlimited) warn('attention', `This approval lets Permit2 spend any amount of ${q.inputSymbol} from this wallet until you change or revoke it.`);
        warn('info', 'This swap is executed by 0x\'s settlement contract along 0x\'s quoted route, not the Uniswap pool. You sign; 0x\'s relayer sends it and takes the network fee from the swap.', true);
        break;
      }
      result(s, simulationAmount(q.amountIn, din, q.inputSymbol), simulationAmount(q.expectedOut, dout, q.outputSymbol), q.conversion ? 'WETH9' : 'Uniswap V3', simulationAmount(q.minimumOut, dout, q.outputSymbol), q.slippageBps);
      for (const stock of q.stocks ?? []) warn('attention', `${stock.symbol}: ${simulationAmount(stock.multiplierWad, 18)} underlying shares per token (Robinhood corporate-action multiplier).`);
      if (q.stocks?.length) warn('attention', 'Stock Tokens are not offered to US persons or in restricted jurisdictions.');
      if (s) s.resultLabel = q.conversion ? 'Exact output' : 'Quoted output';
      // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: native ETH is named as such — what the wallet request carries, and who pays it out — never as WETH.
      if (q.conversion) warn('info', q.conversion === 'WRAP' ? 'Wrap through WETH9: exactly 1:1, no pool, no price impact and no slippage. Your wallet sends the ETH with the request; the network fee is paid separately from the same ETH balance.'
        : 'Unwrap through WETH9: exactly 1:1, no pool, no price impact and no slippage. WETH9 pays you native ETH; the network fee is paid separately.');
      else if (q.native === 'INPUT') warn('info', 'This swap spends native ETH: your wallet sends it with the request (no token approval). The network fee is paid separately from the same ETH balance.');
      else if (q.native === 'OUTPUT') warn('info', 'You receive native ETH: in the same transaction the router unwraps WETH9 and pays you at least the minimum. The network fee is paid separately.');
      // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the pool fee is part of the quoted price (never paid again); the owner-bound gas budget is a ceiling for
      // the next wallet request only.
      if (Number.isSafeInteger(q.fee) && q.fee > 0) view.fees.push({ label: 'Pool fee', value: `${(q.fee / 10_000).toFixed(2)}%`, note: 'Uniswap v3 fee tier, already reflected in the quoted output.', treatment: 'INCLUDED' });
      if (q.ownerReview) fee('Maximum network fee', q.ownerReview.feeBudgetWei, 18, 'ETH', q.ownerReview.step === 'approval'
        ? 'Ceiling for the token approval request; the swap\'s own network fee is checked after the approval confirms.' : 'Ceiling for this wallet request, separate from the swap output.', 'CEILING');
      // ADR-0010: a quote made for the owner on Robinhood Chain knows the native path's worst-case fee, and says before anything is signed when the
      // wallet's ETH does not cover it and why paying it in tokens is not available.
      else if (q.gas?.native.worstCaseWei) fee('Maximum network fee', q.gas.native.worstCaseWei, 18, 'ETH', 'Paid in ETH by your wallet, separate from the swap output.', 'CEILING');
      if (q.gas?.nativeShort) {
        warn('attention', 'This wallet does not have enough ETH for the network fee of this swap. Add ETH on this network before you authorize.');
        for (const reason of q.gas.unavailable) warn('attention', gaslessUnavailableReason(reason.code));
      }
      if (!q.ownerReview && !q.gas) warn('attention', 'This is a pool quote. Network fees and exact transaction simulation are not available yet.');
      break;
    }
    case 'solana-swap': {
      const r = source.state.record; if (!r) break; const q = r.review;
      if (!guard(same(q.workflow), r.provenance, iso(q.expiresAt), r.error)) break;
      const s = step(), tokenIn = solanaSymbol(q.input.symbol, q.cluster), tokenOut = solanaSymbol(q.output.symbol, q.cluster);
      result(s, simulationAmount(q.simulationResult.inputSpent, q.input.decimals, tokenIn), simulationAmount(q.simulationResult.outputReceived, q.output.decimals, tokenOut), q.format === 'gryloo.jupiter-review.v1' ? 'Jupiter' : 'Orca Whirlpools', simulationAmount(q.quote.otherAmountThreshold, q.output.decimals, tokenOut), q.slippageBps);
      if (s) {
        s.resultLabel = 'Simulated output'; s.priceImpact = simulationPriceImpact(q.quote.priceImpactPct, q.format === 'gryloo.jupiter-review.v1');
        const providers = [...new Set(q.quote.routePlan.map(p => simulationProvider(p.label)).filter(Boolean))];
        if (providers.length) s.details.push({ label: 'Route pools', value: providers.join(' → ') });
      }
      // ADR-0010 §4: with Pimlico's Kora fee payer the owner pays no SOL; the network fee is the exact token amount it repays (its ceiling).
      const kora = q.format === 'gryloo.jupiter-review.v1' ? q.gas : undefined;
      if (kora) koraFee(s, kora);
      else {
        fee('Estimated network fee', q.estimatedFeeLamports, 9, 'SOL', undefined, 'ADDITIONAL');
        if (BigInt(q.simulationResult.accountCreationLamports) > 0n) fee('Account deposits', q.simulationResult.accountCreationLamports, 9, 'SOL', 'Account rent, separate from network fees.', 'ADDITIONAL');
      }
      if (q.format === 'gryloo.orca-devnet-review.v1') {
        const trade = q.simulatedTrade;
        for (const [label, amount] of [['Liquidity provider fee', trade.lpFee], ['Protocol fee', trade.protocolFee], ['Input transfer fee', trade.inputTransferFee]] as const) {
          if (BigInt(amount) > 0n) fee(label, amount, q.input.decimals, tokenIn, 'Already reflected in the simulated output.', 'INCLUDED');
        }
        if (BigInt(trade.outputTransferFee) > 0n) fee('Output transfer fee', trade.outputTransferFee, q.output.decimals, tokenOut, 'Already reflected in the simulated output.', 'INCLUDED');
      }
      break;
    }
    case 'uniswap-pool': {
      const r = source.state.record; if (!r) break; const q = r.review;
      if (!guard(same(r.workflow) && boundHash(q.workflowHash, q.revision), r.provenance, Math.min(iso(q.expiresAt), seconds(q.deadline)), r.error)) break;
      const s = step(q.nodeId);
      const amounts = [simulationAmount(q.simulation.mint.amount0, q.token0.decimals, q.token0.symbol), simulationAmount(q.simulation.mint.amount1, q.token1.decimals, q.token1.symbol)];
      result(s, null, amounts.every(Boolean) ? amounts.join(' + ') : null, 'Uniswap V3', null, q.intent.slippageBps);
      if (s) s.resultLabel = 'Expected pool contribution';
      range(s, q.range, 'USDC per WETH'); networkFees(q.fees); approvals(q.approvals.some(a => a.required));
      break;
    }
    case 'solana-pool': {
      const r = source.state.record; if (!r) break; const q = r.review;
      if (!guard(same(q.workflow), r.provenance, iso(q.expiresAt), r.error)) break;
      const s = step(q.nodeId), sim = q.simulationResult, opening = q.operation === 'OPEN';
      const amounts = [simulationAmount(opening ? sim.depositedA : sim.withdrawnPrincipalA, q.token0.decimals, solanaSymbol(q.token0.symbol, q.cluster)), simulationAmount(opening ? sim.depositedB : sim.withdrawnPrincipalB, q.token1.decimals, solanaSymbol(q.token1.symbol, q.cluster))];
      result(s, null, amounts.every(Boolean) ? amounts.join(' + ') : null, 'Orca Whirlpools', null, q.intent.slippageBps);
      if (s) s.resultLabel = opening ? 'Expected pool contribution' : 'Expected withdrawal';
      range(s, q.range, `${solanaSymbol(q.token1.symbol, q.cluster)} per SOL`); fee('Estimated network fee', q.estimatedFeeLamports, 9, 'SOL', undefined, 'ADDITIONAL');
      if (BigInt(sim.rentPaidLamports) > 0n) fee('Account deposits', sim.rentPaidLamports, 9, 'SOL', 'Account rent, separate from network fees.', 'ADDITIONAL');
      break;
    }
    case 'solana-composition': {
      const v = source.state.record; if (!v) break; const q = v.record.review, lp = q.liquidity;
      if (['FAILED', 'NOT_EXECUTED', 'ATTENTION', 'EXPIRED'].includes(v.phase)) { stop('The previous result cannot be used to continue. Simulate again before continuing.'); break; }
      // Before the swap the composed Review is the result; after it, the position's fresh Review (when prepared).
      const position = v.phase === 'CONSUMING' && v.liquidity && !v.liquidity.attempt ? v.liquidity.review : null, planned = ['SIMULATED', 'AUTHORIZED'].includes(v.phase);
      const provenance = v.record.provenance === 'MOCKED' ? 'MOCKED' : 'PUBLIC_DEVNET';
      if (!planned && !position) {
        if (!same(q.workflow)) { stop('The workflow has changed. Simulate again before continuing.'); break; }
        view.status = 'attention'; view.message = v.phase === 'BOUND' ? 'The swap is reconciled. Prepare the position with the received amount.' : 'This run has finished. Simulate again to start a new one.';
      } else if (!guard(same(q.workflow), provenance, iso(position?.expiresAt ?? q.expiresAt), null)) break;
      const swapStep = step(q.swap.nodeId), poolStep = step(lp.nodeId), token = (t: 0 | 1) => t === 0 ? 'SOL' : 'devUSDC', dec = (t: 0 | 1) => t === 0 ? 9 : 6;
      const inToken = q.swap.input.symbol === 'SOL' ? 0 : 1;
      result(swapStep, simulationAmount(q.swap.amount, dec(inToken), token(inToken)), simulationAmount(v.record.binding?.received ?? q.swap.expectedOutput, dec(lp.boundToken), token(lp.boundToken)),
        'Orca Whirlpools', simulationAmount(q.swap.minimumOutput, dec(lp.boundToken), token(lp.boundToken)), q.swap.slippageBps);
      if (swapStep) swapStep.resultLabel = v.record.binding ? 'Reconciled output' : 'Simulated output';
      const contribution = position ? [position.expected.amountA, position.expected.amountB] : [lp.expected.amount0, lp.expected.amount1];
      const amounts = [simulationAmount(contribution[0], 9, 'SOL'), simulationAmount(contribution[1], 6, 'devUSDC')];
      result(poolStep, null, amounts.every(Boolean) ? amounts.join(' + ') : null, 'Orca Whirlpools', null, lp.slippageBps);
      if (poolStep) {
        poolStep.resultLabel = position ? 'Expected pool contribution' : 'Projected pool contribution';
        poolStep.details.push({ label: 'Funded by', value: lp.capIsFullOutput ? '100% of the swap’s reconciled output' : `The swap’s reconciled output, up to ${simulationAmount(lp.cap, dec(lp.boundToken), token(lp.boundToken))}` });
        if (v.record.binding) poolStep.details.push({ label: 'Bound amount', value: simulationAmount(v.record.binding.bound, dec(lp.boundToken), token(lp.boundToken)) ?? '—' });
      }
      range(poolStep, position?.range ?? { lowerPrice: lp.lowerPrice, upperPrice: lp.upperPrice, state: lp.expected.state }, 'devUSDC per SOL');
      fee('Estimated swap network fee', v.swap.review.estimatedFeeLamports, 9, 'SOL', undefined, 'ADDITIONAL');
      if (position) fee('Estimated position network fee', position.estimatedFeeLamports, 9, 'SOL', undefined, 'ADDITIONAL');
      for (const check of lp.preflight) if (!check.ok && !check.blocking) warn('attention', 'With this range, the position would not use any of the swap output.');
      warn('attention', 'The swap and the position are separate transactions. If the position is not opened, the swapped tokens stay in your wallet; the swap is never repeated.');
      if (!position && planned) warn('info', 'Position amounts are a projection. The position is simulated with the actual swap output and reviewed again after the swap.');
      break;
    }
    case 'transfer': {
      const r = source.state.record; if (!r) break; const q = r.review;
      if (!guard(same(q.workflow), r.provenance, iso(q.expiresAt), r.error)) break;
      // BUILD-RH-002: a token transfer is shown in its own asset and decimals; an explicit recipient is named.
      const symbol = q.asset ? resolveNetworkAsset(q.chain, { address: q.asset.token })?.symbol ?? 'Token' : 'ETH';
      const amount = simulationAmount(q.value, q.asset?.decimals ?? 18, symbol), s = step(), self = q.recipient === q.account;
      result(s, amount, amount ? self ? `Send ${amount} to your wallet` : `Send ${amount} to ${q.recipient}` : null, 'Wallet send');
      if (s) { s.resultLabel = 'Expected action'; s.destination = q.recipient; }
      fee('Estimated network fee', q.expectedFee, 18, 'ETH', undefined, 'ADDITIONAL'); fee('Maximum network fee', q.feeBudget, 18, 'ETH', 'Fee ceiling, not an additional charge.', 'CEILING');
      if (q.asset?.multiplierWad) warn('attention', `${symbol}: ${simulationAmount(q.asset.multiplierWad, 18)} underlying shares per token (Robinhood corporate-action multiplier).`);
      if (!self) warn('attention', 'Funds go to an address other than the signing wallet. Confirm it belongs to the intended recipient.');
      warn('info', self && !q.asset ? 'Sending to the same wallet returns the funds; only the network fee is spent.' : 'Only the reviewed amount moves; the network fee is paid in ETH.'); break;
    }
    case 'solana-transfer': {
      // BUILD-SOLANA-TRANSFER-UX-001: the exact amount to the explicit recipient, the reviewed fee and any recipient token-account deposit.
      const r = source.state.record; if (!r) break; const q = r.review;
      if (!guard(same(q.workflow), r.provenance, iso(q.expiresAt), r.error)) break;
      const symbol = q.asset.mint === null ? 'SOL' : q.asset.symbol === 'SPL token' ? `${q.asset.mint.slice(0, 4)}…${q.asset.mint.slice(-4)}` : q.asset.symbol;
      const amount = simulationAmount(q.amount, q.asset.decimals, symbol), s = step();
      result(s, amount, amount ? `Send ${amount} to ${q.recipient}` : null, 'Wallet send');
      if (s) { s.resultLabel = 'Expected action'; s.destination = q.recipient; if (q.asset.mint) s.details.push({ label: 'Token mint', value: q.asset.mint }); }
      // ADR-0010 §4: with Pimlico's Kora fee payer the owner pays no SOL (Kora also advances any recipient account rent, inside the token fee).
      if (q.gas) koraFee(s, q.gas);
      else {
        fee('Estimated network fee', q.estimatedFeeLamports, 9, 'SOL', undefined, 'ADDITIONAL');
        if (BigInt(q.accountCreationLamports) > 0n) fee('Recipient token account deposit', q.accountCreationLamports, 9, 'SOL', 'Opens the recipient\'s token account; paid once, separate from the network fee.', 'ADDITIONAL');
        else if (q.token) fee('Maximum token account deposit', q.maximumAccountCreationLamports, 9, 'SOL', 'Only paid if the recipient token account must be recreated before this transfer lands.', 'CEILING');
      }
      if (!q.asset.verified) warn('attention', 'This token is not on FloFi\'s verified list. Its mint, decimals and token program were checked on chain; confirm it is the token you intend to send.');
      if (q.token?.program === 'token-2022') warn('info', 'Token-2022 token: only extensions FloFi can verify were found, and the recipient receives exactly the amount sent.');
      warn('attention', 'Funds go to an address other than the signing wallet. Confirm it belongs to the intended recipient.');
      break;
    }
    case 'fork-swap': {
      const q = source.state.prepared; if (!q) break;
      if (!guard(same(q.workflow), q.environment, Math.min(seconds(q.quoteExpiresAt), seconds(q.deadline)), source.state.verifyError, true)) break;
      result(step(q.nodeId), simulationAmount(q.amountIn, q.decimalsIn, q.symbolIn), simulationAmount(q.quotedOut, q.decimalsOut, q.symbolOut), 'Uniswap V3', simulationAmount(q.minimumOut, q.decimalsOut, q.symbolOut), q.slippageBps);
      for (const budget of q.artifacts.manifest.gasBudgets) if ('nativeId' in budget.asset && budget.asset.nativeId === 'ETH') fee('Maximum network fee', budget.maximumAmount, budget.asset.decimals, 'ETH', undefined, 'CEILING');
      warn('info', 'Results come from the current local-fork simulation.');
      for (const finding of q.findings) warn(finding.severity === 'BLOCK' ? 'blocking' : 'attention', ['ZERO_SLIPPAGE', 'ELEVATED_SLIPPAGE', 'SLIPPAGE_ABOVE_REVIEW_LIMIT'].includes(finding.code) ? 'Review the configured slippage limit before continuing.' : 'Check the simulation before continuing.');
      if (!source.state.verified['step-approve'] || !source.state.verified['step-swap']) warn('blocking', 'The simulation transactions could not be verified. Simulate again before continuing.');
      break;
    }
    case 'delegated-swap': {
      const q = source.state.status?.prepared; if (!q) break;
      if (!guard(boundHash(q.workflowHash, q.revision), 'FORK_REPRODUCED', seconds(q.quoteExpiresAt), source.state.quoteExpired ? 'QUOTE_EXPIRED' : null, true)) break;
      const tokenIn = q.direction === 'USDC_TO_WETH' ? 'USDC' : 'WETH', tokenOut = tokenIn === 'USDC' ? 'WETH' : 'USDC';
      result(step(), simulationAmount(q.amountIn, decimals(tokenIn), tokenIn), simulationAmount(q.quotedOut, decimals(tokenOut), tokenOut), 'Uniswap V3', simulationAmount(q.minimumOut, decimals(tokenOut), tokenOut));
      warn('info', 'Results come from the current local-fork simulation.'); break;
    }
    case 'composition': {
      const q = source.state.status?.prepared; if (!q) break;
      if (!guard(boundHash(q.workflowHash, q.revision), source.state.info?.environment ?? 'MOCKED', Math.min(seconds(q.quoteExpiresAt), seconds(q.terms.mintDeadline)), null, true)) break;
      const swap = steps.find(s => s.action === 'Swap'), pool = steps.find(s => s.action === 'Pool / Liquidity');
      result(swap, simulationAmount(q.terms.swap.amountIn, 6, 'USDC'), simulationAmount(q.quoteOut, 18, 'WETH'), 'Uniswap V3', simulationAmount(q.minimumOut, 18, 'WETH'));
      if (pool) { pool.provider = 'Uniswap V3'; pool.details.push({ label: 'Tick range', value: `${q.terms.tickLower}–${q.terms.tickUpper}` }); }
      warn('attention', 'Pool contribution amounts are not available. A successful swap is not automatically reversed if the pool step fails.');
      warn('info', 'Results come from the current local-fork simulation.'); break;
    }
    case 'fork-pool': {
      const q = source.state.prepared; if (!q) break;
      if (!guard(boundHash(q.workflowHash, q.revision), source.state.info?.available ? source.state.info.environment : 'MOCKED', seconds(q.deadline), null, true)) break;
      const a = simulationAmount(q.composition.amount0, 18, 'WETH'), b = simulationAmount(q.composition.amount1, 6, 'USDC');
      const s = step();
      result(s, null, q.operation === 'MINT' || q.operation === 'INCREASE' ? a && b ? `${a} + ${b}` : null : null, 'Uniswap V3');
      if (s) s.resultLabel = 'Expected pool contribution';
      if (q.operation !== 'MINT' && q.operation !== 'INCREASE') warn('attention', 'The current simulation covers one position transaction. A full position result is not available.');
      if (!source.state.verified) warn('blocking', 'The simulation transaction could not be verified. Simulate again before continuing.');
      warn('info', 'Results come from the current local-fork simulation.'); break;
    }
    case 'across': {
      const r = source.state.run; if (!r) break; const q = r.quote;
      if (!guard(same(r.workflow), q.provenance, iso(q.quoteExpiresAt))) break;
      const s = step();
      result(s, simulationAmount(q.inputAmount, 6, 'USDC'), simulationAmount(q.expectedOutput, 6, 'USDC'), 'Across', simulationAmount(q.minimumOutput, 6, 'USDC'));
      if (s) s.resultLabel = 'Quoted destination output';
      fee('Maximum bridge fee', q.feeMaximum, 6, 'USDC', undefined, 'CEILING'); fee('Maximum network fee', q.maximumGasCostWei, 18, 'ETH', undefined, 'CEILING');
      warn('attention', 'A route quote is available. Exact transaction and destination delivery simulation are not available.'); break;
    }
  }
  if (view.warnings.some(w => w.severity === 'blocking')) view.status = 'blocked';
  else if (view.warnings.some(w => w.severity === 'attention') || !steps.length || steps.some(s => s.result === null)) view.status = 'attention';
  if (view.status === 'attention' && steps.some(s => s.result !== null)) view.message = 'Review the attention items before continuing.';
  if (view.status === 'blocked' && !view.warnings.some(w => w.message === view.message)) view.message = 'Resolve the blocking items before continuing.';
  return view;
}
