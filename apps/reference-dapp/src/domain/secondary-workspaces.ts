// SPDX-License-Identifier: AGPL-3.0-only
export const SECONDARY_WORKSPACES = [
  { id: 'workflows', label: 'Your workflows', href: '/app/workflows' },
  { id: 'automations', label: 'Automations', href: '/app/automations' },
  { id: 'credentials', label: 'Credentials', href: '/app/credentials' },
  { id: 'agents', label: 'Agents', href: '/app/agents' },
  { id: 'passkeys', label: 'Passkeys', href: '/app/passkeys' },
] as const;

/** BUILD-CHAT-LEARNING-002: account pages reached from Settings, outside the chat and not listed in the navigation drawer. */
export const ACCOUNT_WORKSPACES = [
  { id: 'privacy', label: 'Privacy & memory', href: '/app/privacy' },
] as const;

export type SecondaryWorkspace = typeof SECONDARY_WORKSPACES[number] | typeof ACCOUNT_WORKSPACES[number];

export function secondaryWorkspaceRoute(pathname: string | null | undefined): SecondaryWorkspace | null {
  const path = pathname?.replace(/\/$/, '');
  return [...SECONDARY_WORKSPACES, ...ACCOUNT_WORKSPACES].find(item => item.href === path) ?? null;
}
