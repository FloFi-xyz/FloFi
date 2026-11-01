// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The one loopback origin the browser suites serve and visit the reference app on. Playwright's `baseURL`, its
 * `webServer.url`, the Next.js `PORT` and every fixture's same-origin check derive from it.
 *
 * `FLOFI_E2E_APP_PORT` lets CI use an isolated port when another server already holds 3000 on a shared runner; unset
 * keeps the release isolated on 3108. The value is strict: decimal digits without sign, spaces or leading zeros, an unprivileged port
 * (1024–65535), and never one of the suites' own loopback harness or fork ports.
 */
export const E2E_DEFAULT_APP_PORT = 3000;
/** Loopback ports the browser suites already bind (MOCKED harnesses, synthetic and replayed forks). */
export const E2E_RESERVED_PORTS: readonly number[] = Object.freeze([8545, 8546, 8547, 8549, 8551, 8552, 8553, 8554, 8555, 8556, 8557, 8560]);

export function e2eAppPort(value: string | undefined): number {
  if (value === undefined) return E2E_DEFAULT_APP_PORT;
  if (!/^[1-9][0-9]{3,4}$/.test(value)) throw new Error('FLOFI_E2E_APP_PORT_INVALID');
  const port = Number(value);
  if (port < 1024 || port > 65535 || E2E_RESERVED_PORTS.includes(port)) throw new Error('FLOFI_E2E_APP_PORT_INVALID');
  return port;
}
export const e2eAppOrigin = (port: number) => `http://127.0.0.1:${port}`;

export const E2E_APP_PORT = e2eAppPort(process.env.FLOFI_E2E_APP_PORT ?? process.env.FLOFI_E2E_PORT ?? '3108');
export const E2E_APP_ORIGIN = e2eAppOrigin(E2E_APP_PORT);
/** BUILD-FLOFI-PRIVY-UX-001: the card origin of the MOCKED card suite, the same server under its other loopback name (another origin). */
export const E2E_CARD_ORIGIN = `http://localhost:${E2E_APP_PORT}`;
// Preserve release isolation and the earlier harness API; CI's canonical variable takes precedence.
export const APP_PORT = String(E2E_APP_PORT);
export const APP_ORIGIN = E2E_APP_ORIGIN;

/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the app the browser suites serve. The existing suites certify every engine, test networks included, so they run the
 * isolated engineering scope (a local, loopback-only server: FLOFI_NETWORK_SCOPE is ignored on any hosted deployment). A suite that certifies the
 * public product itself sets FLOFI_E2E_NETWORK_SCOPE=PUBLIC_MAINNET and the app runs exactly as deployed: Mainnet only, no opt-in.
 */
export function e2eNetworkScopeEnv(value = process.env.FLOFI_E2E_NETWORK_SCOPE): Record<string, string> {
  if (value === undefined || value === 'ENGINEERING') return { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' };
  // An explicit empty value: nothing the parent shell exported can opt this server into engineering.
  if (value === 'PUBLIC_MAINNET') return { FLOFI_NETWORK_SCOPE: '' };
  throw new Error('FLOFI_E2E_NETWORK_SCOPE_INVALID');
}
