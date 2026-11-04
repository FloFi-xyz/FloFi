// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsArticlePage } from '../../../components/site/docs-pages';
import { docPage } from '../../../components/site/docs-content';
import { siteLanguage } from '../../../components/site/site-language';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params; const page = docPage(await siteLanguage(), slug);
  return page ? { title: page.title, description: page.lead } : {};
}
export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const language = await siteLanguage(); const page = docPage(language, slug);
  if (!page) notFound();
  return <DocsArticlePage language={language} page={page}/>;
}
