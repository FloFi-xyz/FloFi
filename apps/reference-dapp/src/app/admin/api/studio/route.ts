// SPDX-License-Identifier: AGPL-3.0-only
import { handleStudioCertification } from '../../../../studio/certification-http';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const POST = (request: Request) => handleStudioCertification(request);
