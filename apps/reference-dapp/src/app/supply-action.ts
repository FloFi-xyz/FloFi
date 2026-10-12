// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSupplyService, type SupplyWalletDiagnostic, type SupplyService } from '../server/supply-service';
import { join } from 'node:path';
import { createCatalogLendingReadRpc, createLendingReadRpcs } from '../server/supply-rpc';
import { cloudFlow } from '../server/flow-runtime';
import { catalogNetworkOfRun, catalogNetworkOfWorkflow, localCatalogNetworkMode, type CatalogNetworkRuntime } from '../server/catalog-networks';
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
 * Catalog mainnet lending reuses the network's gate, owner opt-in, journal and read-only RPC.
 * Hosted deployments use the shared cloud flow; local journals use the network's `aave` subdirectory.
 */
const catalogServices=new Map<string,SupplyService>();
function catalog(network:CatalogNetworkRuntime):SupplyService{
  const mode=localCatalogNetworkMode(network,process.env);
  if(mode==='off'||!network.prefixes.lending)throw new Error(network.disabledCode);
  const journalDir=process.env[network.journalEnv];
  if(!journalDir)throw new Error('SUPPLY_STORAGE_NOT_CONFIGURED');
  let instance=catalogServices.get(network.id);
  if(!instance){instance=createSupplyService({journalDir:join(journalDir,'aave'),idPrefix:network.prefixes.lending,provenance:mode==='harness'?'MOCKED':'PUBLIC_MAINNET',
    rpc:async()=>{throw new Error('SUPPLY_NETWORK_UNAVAILABLE');},rpcs:{[network.chain]:createCatalogLendingReadRpc(network,mode==='harness',process.env)},
    executionEnabled:network.ownerExecutionEnabled(mode,process.env)});catalogServices.set(network.id,instance);}
  return instance;
}
const LENDING_ACTIONS=['supply','borrow','repay','withdraw'];
const catalogCall=(args:readonly unknown[])=>typeof args[0]==='string'?catalogNetworkOfRun(args[0],'lending'):
  LENDING_ACTIONS.map(action=>catalogNetworkOfWorkflow(args[0],action)).find(network=>network?.flows.lending)??null;
async function run<T>(method:string,args:readonly unknown[],action:(service:SupplyService)=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;code:string}>{
  const network=catalogCall(args);
  // Cloud deployment: the remote Flofi API or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001); never a local journal.
  const cloud=await cloudFlow<T>(network?.flows.lending??'aave-supply',method,args);if(cloud)return cloud;
  try{return{ok:true,value:await action(network?catalog(network):current())};}catch(cause){const code=cause instanceof Error?cause.message:'';return{ok:false,code:/^[A-Z][A-Z0-9_]{2,80}$/.test(code)?code:'SUPPLY_SERVICE_UNAVAILABLE'};}
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
