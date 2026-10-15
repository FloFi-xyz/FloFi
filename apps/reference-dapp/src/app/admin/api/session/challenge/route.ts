// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: `POST /admin/api/session/challenge` — the admin sign-in message. See `src/admin/http.ts`. */
import { handleAdminChallenge } from '../../../../../admin/http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request): Promise<Response> => handleAdminChallenge(request);
