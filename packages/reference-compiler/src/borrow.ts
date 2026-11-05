// SPDX-License-Identifier: AGPL-3.0-only
import { AAVE_V3_LENDING_PROFILES, aaveEnvironment, assertAaveLendingProfile, isAaveExpansionReserve, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { readBorrowNode, supplyAddress, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { readSupplyState, supplyCall, supplyHex, rpcUint, rpcHex, rpcHash, rpcRecord, supplyHash, lendingProfile, reserveBits, type SupplyRpc, type SupplyState, type SupplyTransaction } from './supply.js';
export const BORROW_MINIMUM_HEALTH_FACTOR = 2n * 10n ** 18n;
const UINT_MAX = (1n << 256n) - 1n;
const units = (value: string) => {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > UINT_MAX) throw new Error('BORROW_STATE_INVALID');
  return BigInt(value);
};
export type BorrowState = { collateralBase:string; debtBase:string; availableBorrowBase:string; liquidationThresholdBps:string;
  ltvBps:string; healthFactor:string; price:string; baseCurrencyUnit:string; reserveConfiguration:string; userConfiguration:string;
  liquidity:string; debt:string; scaledDebt:string; debtIndex:string; variableDebtToken:string; eMode:string; debtTotalSupply:string; codeHash:string;
  /** BUILD AAVE-V3-EXPANSION-001: the account's OTHER Aave reserves (collateral or debt), read and verified at the same block. Absent for an
   * account that uses only this reserve, which keeps the original exact single-reserve checks. */
  positions?: AavePosition[] };
/** One other reserve of a multi-reserve account, from its own verified registry profile. Units are the reserve's own; base values use the AaveOracle. */
export type AavePosition = { reserveId:string; asset:string; decimals:string; collateral:boolean; borrowing:boolean; supplied:string; debt:string; price:string;
  ltvBps:string; liquidationThresholdBps:string; debtCeiling:string; siloed:boolean; reserveConfiguration:string };
/** At most this many other reserves are read for one account (bounded RPC fan-out); a larger account fails closed. */
export const AAVE_MAX_ACCOUNT_POSITIONS = 24;
const field=(config:bigint,shift:bigint,bits:bigint)=>(config>>shift)&((1n<<bits)-1n);
/** Reserve configuration bits (Aave V3 ReserveConfiguration). */
export const reserveFlags=(config:string|bigint)=>{const c=BigInt(config);return {ltv:field(c,0n,16n),liquidationThreshold:field(c,16n,16n),decimals:field(c,48n,8n),
  active:Boolean(field(c,56n,1n)),frozen:Boolean(field(c,57n,1n)),borrowing:Boolean(field(c,58n,1n)),paused:Boolean(field(c,60n,1n)),
  borrowableInIsolation:Boolean(field(c,61n,1n)),siloed:Boolean(field(c,62n,1n)),borrowCap:field(c,80n,36n),supplyCap:field(c,116n,36n),debtCeiling:field(c,212n,40n)};};
/**
 * The account aggregates Aave's GenericLogic derives (E-Mode 0): collateral and debt in base currency, and the collateral-weighted LTV and
 * liquidation threshold. A collateral reserve with a zero liquidation threshold adds nothing; a zero LTV adds no borrowing power.
 */
export function aaveAccountTotals(entries:readonly {collateral:boolean;supplied:bigint;debt:bigint;price:bigint;scale:bigint;ltv:bigint;liquidationThreshold:bigint}[]):
    {collateralBase:bigint;debtBase:bigint;ltvBps:bigint;liquidationThresholdBps:bigint} {
  let collateral=0n,debt=0n,ltv=0n,threshold=0n;
  for(const e of entries){
    if(e.collateral&&e.liquidationThreshold!==0n&&e.supplied>0n){const value=e.supplied*e.price/e.scale;collateral+=value;ltv+=value*e.ltv;threshold+=value*e.liquidationThreshold;}
    if(e.debt>0n)debt+=e.debt*e.price/e.scale;
  }
  return {collateralBase:collateral,debtBase:debt,ltvBps:collateral?ltv/collateral:0n,liquidationThresholdBps:collateral?threshold/collateral:0n};
}
/** The target reserve and every other position as aggregate entries. */
function accountEntries(position:string,state:BorrowState,profile:AaveLendingProfile){
  const {collateral,scale}=reserveBits(profile),flags=reserveFlags(state.reserveConfiguration);
  return [{collateral:Boolean(BigInt(state.userConfiguration)&collateral),supplied:BigInt(position),debt:BigInt(state.debt),price:BigInt(state.price),scale,ltv:flags.ltv,liquidationThreshold:flags.liquidationThreshold},
    ...(state.positions??[]).map(p=>{const f=reserveFlags(p.reserveConfiguration);return {collateral:p.collateral,supplied:BigInt(p.supplied),debt:BigInt(p.debt),price:BigInt(p.price),scale:10n**BigInt(p.decimals),ltv:f.ltv,liquidationThreshold:f.liquidationThreshold};})];
}
/**
 * Proves a multi-reserve account's other positions describe exactly the user-configuration bits outside this reserve, every one a registered
 * reserve of the same market with a positive oracle price. A single-reserve account (no `positions`) must have no other bits, exactly as
 * before. `code` is the caller's unsupported-state error.
 */
export function assertAccountPositions(state:BorrowState,profile:AaveLendingProfile,code:string):void {
  const p=assertAaveLendingProfile(profile),{mask}=reserveBits(p),user=units(state.userConfiguration),others=user&~mask;
  if(!state.positions){if(others)throw new Error(code);return;}
  if(!others||aaveEnvironment(p)!=='MAINNET'||state.positions.length>AAVE_MAX_ACCOUNT_POSITIONS||units(state.eMode)!==0n)throw new Error(code);
  let bits=0n;
  for(const item of state.positions){
    const id=BigInt(item.reserveId),registered=AAVE_V3_LENDING_PROFILES.find(r=>r.chain===p.chain&&r.pool===p.pool&&BigInt(r.reserveId)===id&&r.asset===item.asset);
    const flags=reserveFlags(item.reserveConfiguration);
    if(!registered||registered===p||String(registered.decimals)!==item.decimals||flags.decimals!==BigInt(registered.decimals)||units(item.price)<=0n||
        String(flags.debtCeiling)!==item.debtCeiling||flags.siloed!==item.siloed||String(flags.ltv)!==item.ltvBps||String(flags.liquidationThreshold)!==item.liquidationThresholdBps||
        (!item.collateral&&!item.borrowing)||(item.borrowing&&units(item.debt)===0n))throw new Error(code);
    bits|=(item.borrowing?1n:0n)<<(2n*id)|(item.collateral?2n:0n)<<(2n*id);
  }
  if(bits!==others||new Set(state.positions.map(item=>item.reserveId)).size!==state.positions.length)throw new Error(code);
}
/** Aave's reported account aggregates equal the independently recomputed ones (this reserve's `position` plus every other position). */
export function assertAccountTotals(position:string,state:BorrowState,profile:AaveLendingProfile):void {
  const totals=aaveAccountTotals(accountEntries(position,state,assertAaveLendingProfile(profile))),n=BigInt(state.positions?.length??0)+1n,abs=(v:bigint)=>v<0n?-v:v;
  if(abs(units(state.collateralBase)-totals.collateralBase)>2n*n||abs(units(state.debtBase)-totals.debtBase)>2n*n+1n||
      abs(units(state.liquidationThresholdBps)-totals.liquidationThresholdBps)>1n||abs(units(state.ltvBps)-totals.ltvBps)>1n)throw new Error('BORROW_STATE_INVALID');
}
/** The account's base-currency value of everything except this reserve (other collateral and other debt), from verified positions. */
export function otherAccountBases(state:BorrowState):{collateralBase:bigint;debtBase:bigint;weightedThreshold:bigint} {
  let collateralBase=0n,debtBase=0n,weightedThreshold=0n;
  for(const p of state.positions??[]){
    const scale=10n**BigInt(p.decimals),threshold=BigInt(p.liquidationThresholdBps);
    if(p.collateral&&threshold!==0n&&BigInt(p.supplied)>0n){const value=BigInt(p.supplied)*BigInt(p.price)/scale;collateralBase+=value;weightedThreshold+=value*threshold;}
    if(BigInt(p.debt)>0n)debtBase+=BigInt(p.debt)*BigInt(p.price)/scale;
  }
  return {collateralBase,debtBase,weightedThreshold};
}
/** Isolation mode: the account's only collateral is a reserve with a debt ceiling. */
export function inIsolationMode(state:BorrowState,profile:AaveLendingProfile):boolean {
  const own=Boolean(units(state.userConfiguration)&reserveBits(profile).collateral),collaterals=[...own?[reserveFlags(state.reserveConfiguration).debtCeiling]:[],
    ...(state.positions??[]).filter(p=>p.collateral).map(p=>BigInt(p.debtCeiling))];
  return collaterals.length===1&&collaterals[0]!==0n;
}
export function borrowHealthFactor(collateral:string, threshold:string, debt:string):string {
  const c=units(collateral),lt=units(threshold),d=units(debt);
  if (lt>10000n) throw new Error('BORROW_STATE_INVALID');
  return d===0n ? UINT_MAX.toString() : (c*lt*10n**18n/(10000n*d)).toString();
}
export function estimateBorrow(amount:string,state:BorrowState,profile:AaveLendingProfile):{borrowValueBase:string;debtAfterBase:string;healthFactorAfter:string} {
  const {mask,collateral,scale}=reserveBits(profile),decimals=BigInt(assertAaveLendingProfile(profile).decimals);
  const a=units(amount),price=units(state.price),c=units(state.collateralBase),d=units(state.debtBase),lt=units(state.liquidationThresholdBps);
  if (!a || !price || !units(state.baseCurrencyUnit) || !c || !lt || units(state.ltvBps)>lt || lt>10000n || units(state.eMode)!==0n) throw new Error('BORROW_INSUFFICIENT_COLLATERAL');
  const cfg=units(state.reserveConfiguration);
  const health=units(state.healthFactor),calculated=BigInt(borrowHealthFactor(state.collateralBase,state.liquidationThresholdBps,state.debtBase));
  const difference=health>calculated?health-calculated:calculated-health;
  if((d===0n&&health!==UINT_MAX)||(d>0n&&difference>calculated/1000000n+1n)||(!state.positions&&units(state.userConfiguration)&~mask))throw new Error('BORROW_STATE_UNSUPPORTED');
  if(state.positions)assertAccountPositions(state,profile,'BORROW_STATE_UNSUPPORTED');
  const capacity=(c*units(state.ltvBps)+5000n)/10000n-d;
  const actual=units(state.availableBorrowBase),expected=capacity>0n?capacity:0n;
  if((actual>expected?actual-expected:expected-actual)>2n)throw new Error('BORROW_STATE_INVALID');
  if (((cfg>>56n)&1n)!==1n || ((cfg>>57n)&1n) || ((cfg>>60n)&1n) || !((cfg>>58n)&1n)) throw new Error('BORROW_RESERVE_UNAVAILABLE');
  if (((cfg>>48n)&255n)!==decimals || (cfg>>212n)&((1n<<40n)-1n)) throw new Error('BORROW_RESERVE_UNSUPPORTED');
  // Any enabled collateral of the account backs the borrow (one reserve or several); none at all is refused, never enabled by FloFi.
  if (!(units(state.userConfiguration)&collateral) && !state.positions?.some(p=>p.collateral)) throw new Error('BORROW_COLLATERAL_NOT_ENABLED');
  if (inIsolationMode(state,profile)) throw new Error('BORROW_ISOLATION_MODE_UNSUPPORTED');
  const otherDebt=(state.positions??[]).filter(p=>p.borrowing);
  if ((((cfg>>62n)&1n) && otherDebt.length) || otherDebt.some(p=>p.siloed)) throw new Error('BORROW_SILOED_CONFLICT');
  if (units(state.liquidity)<a) throw new Error('BORROW_INSUFFICIENT_LIQUIDITY');
  const cap=(cfg>>80n)&((1n<<36n)-1n);
  if (cap && units(state.debtTotalSupply)+a>cap*scale) throw new Error('BORROW_CAP_EXCEEDED');
  // Base-currency value of the borrowed amount, rounded up (Aave rounds down), so the preview is conservative.
  const value=(a*price+scale-1n)/scale;
  if (value>units(state.availableBorrowBase)) throw new Error('BORROW_ABOVE_CAPACITY');
  const healthFactorAfter=borrowHealthFactor(c.toString(),lt.toString(),(d+value).toString());
  if (units(state.healthFactor)<BORROW_MINIMUM_HEALTH_FACTOR || BigInt(healthFactorAfter)<BORROW_MINIMUM_HEALTH_FACTOR) throw new Error('BORROW_UNSAFE_HEALTH_FACTOR');
  return {borrowValueBase:value.toString(),debtAfterBase:(d+value).toString(),healthFactorAfter};
}
/** Existing deployment and balance reader, augmented only with Borrow debt/risk reads. */
export async function readBorrowState(rpc:SupplyRpc,profileInput:AaveLendingProfile,account:string,beneficiary:string,tag='latest'):Promise<SupplyState> {
  const p=assertAaveLendingProfile(profileInput);
  if (supplyAddress(account)!==supplyAddress(beneficiary)) throw new Error('BORROW_BENEFICIARY_MUST_BE_OWNER');
  const state=await readSupplyState(rpc,p,account,beneficiary,tag),blockTag=supplyHex(state.block);
  const call=(to:string,sig:string,...args:(string|bigint)[])=>rpc('eth_call',[{to,data:supplyCall(sig,...args)},blockTag]);
  const [reserve,accountData,price,baseUnit,user,eMode,debt,scaled,index,liquidity,total,oracle,underlying,pool,code] = await Promise.all([
    call(p.pool,'getReserveData(address)',p.asset),call(p.pool,'getUserAccountData(address)',account),call(p.oracle,'getAssetPrice(address)',p.asset),
    call(p.oracle,'BASE_CURRENCY_UNIT()'),call(p.pool,'getUserConfiguration(address)',account),call(p.pool,'getUserEMode(address)',account),
    call(p.variableDebtToken,'balanceOf(address)',beneficiary),call(p.variableDebtToken,'scaledBalanceOf(address)',beneficiary),
    call(p.pool,'getReserveNormalizedVariableDebt(address)',p.asset),call(p.asset,'balanceOf(address)',p.aToken),
    call(p.variableDebtToken,'totalSupply()'),call(p.provider,'getPriceOracle()'),call(p.variableDebtToken,'UNDERLYING_ASSET_ADDRESS()'),call(p.variableDebtToken,'POOL()'),
    rpc('eth_getCode',[p.variableDebtToken,blockTag]),
  ]);
  const words=(value:unknown,count:number)=>{const h=rpcHex(value).slice(2);if(h.length!==count*64)throw new Error('BORROW_STATE_INVALID');return h.match(/.{64}/g)!.map(w=>BigInt('0x'+w));};
  const r=words(reserve,15),a=words(accountData,6);
  // The reserve id fixes which user-configuration bits belong to this asset.
  if(r[7]!==BigInt(p.reserveId))throw new Error('BORROW_RESERVE_UNSUPPORTED');
  if (r[10]!==BigInt(p.variableDebtToken) || rpcUint(oracle)!==BigInt(p.oracle) || rpcUint(underlying)!==BigInt(p.asset) || rpcUint(pool)!==BigInt(p.pool) || rpcUint(baseUnit)!==100000000n || rpcHex(code).length<4 || rpcUint(index)<10n**27n) throw new Error('BORROW_DEPLOYMENT_MISMATCH');
  const borrow:BorrowState={collateralBase:a[0]!.toString(),debtBase:a[1]!.toString(),availableBorrowBase:a[2]!.toString(),liquidationThresholdBps:a[3]!.toString(),ltvBps:a[4]!.toString(),healthFactor:a[5]!.toString(),price:rpcUint(price).toString(),baseCurrencyUnit:rpcUint(baseUnit).toString(),reserveConfiguration:r[0]!.toString(),userConfiguration:rpcUint(user).toString(),liquidity:rpcUint(liquidity).toString(),debt:rpcUint(debt).toString(),scaledDebt:rpcUint(scaled).toString(),debtIndex:rpcUint(index).toString(),variableDebtToken:p.variableDebtToken,eMode:rpcUint(eMode).toString(),debtTotalSupply:rpcUint(total).toString(),codeHash:supplyHash(rpcHex(code))};
  const others=rpcUint(user)&~reserveBits(p).mask;
  // BUILD AAVE-V3-EXPANSION-001: a mainnet account that also uses other reserves of this market reads each of them at the same block, and
  // Aave's aggregates must equal the recomputed ones. E-Mode accounts stay unsupported (their LTV/threshold follow the category).
  if (others && aaveEnvironment(p)==='MAINNET') {
    if (rpcUint(eMode)!==0n || rpcUint(price)<=0n) throw new Error('BORROW_STATE_UNSUPPORTED');
    borrow.positions=await readAccountPositions(rpc,p,account,blockTag,rpcUint(user));
    assertAccountPositions(borrow,p,'BORROW_STATE_UNSUPPORTED');
    assertAccountTotals(state.position,borrow,p);
    const ray=10n**27n,abs=(n:bigint)=>n<0n?-n:n;
    if (abs(rpcUint(debt)-(rpcUint(scaled)*rpcUint(index)+ray/2n)/ray)>1n) throw new Error('BORROW_STATE_INVALID');
  } else if ('ownerBeneficiary' in p) {
    const {mask,collateral,scale}=reserveBits(p),config=r[0]!,ray=10n**27n;
    if (rpcUint(user)&~mask || rpcUint(eMode)!==0n || rpcUint(price)<=0n) throw new Error('BORROW_STATE_UNSUPPORTED');
    const collateralEnabled=Boolean(rpcUint(user)&collateral),position=BigInt(state.position);
    const expectedCollateral=collateralEnabled?position*rpcUint(price)/scale:0n,expectedDebt=rpcUint(debt)*rpcUint(price)/scale;
    const abs=(n:bigint)=>n<0n?-n:n;
    if (abs(a[0]!-expectedCollateral)>2n || abs(a[1]!-expectedDebt)>2n ||
        abs(rpcUint(debt)-(rpcUint(scaled)*rpcUint(index)+ray/2n)/ray)>1n ||
        a[3]!== (collateralEnabled&&position>0n?(config>>16n)&65535n:0n) ||
        a[4]!== (collateralEnabled&&position>0n?config&65535n:0n)) throw new Error('BORROW_STATE_INVALID');
  }
  if (rpcHash(rpcRecord(await rpc('eth_getBlockByNumber',[blockTag,false])).hash)!==state.blockHash) throw new Error('BORROW_REORG');
  return {...state,borrow};
}
/** Every other reserve the account uses (its user-configuration bits), each resolved by id on the Pool and matched to its registry profile. */
async function readAccountPositions(rpc:SupplyRpc,p:AaveLendingProfile,account:string,blockTag:string,user:bigint):Promise<AavePosition[]> {
  const ids:number[]=[];
  for(let id=0;id<128;id++)if(id!==p.reserveId&&(user>>(2n*BigInt(id)))&3n)ids.push(id);
  if(ids.length>AAVE_MAX_ACCOUNT_POSITIONS||user>>256n)throw new Error('BORROW_STATE_UNSUPPORTED');
  const call=(to:string,sig:string,...args:(string|bigint)[])=>rpc('eth_call',[{to,data:supplyCall(sig,...args)},blockTag]);
  return Promise.all(ids.map(async id=>{
    const asset='0x'+rpcUint(await call(p.pool,'getReserveAddressById(uint16)',BigInt(id))).toString(16).padStart(40,'0');
    const registered=AAVE_V3_LENDING_PROFILES.find(r=>r.chain===p.chain&&r.pool===p.pool&&r.reserveId===id&&r.asset===asset);
    if(!registered)throw new Error('BORROW_POSITION_UNVERIFIED');
    const [reserve,price,supplied,debt]=await Promise.all([call(p.pool,'getReserveData(address)',asset),call(p.oracle,'getAssetPrice(address)',asset),
      call(registered.aToken,'balanceOf(address)',account),call(registered.variableDebtToken,'balanceOf(address)',account)]);
    const h=rpcHex(reserve).slice(2);if(h.length!==15*64)throw new Error('BORROW_STATE_INVALID');
    const r=h.match(/.{64}/g)!.map(w=>BigInt('0x'+w)),flags=reserveFlags(r[0]!),bits=(user>>(2n*BigInt(id)))&3n;
    if(r[7]!==BigInt(id)||r[8]!==BigInt(registered.aToken)||r[10]!==BigInt(registered.variableDebtToken)||flags.decimals!==BigInt(registered.decimals)||rpcUint(price)<=0n)
      throw new Error('BORROW_POSITION_UNVERIFIED');
    return {reserveId:String(id),asset,decimals:String(registered.decimals),collateral:Boolean(bits&2n),borrowing:Boolean(bits&1n),supplied:rpcUint(supplied).toString(),
      debt:rpcUint(debt).toString(),price:rpcUint(price).toString(),ltvBps:flags.ltv.toString(),liquidationThresholdBps:flags.liquidationThreshold.toString(),
      debtCeiling:flags.debtCeiling.toString(),siloed:flags.siloed,reserveConfiguration:r[0]!.toString()};
  }));
}
export function compileBorrowCalls(workflow:SemanticWorkflow,account:string):SupplyTransaction[] {
  const nodes=workflow.nodes.filter(n=>n.actionType==='borrow');
  if(nodes.length!==1||workflow.nodes.some(n=>n.actionType!=='borrow'&&!n.actionType.startsWith('mock-'))||workflow.resourceEdges.some(e=>e.fromNodeId===nodes[0]?.nodeId||e.toNodeId===nodes[0]?.nodeId)||workflow.nodes.some(n=>n.dependencies.includes(nodes[0]?.nodeId??'')))throw new Error('BORROW_ISOLATED_ONLY');
  const f=readBorrowNode(nodes[0]!),owner=supplyAddress(account),p=lendingProfile(f.chain,'BORROW_DEPLOYMENT_UNSUPPORTED',f.asset);
  if(f.asset.address!==p.asset||f.asset.decimals!==p.decimals)throw new Error('BORROW_DEPLOYMENT_UNSUPPORTED');
  if(f.beneficiary!==owner)throw new Error('BORROW_BENEFICIARY_MUST_BE_OWNER');
  return [{from:owner,to:p.pool,value:'0x0',chainId:p.chainHex,data:supplyCall('borrow(address,uint256,uint256,uint16,address)',p.asset,BigInt(f.amount),2n,0n,owner)}];
}
/** Fixed configuration; bounded 0.1% drift for prices, interest and account values. */
export function assertBorrowFresh(amount:string,before:BorrowState,after:BorrowState,profile:AaveLendingProfile):void {
  for(const k of ['reserveConfiguration','userConfiguration','variableDebtToken','baseCurrencyUnit','eMode','codeHash','scaledDebt','liquidationThresholdBps','ltvBps'] as const)if(before[k]!==after[k])throw new Error('BORROW_AUTHORIZATION_STALE');
  const abs=(n:bigint)=>n<0n?-n:n;
  for(const k of ['collateralBase','debtBase','availableBorrowBase','price','healthFactor','debt'] as const){
    const a=units(before[k]),b=units(after[k]);
    if(abs(a-b)>a/1000n+2n)throw new Error('BORROW_AUTHORIZATION_STALE');
  }
  if(positionShape(before)!==positionShape(after))throw new Error('BORROW_AUTHORIZATION_STALE');
  const a=estimateBorrow(amount,before,profile),b=estimateBorrow(amount,after,profile);
  if(abs(BigInt(a.healthFactorAfter)-BigInt(b.healthFactorAfter))>BigInt(a.healthFactorAfter)/1000n)throw new Error('BORROW_AUTHORIZATION_STALE');
}

/** The other positions' reserves and collateral/debt flags only (reconciliation: a block's own governance change is not this transaction's). */
export const positionIdentity=(state:BorrowState):string=>JSON.stringify((state.positions??[]).map(p=>[p.reserveId,p.asset,p.collateral,p.borrowing]));
/**
 * Reconciliation mode of a lending effect. The original native-USDC single-reserve profiles keep their exact pre/post drift checks. Every
 * other reserve, and any multi-reserve account, proves Aave's aggregates independently at each block instead: account-weighted LTV and
 * liquidation threshold, collateral and debt values legitimately move with oracle prices and collateral mix, so they are recomputed from
 * the verified positions rather than compared across blocks.
 */
export const accountReconciliation=(profile:AaveLendingProfile,pre:BorrowState,post:BorrowState):boolean=>Boolean(pre.positions||post.positions)||isAaveExpansionReserve(assertAaveLendingProfile(profile));
/** The identity and flags of an account's other positions (a review stays valid only while they are the same reserves and configurations). */
export const positionShape=(state:BorrowState):string=>JSON.stringify((state.positions??[]).map(p=>[p.reserveId,p.asset,p.collateral,p.borrowing,p.reserveConfiguration]));
