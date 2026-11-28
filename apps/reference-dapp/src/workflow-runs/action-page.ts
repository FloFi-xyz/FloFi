// SPDX-License-Identifier: AGPL-3.0-only
/** Which FloFi page a server action was posted to, by the proxy's authoritative path: the app page, an approval page, or nothing recordable. */
export type ActionPage = 'APP' | 'APPROVAL';
/**
 * flofi-security review: the path is the proxy's own (`x-flofi-pathname`, set on every product page and stripped from every pass-through request),
 * but the browser chooses which page a server action is posted to. A web record is therefore the weakest origin: an approval that later binds the
 * run (an exact reviewed workflow hash after its claim) takes precedence over it in the Admin counts (`channels.ts`). Pure, with no imports, so the
 * server-action modules that read it do not pull the database runtime into a client bundle.
 */
export function pageOfPath(pathname: string | null | undefined): ActionPage | null {
  if (typeof pathname !== 'string') return null;
  if (pathname === '/app' || pathname.startsWith('/app/')) return 'APP';
  return pathname === '/approve' || pathname === '/mcp/approve' ? 'APPROVAL' : null;
}
