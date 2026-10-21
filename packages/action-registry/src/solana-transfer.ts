// SPDX-License-Identifier: Apache-2.0
import { JUPITER_SOLANA_MAINNET, SOLANA_MAINNET_TOKENS } from './jupiter-solana.js';
import { ORCA_WHIRLPOOLS_DEVNET, SOLANA_DEVNET_TOKENS } from './solana-devnet.js';
/**
 * BUILD-SOLANA-TRANSFER-UX-001: direct transfers to another wallet on Solana mainnet-beta (real funds) and Solana Devnet (valueless test
 * tokens). Native SOL moves with the System Program `Transfer`; SPL tokens with the token's own program (`TokenkegQ…` or Token-2022
 * `TokenzQd…`) via `TransferChecked`, creating the recipient's Associated Token Account idempotently when it is missing.
 * Sources (checked 2026-10-17): https://docs.anza.xyz/runtime/programs (System Program), https://www.solana-program.com/docs/token,
 * https://www.solana-program.com/docs/token-2022 and https://www.solana-program.com/docs/token-2022/extensions (extension types),
 * https://www.solana-program.com/docs/associated-token-account (CreateIdempotent). The verified token list repeats the mints FloFi already
 * pins for Jupiter (mainnet) and Orca (Devnet); any other mint is accepted only with the decimals and token program the chain reports.
 */
export type SolanaTransferAsset = { readonly symbol: string; readonly label: string; readonly mint: string | null; readonly decimals: number;
  readonly program: 'native' | 'spl-token' | 'token-2022' };
export type SolanaTransferProfile = {
  readonly network: 'Solana' | 'Solana Devnet'; readonly cluster: 'mainnet-beta' | 'devnet'; readonly chain: string; readonly genesisHash: string;
  readonly walletChain: 'solana:mainnet' | 'solana:devnet'; readonly environment: 'MAINNET' | 'PUBLIC_TESTNET';
  readonly provenance: 'PUBLIC_MAINNET' | 'PUBLIC_DEVNET'; readonly executedEvidence: 'PUBLIC_EXECUTED' | 'DEVNET_EXECUTED';
  readonly bundleEnvironment: 'MAINNET_EXECUTED' | 'TESTNET_EXECUTED'; readonly realFunds: boolean;
  /** Run ids `<idPrefix>-<32 hex>`; every error the shared core raises starts with `SOLANA_TRANSFER_`. */
  readonly idPrefix: 'soltx' | 'soltd';
  readonly programs: { readonly system: string; readonly token: string; readonly token2022: string; readonly associatedToken: string; readonly computeBudget: string };
  readonly rpc: string; readonly explorer: string; readonly officialSource: string;
  readonly baseFeeLamports: string;
  /**
   * The transaction carries its own reviewed priority fee: a transaction without one is changed by wallets that add a price before signing
   * (P0, observed with Phantom), and the exact-byte check would then refuse it. Micro-lamports per compute unit.
   */
  readonly computeUnitPriceMicroLamports: string; readonly maximumComputeUnits: number;
  readonly reviewTtlSeconds: number;
  /** Largest native amount one transfer may move, in lamports (a typo guard, not a balance). */
  readonly maximumLamports: string;
  readonly assets: readonly SolanaTransferAsset[];
  explorerTx(signature: string): string;
};
const PROGRAMS = Object.freeze({ system: '11111111111111111111111111111111', token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudget: 'ComputeBudget111111111111111111111111111111' });
const native = (label: string): SolanaTransferAsset => Object.freeze({ symbol: 'SOL', label, mint: null, decimals: 9, program: 'native' });
export const SOLANA_MAINNET_TRANSFER: SolanaTransferProfile = Object.freeze({
  network: 'Solana', cluster: 'mainnet-beta', chain: JUPITER_SOLANA_MAINNET.chain, genesisHash: JUPITER_SOLANA_MAINNET.genesisHash, walletChain: 'solana:mainnet',
  environment: 'MAINNET', provenance: 'PUBLIC_MAINNET', executedEvidence: 'PUBLIC_EXECUTED', bundleEnvironment: 'MAINNET_EXECUTED', realFunds: true, idPrefix: 'soltx',
  programs: PROGRAMS, rpc: JUPITER_SOLANA_MAINNET.rpc, explorer: JUPITER_SOLANA_MAINNET.explorer, officialSource: 'https://www.solana-program.com/docs/token',
  baseFeeLamports: '5000', computeUnitPriceMicroLamports: '200000', maximumComputeUnits: 200_000, reviewTtlSeconds: 60, maximumLamports: '10000000000000',
  assets: Object.freeze([native('SOL'),
    Object.freeze({ symbol: 'USDC', label: 'USDC', mint: SOLANA_MAINNET_TOKENS.USDC.mint, decimals: SOLANA_MAINNET_TOKENS.USDC.decimals, program: 'spl-token' as const }),
    Object.freeze({ symbol: 'USDT', label: 'USDT', mint: SOLANA_MAINNET_TOKENS.USDT.mint, decimals: SOLANA_MAINNET_TOKENS.USDT.decimals, program: 'spl-token' as const })]),
  explorerTx: (signature: string) => `${JUPITER_SOLANA_MAINNET.explorer}/tx/${signature}`,
});
export const SOLANA_DEVNET_TRANSFER: SolanaTransferProfile = Object.freeze({
  network: 'Solana Devnet', cluster: 'devnet', chain: ORCA_WHIRLPOOLS_DEVNET.chain, genesisHash: ORCA_WHIRLPOOLS_DEVNET.genesisHash, walletChain: 'solana:devnet',
  environment: 'PUBLIC_TESTNET', provenance: 'PUBLIC_DEVNET', executedEvidence: 'DEVNET_EXECUTED', bundleEnvironment: 'TESTNET_EXECUTED', realFunds: false, idPrefix: 'soltd',
  programs: PROGRAMS, rpc: ORCA_WHIRLPOOLS_DEVNET.rpc, explorer: ORCA_WHIRLPOOLS_DEVNET.explorer, officialSource: 'https://www.solana-program.com/docs/token',
  baseFeeLamports: '5000', computeUnitPriceMicroLamports: ORCA_WHIRLPOOLS_DEVNET.computeUnitPriceMicroLamports, maximumComputeUnits: 200_000, reviewTtlSeconds: 60,
  maximumLamports: '1000000000000',
  assets: Object.freeze([native('Devnet SOL'),
    Object.freeze({ symbol: 'devUSDC', label: 'devUSDC (test)', mint: SOLANA_DEVNET_TOKENS.devUSDC.mint, decimals: SOLANA_DEVNET_TOKENS.devUSDC.decimals, program: 'spl-token' as const })]),
  explorerTx: (signature: string) => `${ORCA_WHIRLPOOLS_DEVNET.explorer}/tx/${signature}?cluster=devnet`,
});
export const SOLANA_TRANSFER_PROFILES: readonly SolanaTransferProfile[] = Object.freeze([SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER]);
export function solanaTransferProfile(chain: string): SolanaTransferProfile | null {
  return SOLANA_TRANSFER_PROFILES.find(profile => profile.chain === chain) ?? null;
}
/** A verified asset of the profile by symbol (case-insensitive) or mint; null for any other mint (chain-verified at Simulate). */
export function solanaTransferAsset(profile: SolanaTransferProfile, reference: string): SolanaTransferAsset | null {
  return profile.assets.find(asset => asset.mint === reference || asset.symbol.toLowerCase() === reference.toLowerCase()) ?? null;
}
/**
 * Token-2022 extension types (spl-token-2022 `ExtensionType`). FloFi accepts a Token-2022 mint only when every extension is listed in
 * `SAFE_MINT_EXTENSIONS` (and its conditions hold at Simulate), so a transfer can be reviewed and reconciled exactly. Anything else is
 * refused with `SOLANA_TRANSFER_TOKEN_EXTENSION_UNSUPPORTED` before any wallet request.
 */
export const TOKEN_2022_EXTENSIONS = Object.freeze({ TransferFeeConfig: 1, TransferFeeAmount: 2, MintCloseAuthority: 3, ConfidentialTransferMint: 4,
  ConfidentialTransferAccount: 5, DefaultAccountState: 6, ImmutableOwner: 7, MemoTransfer: 8, NonTransferable: 9, InterestBearingConfig: 10, CpiGuard: 11,
  PermanentDelegate: 12, NonTransferableAccount: 13, TransferHook: 14, TransferHookAccount: 15, ConfidentialTransferFeeConfig: 16, ConfidentialTransferFeeAmount: 17,
  MetadataPointer: 18, TokenMetadata: 19, GroupPointer: 20, TokenGroup: 21, GroupMemberPointer: 22, TokenGroupMember: 23, ConfidentialMintBurn: 24,
  ScaledUiAmount: 25, Pausable: 26, PausableAccount: 27 } as const);
/**
 * Mint extensions a reviewed transfer can carry: metadata/group pointers and data, a mint close authority, a default account state of
 * Initialized, a permanently zero transfer fee in both epochs, and an immutable transfer hook with no program. Conditional ones are checked by the compiler.
 */
export const SAFE_MINT_EXTENSIONS: readonly number[] = Object.freeze([1, 3, 6, 14, 18, 19, 20, 21, 22, 23]);
/** Token-account extensions on the owner's and the recipient's accounts that leave a direct `TransferChecked` unchanged. */
export const SAFE_ACCOUNT_EXTENSIONS: readonly number[] = Object.freeze([2, 7, 8, 11, 15]);
