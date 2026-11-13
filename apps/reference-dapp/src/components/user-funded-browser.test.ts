// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: what a wallet's EIP-5792 batch status means for the run. Only status 400 (not included on chain) is "nothing was
 * sent"; a batch that failed by the chain's rules (500) or landed partially (600) reached the chain and its owner paid for it.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { eip5792 } from '@defi-workflow-engine/reference-compiler';

/** The owner's wallet in these tests: an in-process EIP-1193 double (no network). Each test sets how it answers each method. */
const wallet = vi.hoisted(() => ({ answers: {} as Record<string, (params: unknown[]) => unknown>, log: [] as string[] }));
vi.mock('../wallet/evm-discovery', () => {
  const provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    wallet.log.push(method);
    const answer = wallet.answers[method];
    if (!answer) throw Object.assign(new Error('Method not supported'), { code: 4200 });
    return answer(params);
  } };
  return { chosenEvmProvider: () => provider, injected: () => provider, evmWalletIdentity: () => null, isFloFiWalletKey: () => false };
});
const { batchOutcome, batchSponsorshipOf, reportedPaymasterService, revokeUserOperation, sendWalletBatch } = await import('./user-funded-browser');

const HASH = '0x' + 'ab'.repeat(32);
const status = (code: number, receipts: unknown[] = []) => eip5792.callsStatus({ version: '2.0.0', id: '0x01', chainId: '0xa4b1', status: code, atomic: true, receipts });
const receipt = { transactionHash: HASH, status: '0x0', blockNumber: '0x10', gasUsed: '0x5208', logs: [] };

describe('wallet batch status → run report', () => {
  it('pending stays pending; confirmed reports its transactions', () => {
    expect(batchOutcome(status(100))).toBeNull();
    expect(batchOutcome(status(200, [{ ...receipt, status: '0x1' }]))).toEqual({ hashes: [HASH], failed: false });
  });
  it('only an off-chain failure (400) without receipts is reported as not sent', () => {
    expect(batchOutcome(status(400))).toEqual({ hashes: [], failed: true });
  });
  it('a chain-rules failure (500) or a partial batch (600) is never "not sent": receipts are reported, none yet keeps it pending', () => {
    expect(batchOutcome(status(500, [receipt]))).toEqual({ hashes: [HASH], failed: false });
    expect(batchOutcome(status(600, [receipt]))).toEqual({ hashes: [HASH], failed: false });
    expect(batchOutcome(status(500))).toBeNull();
    expect(batchOutcome(status(600))).toBeNull();
    expect(batchOutcome(status(200))).toBeNull();
  });
});

/**
 * The owner's browser send path: until `wallet_sendCalls` is requested nothing can have been sent, so every failure before it is a closed
 * "nothing was sent" code and `onSending` (where callers keep their "may have been sent" marker) runs only immediately before that request.
 */
describe('sendWalletBatch', () => {
  const OWNER = '0x' + 'aB'.repeat(20), OTHER = '0x' + 'cd'.repeat(20), ID = '0x' + '12'.repeat(32), BATCH = '0x' + '34'.repeat(32);
  const request = eip5792.sendCallsRequest(8453, OWNER, [{ target: '0x' + '56'.repeat(20), value: 0n, data: '0x095ea7b3' }], ID);
  const rpcError = (code: number) => () => { throw Object.assign(new Error(`wallet error ${code}`), { code }); };
  let onSending: Mock<() => void>;
  beforeEach(() => {
    wallet.log.length = 0;
    // The wallet is on Base, exposes the owner's account (in another letter case) and answers `wallet_sendCalls` with its batch id.
    wallet.answers = { eth_chainId: () => '0x2105', eth_accounts: () => [OWNER.toUpperCase().replace('0X', '0x')], wallet_sendCalls: () => ({ id: BATCH }) };
    onSending = vi.fn<() => void>(() => { wallet.log.push('onSending'); });
  });
  const sent = () => wallet.log.filter(m => m === 'wallet_sendCalls').length;

  it('asks the wallet once and calls onSending exactly once, immediately before wallet_sendCalls', async () => {
    await expect(sendWalletBatch(request, onSending)).resolves.toBe(BATCH);
    expect(onSending).toHaveBeenCalledTimes(1);
    expect(wallet.log).toEqual(['eth_chainId', 'eth_accounts', 'onSending', 'wallet_sendCalls']);
  });
  it('a duplicate id (5720) returns the group\'s own id: the batch was sent before and is read back, never sent twice', async () => {
    wallet.answers.wallet_sendCalls = rpcError(eip5792.DUPLICATE_ID);
    await expect(sendWalletBatch(request, onSending)).resolves.toBe(ID);
    expect(onSending).toHaveBeenCalledTimes(1);
  });
  it('refuses with WALLET_ACCOUNT_MISMATCH unless the wallet\'s SELECTED account is the run\'s account; the wallet is never asked to send', async () => {
    // Another account selected, also while the run's account is connected (a wallet that ignores `from` would send from the selected one);
    // a locked wallet (no account); an unreadable answer; a failed request.
    for (const answer of [() => [OTHER], () => [OTHER, OWNER], () => [], () => null, () => [42, OWNER], rpcError(-32603)]) {
      wallet.answers.eth_accounts = answer;
      await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_ACCOUNT_MISMATCH');
    }
    expect(sent()).toBe(0);
    expect(onSending).not.toHaveBeenCalled();
    // The run's account selected (in any letter case), whatever else is connected: sent.
    wallet.answers.eth_accounts = () => [OWNER.toLowerCase(), OTHER];
    await expect(sendWalletBatch(request, onSending)).resolves.toBe(BATCH);
    expect(sent()).toBe(1);
  });
  it('a throw from onSending (another tab handed the group over) propagates unchanged and wallet_sendCalls is never requested', async () => {
    const refusal = new Error('WALLET_BATCH_SEND_UNCONFIRMED');
    await expect(sendWalletBatch(request, () => { throw refusal; })).rejects.toBe(refusal);
    expect(wallet.log).toEqual(['eth_chainId', 'eth_accounts']);
    expect(sent()).toBe(0);
  });
  it('a failed network switch is "nothing was sent" (WALLET_WRONG_NETWORK), never a raw wallet error; onSending never runs', async () => {
    wallet.answers.eth_chainId = () => '0xa4b1';
    for (const code of [-32002, -32603, 4902]) {
      wallet.answers.wallet_switchEthereumChain = rpcError(code);
      await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_WRONG_NETWORK');
    }
    // The owner's own rejection of the switch keeps its own code.
    wallet.answers.wallet_switchEthereumChain = rpcError(4001);
    await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_REQUEST_REJECTED');
    // The switch "succeeded" but the wallet is still on another network.
    wallet.answers.wallet_switchEthereumChain = () => null;
    await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_WRONG_NETWORK');
    // The network cannot be read at all, or reads as garbage.
    wallet.answers.eth_chainId = rpcError(-32603);
    await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_WRONG_NETWORK');
    wallet.answers.eth_chainId = () => 'not-a-chain';
    await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_WRONG_NETWORK');
    expect(sent()).toBe(0);
    expect(onSending).not.toHaveBeenCalled();
  });
  it('switches the network first when needed, then checks the account, then sends', async () => {
    let chain = '0xa4b1';
    wallet.answers.eth_chainId = () => chain;
    wallet.answers.wallet_switchEthereumChain = () => { chain = '0x2105'; return null; };
    await expect(sendWalletBatch(request, onSending)).resolves.toBe(BATCH);
    expect(wallet.log).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts', 'onSending', 'wallet_sendCalls']);
  });
  it('after wallet_sendCalls was requested: a pre-send refusal code is WALLET_BATCH_NOT_SENT, anything else stays "may have been sent"', async () => {
    wallet.answers.wallet_sendCalls = rpcError(5750);
    await expect(sendWalletBatch(request, onSending)).rejects.toThrow('WALLET_BATCH_NOT_SENT');
    wallet.answers.wallet_sendCalls = rpcError(-32603);
    const raw = await sendWalletBatch(request, onSending).catch((cause: unknown) => cause);
    expect(raw).toMatchObject({ code: -32603 });
    expect(onSending).toHaveBeenCalledTimes(2);
  });

  // BUILD-FLOFI-MAINNET-EXEC-002 (ADR-0009): FloFi's sponsorship offer reaches only a wallet that reports `paymasterService` on the batch's chain.
  describe('network-fee sponsorship (EIP-5792 paymasterService)', () => {
    const offer = { url: 'https://flofi.example/api/gas/paymaster/8453', context: { flofiGrant: 'ab'.repeat(16) }, required: false };
    const sentWith = () => (wallet.answers.wallet_sendCalls as Mock).mock.calls.map(c => ((c[0] as unknown[])[0] as { capabilities?: unknown }).capabilities ?? null);
    beforeEach(() => { wallet.answers.wallet_sendCalls = vi.fn(() => ({ id: BATCH })); });
    it('a wallet reporting paymasterService on this chain gets the capability (FloFi\'s proxy URL and grant, optional); the calls are unchanged', async () => {
      wallet.answers.wallet_getCapabilities = () => ({ '0x2105': { paymasterService: { supported: true }, atomic: { status: 'supported' } } });
      await expect(sendWalletBatch(request, onSending, offer)).resolves.toBe(BATCH);
      expect(sentWith()).toEqual([{ paymasterService: { url: offer.url, context: offer.context, optional: true } }]);
      const params = ((wallet.answers.wallet_sendCalls as Mock).mock.calls[0]![0] as unknown[])[0] as { calls: unknown[] };
      expect(params.calls).toEqual(request.calls);
      expect(wallet.log).toEqual(['eth_chainId', 'eth_accounts', 'wallet_getCapabilities', 'onSending', 'wallet_sendCalls']);
    });
    it('a wallet without it (or that cannot say) gets the plain owner-paid batch; a wallet refusing the capability (5700) gets it once more without', async () => {
      wallet.answers.wallet_getCapabilities = () => ({ '0x2105': { atomic: { status: 'supported' } } });
      await sendWalletBatch(request, onSending, offer);
      delete wallet.answers.wallet_getCapabilities;
      await sendWalletBatch(request, onSending, offer);
      expect(sentWith()).toEqual([null, null]);
      wallet.answers.wallet_getCapabilities = () => ({ '0x0': { paymasterService: { supported: true } } });
      let first = true;
      wallet.answers.wallet_sendCalls = vi.fn(() => { if (first) { first = false; throw Object.assign(new Error('unsupported'), { code: 5700 }); } return { id: BATCH }; });
      await expect(sendWalletBatch(request, onSending, offer)).resolves.toBe(BATCH);
      expect(sentWith()).toEqual([{ paymasterService: { url: offer.url, context: offer.context, optional: true } }, null]);
    });
    it('a REQUIRED offer (the owner cannot pay the fee) is never sent unsponsored: an unsupporting wallet is not asked; a refusal is not retried', async () => {
      wallet.answers.wallet_getCapabilities = () => ({ '0x2105': { atomic: { status: 'supported' } } });
      await expect(sendWalletBatch(request, onSending, { ...offer, required: true })).rejects.toThrow('GAS_SPONSORSHIP_WALLET_UNSUPPORTED');
      expect(sent()).toBe(0);
      expect(onSending).not.toHaveBeenCalled();
      wallet.answers.wallet_getCapabilities = () => ({ '0x2105': { paymasterService: { supported: true } } });
      wallet.answers.wallet_sendCalls = vi.fn(() => { throw Object.assign(new Error('unsupported'), { code: 5700 }); });
      await expect(sendWalletBatch(request, onSending, { ...offer, required: true })).rejects.toThrow('WALLET_BATCH_NOT_SENT');
      expect(sentWith()).toEqual([{ paymasterService: { url: offer.url, context: offer.context } }]);
    });
    it('reads the offer only from FloFi\'s own proxy URL; a review preview (no grant) is never handed to a wallet', () => {
      expect(reportedPaymasterService({ '0x2105': { paymasterService: { supported: true } } }, 8453n)).toBe(true);
      expect(reportedPaymasterService({ '0xa4b1': { paymasterService: { supported: true } } }, 8453n)).toBe(false);
      expect(batchSponsorshipOf({ sponsorship: { url: offer.url, context: offer.context, required: true } })).toEqual({ ...offer, required: true });
      expect(batchSponsorshipOf({ sponsorship: { url: 'https://user:pass@flofi.example/x', context: null } })).toBeNull();
      expect(batchSponsorshipOf({ sponsorship: { url: 'http://flofi.example/x', context: null } })).toBeNull();
      expect(batchSponsorshipOf({})).toBeNull();
    });
  });
});

/**
 * Review fix U5: revoking a signed user operation sends a real transaction from the owner's wallet (`EntryPoint.incrementNonce`), so the network
 * is checked exactly as for a batch: read, switched if needed, and read AGAIN. A wallet whose switch "succeeds" without moving never sends it on
 * the network it is on (the nonce key would be spent on the wrong chain and the signed operation would stay valid).
 */
describe('revokeUserOperation', () => {
  const OWNER = '0x' + 'aB'.repeat(20), RUN = 'wfr_' + 'a'.repeat(26), TX = '0x' + 'cd'.repeat(32);
  const rpcError = (code: number) => () => { throw Object.assign(new Error(`wallet error ${code}`), { code }); };
  beforeEach(() => {
    wallet.log.length = 0;
    wallet.answers = { eth_chainId: () => '0xa4b1', eth_sendTransaction: () => TX };
  });
  const sent = () => wallet.log.filter(m => m === 'eth_sendTransaction').length;

  it('on the run\'s network: one transaction to the EntryPoint, no switch', async () => {
    await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).resolves.toBe(TX);
    expect(wallet.log).toEqual(['eth_chainId', 'eth_sendTransaction']);
  });
  it('switches first when needed, reads the network again, then sends', async () => {
    let chain = '0x2105';
    wallet.answers.eth_chainId = () => chain;
    wallet.answers.wallet_switchEthereumChain = () => { chain = '0xa4b1'; return null; };
    await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).resolves.toBe(TX);
    expect(wallet.log).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_sendTransaction']);
  });
  it('still on another network after the switch "succeeded": WALLET_WRONG_NETWORK, nothing is sent', async () => {
    wallet.answers.eth_chainId = () => '0x2105';
    wallet.answers.wallet_switchEthereumChain = () => null;
    await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).rejects.toThrow('WALLET_WRONG_NETWORK');
    expect(wallet.log).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
    expect(sent()).toBe(0);
  });
  it('a failed or rejected switch, or an unreadable network, is "nothing was sent" with a closed code', async () => {
    wallet.answers.eth_chainId = () => '0x2105';
    for (const code of [-32002, -32603, 4902]) {
      wallet.answers.wallet_switchEthereumChain = rpcError(code);
      await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).rejects.toThrow('WALLET_WRONG_NETWORK');
    }
    wallet.answers.wallet_switchEthereumChain = rpcError(4001);
    await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).rejects.toThrow('WALLET_REQUEST_REJECTED');
    wallet.answers.wallet_switchEthereumChain = () => null;
    wallet.answers.eth_chainId = () => 'not-a-chain';
    await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).rejects.toThrow('WALLET_WRONG_NETWORK');
    wallet.answers.eth_chainId = rpcError(-32603);
    await expect(revokeUserOperation(OWNER, 42161, RUN, 1)).rejects.toThrow('WALLET_WRONG_NETWORK');
    expect(sent()).toBe(0);
  });
});
