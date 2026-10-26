// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-CHAT-LEARNING-001/002 acceptance in the browser: FLOFI_COPILOT=replay (committed answers, no model), learning on a disposable LOOPBACK
// database with persistent automatic learning under the consent basis, wallets proven with an injected test wallet (sign-in only). The chat has no
// Memory panel and nothing invites the user to teach FloFi; an answer to FloFi's question adapts the rest of the conversation; after the user opts in
// under Privacy & memory (Settings), repeated evidence is learned for that wallet only and used in a later session; another wallet never inherits it;
// a published global entry reaches both; turning learning off and deleting everything erase it; an exact command is unchanged.
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { test, expect, applyPendingProposal } from './fixtures';
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
const meanings = () => query("SELECT term, target FROM learning_memories ORDER BY term");
const subjects = () => query<{ subject_id: string }>('SELECT subject_id FROM learning_subjects ORDER BY subject_id');
/** Every per-identity learning record (0013 + 0014): erasure must leave none of them behind. */
const personalRecords = () => query(`SELECT (SELECT count(*) FROM learning_subjects)::int AS subjects, (SELECT count(*) FROM learning_memories)::int AS memories,
  (SELECT count(*) FROM learning_evidence)::int AS evidence, (SELECT count(*) FROM learning_automatic_settings)::int AS settings,
  (SELECT count(*) FROM learning_candidate_support)::int AS support`);
/** Asks about "sol dev" and answers FloFi's question with its own button. */
async function answerSolDev(page: Page, amount: string) {
  await send(page, `Swap ${amount} SOL to devUSDC on sol dev`);
  await lastAi(page).getByRole('button', { name: 'Solana Devnet', exact: true }).click();
  await expect(lastAi(page)).toContainText(`swap ${amount} SOL to devUSDC on Solana Devnet`);
}
/**
 * BUILD-SOLANA-TRANSFER-UX-001: proving reuses the already connected operational wallet (no second connection, no wallet selector); the
 * wallet still signs the server's sign-in message, and that signature alone proves it.
 */
async function proveConnectedWallet(page: Page) {
  await expect(page.getByRole('group', { name: 'Wallet connection' }).locator('.wallet-connection')).toHaveAttribute('title', /Base Sepolia/);
  const signIns = async () => (await walletRequests(page)).filter(method => method === 'personal_sign').length, before = await signIns();
  await page.getByRole('button', { name: 'Prove an EVM wallet', exact: true }).click();
  await expect(page.getByText(/Memory for wallet/)).toBeVisible();
  await expect(page.locator('dialog.wallet-selector[open]')).toHaveCount(0);
  expect(await signIns()).toBe(before + 1);
}
async function provePrivacy(page: Page) {
  await page.goto('/app/privacy');
  await proveConnectedWallet(page);
}

test('invisible learning: adapted in the conversation, learned after consent and repeated evidence, never inherited, erased on request', async ({ browser, page, networkGuard }) => {
  // Two wallets, multiple sessions and durable consent/erasure share one acceptance journey. The 2-vCPU Cloud Build
  // runner exhausted the default 30-second total at different late steps; keep each assertion's 10-second limit.
  test.setTimeout(60_000);
  const a = createTestWallet(), b = createTestWallet();
  await installJourneyWallet(page, [a], { chain: '0x14a34' });
  await page.goto('/app');
  // No Memory panel, no Remember button, no teaching prompt in the chat.
  await expect(page.locator('details.copilot-memory')).toHaveCount(0);

  // In-session adaptation needs nothing stored: FloFi asks about "sol dev" once, then reads it for the rest of the conversation, visibly.
  await answerSolDev(page, '0.1');
  await send(page, 'Swap 0.2 SOL to devUSDC on sol dev');
  await expect(lastAi(page)).toContainText('swap 0.2 SOL to devUSDC on Solana Devnet');
  await expect(lastAi(page).locator('.copilot-notes')).toContainText('“sol dev” read as Solana Devnet — as you chose earlier in this conversation.');
  await expect(page.locator('.chat-messages')).not.toContainText(/Remember|Not now|teach|Prove your wallet/);
  expect(await query('SELECT * FROM learning_subjects')).toEqual([]);
  expect(await query('SELECT * FROM learning_evidence')).toEqual([]);

  // Privacy & memory lives in Settings, outside the chat. Proving the wallet signs a sign-in message only; learning is off until the user turns it on.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Privacy & memory', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/privacy$/);
  await proveConnectedWallet(page);
  const learn = page.getByRole('checkbox', { name: /Learn from how I use the Copilot/ });
  await expect(learn).not.toBeChecked();
  // The switch reflects the recorded choice: it turns on once the server has recorded the consent.
  await learn.click();
  await expect(learn).toBeChecked();
  expect(await query('SELECT enabled, basis, notice_version FROM learning_automatic_settings')).toEqual([{ enabled: true, basis: 'CONSENT', notice_version: 2 }]);
  // The consent created A's subject: the only one so far.
  const subjectA = await subjects();
  expect(subjectA).toHaveLength(1);

  // A new conversation: one answer is evidence, not yet a meaning; applying a proposal FloFi read on its own confirms it — then it is learned.
  await page.goto('/app');
  await answerSolDev(page, '0.1');
  await expect.poll(() => query("SELECT term, target, clarified FROM learning_evidence WHERE term <> ''")).toEqual([{ term: 'sol dev', target: 'network:SOLANA_DEVNET', clarified: 1 }]);
  expect(await meanings()).toEqual([]);
  await send(page, 'Swap 0.2 SOL to devUSDC on sol dev');
  await expect(lastAi(page).locator('.copilot-notes')).toContainText('as you chose earlier in this conversation');
  await applyPendingProposal(page);
  await expect.poll(meanings).toEqual([{ term: 'sol dev', target: 'network:SOLANA_DEVNET' }]);
  // Pseudonymous: the wallet address is stored nowhere in the learning tables.
  expect(JSON.stringify([await query('SELECT * FROM learning_subjects'), await query('SELECT * FROM learning_evidence')])).not.toContain(a.address.toLowerCase().slice(2, 12));

  // A later session: the learned meaning is used, and labelled as learned. It is only a proposal.
  await page.reload();
  await send(page, 'Swap 0.3 SOL to devUSDC on sol dev');
  await expect(lastAi(page)).toContainText('swap 0.3 SOL to devUSDC on Solana Devnet');
  await expect(lastAi(page).locator('.copilot-notes')).toContainText('“sol dev” read as Solana Devnet — learned from your earlier choices.');

  // B, another wallet in another browser: asked, never given A's meaning.
  const other = await browser.newContext(), pageB = await other.newPage();
  await installJourneyWallet(pageB, [b], { chain: '0x14a34' });
  await provePrivacy(pageB);
  await expect(pageB.locator('.privacy-list')).toHaveCount(0);
  await pageB.goto('/app');
  await send(pageB, 'Swap 0.3 SOL to devUSDC on sol dev');
  await expect(lastAi(pageB).getByRole('group', { name: 'Suggested answers' })).toBeVisible();
  await expect(lastAi(pageB)).not.toContainText('learned');
  // Proving B, reading B's memory and chatting stored nothing for B (no subject is created by reading): A's subject is still the only one.
  expect(await subjects()).toEqual(subjectA);

  // Collective knowledge stays reviewed: after an evaluated publication both users get "eth sepolia", with the glossary named.
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

  // Privacy & memory shows what is kept and how; turning learning off erases what it learned; delete everything (two steps) erases the rest.
  await page.goto('/app/privacy');
  await expect(page.locator('.privacy-list')).toContainText('sol dev → Solana Devnet (test network)');
  await expect(page.locator('.privacy-list')).toContainText('learned from your choices');
  await page.getByRole('checkbox', { name: /Learn from how I use the Copilot/ }).click();
  await expect(page.getByRole('checkbox', { name: /Learn from how I use the Copilot/ })).not.toBeChecked();
  await expect(page.getByText('FloFi keeps no meanings for this wallet.')).toBeVisible();
  expect(await meanings()).toEqual([]);
  expect(await query('SELECT * FROM learning_evidence')).toEqual([]);
  // Turning learning off keeps A's subject, its recorded choice and the memory consent (the "Use my saved meanings" switch); only deletion removes them.
  const useSaved = page.getByRole('checkbox', { name: 'Use my saved meanings' });
  await expect(useSaved).toBeVisible();
  expect(await subjects()).toEqual(subjectA);
  expect(await query('SELECT enabled, basis, notice_version FROM learning_automatic_settings')).toEqual([{ enabled: false, basis: 'CONSENT', notice_version: 2 }]);
  await page.getByRole('button', { name: 'Delete everything', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm: delete everything', exact: true }).click();
  // "FloFi keeps no meanings" was already shown before the deletion, so it proves nothing: wait until the page reloaded the erased status (the
  // consent switch is gone and the two-step button is back). The erase deletes A's subject; its memories, evidence and settings cascade.
  await expect(useSaved).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete everything', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Learn from how I use the Copilot/ })).not.toBeChecked();
  // Nothing personal remains for either wallet: A's records are erased and B never had any.
  expect(await personalRecords()).toEqual([{ subjects: 0, memories: 0, evidence: 0, settings: 0, support: 0 }]);
  // The reviewed global glossary is not personal data and stays published.
  expect(await query('SELECT version FROM learning_knowledge_versions')).toEqual([{ version: 1 }]);
  // The only wallet requests were the sign-in: nothing signed or sent a transaction.
  expect((await walletRequests(page)).filter(method => /sendTransaction|signTypedData|eth_sign$/i.test(method))).toEqual([]);
  networkGuard.assertClean();
});
