// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: Channel Core configuration fails closed — every missing, malformed or reused value disables the channels, and
 * nothing falls back to another secret. The handoff policy refuses mainnet unless each network is listed explicitly.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readChannelCoreConfig, readChannelHandoffPolicy } from './config.ts';
import { NETWORKS } from '../../engine/strategy-engine';

const SECRET = randomBytes(32).toString('hex');
const base = () => ({ FLOFI_CHANNEL_SECRET: SECRET, FLOFI_PUBLIC_ORIGIN: 'https://flofi.test', FLOFI_CHANNEL_SUPPORT_CONTACT: 'support@flofi.test',
  FLOFI_CHANNEL_PRIVACY_URL: 'https://flofi.test/privacy' }) as Record<string, string | undefined>;
const reason = (env: Record<string, string | undefined>, provider: string[] = []) => {
  const c = readChannelCoreConfig(env, provider);
  return c.enabled ? 'OK' : c.reason;
};

describe('BUILD-CHANNELS-001 Channel Core configuration', () => {
  it('accepts a complete configuration with safe defaults', () => {
    const c = readChannelCoreConfig(base());
    expect(c).toMatchObject({ enabled: true, tenantId: 'default', origin: 'https://flofi.test', copilot: true, simulation: true, language: 'EN', hosted: false,
      policy: { ok: true, testFunds: false, mainnetNetworks: Object.keys(NETWORKS).filter(n => NETWORKS[n as keyof typeof NETWORKS].class === 'MAINNET') } });
  });

  it('BUILD-TELEGRAM-PUBLIC-001: bounds model calls globally (defaults 300/hour and 2000/day) and fails closed on a malformed budget', () => {
    expect(readChannelCoreConfig(base())).toMatchObject({ enabled: true, modelBudget: { hourly: 300, daily: 2000 } });
    expect(readChannelCoreConfig({ ...base(), FLOFI_CHANNEL_MODEL_BUDGET_HOURLY: '50', FLOFI_CHANNEL_MODEL_BUDGET_DAILY: '400' })).toMatchObject({ modelBudget: { hourly: 50, daily: 400 } });
    for (const [name, value] of [['FLOFI_CHANNEL_MODEL_BUDGET_HOURLY', '0'], ['FLOFI_CHANNEL_MODEL_BUDGET_HOURLY', '-1'], ['FLOFI_CHANNEL_MODEL_BUDGET_HOURLY', '1.5'],
      ['FLOFI_CHANNEL_MODEL_BUDGET_HOURLY', '100001'], ['FLOFI_CHANNEL_MODEL_BUDGET_HOURLY', 'many'], ['FLOFI_CHANNEL_MODEL_BUDGET_DAILY', '0'],
      ['FLOFI_CHANNEL_MODEL_BUDGET_DAILY', '299']] as const) expect(reason({ ...base(), [name]: value }), `${name}=${value}`).toBe(name);
  });

  it('fails closed on every missing or malformed value', () => {
    for (const [name, value, expected] of [
      ['FLOFI_CHANNEL_SECRET', undefined, 'FLOFI_CHANNEL_SECRET'], ['FLOFI_CHANNEL_SECRET', 'short', 'FLOFI_CHANNEL_SECRET'],
      ['FLOFI_PUBLIC_ORIGIN', undefined, 'FLOFI_PUBLIC_ORIGIN'], ['FLOFI_PUBLIC_ORIGIN', 'https://flofi.test/path', 'FLOFI_PUBLIC_ORIGIN'],
      ['FLOFI_PUBLIC_ORIGIN', 'http://flofi.test', 'FLOFI_PUBLIC_ORIGIN'], ['FLOFI_PUBLIC_ORIGIN', 'https://user:pw@flofi.test', 'FLOFI_PUBLIC_ORIGIN'],
      ['FLOFI_CHANNEL_SUPPORT_CONTACT', undefined, 'FLOFI_CHANNEL_SUPPORT_CONTACT'], ['FLOFI_CHANNEL_SUPPORT_CONTACT', 'http://help.test', 'FLOFI_CHANNEL_SUPPORT_CONTACT'],
      ['FLOFI_CHANNEL_PRIVACY_URL', undefined, 'FLOFI_CHANNEL_PRIVACY_URL'], ['FLOFI_CHANNEL_PRIVACY_URL', 'javascript:alert(1)', 'FLOFI_CHANNEL_PRIVACY_URL'],
      ['FLOFI_CHANNEL_COPILOT', 'on', 'FLOFI_CHANNEL_COPILOT'], ['FLOFI_CHANNEL_SIMULATION', 'yes', 'FLOFI_CHANNEL_SIMULATION'],
      ['FLOFI_CHANNEL_LANGUAGE', 'ES', 'FLOFI_CHANNEL_LANGUAGE'], ['FLOFI_CHANNEL_HANDOFF_TEST_FUNDS', 'maybe', 'FLOFI_CHANNEL_HANDOFF_POLICY'],
      ['FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS', 'base-sepolia', 'FLOFI_CHANNEL_HANDOFF_POLICY'], ['FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS', 'dogecoin', 'FLOFI_CHANNEL_HANDOFF_POLICY'],
      ['TENANT_ID', 'Bad Tenant', 'TENANT'],
    ] as const) expect(reason({ ...base(), [name]: value }), `${name}=${value}`).toBe(expected);
  });

  it('refuses a channel secret shared with any other purpose, including a provider secret', () => {
    for (const name of ['API_AUTH_TOKEN', 'FLOFI_SESSION_SECRET', 'FLOFI_MCP_OAUTH_SECRET']) expect(reason({ ...base(), [name]: SECRET })).toBe('FLOFI_CHANNEL_SECRET_REUSED');
    expect(reason(base(), [SECRET])).toBe('FLOFI_CHANNEL_SECRET_REUSED');
  });

  it('allows loopback http only off-hosting', () => {
    expect(reason({ ...base(), FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3100' })).toBe('OK');
    expect(reason({ ...base(), FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3100', VERCEL: '1', VERCEL_ENV: 'production' })).toBe('FLOFI_PUBLIC_ORIGIN');
  });

  it('offers every registered mainnet publicly, regardless of legacy network whitelist or test-fund settings', () => {
    const mainnets = Object.keys(NETWORKS).filter(n => NETWORKS[n as keyof typeof NETWORKS].class === 'MAINNET');
    expect(readChannelHandoffPolicy({})).toEqual({ ok: true, testFunds: false, mainnetNetworks: mainnets });
    expect(readChannelHandoffPolicy({ VERCEL: '1', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS: 'base' }))
      .toEqual({ ok: true, testFunds: false, mainnetNetworks: mainnets });
    expect(readChannelHandoffPolicy({ FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS: 'base, arbitrum-one', FLOFI_CHANNEL_HANDOFF_TEST_FUNDS: 'disabled' }))
      .toEqual({ ok: true, testFunds: false, mainnetNetworks: ['base', 'arbitrum-one'] });
    expect(readChannelHandoffPolicy({ FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS: 'solana-devnet' })).toBeNull();
  });
});
