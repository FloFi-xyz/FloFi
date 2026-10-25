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
import { ARBITRUM_ONE } from './arbitrum-chain.js';
import { ETHEREUM_MAINNET } from './ethereum-chain.js';
import { ROBINHOOD_CHAIN_MAINNET } from './robinhood-chain.js';
import { JUPITER_SOLANA_MAINNET } from './jupiter-solana.js';

export type UniversalEvmDeployment = { readonly chain: string; readonly chainId: number; readonly chainHex: string; readonly rpc: string; readonly explorer: string;
  /** OP Stack source: receipts carry an L1 data fee bounded through the GasPriceOracle. */ readonly l1DataFee: boolean;
  /** Arbitrum Nitro source: gas limits include L1 posting gas (folded into gasUsed). */ readonly nitro: boolean;
  readonly relayDepository: string; readonly relayDepositoryCodeSha256: string };
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
const evm = (chain: string, chainId: number, rpc: string, explorer: string, codeSha256: string, flags: { l1DataFee?: boolean; nitro?: boolean } = {}): UniversalEvmDeployment =>
  Object.freeze({ chain, chainId, chainHex: '0x' + chainId.toString(16), rpc, explorer, l1DataFee: flags.l1DataFee === true, nitro: flags.nitro === true,
    relayDepository: '0x4cd00e387622c35bddb9b4c962c136462338bc31', relayDepositoryCodeSha256: codeSha256 });
export const UNIVERSAL_ROUTER_DEPLOYMENT: UniversalRouterDeployment = Object.freeze({
  adapterId: 'flofi.router.universal', protocol: 'relay-depository', environment: 'MAINNET',
  evm: Object.freeze({
    'eip155:8453': evm('eip155:8453', 8453, 'https://mainnet.base.org', 'https://basescan.org/', 'e1aba2f59c0b4f5838d6f283db6e09631ef58f558107b7d42000c7f1252d1eda', { l1DataFee: true }),
    'eip155:42161': evm('eip155:42161', 42161, ARBITRUM_ONE.rpc, ARBITRUM_ONE.explorer, 'd78b7a01ce1c25dd2bb1d845c10f28acc520fac31ddf81c79eefce888a4a385f', { nitro: true }),
    'eip155:1': evm('eip155:1', 1, ETHEREUM_MAINNET.rpc, 'https://etherscan.io/', '9c1545d18e0f4e037338d9c0c50b360f9312868a866ace22d5310de968e6ae97'),
    // Robinhood Chain (Arbitrum Orbit) is priced exactly as the existing Robinhood routes are: no OP Stack L1 fee, gasUsed folds in L1 data gas.
    'eip155:4663': evm('eip155:4663', 4663, ROBINHOOD_CHAIN_MAINNET.rpc, ROBINHOOD_CHAIN_MAINNET.explorer + '/', '3e9c39244f26b4a09b55792aaa61e37eb698ff83b3268e6c875c950e17a02b1a'),
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
  reviewTtlSeconds: 120, defaultSlippageBps: 50, maximumSlippageBps: 300, deliveryAttentionSeconds: 3_600,
});
export const universalEvmDeployment = (chain: string): UniversalEvmDeployment | null => UNIVERSAL_ROUTER_DEPLOYMENT.evm[chain] ?? null;
