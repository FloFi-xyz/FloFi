// SPDX-License-Identifier: AGPL-3.0-only
/** Phase 5 certification: shared lending runtime, disposable signed MOCKED wallet only. */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AAVE_V3_ARBITRUM as p, AAVE_V3_BASE, assertAaveLendingProfile, aaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { createSupplyNode, createBorrowNode, createRepayNode, createWithdrawNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { assertSupplyReview, supplyCall, supplyHex, type SupplyRpc } from '@defi-workflow-engine/reference-compiler';
import { validateSupplyRun } from '@defi-workflow-engine/reference-executor';
import { createSupplyService, type SupplyRecord } from './supply-service';
import { CATALOG_NETWORKS, catalogNetworkOfRun } from './catalog-networks';
import { nitroGasLimit, nitroMaxFeePerGas } from './arbitrum-fees';
import { createSupplyReadRpc } from './supply-rpc';
import { FLOWS, flowMode } from '../../backend/flows';
import { assertSupplyWalletTransaction } from '../domain/supply-authoring';
// @ts-expect-error Shared browser fixture is plain JavaScript; no public transport exists.
import { createSupplyHarness, mockAllowanceSlot, REPAY_OWNER as OWNER } from '../../e2e/supply-harness.mjs';

type Action = 'supply' | 'borrow' | 'repay' | 'withdraw';
type Model = { state: { owner:string;block:number;nonce:number;allowanceSlot:string;balance:bigint;nativeBalance:bigint;allowance:bigint;scaled:bigint;index:bigint;scaledDebt:bigint;debtIndex:bigint;userConfig:bigint;reserveConfig:bigint;chain:string;price:bigint;liquidity:bigint;mismatch:boolean;revert:boolean };
  rpc:SupplyRpc; transactions:Record<string,unknown>[]; receipts:Map<string,Record<string,unknown>>; history:Map<number,unknown> };
const amounts = { supply:'100000000',borrow:'20000000',repay:'10000000',withdraw:'50000000' };
const actions:Action[]=['supply','borrow','repay','withdraw'];
function workflow(action:Action,amount=amounts[action]):SemanticWorkflow {
  const fields={chain:p.chain,asset:{chainId:p.chain,address:p.asset,decimals:p.decimals},amount,beneficiary:OWNER};
  const node=action==='supply'?createSupplyNode(action,fields):action==='borrow'?createBorrowNode(action,{...fields,interestRateMode:2}):
    action==='repay'?createRepayNode(action,{...fields,interestRateMode:2}):createWithdrawNode(action,{...fields,recipient:'CONNECTED_OWNER'});
  return {schemaVersion:'1.0.0',workflowId:'arbitrum-lending',revision:0,nodes:[node],resourceEdges:[]};
}
async function fixture(test:(f:{model:Model;service:ReturnType<typeof createSupplyService>;restart:()=>ReturnType<typeof createSupplyService>})=>Promise<void>,executionEnabled=true,decorate?:(rpc:SupplyRpc)=>SupplyRpc) {
  const dir=await mkdtemp(join(tmpdir(),'build-arb-005-lending-')),model=createSupplyHarness(p) as Model;
  Object.assign(model.state,{owner:OWNER,allowanceSlot:mockAllowanceSlot(OWNER,p),balance:1000000000n,scaled:800000000n,scaledDebt:40000000n,userConfig:3n<<24n,
    reserveConfig:7500n|(7800n<<16n)|(6n<<48n)|(1n<<56n)|(1n<<58n)|(225000000n<<80n)|(250000000n<<116n)});
  model.history.set(model.state.block,{...model.state});
  const restart=()=>createSupplyService({rpc:async()=>{throw Error('SUPPLY_NETWORK_UNAVAILABLE');},rpcs:{[p.chain]:decorate?decorate(model.rpc):model.rpc},journalDir:dir,idPrefix:'araave',provenance:'MOCKED',executionEnabled});
  try {await test({model,service:restart(),restart});} finally {await rm(dir,{recursive:true,force:true});}
}
async function reviewed(service:ReturnType<typeof createSupplyService>,action:Action):Promise<SupplyRecord>{
  const run=await service.simulate(workflow(action),OWNER);return service.review(run.id,run.review.commitment,workflow(action));
}
async function approveIfNeeded(service:ReturnType<typeof createSupplyService>,model:Model,run:SupplyRecord):Promise<SupplyRecord>{
  if(!run.review.approvalRequired)return run;
  const begin=await service.begin(run.id,OWNER,run.review.workflow);expect(begin.step).toBe('APPROVAL');
  expect(begin.transaction.data).toBe(supplyCall('approve(address,uint256)',p.pool,BigInt(run.review.amount)));
  await service.handoff(run.id,begin.step);const hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;
  await service.report(run.id,begin.step,{kind:'HASH',hash});return service.observe(run.id);
}

describe('Arbitrum Aave deployment, reserve, owner and network gates',()=>{
  it('binds the verified deployment to 42161, with native USDC only',()=>{
    expect(aaveLendingProfile(p.chain)).toBe(p);expect(p).toMatchObject({pool:'0x794a61358d6845594f94dc1db02a252b5b4814ad',reserveId:12,decimals:6,l1DataFee:false,poolRevision:11});
    expect(()=>assertAaveLendingProfile({...p,chain:AAVE_V3_BASE.chain})).toThrow('AAVE_PROFILE_UNSUPPORTED');
    expect(CATALOG_NETWORKS['arbitrum-one'].prefixes.lending).toBe('araave');expect(catalogNetworkOfRun('araave-'+'a'.repeat(32),'lending')?.chain).toBe(p.chain);
    expect(flowMode('arbitrum-aave',{})).toBe('off');expect(CATALOG_NETWORKS['arbitrum-one'].ownerExecutionEnabled('live',{})).toBe(false);
    expect(FLOWS['arbitrum-aave'].runId.test('araave-'+'a'.repeat(32))).toBe(true);expect(FLOWS['arbitrum-aave'].runId.test('baave-'+'a'.repeat(32))).toBe(false);
  });
  it.each(['chain','pool','implementation','provider','oracle','revision','aToken','debtToken','decimals','reserveId'])('fails closed on wrong %s',async kind=>fixture(async({service,model})=>{
    if(kind==='chain')model.state.chain='0x2105';
    await expect(service.simulate(workflow('borrow'),OWNER)).rejects.toThrow();expect(model.transactions).toHaveLength(0);
  },true,rpc=>async(method,params)=>{
    if(kind==='implementation'&&method==='eth_getStorageAt')return supplyHex(1);
    if(method==='eth_call'){
      const tx=params[0] as {to:string;data:string};
      const calls:Record<string,[string,string]>={pool:[p.provider,supplyCall('getPool()')],provider:[p.pool,supplyCall('ADDRESSES_PROVIDER()')],oracle:[p.provider,supplyCall('getPriceOracle()')],revision:[p.pool,supplyCall('POOL_REVISION()')],aToken:[p.aToken,supplyCall('POOL()')],debtToken:[p.variableDebtToken,supplyCall('POOL()')],decimals:[p.asset,supplyCall('decimals()')]};
      if(calls[kind]?.[0]===tx.to&&calls[kind]?.[1]===tx.data)return supplyHex(1);
      if(kind==='reserveId'&&tx.to===p.pool&&tx.data===supplyCall('getReserveData(address)',p.asset)){const raw=await rpc(method,params) as string;return raw.slice(0,2+7*64)+'0'.repeat(64)+raw.slice(2+8*64);}
    }return rpc(method,params);
  }));
  it.each(actions)('%s refuses unscoped USDC.e and foreign decimals',async action=>fixture(async({service})=>{
    for(const [address,decimals] of [['0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',6],[p.asset,18]] as const){const w=workflow(action);for(const input of w.nodes[0]!.inputs)if(input.kind==='QUANTITY')Object.assign(input.value.asset,{address,decimals});await expect(service.simulate(w,OWNER)).rejects.toThrow();}
  }));
  it.each(actions)('%s cannot begin without owner execution opt-in',async action=>fixture(async({service})=>{
    const run=await reviewed(service,action);await expect(service.begin(run.id,OWNER,run.review.workflow)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');expect((await service.load(run.id)).attempts).toEqual([]);
  },false));
  it('separates namespace/provenance and denies read-client mutation methods',async()=>fixture(async({service})=>{
    const run=await service.simulate(workflow('supply'),OWNER);
    expect(()=>validateSupplyRun({...run,id:run.id.replace('araave-','baave-')})).toThrow('CORRUPT');
    expect(()=>validateSupplyRun({...run,provenance:'PUBLIC_TESTNET'})).toThrow('CORRUPT');
    const rpc=createSupplyReadRpc(false,p);for(const method of ['eth_sendTransaction','eth_sendRawTransaction','eth_sign','personal_sign'])await expect(rpc(method,[])).rejects.toThrow('METHOD_DENIED');
  }));
});

describe('Arbitrum lending deterministic risk and Review',()=>{
  it.each(['no collateral','collateral disabled','borrow disabled','unsafe','liquidity','cap','mixed reserves','eMode'])('Borrow refuses %s before Review',async kind=>fixture(async({service,model})=>{
    if(kind==='no collateral')model.state.scaled=0n;if(kind==='collateral disabled')model.state.userConfig=1n<<24n;
    if(kind==='borrow disabled')model.state.reserveConfig&=~(1n<<58n);if(kind==='liquidity')model.state.liquidity=1n;
    if(kind==='cap')model.state.reserveConfig=(model.state.reserveConfig&~(((1n<<36n)-1n)<<80n))|(1n<<80n);
    if(kind==='mixed reserves')model.state.userConfig|=2n;
    await expect(service.simulate(workflow('borrow',kind==='unsafe'?'400000000':amounts.borrow),OWNER)).rejects.toThrow();expect(model.transactions).toHaveLength(0);
  },true,rpc=>async(method,params)=>kind==='eMode'&&method==='eth_call'&&(params[0] as {data:string}).data===supplyCall('getUserEMode(address)',OWNER)?supplyHex(1):rpc(method,params)));
  it.each(['0','50000000','50000001',((1n<<256n)-1n).toString()])('Repay refuses zero/full/overpayment %s',async amount=>fixture(async({service})=>{
    await expect(async()=>service.simulate(workflow('repay',amount),OWNER)).rejects.toThrow();
  }));
  it.each(['1000000000','900000000'])('Withdraw refuses insufficient/unsafe collateral %s',async amount=>fixture(async({service})=>{
    await expect(service.simulate(workflow('withdraw',amount),OWNER)).rejects.toThrow();
  }));
  it.each(actions)('%s rejects stale owner, asset, amount, Pool, spender, balance, debt, allowance and configuration',async action=>fixture(async({service,model})=>{
    const run=await service.simulate(workflow(action),OWNER),r=run.review;
    for(const state of [{...r.state,balance:(BigInt(r.state.balance)+1n).toString()},...action==='borrow'?[]:[{...r.state,allowance:'1'}],
      {...r.state,scaledPosition:'1'},{...r.state,reserveConfiguration:'1'},{...r.state,borrow:{...r.state.borrow!,scaledDebt:'1'}}])expect(()=>assertSupplyReview(r,r.workflow,OWNER,state)).toThrow();
    expect(()=>assertSupplyReview(r,workflow(action,(BigInt(r.amount)+1n).toString()),OWNER,r.state)).toThrow();
    expect(()=>assertSupplyReview({...r,pool:AAVE_V3_BASE.pool},r.workflow,OWNER,r.state)).toThrow();
    if(r.approvalRequired){const changed=structuredClone(r);changed.transactions[0]!.data=supplyCall('approve(address,uint256)',AAVE_V3_BASE.pool,BigInt(r.amount));expect(()=>assertSupplyReview(changed,r.workflow,OWNER,r.state)).toThrow();}
    expect(()=>assertSupplyReview(r,r.workflow,'0x'+'2'.repeat(40),r.state)).toThrow();
    expect(()=>assertSupplyReview(r,r.workflow,OWNER,r.state,Date.parse(r.expiresAt))).toThrow();
    model.state.reserveConfig|=1n<<60n;await expect(service.review(run.id,r.commitment,r.workflow)).rejects.toThrow();
  }));
  it('blocks material state change after preparation and before wallet handoff',async()=>fixture(async({service,model})=>{
    const run=await reviewed(service,'supply'),begin=await service.begin(run.id,OWNER,run.review.workflow);
    model.state.balance-=1n;await expect(service.handoff(run.id,begin.step)).rejects.toThrow('STALE');expect(model.transactions).toHaveLength(0);
  }));
});

describe('Arbitrum shared owner lifecycle, fees and durable recovery',()=>{
  it.each(actions)('%s preserves deployed floor/ceil ray rounding for an odd principal amount',async action=>fixture(async({service,model})=>{
    const w=workflow(action,'13');let run=await service.simulate(w,OWNER);run=await service.review(run.id,run.review.commitment,w);run=await approveIfNeeded(service,model,run);
    const begin=await service.begin(run.id,OWNER,w);await service.handoff(run.id,begin.step);const hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;
    await service.report(run.id,begin.step,{kind:'HASH',hash});run=await service.observe(run.id);expect(run.verdict).toBe('RECONCILED');expect(run.evidence?.bundle.environment).toBe('MOCKED');
  }));
  it.each(actions)('%s proves financial effects, recovers ambiguous submission after restart, and reconciles once',async action=>fixture(async({service,model,restart})=>{
    let run=await reviewed(service,action);expect(model.transactions).toHaveLength(0);run=await approveIfNeeded(service,model,run);
    const begin=await service.begin(run.id,OWNER,run.review.workflow);assertSupplyWalletTransaction(begin.transaction,run.review,begin.step);
    expect(begin.transaction.chainId).toBe(p.chainHex);expect(begin.transaction.to).toBe(p.pool);
    if(action==='borrow'||action==='withdraw')expect(run.review.approvalRequired).toBe(false);
    await service.handoff(run.id,begin.step);const txCount=model.transactions.length;
    await model.rpc('MOCK_submit',[begin.transaction]);await service.report(run.id,begin.step,{kind:'UNKNOWN'});
    await expect(service.begin(run.id,OWNER,run.review.workflow)).rejects.toThrow();
    const resumed=restart();run=await resumed.observe(run.id);expect(run.verdict).toBe('RECONCILED');
    expect(run.evidence?.bundle).toMatchObject({environment:'MOCKED',outcome:'RECONCILED'});
    const observation=run.observations.at(-1)!;expect(observation.prePosition).not.toBeNull();expect(observation.postPosition).not.toBeNull();
    expect(observation.cost).toBe('140000000000');expect(observation.receipt).not.toHaveProperty('l1Fee');
    const pre=observation.prePosition!,post=observation.postPosition!;
    if(action==='supply')expect(BigInt(post.scaledPosition)).toBeGreaterThan(BigInt(pre.scaledPosition));
    if(action==='borrow')expect(BigInt(post.borrow!.scaledDebt)).toBeGreaterThan(BigInt(pre.borrow!.scaledDebt));
    if(action==='repay')expect(BigInt(post.borrow!.scaledDebt)).toBeLessThan(BigInt(pre.borrow!.scaledDebt));
    if(action==='withdraw')expect(BigInt(post.scaledPosition)).toBeLessThan(BigInt(pre.scaledPosition));
    expect(await resumed.observe(run.id)).toEqual(run);expect(model.transactions).toHaveLength(txCount+1);
  }));
  it.each(actions)('%s financially inconsistent successful receipt becomes sticky DIVERGENT',async action=>fixture(async({service,model})=>{
    let run=await reviewed(service,action);run=await approveIfNeeded(service,model,run);const begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    model.state.mismatch=true;const hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;await service.report(run.id,begin.step,{kind:'HASH',hash});
    run=await service.observe(run.id);expect(run.verdict).toBe('DIVERGENT');expect(run.evidence).toBeNull();expect(await service.observe(run.id)).toEqual(run);
  }));
  it('continues a bounded persisted Nitro scan beyond 128 blocks without authorizing resend',async()=>fixture(async({service,model,restart})=>{
    const run=await reviewed(service,'borrow'),begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    await service.report(run.id,begin.step,{kind:'UNKNOWN'});model.state.block+=300;model.history.set(model.state.block,{...model.state});
    await model.rpc('MOCK_submit',[begin.transaction]);
    let observed=await service.observe(run.id);expect(observed.verdict).toBe('PENDING');expect(observed.attempts[0]!.discoveryNextBlock).toBe(138);
    expect(observed.absence).toBeUndefined();await expect(service.recoverReview(run.id)).rejects.toThrow('OBSERVE_ONLY');
    const resumed=restart();observed=await resumed.observe(run.id);expect(observed.verdict).toBe('PENDING');observed=await resumed.observe(run.id);
    expect(observed.verdict).toBe('RECONCILED');expect(model.transactions).toHaveLength(1);
  }));
  it('retains delayed receipts and temporary read failures for retry',async()=>{
    let unavailable=true;await fixture(async({service,model})=>{
      const run=await reviewed(service,'borrow'),begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
      const hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;await service.report(run.id,begin.step,{kind:'HASH',hash});
      expect((await service.observe(run.id)).verdict).toBe('PENDING');unavailable=false;expect((await service.observe(run.id)).verdict).toBe('RECONCILED');
    },true,rpc=>async(method,params)=>unavailable&&method==='eth_getTransactionReceipt'?null:rpc(method,params));
  });
  it.each(['supply','repay'] as const)('%s recovers a lost approval response without approving again',async action=>fixture(async({service,model,restart})=>{
    let run=await reviewed(service,action);const begin=await service.begin(run.id,OWNER,run.review.workflow);expect(begin.step).toBe('APPROVAL');await service.handoff(run.id,begin.step);
    await model.rpc('MOCK_submit',[begin.transaction]);await service.report(run.id,begin.step,{kind:'UNKNOWN'});
    const resumed=restart();run=await resumed.observe(run.id);expect(run.attempts[0]!.reconciled).toBe(true);expect(run.verdict).toBe('PENDING');
    expect(await resumed.observe(run.id)).toEqual(run);expect(model.transactions).toHaveLength(1);
    const next=await resumed.begin(run.id,OWNER,run.review.workflow);expect(next.step).toBe(action.toUpperCase());
    model.state.allowance+=1n;await expect(resumed.handoff(run.id,next.step)).rejects.toThrow('STALE');
  }));
  it.each(actions.flatMap(action=>['owner','reserve'].map(kind=>({action,kind}))))('$action refuses receipt proof with wrong $kind',async ({action,kind})=>fixture(async({service,model})=>{
    let run=await reviewed(service,action);run=await approveIfNeeded(service,model,run);const begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    const hash=await model.rpc('MOCK_submit',[begin.transaction]) as string,receipt=model.receipts.get(hash)!;
    if(kind==='owner')receipt.from='0x'+'2'.repeat(40);
    else ((receipt.logs as {address:string;topics:string[]}[]).find(log=>log.address===p.pool)!).topics[1]='0x'+'0'.repeat(24)+AAVE_V3_BASE.asset.slice(2);
    await service.report(run.id,begin.step,{kind:'HASH',hash});
    const divergent=await service.observe(run.id);expect(divergent.verdict).toBe('DIVERGENT');expect(divergent.evidence).toBeNull();
  }));
  it('supplies into an empty owner account, then borrows against that same native USDC collateral',async()=>fixture(async({service,model})=>{
    model.state.scaled=0n;model.state.scaledDebt=0n;model.state.userConfig=0n;model.history.set(model.state.block,{...model.state});
    let run=await reviewed(service,'supply');expect(run.review.state.borrow!.collateralBase).toBe('0');run=await approveIfNeeded(service,model,run);
    let begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    let hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;await service.report(run.id,begin.step,{kind:'HASH',hash});expect((await service.observe(run.id)).verdict).toBe('RECONCILED');
    run=await reviewed(service,'borrow');expect(BigInt(run.review.borrow!.expectedPostHealthFactor)).toBeGreaterThanOrEqual(2n*10n**18n);
    begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;await service.report(run.id,begin.step,{kind:'HASH',hash});expect((await service.observe(run.id)).verdict).toBe('RECONCILED');
  }));
  it('restart after submission before any wallet report observes the original transaction',async()=>fixture(async({service,model,restart})=>{
    const run=await reviewed(service,'borrow'),begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    await model.rpc('MOCK_submit',[begin.transaction]);expect((await restart().observe(run.id)).verdict).toBe('RECONCILED');expect(model.transactions).toHaveLength(1);
  }));
  it('does not advance ambiguous discovery beyond the safe chain head',async()=>fixture(async({service,model})=>{
    const run=await reviewed(service,'borrow'),begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);await service.report(run.id,begin.step,{kind:'UNKNOWN'});
    model.state.block+=300;const observed=await service.observe(run.id);expect(observed.attempts[0]!.discoveryNextBlock).toBe(21);expect(observed.absence).toBeUndefined();
  },true,rpc=>async(method,params)=>method==='eth_getBlockByNumber'&&params[0]==='safe'?rpc(method,['0x14',false]):rpc(method,params)));
  it('uses shared Nitro margins, binds total gas, and refuses over-bound estimates at begin and handoff',async()=>{
    let gas=150000n;await fixture(async({service})=>{
      const run=await reviewed(service,'borrow');expect(run.review.gasLimits).toEqual([nitroGasLimit(gas).toString()]);expect(run.review.gasPrice).toBe(nitroMaxFeePerGas(1000000n).toString());
      expect(run.review.manifest.gasBudgets[0]!.maximumAmount).toBe((nitroGasLimit(gas)*nitroMaxFeePerGas(1000000n)).toString());
      gas=300000n;await expect(service.begin(run.id,OWNER,run.review.workflow)).rejects.toThrow('FEE_BOUND');gas=150000n;
      const begin=await service.begin(run.id,OWNER,run.review.workflow);gas=300000n;await expect(service.handoff(run.id,begin.step)).rejects.toThrow('FEE_BOUND');
      expect(()=>assertSupplyWalletTransaction({...begin.transaction,to:AAVE_V3_BASE.pool},run.review,begin.step)).toThrow('MISMATCH');
    },true,rpc=>async(method,params)=>method==='eth_estimateGas'?supplyHex(gas):rpc(method,params));
  });
  it.each(actions)('%s rejects an OP Stack l1Fee on a Nitro receipt',async action=>fixture(async({service,model})=>{
    let run=await reviewed(service,action);run=await approveIfNeeded(service,model,run);const begin=await service.begin(run.id,OWNER,run.review.workflow);await service.handoff(run.id,begin.step);
    const hash=await model.rpc('MOCK_submit',[begin.transaction]) as string;model.receipts.get(hash)!.l1Fee='0x1';await service.report(run.id,begin.step,{kind:'HASH',hash});
    expect((await service.observe(run.id)).verdict).toBe('DIVERGENT');
  }));
});
