// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSupplyService, type SupplyWalletDiagnostic, type SupplyService } from '../server/supply-service';
import { join } from 'node:path';
import { createBaseLendingReadRpc, createLendingReadRpcs } from '../server/supply-rpc';
import { cloudFlow, cloudFlowMode } from '../server/flow-runtime';
import { CATALOG_NETWORKS, localCatalogNetworkMode } from '../server/catalog-networks';
let service:SupplyService|null=null;
function current():SupplyService {
  const harness=process.env.GRYLOO_SUPPLY_HARNESS==='MOCKED_LOOPBACK_ONLY';
  const journalDir=process.env.GRYLOO_SUPPLY_JOURNAL;
  if(!journalDir)throw new Error('SUPPLY_STORAGE_NOT_CONFIGURED');
  // Pace public reads and retry only bounded provider throttling. No mutation method is permitted.
  // One chain-bound read client per Aave profile; the reviewed chain selects it.
  service??=(()=>{const rpcs=createLendingReadRpcs(harness,process.env);return createSupplyService({journalDir,provenance:harness?'MOCKED':'PUBLIC_TESTNET',rpc:rpcs['eip155:84532'],rpcs});})();
  return service;
}
/**
 * BUILD-BASE-001: Base mainnet Aave (real funds, `baave-` runs at `$GRYLOO_BASE_JOURNAL/aave`) on the same service: `GRYLOO_BASE_MAINNET=live`
 * in local development (hosted deployments use the cloud flow) or the loopback harness; owner execution additionally needs
 * `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`.
 */
const BASE=CATALOG_NETWORKS.base;
let baseService:SupplyService|null=null;
function base():SupplyService{
  const mode=localCatalogNetworkMode(BASE,process.env);
  if(mode==='off')throw new Error(BASE.disabledCode);
  const journalDir=process.env[BASE.journalEnv];
  if(!journalDir)throw new Error('SUPPLY_STORAGE_NOT_CONFIGURED');
  baseService??=createSupplyService({journalDir:join(journalDir,'aave'),idPrefix:'baave',provenance:mode==='harness'?'MOCKED':'PUBLIC_MAINNET',
    rpc:async()=>{throw new Error('SUPPLY_NETWORK_UNAVAILABLE');},rpcs:{[BASE.chain]:createBaseLendingReadRpc(mode==='harness',process.env)},
    executionEnabled:BASE.ownerExecutionEnabled(mode,process.env)});
  return baseService;
}
const LENDING_ACTIONS=['supply','borrow','repay','withdraw'];
/** A call addresses Base mainnet when it names a `baave-` run or a workflow whose lending step is on Base. */
const baseCall=(args:readonly unknown[])=>typeof args[0]==='string'?args[0].startsWith('baave-'):Boolean(args[0]&&typeof args[0]==='object'&&
  Array.isArray((args[0] as SemanticWorkflow).nodes)&&(args[0] as SemanticWorkflow).nodes.some(node=>LENDING_ACTIONS.includes(node.actionType)&&node.chainId===BASE.chain));
async function run<T>(method:string,args:readonly unknown[],action:(service:SupplyService)=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;code:string}>{
  const onBase=baseCall(args);
  // Cloud deployment: the remote Flofi API or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001); never a local journal.
  const cloud=await cloudFlow<T>(onBase?'base-aave':'aave-supply',method,args);if(cloud)return cloud;
  try{return{ok:true,value:await action(onBase?base():current())};}catch(cause){const code=cause instanceof Error?cause.message:'';return{ok:false,code:/^[A-Z][A-Z0-9_]{2,80}$/.test(code)?code:'SUPPLY_SERVICE_UNAVAILABLE'};}
}
/** BUILD-BASE-001: whether this instance serves Base mainnet Aave lending (live or the MOCKED loopback harness). */
export async function baseLendingMode():Promise<'live'|'harness'|'off'>{
  const cloud=await cloudFlowMode('base-aave');if(cloud)return cloud;
  return localCatalogNetworkMode(BASE,process.env);
}
export async function supplySimulate(workflow:SemanticWorkflow,account:string){return run('simulate',[workflow,account],service=>service.simulate(workflow,account));}
export async function supplyReview(id:string,commitment:string,workflow:SemanticWorkflow){return run('review',[id,commitment,workflow],service=>service.review(id,commitment,workflow));}
export async function supplyBegin(id:string,account:string,workflow:SemanticWorkflow){return run('begin',[id,account,workflow],service=>service.begin(id,account,workflow));}
export async function supplyReport(id:string,step:'APPROVAL'|'SUPPLY'|'BORROW'|'REPAY'|'WITHDRAW',result:{kind:'HASH';hash:string}|{kind:'UNKNOWN'|'REJECTED';code?:string}){return run('report',[id,step,result],service=>service.report(id,step,result));}
export async function supplyObserve(id:string){return run('observe',[id],service=>service.observe(id));}
export async function supplyStatus(id:string){return run('status',[id],service=>service.load(id));}

export async function supplyInvalidate(id:string){return run('invalidate',[id],service=>service.invalidate(id));}
export async function supplyRecoverReview(id:string){return run('recoverReview',[id],service=>service.recoverReview(id));}

export async function supplyWalletFailure(id:string,diagnostic:SupplyWalletDiagnostic){return run('walletFailure',[id,diagnostic],service=>service.walletFailure(id,diagnostic));}
export async function supplyWalletTrace(id:string,diagnostic:SupplyWalletDiagnostic){return run('walletTrace',[id,diagnostic],service=>service.walletTrace(id,diagnostic));}

export async function supplyHandoff(id:string,step:'APPROVAL'|'SUPPLY'|'BORROW'|'REPAY'|'WITHDRAW',walletManagedNonce=false){return run('handoff',[id,step,walletManagedNonce],service=>service.handoff(id,step,walletManagedNonce));}
