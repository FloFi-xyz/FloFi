# FloFi Developer SDK (TypeScript)

A dependency-free server client for the FloFi Developer API v1, licensed under Apache-2.0. Build a versioned tarball
from this repository to use the SDK in a separate project. Public registry publication is pending.

Use the repository's pinned Node 24.21.0 and pnpm 11.22.0 to build the workspace package.

```sh
git clone https://github.com/FloFi-xyz/FloFi.git
cd FloFi
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @defi-workflow-engine/developer-sdk build
pnpm --filter @defi-workflow-engine/developer-sdk pack --out /tmp/flofi-developer-sdk-%v.tgz
```

From your external project, run `pnpm add /tmp/flofi-developer-sdk-0.1.0.tgz` for version 0.1.0. Inside the FloFi repository,
declare `"@defi-workflow-engine/developer-sdk": "workspace:*"` instead. The built SDK requires Node.js 20+
or a compatible server runtime with Fetch and Web Crypto. Set `FLOFI_BASE_URL` to the deployment origin and load the
sandbox key issued by that deployment into `FLOFI_API_KEY` through your server's secret store. The client appends `/api/developer/v1`.
The deployment must have the API enabled.

```ts
import { FloFi } from '@defi-workflow-engine/developer-sdk';

const flofi = new FloFi({
  apiKey: process.env.FLOFI_API_KEY!,
  baseUrl: process.env.FLOFI_BASE_URL!,
});
const { data } = await flofi.capabilities.list();
```

### Next.js server module

Keep the client in a server-only module and call it from a Server Component, Route Handler or Server Action. Configure
`FLOFI_API_KEY` and `FLOFI_BASE_URL` as server variables.

```ts
import 'server-only';
import { FloFi } from '@defi-workflow-engine/developer-sdk';

export async function listBridgeCapabilities() {
  const flofi = new FloFi({ apiKey: process.env.FLOFI_API_KEY!, baseUrl: process.env.FLOFI_BASE_URL! });
  return (await flofi.capabilities.list({ action: 'bridge' })).data;
}
```

Before exposing approval status in your app, authenticate the caller and resolve the FloFi approval ID from a record
that belongs to that caller. See the [Node.js quickstart](../../docs/developer/QUICKSTART.md) for creating the approval
and storing its ID alongside your own request.

Any valid sandbox key can discover capabilities on a deployment where it was issued. Hosted FloFi is mainnet-only, while the
[local MOCKED quickstart](../../docs/developer/QUICKSTART.md) uses test funds and reaches Review with signing blocked.

When a deployment explicitly activates live access, put the production key from the Developer Console in `FLOFI_API_KEY` and
follow the [mainnet integration](../../docs/developer/QUICKSTART.md#mainnet-integration).
Use `strategies.simulateWorkflow` for a read-only preview per step and `approvals.create` to hand off the exact workflow.
The user reviews and signs each eligible step in FloFi. Access to `workflowRun`, execution status and evidence depends on their consent.

- `FloFiError` exposes `status`, `code`, `reason`, `requestId`, `issues` and `retryAfter`.
- Creating POSTs use your `idempotencyKey` or a generated one. The client reuses it across its own retries. Supply a stable key
  for retries that can span calls or process restarts.
- GETs and creating POSTs can retry network errors, `409 IDEMPOTENCY_IN_PROGRESS`, `429`, `502`, `503` and `504`.
  The client uses `Retry-After` up to its configured delay ceiling.
- `verifyWebhook` verifies the raw body and headers. Deduplicate on `webhook-id` and use a fresh API read for current state.
  Signature failures are reported as `FloFiWebhookError`.
- Use `webhookEndpoints.create({ url })` to register a receiver and `webhookEndpoints.delete(endpointId)` to retire it. Both calls require the `webhooks` scope.

[API reference](../../docs/developer/API.md) · [OpenAPI](../../docs/developer/openapi.json) · [Webhooks](../../docs/developer/WEBHOOKS.md)

## Studio integration packages

Use `defineIntegrationPackage(input)` to validate and normalize version 2 proposal
metadata before entering it in Developer Console → FloFi Studio. Every new
version is immutable once saved. CAIP-2 identifies on-chain deployments. Select
the architecture that defines how their network identity can be checked.

Once an independent FloFi operator certifies and publishes a package, it appears
in `capabilities.list()` under `publishedIntegrations` (only when no filter is
set). A PUBLIC package is visible to every project; a PRIVATE one only to its
audience. These entries are metadata (`network.read` or `vault.read`) and grant
no execution capability.

```ts
import { defineIntegrationPackage } from '@defi-workflow-engine/developer-sdk';

const proposal = defineIntegrationPackage({
  schemaVersion: 2,
  kind: 'network',
  slug: 'move-network',
  name: 'Move Network',
  architecture: 'move',
  chainRef: 'move:example',
  environment: 'mainnet',
  capabilities: ['network.read'],
  dependencies: [],
  adapter: {
    kind: 'external',
    repository: 'https://github.com/example-org/adapter',
    commit: 'a'.repeat(40),
    sourceSha256: 'b'.repeat(64),
    sdkVersion: 1,
  },
});
```

The example uses placeholder source identifiers. For a real submission, record
the full commit revision and the SHA-256 of the commit archive bytes. Keep the
toolchain and dependency lockfile in the submitted source. Press **Submit
adapter** on the saved draft to enter the source intake queue. The commit and
digest identify the proposal for review. FloFi requires a separately attested
build before granting runtime permissions.

Built-in EVM network verification uses `evm-rpc` v1. Provide an unauthenticated
HTTPS endpoint and a checkpoint with a hexadecimal height and 32-byte lowercase
hash. For an ERC-4626 vault use `erc4626-read` v1 and provide the vault deployment
address and underlying asset. The probe checks RPC responses against the
proposal. An independent review establishes mainnet classification and approved
capabilities. Proposed transfer and vault write capabilities have no wallet
authority by themselves.

The proposal accepts public configuration only. Keep API keys, exchange account
credentials, HTTP authorization headers and signing material outside the
package. The CEX category accepts a balances-read request under user scope.

### Isolated adapter check

SDK version 1 accepts a single `src/adapter.mts` source file that exports a
`check` function of type `StudioAdapterV1`. Its input contains the verification
mode, the CAIP-2 identity and observations supplied by the runner. Keep imports
from the FloFi SDK type-only. The runner currently supports dependency-free
adapters and receives recorded fixtures from a separate operator.

```ts
import type { StudioAdapterV1 } from '@defi-workflow-engine/developer-sdk';

export const check: StudioAdapterV1 = ({ mode, chainRef, observations }) => {
  if (observations.chain !== chainRef) return { ok: false, code: 'CHAIN_MISMATCH' };
  if (mode === 'test' && observations.accountRead !== true) {
    return { ok: false, code: 'ACCOUNT_READ_UNAVAILABLE' };
  }
  return { ok: true, chainRef, facts: { identityMatches: true } };
};
```

After building the SDK, run the operator harness on a dedicated x86-64 Linux
worker with Bubblewrap, the repository Node version and TypeScript. Supply the
normalized manifest JSON, exact commit archive and a JSON array of
`{ input, expected }` fixture cases with both a passing verification and a passing
compatibility case. The operator obtains the archive from the referenced commit
and checks the commit provenance independently.

```sh
python3 scripts/studio-adapter-check.py manifest.json source.tar.gz fixtures.json
```

The build and each fixture run use isolated namespaces, a clean environment,
bounded resources and no host network. Fixture expectations stay outside the
adapter process. The report records content digests and toolchain versions.
This evidence is unsigned. The Studio intake queue records the external
submission for review. A trusted signed attestation and certified runtime
dispatch for external adapters remain pending.
