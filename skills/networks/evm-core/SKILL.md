# EVM core (FloFi engineering skill)

Reference knowledge for reviewing FloFi's EVM read, review and execution paths. It informs review; the code, the
capability registry and deterministic tests remain the evidence.

## Transactions and fees
- FloFi signs only EIP-1559 (type 2) transactions: `maxFeePerGas`, `maxPriorityFeePerGas`, `gas`, `nonce`, `chainId`
  are bound by the Review or bounded at signing (`server/managed-signing.ts`). A legacy-gas request is refused.
- The nonce a reviewed transaction carries is the account's next *pending* nonce. Each run reserves its nonce; a
  second signature for the same attempt must never be valid alongside the first.
- Gas: owner-bound Reviews estimate at the quote's pinned block; `begin` estimates again at the latest block just before
  the wallet request and refuses an estimate above the reviewed limit. Nitro (Arbitrum) estimates include posting gas;
  OP Stack chains (Base) add an L1 data fee read from the GasPriceOracle predeploy.

## Reads
- Every quote and Review read is pinned to one block (`eth_getBlockByNumber` → number/hash), and the block hash is
  re-read at the end: a different hash is a reorg (`QUOTE_BLOCK_REORG`), never "probably fine".
- `eth_chainId` binds a client to its chain (`chainBoundRpc`); a wrong chain is refused, never followed.
- A contract created by CREATE/CREATE2 keeps its code (EIP-6780 limits SELFDESTRUCT to the creating transaction;
  CREATE2 redeploys need it), so pinned code hashes and constructor immutables are stable facts (`DeploymentFactCache`).
  An EIP-7702 delegation designator (`0xef0100…`) on an account can be changed or cleared, so it is never cached.
  Balances, allowances, liquidity, prices, nonces and fees are never cached and are always read fresh.

## Latency
- Public endpoints rate-limit bursts: reads go through `pacedReadRpc` (one at a time, 250 ms). Only an operator
  endpoint declared `GRYLOO_RPC_READ_PROFILE=dedicated` runs bounded parallel reads. Parallelizing code does not help
  a serialized transport; removing redundant reads does.
- Independent reads may be issued together only when their failures are still judged in the original order.

## Never
- Never move a decision to a provider answer or a hash: completion is a reconciled outcome.
- Never retry a submission whose result is unknown; reconcile it.
