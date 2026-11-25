// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: deployment profile of the universal Cross-chain Router — the five FloFi mainnets as source and
 * destination, executed through Relay's Depository (the `relay-depository` protocol) with FloFi-built source transactions.
 *
 * Verified read-only on 2026-10-25:
 *  - Relay EVM Depository `0x4cd00e387622c35bddb9b4c962c136462338bc31` at the same address on Base (block ≈ 53,070,500), Arbitrum One
 *    (≈ 518,137,100), Ethereum (≈ 26,269,600) and Robinhood Chain (≈ 97,577,100): 8,628 bytes of runtime code, NOT a proxy (EIP-1967
 *    implementation slot empty); per-chain SHA-256 of the runtime code below (immutables differ per chain). Real `RelayErc20Deposit` /
 *    `RelayNativeDeposit` logs observed on Arbitrum One and Robinhood Chain.
 *  - Relay Solana Depository program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`: executable, owned by the upgradeable BPF loader,
 *    ProgramData `6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF`, upgrade authority `6Bz8AWWipCDf7XCSqNuRXrEtKZM5M4Y56uP9ZRjSaMWD`, last
 *    deployed at slot 386,211,280. The program is upgradeable by Relay: FloFi pins the deployment slot and authority and fails closed on
 *    any redeployment until it is re-verified.
 * A different deployment anywhere fails closed (`UNIVERSAL_UNEXPECTED_CONTRACT`).
 */
import { UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS } from '@defi-workflow-engine/workflow-contracts';
import { ARBITRUM_ONE } from './arbitrum-chain.js';
import { ETHEREUM_MAINNET } from './ethereum-chain.js';
import { ROBINHOOD_CHAIN_MAINNET } from './robinhood-chain.js';
import { JUPITER_SOLANA_MAINNET } from './jupiter-solana.js';

export type UniversalEvmDeployment = { readonly chain: string; readonly chainId: number; readonly chainHex: string; readonly rpc: string; readonly explorer: string;
  /** OP Stack source: receipts carry an L1 data fee bounded through the GasPriceOracle. */ readonly l1DataFee: boolean;
  /** Arbitrum Nitro source: gas limits include L1 posting gas (folded into gasUsed). */ readonly nitro: boolean;
  readonly relayDepository: string; readonly relayDepositoryCodeSha256: string;
  readonly relaySettlement?: { readonly router: string; readonly executors: readonly string[] } };
export type UniversalSolanaDeployment = { readonly chain: string; readonly cluster: 'mainnet-beta'; readonly walletChain: 'solana:mainnet'; readonly genesisHash: string;
  readonly rpc: string; readonly explorer: string;
  readonly relayProgram: string; readonly relayProgramData: string; readonly relayUpgradeAuthority: string; readonly relayDeploymentSlot: number;
  /** Compute budget FloFi adds to the deposit transaction (limit is the simulated usage + margin, capped here). */
  readonly computeUnitPriceMicroLamports: string; readonly maximumComputeUnits: number };
export type UniversalRouterDeployment = {
  readonly adapterId: 'flofi.router.universal'; readonly protocol: 'relay-depository'; readonly environment: 'MAINNET';
  readonly evm: Readonly<Record<string, UniversalEvmDeployment>>; readonly solana: UniversalSolanaDeployment;
  readonly providers: { readonly relay: { readonly api: string; readonly docs: string }; readonly lifi: { readonly api: string; readonly integrator: string };
    /** Mayan's quote API refuses requests without the SDK version it serves (`SDK_VERSION_TOO_OLD`); the value its official SDK sends. */
    readonly mayan: { readonly api: string; readonly sdkVersion: string }; readonly across: { readonly api: string } };
  /** A Review authorizes wallet requests for at most this long (provider quotes move with prices and gas). */ readonly reviewTtlSeconds: number;
  readonly defaultSlippageBps: number; readonly maximumSlippageBps: number;
  /** No delivery after this long past the source confirmation: the run needs attention (it keeps observing; refunds are verified). */
  readonly deliveryAttentionSeconds: number;
};
/**
 * Relay native fills on EVM destinations: the solver EOA pays the recipient directly, or a Relay solver calls RelayRouter v3.2, which
 * forwards the value by an internal call (BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0 incident, Base, 2026-11-18). Router address from
 * Relay GET /chains `contracts.v3.2.erc20Router`; bytecode sha256 05acc78feee62dee91038a20707e37e13097745985bc33881a2e344f73e0a71d is
 * identical on all four networks (eth_getCode, 2026-11-18). Executors are that response's `solverAddresses` per chain. They only
 * authorize the order binding, through a router call or an exact order word in a direct payment to the reviewed recipient.
 * The verifier independently proves the value credited by the canonical transaction.
 */
export const RELAY_ROUTER_V3_2 = '0x0729e2a4716d9f7dd17858d5d504426d228697f7';
const relaySolvers = (addresses: readonly string[]) => Object.freeze({ router: RELAY_ROUTER_V3_2, executors: Object.freeze([...addresses]) });
export const RELAY_SETTLEMENT_EXECUTORS = Object.freeze({
  // ethereum (1)
  1: relaySolvers([
      '0x18dd3c14e34c1bc379f7538068c59160d9f68e25', '0x331d9a049d496385998067abf6cbb6371c8d2466', '0x370a7e2d300c14d79d4a7ee07aaca46c4b3012cf',
      '0x56c262027e0de4aea31d2489529cb25d23e58a8b', '0xa5a5491bca93dd4c076e4906e79e7673f4a5a142', '0xa67d7eb4dc68fa6ce8e34ef8cadaf075b9893fbb',
      '0xabb2acd3be814a80e502575d6c1dc5f789e9cd10', '0xada5bb90d0de0bd1b6f3938708f49295a8d1f7cb', '0xca7ded7e4f4ba8ab3b10009236ae6d1b95094589',
      '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
  ]),
  // base (8453)
  8453: relaySolvers([
      '0x035239dd57a4716e14e4a00f84b8fa7ee03e152e', '0x059df16bdcf8a6bd20bb4814518ff6a2df3c7b11', '0x0ec4e45f9ce3020024c0418a74cd31fbc487038f',
      '0x18dd3c14e34c1bc379f7538068c59160d9f68e25', '0x1cd9d560440aab96f7b0a007ced7c2191cac5baf', '0x2bb27b73c602643f42471d4751fe4fc4eebefbd1',
      '0x331d9a049d496385998067abf6cbb6371c8d2466', '0x344daadde53a81f95bcc46a99d39107a509251a1', '0x370a7e2d300c14d79d4a7ee07aaca46c4b3012cf',
      '0x4381045063b19a615a272733fa6b5f169b622646', '0x511808449be470efaf4131838b2d4998500a6f72', '0x53939cb0b8b5d8ebc8f8208273a04a12f21c7346',
      '0x56c262027e0de4aea31d2489529cb25d23e58a8b', '0x59a2c9bd639226012d59bba67b6990743193af78', '0x6085932878d587332419ac976fc13d98eba6fdab',
      '0x67d698a325f29e17a9477f28ba4fe50f1cec60e4', '0x69374f8233a4069d48f8994d84052ecae6277ef5', '0x698dd6c03b50c3d4af12932a0388338bcdd3aaed',
      '0x6d0a66df5f4a32be3656f63750e0253eb59d9399', '0x728f51950ff096dc03a48f5e83f45ac8bb75f500', '0x744dce9a9e94ac1d124bec9f2a02a9b3ec68507d',
      '0x81adf99fcc6073157008e25010967d307875c13c', '0x850ae73e224780aff70d46157e7acc1038d9ceb6', '0x8583297605d996da21b5f47d69bf56a0f7fb74f4',
      '0x919968a4238a54b381f022a360260ef5d7e015ac', '0x9bc462bce2acd6fbe2ef5470d55b439453451083', '0xa5a5491bca93dd4c076e4906e79e7673f4a5a142',
      '0xa67d7eb4dc68fa6ce8e34ef8cadaf075b9893fbb', '0xabb2acd3be814a80e502575d6c1dc5f789e9cd10', '0xada5bb90d0de0bd1b6f3938708f49295a8d1f7cb',
      '0xca7ded7e4f4ba8ab3b10009236ae6d1b95094589', '0xcc4bc7882d5ec4a3716e589ab3d816b61ae47a1a', '0xd460b4182ed80992d498290bcbc6b60e95de181b',
      '0xd782268f600403843484b70710daee6846fc0db8', '0xd9497b53abcd6972b6370cb195b6bfd6b280e607', '0xe209e0047731aa494289e1af9a0d03da19c5ef08',
      '0xeb81da7ac500267f62d9f93a03a0a5fb86864b2a', '0xf42b73d2e4d3912eade2a5f7ab39b54064c2acec', '0xf57519ebc17347af5a6eb3df2eab68204b1df4e1',
      '0xf70da97812cb96acdf810712aa562db8dfa3dbef', '0xfdee58cc140e170d72aba75f29b23d7bcc05da0c',
  ]),
  // arbitrum (42161)
  42161: relaySolvers([
      '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
  ]),
  // robinhood (4663)
  4663: relaySolvers([
      '0x059df16bdcf8a6bd20bb4814518ff6a2df3c7b11', '0x0ec4e45f9ce3020024c0418a74cd31fbc487038f', '0x18dd3c14e34c1bc379f7538068c59160d9f68e25',
      '0x1cd9d560440aab96f7b0a007ced7c2191cac5baf', '0x2bb27b73c602643f42471d4751fe4fc4eebefbd1', '0x331d9a049d496385998067abf6cbb6371c8d2466',
      '0x344daadde53a81f95bcc46a99d39107a509251a1', '0x370a7e2d300c14d79d4a7ee07aaca46c4b3012cf', '0x4381045063b19a615a272733fa6b5f169b622646',
      '0x511808449be470efaf4131838b2d4998500a6f72', '0x56c262027e0de4aea31d2489529cb25d23e58a8b', '0x6085932878d587332419ac976fc13d98eba6fdab',
      '0x67d698a325f29e17a9477f28ba4fe50f1cec60e4', '0x69374f8233a4069d48f8994d84052ecae6277ef5', '0x698dd6c03b50c3d4af12932a0388338bcdd3aaed',
      '0x728f51950ff096dc03a48f5e83f45ac8bb75f500', '0x81adf99fcc6073157008e25010967d307875c13c', '0x919968a4238a54b381f022a360260ef5d7e015ac',
      '0x9bc462bce2acd6fbe2ef5470d55b439453451083', '0xa5a5491bca93dd4c076e4906e79e7673f4a5a142', '0xa67d7eb4dc68fa6ce8e34ef8cadaf075b9893fbb',
      '0xabb2acd3be814a80e502575d6c1dc5f789e9cd10', '0xada5bb90d0de0bd1b6f3938708f49295a8d1f7cb', '0xca7ded7e4f4ba8ab3b10009236ae6d1b95094589',
      '0xcc4bc7882d5ec4a3716e589ab3d816b61ae47a1a', '0xd460b4182ed80992d498290bcbc6b60e95de181b', '0xd782268f600403843484b70710daee6846fc0db8',
      '0xd9497b53abcd6972b6370cb195b6bfd6b280e607', '0xe209e0047731aa494289e1af9a0d03da19c5ef08', '0xf42b73d2e4d3912eade2a5f7ab39b54064c2acec',
      '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
  ]),
});
const evm = (chain: string, chainId: number, rpc: string, explorer: string, codeSha256: string,
  flags: { l1DataFee?: boolean; nitro?: boolean; relaySettlement?: UniversalEvmDeployment['relaySettlement'] } = {}): UniversalEvmDeployment =>
  Object.freeze({ chain, chainId, chainHex: '0x' + chainId.toString(16), rpc, explorer, l1DataFee: flags.l1DataFee === true, nitro: flags.nitro === true,
    ...flags.relaySettlement ? { relaySettlement: flags.relaySettlement } : {},
    relayDepository: '0x4cd00e387622c35bddb9b4c962c136462338bc31', relayDepositoryCodeSha256: codeSha256 });
export const UNIVERSAL_ROUTER_DEPLOYMENT: UniversalRouterDeployment = Object.freeze({
  adapterId: 'flofi.router.universal', protocol: 'relay-depository', environment: 'MAINNET',
  evm: Object.freeze({
    'eip155:8453': evm('eip155:8453', 8453, 'https://mainnet.base.org', 'https://basescan.org/', 'e1aba2f59c0b4f5838d6f283db6e09631ef58f558107b7d42000c7f1252d1eda', {
      l1DataFee: true, relaySettlement: RELAY_SETTLEMENT_EXECUTORS[8453] }),
    'eip155:42161': evm('eip155:42161', 42161, ARBITRUM_ONE.rpc, ARBITRUM_ONE.explorer, 'd78b7a01ce1c25dd2bb1d845c10f28acc520fac31ddf81c79eefce888a4a385f', {
      nitro: true, relaySettlement: RELAY_SETTLEMENT_EXECUTORS[42161] }),
    'eip155:1': evm('eip155:1', 1, ETHEREUM_MAINNET.rpc, 'https://etherscan.io/', '9c1545d18e0f4e037338d9c0c50b360f9312868a866ace22d5310de968e6ae97', {
      relaySettlement: RELAY_SETTLEMENT_EXECUTORS[1] }),
    // Robinhood Chain (Arbitrum Orbit) is priced exactly as the existing Robinhood routes are: no OP Stack L1 fee, gasUsed folds in L1 data gas.
    'eip155:4663': evm('eip155:4663', 4663, ROBINHOOD_CHAIN_MAINNET.rpc, ROBINHOOD_CHAIN_MAINNET.explorer + '/', '3e9c39244f26b4a09b55792aaa61e37eb698ff83b3268e6c875c950e17a02b1a', {
      relaySettlement: RELAY_SETTLEMENT_EXECUTORS[4663] }),
  }),
  solana: Object.freeze({ chain: JUPITER_SOLANA_MAINNET.chain, cluster: 'mainnet-beta', walletChain: 'solana:mainnet', genesisHash: JUPITER_SOLANA_MAINNET.genesisHash,
    rpc: JUPITER_SOLANA_MAINNET.rpc, explorer: 'https://solscan.io/',
    relayProgram: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', relayProgramData: '6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF',
    relayUpgradeAuthority: '6Bz8AWWipCDf7XCSqNuRXrEtKZM5M4Y56uP9ZRjSaMWD', relayDeploymentSlot: 386_211_280,
    computeUnitPriceMicroLamports: '50000', maximumComputeUnits: 200_000 }),
  providers: Object.freeze({
    relay: Object.freeze({ api: 'https://api.relay.link', docs: 'https://docs.relay.link/references/api/api_core_concepts/input-validation' }),
    lifi: Object.freeze({ api: 'https://li.quest/v1', integrator: 'flofi' }),
    mayan: Object.freeze({ api: 'https://price-api.mayan.finance/v3', sdkVersion: '15_3_0' }), // @mayanfinance/swap-sdk 15.3.0, read 2026-10-25
    across: Object.freeze({ api: 'https://app.across.to/api' }),
  }),
  reviewTtlSeconds: 120, defaultSlippageBps: 50, maximumSlippageBps: UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS, deliveryAttentionSeconds: 3_600,
});
export const universalEvmDeployment = (chain: string): UniversalEvmDeployment | null => UNIVERSAL_ROUTER_DEPLOYMENT.evm[chain] ?? null;
