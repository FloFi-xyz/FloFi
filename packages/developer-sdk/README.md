# FloFi Developer SDK (TypeScript)

A dependency-free server client for the FloFi Developer API v1. Use the private package from this workspace. It is licensed
under Apache-2.0.

Use the repository's pinned Node 24.21.0 and pnpm 11.22.0 to build the workspace package.

```sh
git clone https://github.com/FloFi-xyz/FloFi.git
cd FloFi
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @defi-workflow-engine/developer-sdk build
```

Declare `"@defi-workflow-engine/developer-sdk": "workspace:*"` in a consumer in this workspace. The built SDK requires Node.js 20+
or a compatible server runtime with Fetch and Web Crypto. Set `FLOFI_BASE_URL` to the deployment origin and load the
operator-issued sandbox key into `FLOFI_API_KEY` through your server's secret store. The client appends `/api/developer/v1`.
The deployment must have the API enabled.

```ts
import { FloFi } from '@defi-workflow-engine/developer-sdk';

const flofi = new FloFi({
  apiKey: process.env.FLOFI_API_KEY!,
  baseUrl: process.env.FLOFI_BASE_URL!,
});
const { data } = await flofi.capabilities.list();
```

Any valid sandbox key can discover capabilities on a deployment where it was issued. Hosted FloFi is mainnet-only, while the
API refuses mainnet strategies and live keys. Use the [local MOCKED Quickstart](../../docs/developer/QUICKSTART.md) for tested
examples of `strategies.create`, `strategies.validate`, `strategies.simulate` and `approvals.create`. The example reaches Review
with signing blocked. In an eligible workflow the user reviews and signs in FloFi. Sharing execution status and evidence
requires their consent.

- `FloFiError` exposes `status`, `code`, `reason`, `requestId`, `issues` and `retryAfter`.
- Creating POSTs use your `idempotencyKey` or a generated one. The key is reused across the client's own retries.
- GETs and creating POSTs can retry network errors, `409 IDEMPOTENCY_IN_PROGRESS`, `429`, `502`, `503` and `504`.
  The client uses `Retry-After` up to its configured delay ceiling.
- `verifyWebhook` verifies the raw body and headers. Deduplicate on `webhook-id` and use a fresh API read for current state.
  Signature failures are reported as `FloFiWebhookError`.
- Use `webhookEndpoints.create({ url })` to register a receiver and `webhookEndpoints.delete(endpointId)` to retire it. Both calls require the `webhooks` scope.

[API reference](../../docs/developer/API.md) · [OpenAPI](../../docs/developer/openapi.json) · [Webhooks](../../docs/developer/WEBHOOKS.md)
