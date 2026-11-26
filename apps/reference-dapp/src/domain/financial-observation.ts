// SPDX-License-Identifier: AGPL-3.0-only
/** Durable observation facts, separate from authorization and from a final evidence bundle. */
export type FinancialObservation = {
  checkedAt: string;
  outcome: 'CONFIRMED' | 'APPROVAL_CONFIRMED' | 'UNWRAP_CONFIRMED' | 'DESTINATION_OBSERVED' | 'REFUND_OBSERVED' | 'PENDING' | 'REVERTED' | 'NOT_SUBMITTED' | 'UNDETERMINED' | 'TEMPORARY_FAILURE' | 'RECONCILED';
  reason: string;
};
export type AllowanceObservation = {
  chain: string; owner: string; token: string; spender: string; observedAt: string;
  blockNumber: number | null; blockHash: string | null; amount: string | null; status: 'VERIFIED' | 'UNAVAILABLE';
};
/** The bridge services' code for a verified delivery that waits only for the source and destination safe blocks. */
const FINALITY_WAIT = /^(UNIVERSAL|ROUTER)_AWAITING_FINALITY$/;
export function financialObservationMessage(observation: FinancialObservation): string {
  switch (observation.outcome) {
    case 'APPROVAL_CONFIRMED': return 'The token approval is confirmed. Approval does not transfer your tokens. The source deposit needs its own wallet request.';
    // BUILD-FLOFI-MAINNET-EXEC-002 (review round 2): the owner's own unwrap landed; nothing was bridged yet.
    case 'UNWRAP_CONFIRMED': return 'Your WETH is now ETH in your wallet. Nothing was bridged yet: the bridge deposit needs its own wallet request.';
    // A delivery that only awaits each network's safe block is network finality, not a FloFi delay: the worker reconciles it on its own as soon
    // as both blocks are final (`backend/reconcile-pacing.ts`), and every open page follows the durable record (`domain/settlement-sync.ts`).
    case 'DESTINATION_OBSERVED': return FINALITY_WAIT.test(observation.reason)
      ? 'A delivery was found on the destination network and is waiting for network finality. This wait is network finality, not a FloFi delay. FloFi checks it again automatically; no action or signature is needed.'
      : 'A destination transfer was verified on-chain. Finality and full reconciliation are still pending.';
    case 'REFUND_OBSERVED': return 'A refund was verified on-chain. Review its actual amount and the known transaction costs.';
    case 'CONFIRMED': return 'The source transaction is confirmed. Destination delivery and the final result are checked separately.';
    case 'PENDING': return 'The transaction was found and is awaiting confirmation. No transaction is repeated.';
    case 'REVERTED': return 'The transaction reverted. Any proven network costs remain recorded.';
    case 'NOT_SUBMITTED': return 'This request was not submitted. Earlier confirmed approvals and costs remain recorded.';
    case 'TEMPORARY_FAILURE': return 'The network could not be checked right now. The previous financial state is preserved. Try checking again.';
    case 'RECONCILED': return 'Source and destination evidence confirm the completed transfer.';
    case 'UNDETERMINED': return 'No matching transaction was found in the available network view. A delayed or private submission cannot be ruled out. No transaction is repeated.';
  }
}
