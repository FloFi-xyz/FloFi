// SPDX-License-Identifier: AGPL-3.0-only
/** Ethereum public READ-ONLY verification. No keys, signing, submission, gate activation or deployment.
 * Source bytes stay in memory; output contains independent chain observations and source hashes only.
 * Results are PUBLIC_READ_ONLY, never MAINNET_EXECUTED or execution authority. Build workspace packages first. */
import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { supplySelector as selector } from '../packages/reference-compiler/dist/index.js';
import { UNISWAP_V3_ETHEREUM as UNI, AAVE_V3_ETHEREUM as AAVE, parseEthereumTokenList } from '../packages/action-registry/dist/index.js';
const [outputPath, endpoint = 'https://ethereum-rpc.publicnode.com'] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/verify-ethereum-mainnet.mjs output.json [https-rpc-url]');
const endpointUrl = new URL(endpoint);
if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password || endpointUrl.hash) throw Error('RPC_CONFIGURATION_INVALID');
async function source(url) {
  const response = await globalThis.fetch(url, { redirect: 'error', signal: globalThis.AbortSignal.timeout(30000) });
  const bytes = await response.text();
  if (!response.ok || Buffer.byteLength(bytes) > 4000000) throw Error('SOURCE_UNAVAILABLE');
  return bytes;
}
const sources = await Promise.all(['https://tokens.uniswap.org', 'https://developers.uniswap.org/deployments.json',
  'https://raw.githubusercontent.com/aave-dao/aave-address-book/main/src/AaveV3Ethereum.sol'].map(source));

const methods=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call']);let id=0;
async function rpc(method,params) {if(!methods.has(method))throw Error('READ_ONLY'); const r=await globalThis.fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:globalThis.AbortSignal.timeout(30000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;}
const result={evidence:'PUBLIC_READ_ONLY',chain:await rpc('eth_chainId',[]),verifiedAt:new Date().toISOString(),sources:{},code:{},relationships:{},tokens:[],pools:{}};
if(result.chain!=='0x1')throw Error('WRONG_CHAIN');result.block=await rpc('eth_getBlockByNumber',['safe',false]);const at=result.block.number;
const hash=s=>createHash('sha256').update(s).digest('hex'); const word=n=>BigInt(n).toString(16).padStart(64,'0');const addr=a=>a.slice(2).padStart(64,'0'); const words=d=>d.slice(2).match(/.{64}/g).map(x=>BigInt('0x'+x));const addressAt=(d,i=0)=>'0x'+d.slice(2+i*64+24,2+(i+1)*64).toLowerCase();
const call=(to,fn,...args)=>rpc('eth_call',[{to,data:selector(fn)+args.join('')},at]);
const deployments=JSON.parse(sources[1]);
const catalog = parseEthereumTokenList(sources[0], result.verifiedAt);
result.catalog = { eligibleAssets: catalog.assets.length, excludes: ['both ambiguous LIT records', 'FLUX decimals mismatch'] };
for (const [i, name] of ['tokenList', 'uniswapDeploymentRegistry', 'aaveAddressBook'].entries()) result.sources[name] = hash(sources[i]);
for (const address of [AAVE.pool, AAVE.provider, AAVE.oracle, AAVE.asset, AAVE.aToken, AAVE.variableDebtToken, AAVE.poolImplementation]) if (!sources[2].toLowerCase().includes(address)) throw Error('AAVE_SOURCE_IDENTITY_MISMATCH');
const roles={};for(const [role,name] of [['factory','UniswapV3Factory'],['router','SwapRouter02'],['quoter','QuoterV2'],['positionManager','NonfungiblePositionManager']]) roles[role]=deployments.records.find(r=>r.chainId===1&&r.protocol==='v3'&&r.contract===name).address.toLowerCase();
Object.assign(roles,{usdc:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',weth:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',pool:'0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',provider:'0x2f39d218133afab8f2b819b1066c7e434ad94e9e',oracle:'0x54586be62e3c3580375ae3723c145253060ca0c2',aToken:'0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',variableDebtToken:'0x72e95b8931767c79ba4eee721354d6e99a61d004'});
for(const [role,address] of Object.entries(roles)){const code=await rpc('eth_getCode',[address,at]);if(code==='0x')throw Error('NO_CODE '+role);result.code[role]={address,bytes:(code.length-2)/2,sha256:hash(Buffer.from(code.slice(2),'hex'))};if (role in UNI.codeSha256 && result.code[role].sha256 !== UNI.codeSha256[role]) throw Error('CODE_PIN_MISMATCH '+role);}
for(const role of ['router','quoter','positionManager'])for(const [fn,expected] of [['factory()',roles.factory],['WETH9()',roles.weth]]){const observed=addressAt(await call(roles[role],fn));if(observed!==expected)throw Error('IDENTITY '+role+' '+fn);result.relationships[role+':'+fn]=observed;}
for(const [role,fn,expected] of [['provider','getPool()',roles.pool],['provider','getPriceOracle()',roles.oracle],['pool','ADDRESSES_PROVIDER()',roles.provider],['aToken','UNDERLYING_ASSET_ADDRESS()',roles.usdc],['variableDebtToken','UNDERLYING_ASSET_ADDRESS()',roles.usdc],['aToken','POOL()',roles.pool]]){const observed=addressAt(await call(roles[role],fn));if(observed!==expected)throw Error('AAVE_IDENTITY');result.relationships[role+':'+fn]=observed;}
const reserve=await call(roles.pool,'getReserveData(address)',addr(roles.usdc));result.reserve={raw:reserve,words:words(reserve).map(String),aToken:addressAt(reserve,8),variableDebtToken:addressAt(reserve,10),poolRevision:words(await call(roles.pool,'POOL_REVISION()'))[0].toString()};
for(const fee of [100,500,3000,10000]){const pool=addressAt(await call(roles.factory,'getPool(address,address,uint24)',addr(roles.usdc),addr(roles.weth),word(fee)));const spacing=words(await call(roles.factory,'feeAmountTickSpacing(uint24)',word(fee)))[0].toString();result.pools[fee]={pool,spacing};if(BigInt(pool)!==0n){result.pools[fee].liquidity=words(await call(pool,'liquidity()'))[0].toString();try{result.pools[fee].quote10Usdc=words(await call(roles.quoter,'quoteExactInputSingle((address,address,uint256,uint24,uint160))',addr(roles.usdc),addr(roles.weth),word(10000000),word(fee),word(0))).map(String);}catch{result.pools[fee].quoteUnavailable=true;}}}

await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');
const tokens=JSON.parse(sources[0]).tokens.filter(t=>t.chainId===1);
for(const t of tokens){try{const code=await rpc('eth_getCode',[t.address,at]);const decimals=words(await call(t.address,'decimals()'))[0].toString();result.tokens.push({address:t.address.toLowerCase(),symbol:t.symbol,declaredDecimals:t.decimals,observedDecimals:decimals,hasCode:code!=='0x'});}catch(e){result.tokens.push({address:t.address.toLowerCase(),symbol:t.symbol,error:String(e)});}if(result.tokens.length%40===0){await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');process.stdout.write('tokens '+result.tokens.length+'\n');}}
result.requests=id;await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ evidence: result.evidence, block: at, requests: id, catalogAssets: catalog.assets.length, mismatches: result.tokens.filter(t=>!t.hasCode||Number(t.observedDecimals)!==t.declaredDecimals) }));
