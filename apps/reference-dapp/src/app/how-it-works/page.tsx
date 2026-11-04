// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { HowItWorksPage } from '../../components/site/how-it-works-page';
import { SITE_COPY } from '../../components/site/site-copy';
import { siteLanguage } from '../../components/site/site-language';

export async function generateMetadata(): Promise<Metadata> {
  const t = SITE_COPY[await siteLanguage()].how;
  return { title: t.title, description: t.description };
}
export default async function Page() {
  return <HowItWorksPage language={await siteLanguage()}/>;
}
