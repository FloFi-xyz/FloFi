// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: `POST /admin/api/support` — the Support & Recovery Center's only state-changing endpoint. Same
 * boundary as every admin mutation (`http.ts`): POST + JSON + same Origin + no cross-site fetch metadata + session CSRF token, the role read
 * from the database on every request.
 *
 *   preview  `{ action: 'preview', recovery, runId }`                                        any role: eligibility, declared effects, stateToken
 *   recover  `{ action: 'recover', recovery, runId, stateToken, idempotencyKey, reason }`   OPERATOR: one registered action, atomic and audited
 *   note     `{ action: 'note', incidentId, kind, text }`                                   OPERATOR: an append-only operational note
 *   search   `{ action: 'search', q }`                                                      any role (wallets: OPERATOR): one audited lookup — a POST
 *                                                                                         so identifiers never appear in URLs, logs or history
 *
 * `recovery` must name a registered action (`registry.ts`); there is no generic retry, no free-form operation and no way to pass a work
 * kind, payload, SQL or code. Every refusal of a recovery request is audited.
 */
import { adminPermits } from '../guard.ts';
import { adminMutation, json, readJsonObject, type AdminHttpOptions } from '../http.ts';
import { recordAudit } from '../store.ts';
import { freeText, isIncidentId, NOTE_KINDS, noteText, supportSearch, type NoteKind } from './diagnostics.ts';
import { auditRecoveryRefusal, executeRecovery, IDEMPOTENCY_KEY, previewRecovery, RecoveryRefusal, RUN_ID, STATE_TOKEN } from './recovery.ts';
import { isRecoveryActionId, RECOVERY_ACTIONS } from './registry.ts';
import { periodFingerprinter, supportPrivacyConfig, writeSupportText } from './privacy.ts';

export const NOTE_RATE_WINDOW_MS = 600_000, NOTE_RATE_LIMIT = 60;

export async function handleSupport(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  // The body decides the permission, so the read-level check runs first and the recovery/note paths re-check below.
  const allowed = await adminMutation(request, options, 'read');
  if (allowed instanceof Response) return allowed;
  const { context, request: base } = allowed, actor = context.principal.principalId, host = base.host;
  const body = await readJsonObject(request);
  const action = body?.action;
  const denied = async () => {
    await base.store.audit({ actor, kind: 'ADMIN_PERMISSION_DENIED', outcome: 'REFUSED', code: 'ADMIN_ROLE_INSUFFICIENT', target: `support:${String(action)}`.replace(/[^A-Za-z0-9:._-]/g, ':').slice(0, 120) })
      .catch(() => undefined);
    return json(403, { ok: false, code: 'ADMIN_ROLE_INSUFFICIENT' });
  };

  if (action === 'preview') {
    if (!isRecoveryActionId(body!.recovery) || typeof body!.runId !== 'string' || !RUN_ID.test(body!.runId)) return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
    try {
      const preview = await previewRecovery(host, body!.runId, body!.recovery, base.now);
      if (!preview) return json(404, { ok: false, code: 'SUPPORT_RUN_NOT_FOUND' });
      const definition = RECOVERY_ACTIONS[body!.recovery];
      return json(200, { ok: true, preview, definition: { id: definition.id, name: definition.name, description: definition.description, resource: definition.resource,
        preconditions: definition.preconditions, postcondition: definition.postcondition, idempotency: definition.idempotency, fundsInvolved: definition.fundsInvolved,
        reversible: definition.reversible, risks: definition.risks, failureOutcomes: definition.failureOutcomes, confirmation: definition.confirmation },
      canExecute: adminPermits(context, 'recover') });
    } catch { return json(503, { ok: false, code: 'SUPPORT_STORE_UNAVAILABLE' }); }
  }

  if (action === 'search') {
    if (typeof body!.q !== 'string' || body!.q.length > 200) return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
    // BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: the quarter's lookup key (wrapped under a subkey of the admin secret), not the secret's v1 subkey.
    const result = await supportSearch(host, context.principal, body!.q, base.now, periodFingerprinter(host.db, host.tenantId, base.key, () => base.now));
    return result.ok ? json(200, result) : json(result.code === 'SUPPORT_SEARCH_RATE_LIMITED' ? 429 : result.code === 'SUPPORT_SEARCH_WALLET_NOT_PERMITTED' ? 403
      : result.code === 'SUPPORT_SEARCH_UNAVAILABLE' ? 503 : 400, result);
  }

  if (action === 'recover') {
    if (!adminPermits(context, 'recover')) return denied();
    const recovery = body!.recovery, runId = body!.runId, token = body!.stateToken, key = body!.idempotencyKey;
    const reason = freeText(body!.reason, 3, 200);
    // Only a registered name is ever copied into the audit record (raw client text could make the insert fail and lose the refusal).
    const detail = { action: isRecoveryActionId(recovery) ? recovery : 'UNREGISTERED', runId: typeof runId === 'string' && RUN_ID.test(runId) ? runId : null,
      idempotencyKey: typeof key === 'string' && IDEMPOTENCY_KEY.test(key) ? key : null };
    if (!isRecoveryActionId(recovery) || typeof runId !== 'string' || !RUN_ID.test(runId) || typeof token !== 'string' || !STATE_TOKEN.test(token)
      || typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
      await auditRecoveryRefusal(host.db, host.tenantId, actor, 'ADMIN_REQUEST_INVALID', detail, base.now);
      return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
    }
    if (!reason) {
      await auditRecoveryRefusal(host.db, host.tenantId, actor, 'SUPPORT_REASON_REQUIRED', detail, base.now);
      return json(400, { ok: false, code: 'SUPPORT_REASON_REQUIRED' });
    }
    try {
      const result = await executeRecovery(host, actor, { runId, action: recovery, stateToken: token, idempotencyKey: key, reason }, base.now,
        supportPrivacyConfig(process.env).textRetentionDays);
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof RecoveryRefusal) {
        await auditRecoveryRefusal(host.db, host.tenantId, actor, error.code, detail, base.now);
        return json(error.status, { ok: false, code: error.code, reason: error.reason });
      }
      await auditRecoveryRefusal(host.db, host.tenantId, actor, 'SUPPORT_RECOVERY_FAILED', detail, base.now, 'FAILED');
      return json(503, { ok: false, code: 'SUPPORT_RECOVERY_FAILED' });
    }
  }

  if (action === 'note') {
    if (!adminPermits(context, 'recover')) return denied();
    const text = noteText(body!.text), kind = body!.kind;
    if (!isIncidentId(body!.incidentId) || !NOTE_KINDS.includes(kind as NoteKind)) return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
    if (!text) return json(400, { ok: false, code: 'SUPPORT_NOTE_INVALID' });
    try {
      const { rows } = await host.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = 'SUPPORT_NOTE' AND actor = $2 AND at >= $3`,
        [host.tenantId, actor, new Date(base.now.getTime() - NOTE_RATE_WINDOW_MS)]);
      if ((rows[0]?.n ?? 0) >= NOTE_RATE_LIMIT) return json(429, { ok: false, code: 'SUPPORT_NOTE_RATE_LIMITED' });
      // The text goes to the separately governed store and the audit skeleton keeps its reference and digest — one transaction, so neither
      // can exist without the other. The text is never copied into the append-only audit JSON.
      const incidentId = body!.incidentId, runId = incidentId.startsWith('run:') ? incidentId.slice(4) : null;
      await host.db.transaction(async tx => {
        const stored = await writeSupportText(tx, host.tenantId, { purpose: 'SUPPORT_NOTE', body: text, runId: runId && RUN_ID.test(runId) ? runId : null, incidentId,
          actor, now: base.now, retentionDays: supportPrivacyConfig(process.env).textRetentionDays });
        await recordAudit(tx, host.tenantId, { actor, kind: 'SUPPORT_NOTE', outcome: 'OK', target: incidentId.slice(0, 120),
          detail: { incidentId, noteKind: kind as NoteKind, textRef: stored.textRef, textDigest: stored.textDigest } });
      });
      return json(200, { ok: true });
    } catch { return json(503, { ok: false, code: 'SUPPORT_STORE_UNAVAILABLE' }); }
  }
  return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
}
