// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { DocsHomePage } from '../../components/site/docs-pages';
import { SITE_COPY } from '../../components/site/site-copy';
import { siteLanguage } from '../../components/site/site-language';

export async function generateMetadata(): Promise<Metadata> {
  const t = SITE_COPY[await siteLanguage()].docsHome;
  return { title: { absolute: t.title }, description: t.description };
}
export default async function DocsHome() {
  return <DocsHomePage language={await siteLanguage()}/>;
}
