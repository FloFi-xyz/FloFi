// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-FLIGHT-001: the client a network address counts as for the list form's rate limit (server only). */
import { isIP } from 'node:net';

/**
 * The rate-limit client of a network address: an IPv4 address as is, an IPv6 address by its /64 network (one subscriber's prefix,
 * which hands out unlimited addresses), or null when it is neither.
 */
export function rateLimitClient(address: string): string | null {
  const value = address.trim().replace(/^\[|\](?::\d+)?$/g, '');
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind !== 6) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return mapped[1]!; // An IPv4 client seen through IPv6.
  const [head, tail = ''] = value.toLowerCase().split('%')[0]!.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  if (right.at(-1)?.includes('.')) right.splice(-1, 1, '0', '0'); // An embedded IPv4 tail sits outside the /64.
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
