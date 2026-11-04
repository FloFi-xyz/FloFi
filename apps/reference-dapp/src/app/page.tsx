// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { HomePage } from '../components/site/home-page';
import { SITE_COPY } from '../components/site/site-copy';
import { siteLanguage } from '../components/site/site-language';

// BUILD-FLOFI-SITE-001: the owner-approved site (Claude Artifact "FloFi — site aprovado", version 1793715580-4561) replaces Landing 07.
export async function generateMetadata(): Promise<Metadata> {
  const t = SITE_COPY[await siteLanguage()].home;
  return { title: t.title, description: t.description, openGraph: { title: t.title, description: t.description, type: 'website' } };
}
export default async function Page() {
  return <HomePage language={await siteLanguage()}/>;
}
