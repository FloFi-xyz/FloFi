// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HTTPS session/proof cookies are host-prefixed: a same-site sibling origin (including the isolated card origin) cannot plant a
 * Domain cookie that shadows them. Secure requests never fall back to the old unprefixed name. Plain names serve loopback HTTP only;
 * session claims are independently sealed for the request host. Every host-prefixed cookie must be Secure, host-only and Path=/.
 */
export const sessionCookieName = (name: string, secure: boolean): string => secure ? `__Host-${name}` : name;
