// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { FaqPage } from '../../components/site/faq-page';
import { SITE_COPY } from '../../components/site/site-copy';
import { siteLanguage } from '../../components/site/site-language';

// BUILD-FLOFI-LAUNCH-001: the FAQ of the team-approved launch landing.
export async function generateMetadata(): Promise<Metadata> {
  const t = SITE_COPY[await siteLanguage()].faq;
  return { title: t.title, description: t.description, openGraph: { title: t.title, description: t.description, type: 'website' } };
}
export default async function Page() {
  return <FaqPage language={await siteLanguage()}/>;
}
