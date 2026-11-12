// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { siteLanguage } from '../../components/site/site-language';
import PrivacyPage, { generateMetadata as privacyMetadata } from './page';
import TermsPage, { generateMetadata as termsMetadata } from '../terms/page';

vi.mock('../../components/site/site-language', () => ({ siteLanguage: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { vi.unstubAllEnvs(); });

describe('Flight legal pages use the saved language and factual approved content', () => {
  it('renders one language per response, with the same compact menu and links between legal pages', async () => {
    for (const language of ['EN', 'PT'] as const) {
      vi.mocked(siteLanguage).mockResolvedValue(language);
      const privacy = renderToStaticMarkup(await PrivacyPage()), terms = renderToStaticMarkup(await TermsPage());
      for (const html of [privacy, terms]) {
        expect(html).toContain(`lang="${language === 'PT' ? 'pt-BR' : 'en'}"`);
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain('···');
        expect(html).not.toContain('Legal operator identity to be confirmed');
        expect(html).not.toContain('For public launch');
      }
      expect(privacy).toContain('href="/terms"'); expect(terms).toContain('href="/privacy"');
      if (language === 'PT') {
        expect(privacy).toContain('Quem cuida dos seus dados'); expect(privacy).not.toContain('Who handles your data');
        expect(terms).toContain('Quem somos e aceite'); expect(terms).not.toContain('Who we are and acceptance');
      } else {
        expect(privacy).toContain('Who handles your data'); expect(privacy).not.toContain('Quem cuida dos seus dados');
        expect(terms).toContain('Who we are and acceptance'); expect(terms).not.toContain('Quem somos e aceite');
      }
      expect((await privacyMetadata()).alternates?.canonical).toBe('https://flofi.xyz/privacy');
      expect((await termsMetadata()).alternates?.canonical).toBe('https://flofi.xyz/terms');
    }
  });
  it('keeps all sixteen approved Terms clauses and corrects the unsupported per-route maximum promise', async () => {
    vi.mocked(siteLanguage).mockResolvedValue('EN');
    const html = renderToStaticMarkup(await TermsPage());
    expect(html.match(/id="terms-\d+"/g)).toHaveLength(16);
    expect(html).toContain('Version of November 12, 2026');
    expect(html).toContain('FloFi does not execute anything on its own');
    expect(html).toContain('Only routes and contracts approved by FloFi can be used');
    expect(html).toContain('Brazilian Consumer Defense Code');
    expect(html).toContain('flofi.xyz@gmail.com');
    expect(html).not.toContain('each route has a maximum value');
  });
  it('retains the previous service-specific privacy information and describes actual retention, cookies and invite storage', async () => {
    vi.mocked(siteLanguage).mockResolvedValue('EN');
    const html = renderToStaticMarkup(await PrivacyPage());
    for (const text of ['Resend', 'Privy', 'one day', 'two hours', '90 days', '13 months', 'Global improvements', 'consent',
      'up to 12 hours', 'Invite codes are stored with their issuer and use state', 'Email access links and their six-digit codes']) expect(html).toContain(text);
    expect(html).not.toContain('Access logs are kept for 6 months');
    expect(html).not.toContain('opened emails');
    expect(html).not.toContain('Invite codes and access links are stored only as hashes');
    expect(html).not.toContain('your session (30 days)');
  });
});
