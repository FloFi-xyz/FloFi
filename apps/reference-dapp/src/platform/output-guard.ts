// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-002 / BUILD-DEVELOPER-001: the last line on every surface's output. It has no imports so any module, including ones loaded by
 * plain-Node tooling, can apply it (moved unchanged from src/mcp/simulation.ts, which re-exports it).
 */
/** Keys that only executable material, secrets or wallet internals use. */
const FORBIDDEN_KEY = /^(data|calldata|tx|txs|transaction|transactions|unsignedtransaction|signedtransaction|rawtransaction|serializedtransaction|signature|signatures|privatekey|secret|mnemonic|seed|seedphrase|commitment|apikey|accesstoken|bearer)$/i;
/**
 * Fails closed when an MCP result contains anything executable or secret: forbidden keys, hex payloads longer than a hash
 * (66 chars), or long base64 blobs (serialized transactions). Hashes, addresses, selectors and mints pass.
 */
export function assertSafeOutput(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('MCP_OUTPUT_GUARD');
  if (typeof value === 'string') {
    if (/0x[0-9a-fA-F]{67,}/.test(value) || /^[A-Za-z0-9+/]{200,}={0,2}$/.test(value)) throw new Error('MCP_OUTPUT_GUARD');
    // BUILD-MCP-002: OAuth access/refresh tokens, codes and consent tokens never appear in a tool result.
    // BUILD-DEVELOPER-001: nor a Developer API key or a webhook signing secret (the one response that issues a secret checks it apart).
    if (/flofi_(at|rt|code|csrf|sk)_[A-Za-z0-9_-]/.test(value) || /whsec_[A-Za-z0-9+/]/.test(value)) throw new Error('MCP_OUTPUT_GUARD');
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertSafeOutput(item, depth + 1); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error('MCP_OUTPUT_GUARD');
    assertSafeOutput(item, depth + 1);
  }
}
