// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: `POST /admin/api/settings/copilot` — versioned Copilot runtime settings (OPERATOR). See `src/admin/settings-http.ts`. */
import { handleCopilotSettings } from '../../../../../admin/settings-http';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const POST = (request: Request): Promise<Response> => handleCopilotSettings(request);
