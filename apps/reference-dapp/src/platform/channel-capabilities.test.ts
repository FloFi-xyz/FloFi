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
import { DOCS, type DocInline } from '../components/site/docs-content';
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
      expect(row.signing).toContain('embedded in MCP Apps');
    }
    expect(tools.filter(name => /sign|submit|execute|authori[sz]e|approve(?!al)/.test(name))).toEqual([]);
    // The wrapper embeds the existing runtime; it never becomes a model-callable financial endpoint.
    expect(source('../mcp/app/panel.ts')).toContain('/mcp/approve');
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
    expect(IN_CHAT_EXECUTION).toBe('HOST_AND_WALLET_DEPENDENT');
  });

  // BUILD-FLOFI-SITE-001: the approved site's MCP guide presents the same matrix as one card per surface (English is the source text).
  it('is published in the MCP integration guide, surface for surface', () => {
    const page = DOCS.EN.pages.find(a => a.slug === 'mcp-integrations')!;
    const section = page.sections.find(s => s.id === 'in-chat')!;
    const blocks = section.blocks.filter(b => b.kind === 'cards');
    expect(blocks).toHaveLength(1);
    const text = (parts: readonly DocInline[]) => parts.map(part => typeof part === 'string' ? part : 'code' in part ? part.code : 'strong' in part ? part.strong : 'em' in part ? part.em : part.link).join('');
    const cards = (blocks[0] as Extract<(typeof blocks)[number], { kind: 'cards' }>).cards;
    expect(cards.map(card => card.title)).toEqual(SURFACE_CAPABILITIES.map(s => s.name));
    // Each card also states how the surface becomes available, so WhatsApp reads "Not live" (the boards omitted it).
    for (const [i, s] of SURFACE_CAPABILITIES.entries()) expect(cards[i]!.rows.map(row => text(row.text))).toEqual([s.compose, s.simulation, s.progress, s.signing, s.coverage, s.activation]);
    // Portuguese carries one card per surface too, in the same order, with the same availability.
    const pt = DOCS.PT.pages.find(a => a.slug === 'mcp-integrations')!.sections.find(s => s.id === 'in-chat')!.blocks.filter(b => b.kind === 'cards');
    expect(pt).toHaveLength(1);
    const ptCards = (pt[0] as Extract<(typeof pt)[number], { kind: 'cards' }>).cards;
    expect(ptCards.map(card => card.title)).toEqual(SURFACE_CAPABILITIES.map(s => s.name));
    expect(ptCards.map(card => card.rows.length)).toEqual(SURFACE_CAPABILITIES.map(() => 6));
    expect(text(ptCards.find(card => card.title === 'WhatsApp')!.rows.at(-1)!.text)).toMatch(/^Ainda não está no ar/);
  });
});
