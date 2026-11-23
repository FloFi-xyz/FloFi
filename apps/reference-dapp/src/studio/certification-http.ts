// SPDX-License-Identifier: AGPL-3.0-only
import { adminMutation, codeOf, json, readJsonObject, type AdminHttpOptions } from '../admin/http.ts';
import { fixedWindow } from '../platform/fixed-window.ts';
import { decideStudioCertification, parseStudioDecision, studioCertificationInstalled } from './certification-store.ts';

export async function handleStudioCertification(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  const allowed = await adminMutation(request, options, 'write');
  if (allowed instanceof Response) return allowed;
  const { context, request: { host, now } } = allowed;
  const body = await readJsonObject(request);
  if (!body) return json(400, { ok: false, code: 'STUDIO_CERTIFICATION_REQUEST_INVALID' });
  try {
    if (!await studioCertificationInstalled(host.db)) return json(503, { ok: false, code: 'STUDIO_CERTIFICATION_NOT_INSTALLED' });
    const decision = parseStudioDecision(body);
    if (decision.action === 'approve' && !await fixedWindow(host.db, host.tenantId).allow('studio:review-rpc', 12, 60, now))
      return json(429, { ok: false, code: 'CONSOLE_RATE_LIMITED' });
    return json(200, { ok: true, ...await decideStudioCertification(host.db, host.tenantId, context, decision, options.now) });
  } catch (error) {
    const code = codeOf(error, 'STUDIO_CERTIFICATION_UNAVAILABLE');
    if (!code.startsWith('STUDIO_') || code === 'STUDIO_CERTIFICATION_UNAVAILABLE')
      return json(503, { ok: false, code: 'STUDIO_CERTIFICATION_UNAVAILABLE' });
    const status = ['STUDIO_CERTIFICATION_OPERATOR_REQUIRED', 'STUDIO_CERTIFICATION_REVIEWER_UNBOUND', 'STUDIO_CERTIFICATION_SELF_REVIEW'].includes(code) ? 403
      : ['STUDIO_MANIFEST_INVALID', 'STUDIO_CERTIFICATION_REQUEST_INVALID', 'STUDIO_CERTIFICATION_REFERENCE_NOT_INDEPENDENT'].includes(code) ? 400 : 409;
    return json(status, { ok: false, code });
  }
}
