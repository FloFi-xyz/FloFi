// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: Resend, the campaign's email provider (free plan), over its REST API. Server only: the key is read from
 * `RESEND_API_KEY` in the process that sends (the Railway worker or the operator CLI), never sent to a browser, never logged.
 *
 * Every send carries an `Idempotency-Key` (the outbox email id): Resend keeps it 24 hours and never sends the same key twice, so a request
 * whose answer was lost (timeout, connection reset, 5xx) is retried with the same key instead of being assumed unsent.
 * Answers are classified into what the outbox does next (`SendOutcome`); a provider message is never stored, only a fixed code.
 */
export type ResendConfig = { readonly apiKey: string; readonly from: string; readonly replyTo: string; readonly baseUrl?: string; readonly timeoutMs?: number;
  readonly fetch?: typeof fetch };
export type OutgoingEmail = {
  readonly idempotencyKey: string; readonly to: string; readonly subject: string; readonly html: string; readonly text: string;
  readonly headers?: Readonly<Record<string, string>>; readonly attachments?: readonly { readonly filename: string; readonly path: string }[];
  readonly tags?: readonly { readonly name: string; readonly value: string }[];
};
/**
 * - SENT: accepted, with Resend's id.
 * - RETRY: definitely not sent (rate limited); try again after `retryAfterMs`.
 * - UNKNOWN: the request may have been processed (timeout, network, 5xx, a concurrent request with the same key); retry with the same key.
 * - QUOTA: the account's daily or monthly quota is spent (nothing sent); hold until the team decides.
 * - CONFIG: the key, permissions or the sending domain are wrong (nothing sent); hold everything until an operator fixes it.
 * - REJECTED: this email can never be sent as it is (validation); fail it.
 * - CONFLICT: the same key was already used with a different body: the first one probably went out; hold for an operator.
 */
export type SendOutcome =
  | { readonly kind: 'SENT'; readonly providerId: string }
  | { readonly kind: 'RETRY'; readonly code: string; readonly retryAfterMs: number }
  | { readonly kind: 'UNKNOWN'; readonly code: string }
  | { readonly kind: 'QUOTA'; readonly code: 'PROVIDER_QUOTA_DAILY' | 'PROVIDER_QUOTA_MONTHLY' }
  | { readonly kind: 'CONFIG'; readonly code: string }
  | { readonly kind: 'REJECTED'; readonly code: string }
  | { readonly kind: 'CONFLICT'; readonly code: string };

export const RESEND_API = 'https://api.resend.com';
const PROVIDER_ID = /^[A-Za-z0-9-]{1,100}$/;

/** Classify one Resend answer (pure, for tests). `name` is Resend's error type (`rate_limit_exceeded`, `daily_quota_exceeded`, …). */
export function classifyResend(status: number, body: { id?: unknown; name?: unknown } | null, retryAfter: string | null): SendOutcome {
  if (status >= 200 && status < 300) {
    const id = typeof body?.id === 'string' && PROVIDER_ID.test(body.id) ? body.id : null;
    // Accepted without a readable id: it was sent, but we cannot reconcile it by id — still SENT (never resend), with a marker id.
    return { kind: 'SENT', providerId: id ?? 'accepted-without-id' };
  }
  const name = typeof body?.name === 'string' ? body.name : '';
  if (status === 429) {
    if (name === 'daily_quota_exceeded') return { kind: 'QUOTA', code: 'PROVIDER_QUOTA_DAILY' };
    if (name === 'monthly_quota_exceeded') return { kind: 'QUOTA', code: 'PROVIDER_QUOTA_MONTHLY' };
    const seconds = Number(retryAfter);
    return { kind: 'RETRY', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 2000 };
  }
  if (status === 409) return name === 'concurrent_idempotent_requests' ? { kind: 'UNKNOWN', code: 'PROVIDER_IDEMPOTENT_IN_PROGRESS' }
    : { kind: 'CONFLICT', code: name === 'invalid_idempotent_request' ? 'PROVIDER_IDEMPOTENCY_BODY_CHANGED' : 'PROVIDER_CONFLICT' };
  if (status === 401 || status === 403) return { kind: 'CONFIG', code: status === 401 ? 'PROVIDER_KEY_INVALID' : 'PROVIDER_FORBIDDEN' };
  if (status === 400 || status === 422) return { kind: 'REJECTED', code: name === 'validation_error' ? 'PROVIDER_VALIDATION' : 'PROVIDER_REJECTED' };
  if (status >= 500) return { kind: 'UNKNOWN', code: `PROVIDER_${status === 503 ? 'UNAVAILABLE' : 'ERROR'}` };
  return { kind: 'REJECTED', code: 'PROVIDER_UNEXPECTED_STATUS' };
}

export function createResendClient(config: ResendConfig) {
  const base = config.baseUrl ?? RESEND_API, timeoutMs = config.timeoutMs ?? 15_000, http = config.fetch ?? fetch;
  const auth = { authorization: `Bearer ${config.apiKey}` };
  async function send(email: OutgoingEmail): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await http(`${base}/emails`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': email.idempotencyKey, 'user-agent': 'flofi-flight/1' },
        body: JSON.stringify({ from: config.from, to: [email.to], reply_to: config.replyTo, subject: email.subject, html: email.html, text: email.text,
          ...email.headers ? { headers: email.headers } : {}, ...email.attachments?.length ? { attachments: email.attachments } : {},
          ...email.tags?.length ? { tags: email.tags } : {} }),
      });
    } catch (error) {
      // Timeout, reset, DNS: the request may have reached Resend. Never assume it was not sent.
      return { kind: 'UNKNOWN', code: error instanceof Error && error.name === 'TimeoutError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK' };
    }
    const body = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
    return classifyResend(response.status, body, response.headers.get('retry-after'));
  }
  /**
   * Whether `domain` is verified on this Resend account: VERIFIED, NOT_VERIFIED (absent, pending, failed), or UNKNOWN (the key cannot list
   * domains — a sending-only key — or Resend did not answer). The worker sends only on VERIFIED, or on an operator's explicit attestation.
   */
  async function domainStatus(domain: string): Promise<'VERIFIED' | 'NOT_VERIFIED' | 'UNKNOWN'> {
    try {
      const response = await http(`${base}/domains`, { headers: { ...auth, 'user-agent': 'flofi-flight/1' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) return 'UNKNOWN';
      const body = await response.json() as { data?: { name?: unknown; status?: unknown }[] };
      const found = (body.data ?? []).find(item => item.name === domain);
      return found?.status === 'verified' ? 'VERIFIED' : 'NOT_VERIFIED';
    } catch { return 'UNKNOWN'; }
  }
  return { send, domainStatus };
}
export type ResendClient = ReturnType<typeof createResendClient>;
