// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-CROSSCHAIN-UNIVERSAL-001: durable record, Review and attempt shapes of the universal router service. */
import type { SolanaWalletChange, SolanaWalletGuard, UniversalArtifacts } from '@defi-workflow-engine/reference-compiler';
import type { EvidenceBundle, RouteChange, RouterPhase, SemanticWorkflow, UniversalAssetRef, UniversalRecipient, UniversalRoute, UniversalRouteSelection,
  UniversalRoutingProvider } from '@defi-workflow-engine/workflow-contracts';
import type { ProviderStatusHint } from './relay-provider.ts';

export const UNIVERSAL_RUN_ID = /^xuni-[a-f0-9]{32}$/;
export type UniversalProvenance = 'PUBLIC_MAINNET' | 'MOCKED';
export type UniversalStep = 'APPROVAL' | 'DEPOSIT';
export type UniversalAttemptState = 'PREPARED' | 'CANCELLED' | 'SUBMITTING' | 'SUBMISSION_RESULT_UNKNOWN' | 'NOT_FOUND' | 'PENDING' | 'CONFIRMED' | 'REVERTED' |
  'RECONCILIATION_REQUIRED';
export const UNIVERSAL_ACTIVE: readonly UniversalAttemptState[] = ['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
export const UNIVERSAL_OBSERVABLE: readonly UniversalAttemptState[] = ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
export const UNIVERSAL_TERMINAL: readonly UniversalAttemptState[] = ['CANCELLED', 'NOT_FOUND', 'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED'];
export const UNIVERSAL_SETTLING: readonly RouterPhase[] = ['SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'RECOVERY_REQUIRED'];

export type EvmTx = { readonly chainId: string; readonly from: string; readonly to: string; readonly data: string; readonly value: string; readonly gas: string;
  readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string };
type AttemptBase = { readonly attemptId: string; readonly step: UniversalStep; readonly state: UniversalAttemptState; readonly reviewCommitment: string;
  readonly createdAt: string; readonly transactionHash: string | null; readonly reconciled: boolean; readonly note: string | null };
export type UniversalEvmAttempt = AttemptBase & { readonly ecosystem: 'EVM'; readonly nonce: string; readonly preparedAtBlock: number; readonly tx: EvmTx;
  readonly replacementHash: string | null; readonly receipt: { readonly transactionHash: string; readonly status: 0 | 1; readonly blockNumber: number; readonly blockHash: string;
    readonly from: string; readonly gasCostWei: string; readonly submissionKind: 'DIRECT' | 'DELEGATED_SINGLE' } | null;
  /** Durable cursor of the order-log scan used when the hash was lost. */ readonly depositScanFrom?: number };
export type UniversalSolanaAttempt = AttemptBase & { readonly ecosystem: 'SOLANA'; readonly step: 'DEPOSIT'; readonly messageHash: string;
  readonly preparedAtHeight: number; readonly lastValidBlockHeight: number;
  /** The owner-signed bytes FloFi verified and broadcast (base64), kept for reconciliation against the landed transaction. */ readonly transaction: string | null;
  readonly walletGuard: SolanaWalletGuard | null; readonly feeLamports: string | null;
  /** What the wallet altered in refused bytes (public keys, counts and hashes only; never the bytes or signatures). */ readonly walletChange?: SolanaWalletChange };
export type UniversalAttempt = UniversalEvmAttempt | UniversalSolanaAttempt;

export type TokenFacts = { readonly chainId: string; readonly kind: 'NATIVE' | 'TOKEN'; readonly address: string | null; readonly decimals: number; readonly symbol: string;
  /** Solana mints: the owning token program, read on chain. */ readonly program: 'spl-token' | 'token-2022' | null; readonly verifiedOnChain: true };
export type ProviderConsideration = { readonly provider: UniversalRoutingProvider; readonly outcome: 'SELECTED' | 'AVAILABLE' | 'REFUSED' | 'UNAVAILABLE' | 'NOT_EXECUTABLE';
  readonly code: string | null; readonly expectedOutput: string | null; readonly minimumOutput: string | null; readonly routeCommitment: string | null };
export type EvmReviewSource = { readonly ecosystem: 'EVM'; readonly chainId: number; readonly block: { readonly number: number; readonly hash: string; readonly timestamp: number };
  readonly balance: string; readonly nativeBalance: string; readonly allowance: string | null; readonly nonce: string; readonly depositoryCodeSha256: string;
  readonly approvals: readonly { readonly token: string; readonly spender: string; readonly amount: string; readonly currentAllowance: string; readonly required: boolean }[];
  readonly calls: readonly { readonly purpose: 'APPROVAL' | 'BRIDGE_DEPOSIT'; readonly to: string; readonly data: string; readonly value: string; readonly gasUsed: string;
    readonly gasLimit: string; readonly l1FeeUpperBoundWei: string | null }[];
  readonly fees: { readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly gasLimitTotal: string; readonly executionFeeUpperBoundWei: string;
    readonly l1FeeUpperBoundWei: string | null; readonly totalUpperBoundWei: string | null };
  readonly simulation: { readonly provenance: 'TRANSACTION_SIMULATION'; readonly method: 'eth_simulateV1'; readonly block: number;
    readonly calls: readonly { readonly purpose: 'APPROVAL' | 'BRIDGE_DEPOSIT'; readonly gasUsed: string }[]; readonly orderId: string; readonly ownerDebit: string;
    readonly notSimulated: readonly ['DESTINATION_DELIVERY', 'SOLVER_BEHAVIOUR', 'REFUND'] } };
export type SolanaReviewSource = { readonly ecosystem: 'SOLANA'; readonly slot: number; readonly balance: string; readonly lamports: string;
  readonly program: { readonly id: string; readonly programData: string; readonly authority: string | null; readonly deploymentSlot: number };
  readonly message: string; readonly messageHash: string; readonly unsignedTransaction: string; readonly blockhash: string; readonly lastValidBlockHeight: number;
  readonly computeUnitLimit: number; readonly computeUnitPrice: string; readonly estimatedFeeLamports: string; readonly vaultTokenCreationLamports: string;
  readonly simulation: { readonly provenance: 'TRANSACTION_SIMULATION'; readonly method: 'simulateTransaction'; readonly slot: number; readonly unitsConsumed: number;
    readonly orderId: string; readonly ownerDebit: string; readonly notSimulated: readonly ['DESTINATION_DELIVERY', 'SOLVER_BEHAVIOUR', 'REFUND'] } };
export type UniversalReview = {
  readonly format: 'flofi.universal-bridge-review.v1'; readonly commitment: string;
  readonly owner: string; readonly recipient: string; readonly recipientKind: 'CONNECTED_OWNER' | 'CONNECTED_DESTINATION_WALLET' | 'EXPLICIT'; readonly recipientHasCode: boolean;
  readonly workflowHash: string; readonly revision: number; readonly nodeId: string; readonly observedAt: string; readonly expiresAt: string;
  readonly intent: { readonly sourceChain: string; readonly destinationChain: string; readonly inputAsset: UniversalAssetRef; readonly outputAsset: UniversalAssetRef;
    readonly amount: string; readonly recipient: UniversalRecipient; readonly slippageBps: number; readonly providers: readonly UniversalRoutingProvider[];
    readonly selection: UniversalRouteSelection };
  readonly selection: { readonly policy: UniversalRouteSelection; readonly selected: UniversalRoutingProvider; readonly considered: readonly ProviderConsideration[] };
  readonly route: UniversalRoute; readonly routeCommitment: string;
  readonly tokens: { readonly input: TokenFacts; readonly output: TokenFacts };
  readonly source: EvmReviewSource | SolanaReviewSource;
  readonly destination: { readonly chainId: string; readonly position: { readonly kind: 'BLOCK' | 'SLOT'; readonly height: number }; readonly recipientBalance: string };
  readonly deadlines: { readonly reviewExpiresAt: string; readonly quoteExpiresAt: string; readonly orderDeadline: number };
  /** FloFi charges no fee on this route (no FloFi fee mechanism exists; see the build report). Provider fees are the route's itemized lines. */
  readonly feePolicy: { readonly flofiFee: 'NONE'; readonly networkFeeUpperBound: string; readonly networkFeeSymbol: 'ETH' | 'SOL'; readonly networkFeeDecimals: number };
  /** Owner signatures this route needs on the source chain, and whether anything is needed on the destination chain. */
  readonly authorizations: { readonly sourceSignatures: number; readonly destinationAuthorization: 'NONE' };
  readonly artifacts: UniversalArtifacts;
};
export type SourceSettlement = { readonly chainId: string; readonly transactionHash: string; readonly position: { readonly kind: 'BLOCK' | 'SLOT'; readonly height: number };
  readonly blockHash: string | null; readonly timestamp: number | null; readonly orderId: string; readonly ownerDebit: string; readonly final: boolean;
  readonly confirmedAt: string };
export type DestinationDelivery = { readonly chainId: string; readonly transactionHash: string; readonly position: { readonly kind: 'BLOCK' | 'SLOT'; readonly height: number };
  readonly blockHash: string | null; readonly timestamp: number | null; readonly recipient: string; readonly token: string; readonly amount: string;
  readonly orderBound: boolean; readonly discoveredBy: 'PROVIDER_HINT'; readonly contentHash: string; readonly final: boolean };
export type RefundRecord = { readonly chainId: string; readonly transactionHash: string; readonly recipient: string; readonly token: string; readonly amount: string };
export type UniversalEvidence = { readonly bundle: EvidenceBundle; readonly bundleHash: string; readonly evidenceClass: 'MAINNET_EXECUTED' | 'MOCKED';
  readonly route: { readonly provider: UniversalRoutingProvider; readonly protocol: string; readonly routeCommitment: string; readonly orderId: string; readonly manifestHash: string };
  readonly source: SourceSettlement; readonly destination: DestinationDelivery; readonly recipient: string; readonly minimumOutput: string; readonly received: string;
  readonly transactions: readonly { readonly chain: string; readonly step: string; readonly transactionHash: string; readonly explorer: string }[];
  readonly reconciliation: 'RECONCILED'; readonly observedAt: string };
export type UniversalVerdict = 'PENDING' | 'RECONCILED' | 'DIVERGENT' | 'FAILED' | 'REFUNDED';
export type UniversalRecord = { readonly format: 'flofi.universal-bridge-run.v1'; readonly id: string; readonly provenance: UniversalProvenance;
  readonly workflow: SemanticWorkflow; readonly owner: string; readonly review: UniversalReview; readonly authorization: string | null; readonly phase: RouterPhase;
  readonly attempts: readonly UniversalAttempt[]; readonly source: SourceSettlement | null; readonly destination: DestinationDelivery | null; readonly refund: RefundRecord | null;
  readonly lastHint: ProviderStatusHint | null; readonly routeChanges: readonly RouteChange[]; readonly requote: boolean; readonly evidence: UniversalEvidence | null;
  readonly verdict: UniversalVerdict; readonly error: string | null;
  /** The delivered amount proven on the destination chain (what a later bound step may spend). */ readonly received: string | null };
export type UniversalWalletDiagnostic = { invoked: boolean; calls: { method: string; submission?: boolean; result?: string | null; error?: unknown }[]; code: string; rejectionCode?: number };
export type UniversalBegin = { readonly record: UniversalRecord; readonly attempt: UniversalAttempt } &
  ({ readonly ecosystem: 'EVM'; readonly transaction: EvmTx } | { readonly ecosystem: 'SOLANA'; readonly unsignedTransaction: string; readonly walletChain: 'solana:mainnet' });
