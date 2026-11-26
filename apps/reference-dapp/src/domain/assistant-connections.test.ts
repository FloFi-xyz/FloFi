// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ASSISTANT_PROVIDERS, ASSISTANT_SETUP, assistantProvidersOf, FLOFI_MCP_ENDPOINT } from './assistant-connections';

describe('post-#254 hotfix: assistant connections (Agents page)', () => {
  it('names a provider only from the hosts its client registered, never from the name a client gives itself', () => {
    expect(assistantProvidersOf([])).toEqual([]);
    expect(assistantProvidersOf([{ clientId: 'dcr_3f2a9c', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] }])).toEqual(['Claude']);
    expect(assistantProvidersOf([{ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', redirectUris: [] }])).toEqual(['Claude']);
    expect(assistantProvidersOf([{ clientId: 'dcr_8b1e44', redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }])).toEqual(['ChatGPT']);
    expect(assistantProvidersOf([{ clientId: 'dcr_a', redirectUris: ['https://chatgpt.com/cb'] }, { clientId: 'dcr_b', redirectUris: ['https://claude.ai/cb'] }]))
      .toEqual(['Claude', 'ChatGPT']);
    // Mixed, foreign, look-alike or non-https hosts name no provider.
    for (const redirectUris of [['https://claude.ai/cb', 'https://chatgpt.com/cb'], ['https://evil.example/cb'], ['https://claude.ai.evil.example/cb'],
      ['http://claude.ai/cb'], ['not a url']]) expect(assistantProvidersOf([{ clientId: 'dcr_x', redirectUris }])).toEqual([]);
    // A client whose registration is gone (no redirect URIs, opaque id) names none: "Connected" is never assumed.
    expect(assistantProvidersOf([{ clientId: 'dcr_gone', redirectUris: [] }])).toEqual([]);
  });

  it('reuses the production MCP endpoint and gives each platform its own setup steps and settings page', () => {
    expect(FLOFI_MCP_ENDPOINT).toBe('https://flofi.xyz/api/mcp');
    expect(ASSISTANT_PROVIDERS).toEqual(['Claude', 'ChatGPT']);
    for (const provider of ASSISTANT_PROVIDERS) {
      expect(new URL(ASSISTANT_SETUP[provider].open).protocol).toBe('https:');
      expect(ASSISTANT_SETUP[provider].steps.length).toBeGreaterThanOrEqual(3);
    }
    expect(new URL(ASSISTANT_SETUP.Claude.open).hostname).toBe('claude.ai');
    expect(new URL(ASSISTANT_SETUP.ChatGPT.open).hostname).toBe('chatgpt.com');
  });
});
