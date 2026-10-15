// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: `POST /admin/api/session` — verifies the administrator's signature and grant, then opens a session. See `src/admin/http.ts`. */
import { handleAdminSignIn } from '../../../../admin/http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request): Promise<Response> => handleAdminSignIn(request);
