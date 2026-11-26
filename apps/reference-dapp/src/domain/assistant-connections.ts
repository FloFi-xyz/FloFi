// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-#254 hotfix (Agents page): Claude and ChatGPT connect to FloFi's existing Remote MCP server (`/api/mcp`) through each platform's own custom
 * connector setup, then FloFi's OAuth consent page. Neither platform offers a link that adds a connector for the person, so the page gives the
 * steps and the endpoint to copy. A provider reads "Connected" only from an actual live OAuth grant of this browser's FloFi connection account,
 * identified by the client's registered redirect host (never by the name a client gives itself).
 */
import { FLOFI_PRODUCTION_ORIGIN } from '../platform/navigation';

export type AssistantProvider = 'Claude' | 'ChatGPT';
export const ASSISTANT_PROVIDERS: readonly AssistantProvider[] = Object.freeze(['Claude', 'ChatGPT']);
/** The production MCP endpoint (the same one `get_capabilities` names). A deployment with its own OAuth origin reports its own. */
export const FLOFI_MCP_ENDPOINT = `${FLOFI_PRODUCTION_ORIGIN}/api/mcp`;
export const ASSISTANT_SETUP: Readonly<Record<AssistantProvider, { readonly open: string; readonly steps: readonly string[] }>> = Object.freeze({
  Claude: { open: 'https://claude.ai/settings/connectors', steps: [
    'In Claude, open Settings › Connectors and choose Add custom connector.',
    'Name it FloFi, paste the FloFi address below and choose Add.',
    'Choose Connect, then sign in to FloFi and approve the connection.'] },
  ChatGPT: { open: 'https://chatgpt.com/', steps: [
    'In ChatGPT, open Settings › Apps › Advanced settings and turn on Developer mode (available on eligible plans).',
    'Choose Create, name it FloFi, paste the FloFi address below and choose OAuth.',
    'Choose Connect, then sign in to FloFi and approve the connection.'] },
});
const HOSTS: Readonly<Record<AssistantProvider, readonly string[]>> = { Claude: ['claude.ai', 'claude.com'], ChatGPT: ['chatgpt.com', 'chat.openai.com'] };
const hostOf = (value: string): string | null => { try { const url = new URL(value); return url.protocol === 'https:' ? url.hostname.toLowerCase() : null; } catch { return null; } };
const providerOfHost = (host: string) => ASSISTANT_PROVIDERS.find(provider => HOSTS[provider].some(known => host === known || host.endsWith(`.${known}`))) ?? null;
/**
 * The providers among connected clients, by the hosts of their redirect URIs (and of a CIMD client id, an https URL on its own host). A client
 * counts only when every host it names belongs to ONE provider; a client of any other or of mixed hosts names none.
 */
export function assistantProvidersOf(clients: readonly { readonly clientId: string; readonly redirectUris: readonly string[] }[]): AssistantProvider[] {
  const found = new Set<AssistantProvider>();
  for (const client of clients) {
    const hosts = [client.clientId, ...client.redirectUris].map(hostOf).filter((host): host is string => host !== null);
    const providers = new Set(hosts.map(providerOfHost));
    const [only] = providers;
    if (hosts.length && providers.size === 1 && only) found.add(only);
  }
  return ASSISTANT_PROVIDERS.filter(provider => found.has(provider));
}
