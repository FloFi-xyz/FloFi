// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-CHAT-LEARNING-001 acceptance in the browser: FLOFI_COPILOT=replay (committed answers, no model), learning on a disposable LOOPBACK
// database, wallets proven with an injected test wallet (sign-in only). User A keeps a private meaning; user B does not inherit it; a published
// global glossary entry reaches both; Memory can be viewed and erased; an ordinary exact command still proposes exactly as before.
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { test, expect, chooseWallet } from './fixtures';
import { installJourneyWallet, walletRequests } from './journey-fixtures';
import { query } from './automation-fixtures';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import { evaluateKnowledge } from '../src/learning/evaluation';
import { KNOWLEDGE_SCHEMA, validateKnowledgeDocument } from '../src/learning/knowledge';
import { createLearningStore } from '../src/learning/store';
import type { Page } from '@playwright/test';

test.beforeAll(() => {
  if (process.env.FLOFI_LEARNING_E2E !== 'LOOPBACK_ONLY' || process.env.FLOFI_COPILOT !== 'replay') throw new Error('LEARNING_HARNESS_REQUIRED');
});
const send = async (page: Page, text: string) => { await page.locator('#mock-prompt').fill(text); await page.locator('.chat-form button[type=submit]').click(); };
const lastAi = (page: Page) => page.locator('.message.ai').last();
async function proveWallet(page: Page) {
  await page.goto('/app');
  const memory = page.locator('details.copilot-memory');
  await memory.locator('summary').click();
  await memory.getByRole('button', { name: 'Prove an EVM wallet', exact: true }).click();
  await chooseWallet(page, 'Browser wallet');
  await expect(memory.getByText(/Memory for wallet/)).toBeVisible();
  return memory;
}

test('A keeps a private meaning, B does not inherit it, a published global entry reaches both, and Memory erases', async ({ browser, page, networkGuard }) => {
  const a = createTestWallet(), b = createTestWallet();
  await installJourneyWallet(page, [a], { chain: '0x14a34' });
  const memory = await proveWallet(page);

  // A states a meaning: FloFi answers locally and only offers to remember it.
  await send(page, 'Whenever I say Arb, I mean Arbitrum');
  await expect(lastAi(page)).toContainText('In this conversation, I\'ll read “arb” as Arbitrum One (real funds).');
  expect(await query('SELECT * FROM learning_memories')).toEqual([]);
  await lastAi(page).getByRole('button', { name: 'Remember', exact: true }).click();
  await expect(lastAi(page)).toContainText('Saved: “arb” = Arbitrum One (real funds).');
  await expect(memory.locator('.copilot-memory-list')).toContainText('arb → Arbitrum One (real funds)');
  expect(await query('SELECT term, target FROM learning_memories')).toEqual([{ term: 'arb', target: 'network:ARBITRUM' }]);
  // Pseudonymous: the wallet address is stored nowhere in the learning tables.
  expect(JSON.stringify(await query('SELECT * FROM learning_subjects'))).not.toContain(a.address.toLowerCase().slice(2, 12));

  // A later session: the saved meaning grounds the network, visibly; it is only a proposal.
  await page.reload();
  await send(page, 'Bridge 10 USDC from Base to Arb');
  await expect(lastAi(page)).toContainText('bridge 10 USDC from Base to Arbitrum');
  await expect(lastAi(page).locator('.copilot-notes')).toContainText('“arb” read as Arbitrum One — your saved meaning.');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');

  // B, another wallet in another browser: asked, never given A's meaning.
  const other = await browser.newContext(), pageB = await other.newPage();
  await installJourneyWallet(pageB, [b], { chain: '0x14a34' });
  await proveWallet(pageB);
  await send(pageB, 'Bridge 10 USDC from Base to Arb');
  await expect(lastAi(pageB)).not.toContainText('saved meaning');
  await expect(lastAi(pageB).getByRole('group', { name: 'Suggested answers' })).toBeVisible();

  // Before publication both are asked about "eth sepolia"; after an evaluated publication both get it, with the glossary named.
  await send(page, 'Swap 0.001 WETH to USDC on eth sepolia');
  await expect(lastAi(page)).not.toContainText('glossary');
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    const store = createLearningStore(db, 'default'), document = validateKnowledgeDocument({ schema: KNOWLEDGE_SCHEMA,
      entries: [{ term: 'eth sepolia', target: 'network:ETHEREUM_SEPOLIA', language: 'ANY', candidateId: null }] });
    const result = evaluateKnowledge(document, null, { version: 1 });
    expect(result.passed).toBe(true);
    const evaluation = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: null, document, corpus: result.corpus, passed: true, result, createdBy: 'cli' }, new Date());
    await store.appendKnowledge({ expectedVersion: 0, document, evaluationId: evaluation.evaluationId, restoredFrom: null, createdBy: 'cli', reason: 'e2e' }, new Date());
  } finally { await db.close(); }
  for (const p of [page, pageB]) {
    await p.reload();
    await send(p, 'Swap 0.001 WETH to USDC on eth sepolia');
    await expect(lastAi(p)).toContainText('swap 0.001 WETH to USDC on Ethereum Sepolia');
    await expect(lastAi(p).locator('.copilot-notes')).toContainText('“eth sepolia” read as Ethereum Sepolia — FloFi glossary v1.');
  }
  await other.close();

  // An ordinary exact command is unchanged (no learning note, no model).
  await page.reload();
  await send(page, 'supply 1 USDC to Aave on Base Sepolia');
  await expect(page.locator('.message.system').last()).toContainText('Proposal: supply 1 USDC to Aave on Base Sepolia.');

  // Delete everything (two-step), and the memory is gone.
  const panel = page.locator('details.copilot-memory');
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: 'Delete all memory', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm: delete everything', exact: true }).click();
  await expect(panel.getByText(/Nothing saved yet/)).toBeVisible();
  expect(await query('SELECT * FROM learning_memories')).toEqual([]);
  // The only wallet requests were the sign-in: nothing signed or sent a transaction.
  expect((await walletRequests(page)).filter(method => /sendTransaction|signTypedData|eth_sign$/i.test(method))).toEqual([]);
  networkGuard.assertClean();
});
