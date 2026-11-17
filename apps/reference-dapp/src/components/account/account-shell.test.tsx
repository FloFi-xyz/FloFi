// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-03): the first sign-in highlight shows every capability around the account with its own mark (EVM
// and Solana with their official brand marks), subtle orbit rings behind, all decorative; the text, controls and other slides are unchanged.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountShell } from './account-shell';

const html = renderToStaticMarkup(<AccountShell showcase="account"><p>task</p></AccountShell>);
const orbit = html.slice(html.indexOf('aria-hidden="true"', html.indexOf('<aside')), html.indexOf('One account for FloFi</span></div></div>'));

describe('sign-in account highlight', () => {
  it('marks each capability chip with an icon and keeps its label', () => {
    const chips = orbit.split('style="left:').slice(1);
    expect(chips).toHaveLength(8);
    for (const chip of chips) expect(chip).toMatch(/<(svg|img) class="[^"]*chipMark/);
    for (const label of ['Build', 'Simulate', 'Copilot', 'EVM', 'Dashboard', 'Solana', 'AI agents (MCP)', 'Execute']) expect(orbit).toContain(`>${label}</span>`);
    expect(chips.find(chip => chip.includes('>EVM<'))).toContain('src="/brand/crypto/ethereum.svg"');
    expect(chips.find(chip => chip.includes('>Solana<'))).toContain('src="/brand/crypto/solana.svg"');
    // Decorative only: the marks carry no name, the orbit (rings included) is hidden from assistive technology.
    expect(orbit).not.toMatch(/<img [^>]*alt="[^"]+"/);
    expect(orbit).toMatch(/<svg class="[^"]*orbitRings[^"]*"[^>]*aria-hidden="true"/);
  });

  it('keeps the carousel text and controls', () => {
    expect(html).toContain('One account. Every workflow.');
    expect(html).toContain('aria-label="Highlight 1 of 3"');
    expect(html).toMatch(/aria-pressed="false"[^>]*>Pause highlights</);
    // The phone band carries the same marks.
    const band = html.slice(html.indexOf('mobileChips'), html.indexOf('</div></div>', html.indexOf('mobileChips')));
    expect(band.match(/<(svg|img) class="[^"]*chipMark/g)).toHaveLength(4);
  });
});
