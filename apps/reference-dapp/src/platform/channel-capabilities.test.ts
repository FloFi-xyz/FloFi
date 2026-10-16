// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-UI-002 (UX/UI-008 A): the per-surface capability matrix states only what the code does. Each claim is checked against the
 * module that implements it, so a change there fails here until the published matrix is updated too.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPROVAL_TOOL_NAMES, MCP_TOOL_NAMES } from '../mcp/tools';
import { readChannelCoreConfig } from '../channels/core/config.ts';
import { channelCopy } from '../channels/core/copy.ts';
import { plannedNotifications } from '../channels/core/status.ts';
import { WHATSAPP_POLICY_CLEARANCE } from '../channels/whatsapp/config.ts';
import { articles } from '../components/docs/content';
import type { HandoffRecord } from './handoff-store.ts';
import { IN_CHAT_EXECUTION, SURFACE_CAPABILITIES } from './channel-capabilities.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tools = [...MCP_TOOL_NAMES, ...APPROVAL_TOOL_NAMES] as readonly string[];
const surface = (id: string) => SURFACE_CAPABILITIES.find(s => s.id === id)!;

describe('BUILD-FLOFI-UX-UI-002 conversational capability matrix', () => {
  it('MCP: in-chat composition, read-only preview and status use tools that exist; none signs, submits or approves', () => {
    for (const id of ['chatgpt', 'claude']) {
      const row = surface(id), named = JSON.stringify(row).match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
      expect(named.filter(name => !name.startsWith('flofi_'))).not.toHaveLength(0);
      for (const name of named) expect(tools, `${id}: ${name}`).toContain(name);
      expect(row.signing).toMatch(/^Your wallet, in FloFi\./);
    }
    expect(tools.filter(name => /sign|submit|execute|authori[sz]e|approve(?!al)/.test(name))).toEqual([]);
    // The panel's in-frame wallet is a diagnostic probe only, never an execution path.
    expect(source('../mcp/app/panel.ts')).toContain('in-frame execution is not enabled');
  });

  it('channels: composition and preview follow the deployment switches; progress needs the owner’s sharing; no message authorizes', () => {
    const env = { FLOFI_CHANNEL_SECRET: randomBytes(32).toString('hex'), FLOFI_PUBLIC_ORIGIN: 'https://flofi.test', FLOFI_CHANNEL_SUPPORT_CONTACT: 'support@flofi.test',
      FLOFI_CHANNEL_PRIVACY_URL: 'https://flofi.test/privacy' };
    expect(readChannelCoreConfig(env)).toMatchObject({ copilot: true, simulation: true });
    expect(readChannelCoreConfig({ ...env, FLOFI_CHANNEL_COPILOT: 'disabled', FLOFI_CHANNEL_SIMULATION: 'disabled' })).toMatchObject({ copilot: false, simulation: false });
    for (const id of ['telegram', 'whatsapp']) {
      const row = surface(id);
      expect(row.compose).toContain('FLOFI_CHANNEL_COPILOT');
      expect(row.simulation).toContain('FLOFI_CHANNEL_SIMULATION');
      expect(row.signing).toMatch(/^Your wallet, in FloFi\./);
    }
    expect(channelCopy('EN').authority).toMatch(/^Nothing can be authorized here/);
    // Status notices reach the chat only once the owner shares run status in FloFi.
    const handoff = { handoffId: 'apr_test', requesterKind: 'CHANNEL_CONVERSATION', shareStatus: false } as unknown as HandoffRecord;
    const progress = { status: 'APPLIED', runs: [] } as unknown as Parameters<typeof plannedNotifications>[2];
    expect(plannedNotifications('EN', handoff, progress).due).toEqual([]);
    expect(plannedNotifications('EN', { ...handoff, shareStatus: true }, progress).due.map(n => n.key)).toEqual(['notify:apr_test:loaded']);
  });

  it('WhatsApp stays not live until the owner records provider clearance; nothing executes inside a chat', () => {
    expect(WHATSAPP_POLICY_CLEARANCE).toBeNull();
    expect(surface('whatsapp').activation).toMatch(/^Not live/);
    expect(IN_CHAT_EXECUTION).toBe('NOT_AVAILABLE');
  });

  it('is published in the MCP integration guide, row for row', () => {
    const article = articles.find(a => a.slug === 'mcp-integrations')!;
    const section = article.sections.find(s => s.id === 'in-chat')!;
    const tables = section.blocks.filter(b => b.type === 'table');
    expect(tables).toHaveLength(1);
    const rows = (tables[0] as { rows: string[][] }).rows;
    expect(rows.map(r => r[0])).toEqual(SURFACE_CAPABILITIES.map(s => s.name));
    for (const [i, s] of SURFACE_CAPABILITIES.entries()) expect(rows[i]).toEqual([s.name, s.compose, s.simulation, s.progress, s.signing, s.coverage]);
  });
});
