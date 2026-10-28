// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import base from './playwright.transfer-ux.config';
export default defineConfig(base, { testMatch: 'caio-ux-final.spec.ts', timeout: 60_000 });
