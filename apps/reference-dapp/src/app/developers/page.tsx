// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { DevelopersPage } from '../../components/site/developers-page';
import { SITE_COPY } from '../../components/site/site-copy';
import { siteLanguage } from '../../components/site/site-language';

export async function generateMetadata(): Promise<Metadata> {
  const t = SITE_COPY[await siteLanguage()].developers;
  return { title: t.title, description: t.description };
}
export default async function Page() {
  return <DevelopersPage language={await siteLanguage()}/>;
}
