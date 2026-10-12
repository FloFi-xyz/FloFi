// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import base from './playwright.workflow-ux.config';
// Same passive-wallet, gates-off profile as Phase 7A. Optional isolated output
// leaves an owner's existing .next server intact. Both paths use compiled code.
const isolated = process.env.FLOFI_CANVAS_UX_ISOLATED === 'true';
const copilot = process.env.FLOFI_CANVAS_COPILOT_E2E === 'true';
if (copilot) {
  process.env.FLOFI_COPILOT = 'replay';
  process.env.GRYLOO_SUPPLY_E2E = 'MOCKED_LOOPBACK_ONLY';
  process.env.GRYLOO_SUPPLY_JOURNAL = join(tmpdir(), 'gryloo-build012a-p7b-' + process.pid);
}
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: ['canvas-workflow-ux.spec.ts', 'workflow-ux-authoring.spec.ts', ...(copilot ? ['copilot-conversation.spec.ts'] : [])],
  webServer: [...servers.map((server, index) => index === 1 && isolated ? { ...server,
    env: { ...server.env, FLOFI_MOTION_PREVIEW: 'true' } } : server), ...(copilot ? [{ command: 'node e2e/supply-harness.mjs --serve', url: 'http://127.0.0.1:8549', reuseExistingServer: false, timeout: 30_000 }] : [])],
});
