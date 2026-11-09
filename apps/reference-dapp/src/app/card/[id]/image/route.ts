// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: a boarding card as an image (`/card/{id}/image`): 1200 × 630 for link previews and emails, 1600 × 900 with
 * `?download=1` (saved as flofi-boarding-card-042.png). Public, like the card page, so X's crawler can read it; a card taken down is 404.
 */
import { cardImage } from '../../../../flight/card-image';
import { flightStore } from '../../../../flight/host';

export const dynamic = 'force-dynamic';

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^[a-z2-7]{12}$/.test(id)) return notFound();
  const store = await flightStore().catch(() => null);
  const card = store ? await store.publicCard(id).catch(() => null) : null;
  if (!card) return notFound();
  const download = new URL(request.url).searchParams.get('download') === '1';
  const seat = card.founding ? card.seat.replace('#', '') : card.seat.toLowerCase();
  return cardImage(card, download ? 'download' : 'link', download ? { 'content-disposition': `attachment; filename="flofi-boarding-card-${seat}.png"` } : {});
}
