// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: `POST /admin/api/support` — recovery preview/execution and support notes. See `src/admin/support/support-http.ts`. */
import { handleSupport } from '../../../../admin/support/support-http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request): Promise<Response> => handleSupport(request);
