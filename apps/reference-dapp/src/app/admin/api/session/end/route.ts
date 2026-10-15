// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: `POST /admin/api/session/end` — ends the administrator's server-side session. See `src/admin/http.ts`. */
import { handleAdminSignOut } from '../../../../../admin/http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request): Promise<Response> => handleAdminSignOut(request);
