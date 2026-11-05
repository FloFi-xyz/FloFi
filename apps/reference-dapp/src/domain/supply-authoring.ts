// SPDX-License-Identifier: AGPL-3.0-only
import { ownDeclaration } from './node-declaration';
import { createSupplyNode, readSupplyNode, createBorrowNode, readBorrowNode, createRepayNode, readRepayNode, createWithdrawNode, readWithdrawNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { AAVE_V3_BASE_SEPOLIA, AAVE_V3_LENDING_PROFILES, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import type { SupplyReview } from '@defi-workflow-engine/reference-compiler';
import { resolveAssetReference } from './asset-catalogs';
import { networkIdentity } from './network-registry';
/**
 * Aave V3 authoring for each registered lending profile: Base Sepolia USDC, Ethereum Sepolia WBTC and (BUILD AAVE-V3-EXPANSION-001) every
 * listed reserve of the Ethereum, Base and Arbitrum One mainnet markets. The named network selects the market; the asset selects one of
 * that market's reserves by its exact identity. A written symbol is resolved within that one market only — to the reserve whose label it is
 * or, on official-catalog networks, to the catalog asset whose address is a reserve — and both must agree, so a symbol never reaches another
 * network ("USDC on Ethereum Sepolia" is refused, not mapped to another network's USDC) and never picks one of two different tokens.
 */
export type LendingNetwork = AaveLendingProfile['network'];
export type LendingAsset = AaveLendingProfile['symbol'];
export type SupplyInput={network:LendingNetwork;asset:LendingAsset;amount:string;beneficiary:string};
export const LENDING_NETWORKS: readonly LendingNetwork[] = Object.freeze([...new Set(AAVE_V3_LENDING_PROFILES.map(profile => profile.network))]);
/** Every registered reserve of a lending network (its market), the original verified asset first. */
export const lendingReservesFor = (network: string): readonly AaveLendingProfile[] => AAVE_V3_LENDING_PROFILES.filter(item => item.network === network);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The profile for an authored network and asset (exact address, reserve label, or official catalog asset); any other pair is unsupported. */
export function lendingProfileFor(network: string, asset: string, code = 'SUPPLY_DEPLOYMENT_UNSUPPORTED'): AaveLendingProfile {
  const reserves = lendingReservesFor(network);
  if (!reserves.length || typeof asset !== 'string' || !asset.trim() || asset.length > 120) throw new Error(code);
  const text = asset.trim();
  if (ADDRESS.test(text)) return reserves.find(item => item.asset === text.toLowerCase()) ?? (() => { throw new Error(code); })();
  const wanted = text.toLowerCase();
  const byLabel = reserves.filter(item => item.symbol.toLowerCase() === wanted || ('addressBookKey' in item && item.addressBookKey.toLowerCase() === wanted));
  let byCatalog: AaveLendingProfile | null = null;
  if (networkIdentity(network)?.catalog) {
    try {
      const resolved = resolveAssetReference(reserves[0]!.chain, text);
      if (resolved.kind === 'AMBIGUOUS') throw new Error(code);
      if (resolved.kind === 'FOUND' && resolved.asset.address)
        byCatalog = reserves.find(item => item.asset === resolved.asset.address!.toLowerCase() && item.decimals === resolved.asset.decimals) ?? null;
      // The catalog names a different token than every reserve: never substitute a reserve that only shares its label.
      if (resolved.kind === 'FOUND' && !byCatalog && byLabel.length) throw new Error(code);
    } catch (cause) { if (cause instanceof Error && cause.message === code) throw cause; }
  }
  if (byLabel.length > 1 || (byLabel[0] && byCatalog && byLabel[0] !== byCatalog)) throw new Error(code);
  const profile = byLabel[0] ?? byCatalog;
  if (!profile) throw new Error(code);
  return profile;
}
/** The default (original verified) Aave asset of a lending network: the first reserve of its market. */
export function lendingAssetFor(network:LendingNetwork):LendingAsset{
  const profile=lendingReservesFor(network)[0];if(!profile)throw new Error('SUPPLY_DEPLOYMENT_UNSUPPORTED');return profile.symbol;
}
/** The market profile serving a chain (its first reserve), or null when no lending profile serves it. Market-level facts only. */
export function lendingProfileOfChain(chain: string): AaveLendingProfile | null { return AAVE_V3_LENDING_PROFILES.find(item => item.chain === chain) ?? null; }
/** The exact reserve profile of a chain and asset address, or null. */
export function lendingProfileOfReserve(chain: string, asset: string | null | undefined): AaveLendingProfile | null {
  const address = typeof asset === 'string' ? asset.toLowerCase() : '';
  return AAVE_V3_LENDING_PROFILES.find(item => item.chain === chain && item.asset === address) ?? null;
}
/** Exact decimal amount in the asset's smallest unit; never more fractional digits than the asset has. */
export function parseLendingAmount(value:string,decimals:number):string {
  const pattern=new RegExp(`^(0|[1-9][0-9]*)(?:\\.[0-9]{1,${decimals}})?$`);
  if(typeof value!=='string'||!pattern.test(value)||value.length>80)throw new Error('SUPPLY_AMOUNT_INVALID');
  const [whole,fraction='']=value.split('.');const units=BigInt(whole!)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
  if(units<=0n||units>=1n<<256n)throw new Error('SUPPLY_AMOUNT_INVALID');return units.toString();
}
/** Six-decimal USDC amounts (Base Sepolia profile and the Base Sepolia lending composition). */
export function parseSupplyAmount(value:string):string { return parseLendingAmount(value,6); }
export function formatLendingAmount(units:string|bigint,decimals:number):string {
  const amount=BigInt(units),scale=10n**BigInt(decimals);
  return `${amount/scale}${amount%scale?'.'+(amount%scale).toString().padStart(decimals,'0').replace(/0+$/,''):''}`;
}
const assetOf=(profile:AaveLendingProfile)=>({chainId:profile.chain,address:profile.asset,decimals:profile.decimals});
function details(fields:{chain:string;amount:string;asset:{address?:string}}):{network:LendingNetwork;asset:LendingAsset;amount:string}|null{
  // The node's own reserve (chain + address) supplies the label and decimals; never the market's first reserve.
  const profile=lendingProfileOfReserve(fields.chain,fields.asset.address);
  return profile?{network:profile.network,asset:profile.symbol,amount:formatLendingAmount(fields.amount,profile.decimals)}:null;
}
export function createAuthoredSupply(nodeId:string,input:SupplyInput):SemanticWorkflow['nodes'][number]{
  const profile=lendingProfileFor(input.network,input.asset);
  return createSupplyNode(nodeId,{chain:profile.chain,asset:assetOf(profile),amount:parseLendingAmount(input.amount,profile.decimals),beneficiary:input.beneficiary});
}
export function supplyDetails(node:SemanticWorkflow['nodes'][number]):SupplyInput|null{
  node = ownDeclaration(node);
  if(node.actionType!=='supply')return null;
  const fields=readSupplyNode(node),shown=details(fields);
  return shown&&{...shown,beneficiary:fields.beneficiary};
}

// Some injected providers return a safe JS integer for this read instead of an RPC quantity.
// Preserve the raw response in diagnostics; normalize only lossless, nonnegative values.
export function supplyWalletNonce(value:unknown):bigint {
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
  if(typeof value==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))return BigInt(value);
  throw new Error('SUPPLY_WALLET_NONCE_RESPONSE_INVALID');
}
export function supplyWalletTransaction(prepared:Record<string,string>):Record<string,string> {
  const transaction={...prepared};delete transaction.nonce;
  for(const field of ['chainId','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','value']){
    if(transaction[field]!==undefined&&!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(transaction[field]))throw new Error('SUPPLY_WALLET_QUANTITY_INVALID');
  }
  return transaction;
}
/** The connected owner submits only the exact reviewed call and frozen fee envelope. */
export function assertSupplyWalletTransaction(prepared:Record<string,string>,review:SupplyReview,step:string):void {
  const index=step==='APPROVAL'?0:review.transactions.length-1,expected=review.transactions[index];
  if(!expected||Object.keys(prepared).some(key=>!['from','to','data','value','chainId','nonce','gas','gasPrice'].includes(key))||
      (['from','to','data','value','chainId'] as const).some(key=>prepared[key]!==expected[key])||
      prepared.gas!==`0x${BigInt(review.gasLimits[index]!).toString(16)}`||prepared.gasPrice!==`0x${BigInt(review.gasPrice).toString(16)}`)
    throw new Error('SUPPLY_WALLET_TRANSACTION_MISMATCH');
}

export function createAuthoredBorrow(nodeId:string,input:SupplyInput):SemanticWorkflow['nodes'][number]{
  const profile=lendingProfileFor(input.network,input.asset,'BORROW_DEPLOYMENT_UNSUPPORTED');
  return createBorrowNode(nodeId,{chain:profile.chain,asset:assetOf(profile),amount:parseLendingAmount(input.amount,profile.decimals),beneficiary:input.beneficiary,interestRateMode:2});
}
export function borrowDetails(node:SemanticWorkflow['nodes'][number]):SupplyInput|null{
  node = ownDeclaration(node);
  if(node.actionType!=='borrow')return null;
  // A composition Borrow (Supply → Borrow → Swap) is not a standalone declaration: it has no standalone details.
  let fields:ReturnType<typeof readBorrowNode>;try{fields=readBorrowNode(node);}catch{return null;}
  const shown=details(fields);
  return shown&&{...shown,beneficiary:fields.beneficiary};
}

export function createAuthoredRepay(nodeId:string,input:SupplyInput):SemanticWorkflow['nodes'][number]{
  const profile=lendingProfileFor(input.network,input.asset,'REPAY_DEPLOYMENT_UNSUPPORTED');
  return createRepayNode(nodeId,{chain:profile.chain,asset:assetOf(profile),amount:parseLendingAmount(input.amount,profile.decimals),beneficiary:input.beneficiary,interestRateMode:2});
}
export function repayDetails(node:SemanticWorkflow['nodes'][number]):SupplyInput|null{
  node = ownDeclaration(node);
  if(node.actionType!=='repay')return null;
  const fields=readRepayNode(node),shown=details(fields);
  return shown&&{...shown,beneficiary:fields.beneficiary};
}

export type WithdrawInput={network:LendingNetwork;asset:LendingAsset;amount:string;recipient:'CONNECTED_OWNER'};
export function createAuthoredWithdraw(nodeId:string,input:WithdrawInput):SemanticWorkflow['nodes'][number]{
  if(input.recipient!=='CONNECTED_OWNER')throw new Error('WITHDRAW_DEPLOYMENT_UNSUPPORTED');
  const profile=lendingProfileFor(input.network,input.asset,'WITHDRAW_DEPLOYMENT_UNSUPPORTED');
  return createWithdrawNode(nodeId,{chain:profile.chain,asset:assetOf(profile),amount:parseLendingAmount(input.amount,profile.decimals),recipient:input.recipient});
}
export function withdrawDetails(node:SemanticWorkflow['nodes'][number]):WithdrawInput|null{
  node = ownDeclaration(node);
  if(node.actionType!=='withdraw')return null;
  const fields=readWithdrawNode(node),shown=details(fields);
  return shown&&{...shown,recipient:fields.recipient};
}
/** "0.1 USDC · Base Sepolia" for a lending node; null for any other node. Display text only. */
export function lendingAmountLabel(node:SemanticWorkflow['nodes'][number]):string|null{
  const value=withdrawDetails(node)??repayDetails(node)??borrowDetails(node)??supplyDetails(node);
  return value&&`${value.amount} ${value.asset} · ${value.network}`;
}
/** Display facts of the reserve being authored or reviewed. Before anything is authored the panels describe Base Sepolia, as before. */
export type LendingView={network:LendingNetwork;asset:LendingAsset;decimals:number;explorer:string;chainHex:AaveLendingProfile['chainHex'];collateralBit:bigint};
const viewOf=(profile:AaveLendingProfile):LendingView=>({network:profile.network,asset:profile.symbol,decimals:profile.decimals,explorer:profile.explorer,chainHex:profile.chainHex,
  collateralBit:2n<<(2n*BigInt(profile.reserveId))});
/** The reviewed or authored reserve (chain + asset address); a chain without an asset shows its market's first reserve. */
export function lendingView(chain:string|null|undefined,asset?:string|null):LendingView{
  return viewOf((chain?lendingProfileOfReserve(chain,asset)??(asset?null:lendingProfileOfChain(chain)):null)??AAVE_V3_BASE_SEPOLIA);
}
/** Display facts of a lending network and asset chosen in an authoring form (the network's first reserve when no asset is chosen). */
export function lendingNetworkView(network:LendingNetwork,asset?:string):LendingView{
  // Display only: the registry entry the form selected (never a catalog lookup that may refuse); authoring still resolves through `lendingProfileFor`.
  const reserves=lendingReservesFor(network),wanted=asset??lendingAssetFor(network);
  return viewOf(reserves.find(reserve=>reserve.symbol===wanted)??reserves[0]??AAVE_V3_BASE_SEPOLIA);
}
/** Whether a form may author this registry reserve: its label resolves to exactly this reserve (a label the token list names differently is refused). */
export function lendingSelectable(network:string,reserve:{readonly symbol:string;readonly asset:string}):boolean{
  try{return lendingProfileFor(network,reserve.symbol).asset===reserve.asset;}catch{return false;}
}
/** The reserve asset address of an authored lending node (null for any other node). */
export function lendingNodeAsset(node:SemanticWorkflow['nodes'][number]):string|null{
  node = ownDeclaration(node);
  try{
    const fields=node.actionType==='supply'?readSupplyNode(node):node.actionType==='borrow'?readBorrowNode(node):node.actionType==='repay'?readRepayNode(node):node.actionType==='withdraw'?readWithdrawNode(node):null;
    return fields?.asset.address??null;
  }catch{return null;}
}
/** Panel copy is written for Base Sepolia USDC; the shown profile's network and asset are substituted. Display text only. */
export function lendingCopy(text:string,view:LendingView,tr:(value:string)=>string=value=>value):string{
  // A mainnet reserve holds real funds: never "Aave test" wording. The fixed sentence is translated first, then the network and asset are named.
  const copy=/Sepolia/.test(view.network)?text:text.replaceAll('the Aave test asset','this asset').replaceAll('Aave test ','');
  return tr(copy).replaceAll('Base Sepolia',view.network).replaceAll('USDC',view.asset);
}
