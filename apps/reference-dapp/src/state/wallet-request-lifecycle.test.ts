// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { forgetWalletReport, readWalletReports, rememberWalletReport, watchWalletResponse } from './wallet-request-lifecycle';

it('does not invent failure or invoke the wallet twice when its promise never settles', async () => {
  const provider = new EventEmitter(), interrupted = vi.fn(), request = vi.fn(() => new Promise<string>(() => undefined));
  const pending = watchWalletResponse(provider, request, interrupted);
  let settled = false; void pending.finally(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); expect(request).toHaveBeenCalledOnce(); expect(interrupted).not.toHaveBeenCalled();
  provider.emit('disconnect'); provider.emit('accountsChanged', []);
  expect(interrupted).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce(); expect(settled).toBe(false);
});
it.each(['accountsChanged', 'chainChanged', 'disconnect'])('preserves a late hash after %s without making another request', async event => {
  const provider = new EventEmitter(), interrupted = vi.fn(); let resolve!: (s: string) => void;
  const response = new Promise<string>(r => { resolve = r; }), request = vi.fn(() => response);
  const pending = watchWalletResponse(provider, request, interrupted);
  provider.emit(event); resolve('0x' + 'a'.repeat(64));
  expect(await pending).toBe('0x' + 'a'.repeat(64));
  expect(interrupted).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce(); expect(provider.listenerCount(event)).toBe(0);
});
it('retains the wallet hash when the server report fails and restores it for only the original owner and attempt', () => {
  const data = new Map<string, string>(), storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  const runId = 'xuni-' + 'a'.repeat(32), attemptId = runId + '.approval.1';
  const report = { runId, attemptId, owner: 'owner-a', kind: 'HASH' as const, hash: '0x' + 'b'.repeat(64) };
  rememberWalletReport(storage, report); rememberWalletReport(storage, report);
  expect(readWalletReports(storage, 'owner-a')).toEqual([report]);
  expect(readWalletReports(storage, 'owner-b')).toEqual([]);
  forgetWalletReport(storage, attemptId); expect(readWalletReports(storage, 'owner-a')).toEqual([]);
});
