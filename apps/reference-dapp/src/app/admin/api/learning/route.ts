// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-CHAT-LEARNING-001: `POST /admin/api/learning` — global glossary review, evaluation and publication (OPERATOR). See `src/admin/learning-http.ts`. */
import { handleLearningAdmin } from '../../../../admin/learning-http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const POST = (request: Request): Promise<Response> => handleLearningAdmin(request);
