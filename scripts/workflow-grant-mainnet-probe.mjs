#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: a READ-ONLY adversarial probe of one owner-signed workflow grant against the REAL MetaMask
 * Delegation Framework v1.3.0 contracts on a public mainnet. It replays what a fully compromised FloFi executor could try with the grant's
 * session key, but only through `eth_call` (simulated from the executor's address): nothing is signed, nothing is broadcast, no state changes.
 *
 * For every authorized call it records whether the exact call would currently succeed (informational: it depends on the owner's balances and
 * on which calls already ran), and for every attack variant it requires a revert from the delegation framework — never a success:
 *   - the same call with the amount + 1 and - 1 (ExactCalldata)
 *   - an unlimited approval, a transfer of the owner's token to another address, a native-value send (ExactCalldata / AllowedTargets / ValueLte)
 *   - the authorized call through another call's group (ExactCalldata), and from another redeemer (Redeemer)
 *
 * Input: a JSON file {"chainId", "delegation": <the signed delegation as FloFi stores it: grant_payload.delegation>, "executor": "0x…"} and
 * the chain's RPC URL in FLOFI_PROBE_RPC_URL (HTTPS). Only eth_chainId, eth_getCode, eth_blockNumber and eth_call are ever sent.
 * Output: JSON evidence on stdout (or the file named by the second argument): block number, each probe, each verdict.
 * Usage: FLOFI_PROBE_RPC_URL=https://… node scripts/workflow-grant-mainnet-probe.mjs grant.json [evidence.json]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { erc7710 as D } from '../apps/reference-dapp/node_modules/@defi-workflow-engine/reference-compiler/dist/index.js';

const ALLOWED = new Set(['eth_chainId', 'eth_getCode', 'eth_blockNumber', 'eth_call']);
const fail = message => { console.error(message); process.exit(2); };
const [file, out] = process.argv.slice(2);
if (!file) fail('usage: FLOFI_PROBE_RPC_URL=https://… node scripts/workflow-grant-mainnet-probe.mjs grant.json [evidence.json]');
const url = new URL(process.env.FLOFI_PROBE_RPC_URL ?? fail('FLOFI_PROBE_RPC_URL is required'));
if (url.protocol !== 'https:' || url.username || url.password) fail('FLOFI_PROBE_RPC_URL must be https with no credentials in the URL');
let id = 0;
async function rpc(method, params) {
  if (!ALLOWED.has(method)) throw new Error(`PROBE_METHOD_FORBIDDEN ${method}`);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  return response.json();
}
const input = JSON.parse(await readFile(file, 'utf8'));
const s = input.delegation;
const delegation = { delegate: D.evmAddress(s.delegate), delegator: D.evmAddress(s.delegator), authority: s.authority, salt: BigInt(s.salt), signature: s.signature,
  caveats: s.caveats.map(c => ({ enforcer: D.evmAddress(c.enforcer), terms: c.terms, args: c.args ?? '0x' })) };
const executor = D.evmAddress(input.executor), chainId = Number(input.chainId), F = D.DELEGATION_FRAMEWORK_V1_3;
const calls = D.workflowGrantCalls(delegation) ?? fail('not a workflow grant (ExactCalldata + Id per call)');
const chain = await rpc('eth_chainId', []);
if (BigInt(chain.result) !== BigInt(chainId)) fail(`RPC chain ${chain.result} is not ${chainId}`);
const block = (await rpc('eth_blockNumber', [])).result;
const code = async address => String((await rpc('eth_getCode', [address, block])).result ?? '0x').toLowerCase();
const framework = { delegationManager: await code(F.delegationManager) !== '0x', ownerDesignator: await code(delegation.delegator) === D.DELEGATOR_DESIGNATOR };
for (const [name, address] of Object.entries(F.enforcers)) framework[name] = await code(address) !== '0x';
const ERROR = '0x08c379a0';
/** `Error(string)` revert data as its text; anything else (custom errors such as CannotUseADisabledDelegation()) as raw data. */
const reason = data => {
  if (typeof data !== 'string' || !data.startsWith(ERROR)) return data ?? null;
  try { const [text] = D.abiDecode(['bytes'], D.bytesOf('0x' + data.slice(10))); return new TextDecoder().decode(D.bytesOf(text)); }
  catch { return data; }
};
async function simulate(from, group, call) {
  const data = D.redeemCalldata(delegation, group, call);
  const r = await rpc('eth_call', [{ from, to: F.delegationManager, data, value: '0x0' }, block]);
  return r.error ? { ok: false, reason: reason(r.error.data) ?? r.error.message } : { ok: true };
}
const word = v => v.toString(16).padStart(64, '0'), addr = a => a.slice(2).padStart(64, '0');
const attacker = '0x000000000000000000000000000000000000dEaD'.toLowerCase();
const probes = [];
for (const [i, c] of calls.entries()) {
  probes.push({ kind: 'AUTHORIZED', group: i, target: c.target, expect: 'INFORMATIONAL', result: await simulate(executor, i, c) });
  const data = c.data;
  if (data.length >= 10 + 128) {
    // The last-but-k amount words of the call, bumped by one in each direction.
    for (const offset of [1, 2]) {
      const at = 10 + 64 * offset, value = BigInt('0x' + data.slice(at, at + 64));
      if (value > 1n && value < (1n << 255n)) for (const v of [value + 1n, value - 1n])
        probes.push({ kind: 'CHANGED_WORD', group: i, word: offset, expect: 'REVERT', result: await simulate(executor, i, { ...c, data: data.slice(0, at) + word(v) + data.slice(at + 64) }) });
    }
  }
  probes.push({ kind: 'UNLIMITED_APPROVE', group: i, expect: 'REVERT', result: await simulate(executor, i, { target: c.target, value: 0n, data: D.APPROVE_METHOD + addr(attacker) + word((1n << 256n) - 1n) }) });
  probes.push({ kind: 'TRANSFER_AWAY', group: i, expect: 'REVERT', result: await simulate(executor, i, { target: c.target, value: 0n, data: D.ERC20_TRANSFER_METHOD + addr(attacker) + word(1n) }) });
  probes.push({ kind: 'NATIVE_VALUE', group: i, expect: 'REVERT', result: await simulate(executor, i, { target: attacker, value: 1n, data: '0x' }) });
  probes.push({ kind: 'OTHER_REDEEMER', group: i, expect: 'REVERT', result: await simulate(attacker, i, c) });
  const other = calls[(i + 1) % calls.length];
  if (calls.length > 1 && other.data !== c.data) probes.push({ kind: 'OTHER_GROUP', group: (i + 1) % calls.length, expect: 'REVERT', result: await simulate(executor, (i + 1) % calls.length, c) });
}
const violations = probes.filter(p => p.expect === 'REVERT' && p.result.ok);
const evidence = { kind: 'flofi.workflow-grant-mainnet-probe.v1', chainId, block, executor, delegator: delegation.delegator, delegationHash: D.delegationHash(delegation),
  framework, authorizedCalls: calls.length, probes, violations: violations.length,
  verdict: violations.length === 0 && Object.values(framework).every(Boolean) ? 'ON_CHAIN_BOUNDS_HELD' : 'VIOLATION_OR_FRAMEWORK_MISSING',
  provenance: 'PUBLIC_MAINNET_READ_ONLY_ETH_CALL' };
const text = JSON.stringify(evidence, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
if (out) await writeFile(out, text + '\n', { flag: 'wx' }); else console.log(text);
process.exit(evidence.verdict === 'ON_CHAIN_BOUNDS_HELD' ? 0 : 1);
