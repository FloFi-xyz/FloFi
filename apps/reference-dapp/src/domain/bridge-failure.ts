// SPDX-License-Identifier: AGPL-3.0-only
/** Shared safe messages: technical codes stay available separately for support. */
export function bridgeFailureMessage(code: string): string | null {
  if (code.endsWith('_AMOUNT_TOO_LOW')) return 'The amount is below the provider minimum. Choose a larger amount or another provider.';
  if (code.endsWith('_AMOUNT_TOO_HIGH')) return 'The amount is above the provider maximum. Choose a smaller amount or another provider.';
  if (code.endsWith('_INSUFFICIENT_LIQUIDITY')) return 'The provider has insufficient liquidity for these assets and this amount. Try another provider or try again later.';
  if (code.endsWith('_NO_ROUTE')) return 'The provider has no route for the requested networks and assets right now.';
  if (/_(HTTP_\d+|RATE_LIMITED|UNAVAILABLE|RESPONSE_INVALID|RESPONSE_TOO_LARGE)$/.test(code)) return 'The provider or network service is unavailable. Try again shortly.';
  if (/_(REQUIRES_CERTIFIED_ROUTER_VALIDATION)$/.test(code)) return 'This quote needs transaction validation through the certified Router before execution.';
  if (code === 'UNIVERSAL_SIMULATION_APPROVAL_REVERTED') return 'The source token approval reverted during simulation. Nothing was signed.';
  if (code === 'UNIVERSAL_SIMULATION_INVALID') return 'The network returned an invalid simulation response. Nothing was signed. Try another network service.';
  if (/^RELAY_.*(MISMATCH|INVALID|UNEXPECTED)$/.test(code)) return 'The provider quote does not match the requested bridge or its verified transaction. Nothing was signed.';
  if (/^(RELAY_.*UNSUPPORTED|LIFI_.*NOT_IMPLEMENTED|MAYAN_.*NOT_VERIFIED|ACROSS_.*ONLY)$/.test(code)) return 'A quote may be available, but FloFi cannot yet verify this provider transaction for execution.';
  return null;
}
