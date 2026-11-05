// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD AAVE-V3-EXPANSION-001: regenerates `packages/action-registry/src/aave-v3-reserves.generated.ts` from the official Aave DAO
 * address book (MIT, https://github.com/aave-dao/aave-address-book) at ONE pinned commit.
 *
 * The address book is itself generated from each market's on-chain `Pool.getReservesList()` / `getReserveData()`; FloFi only copies its
 * market-level contracts and the identity of every listed reserve (id, decimals, underlying, aToken, variable-debt token, oracle source).
 * The files are parsed as TEXT with strict patterns, never imported or executed. Every runtime read still re-verifies each reserve on chain
 * (`discoverAaveReserves`, `readSupplyState`) and fails closed on any difference, so this snapshot is a pinned allowlist, not an authority.
 *
 *   node scripts/generate-aave-v3-reserves.mjs            write the module
 *   node scripts/generate-aave-v3-reserves.mjs --check    exit 1 when the committed module differs from a fresh generation
 *   node scripts/generate-aave-v3-reserves.mjs --from <dir> read <dir>/<Library>.ts instead of downloading (offline review)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'b71495aeb9948348aac898787cc1de3ab4b408ae';
const MARKETS = [
  { library: 'AaveV3Ethereum', chain: 'eip155:1', chainId: 1 },
  { library: 'AaveV3Base', chain: 'eip155:8453', chainId: 8453 },
  { library: 'AaveV3Arbitrum', chain: 'eip155:42161', chainId: 42161 },
];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages/action-registry/src/aave-v3-reserves.generated.ts');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const args = process.argv.slice(2), check = args.includes('--check'), fromIndex = args.indexOf('--from');
const from = fromIndex >= 0 ? args[fromIndex + 1] : null;

async function source(library) {
  if (from) return readFile(join(from, `${library}.ts`), 'utf8');
  const url = `https://raw.githubusercontent.com/aave-dao/aave-address-book/${COMMIT}/src/ts/${library}.ts`;
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`ADDRESS_BOOK_UNAVAILABLE ${library} ${response.status}`);
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error(`ADDRESS_BOOK_TOO_LARGE ${library}`);
  return text;
}
const address = (value, what) => { if (!ADDRESS.test(value)) throw new Error(`ADDRESS_INVALID ${what}`); return value.toLowerCase(); };
function constant(text, name, library) {
  const match = new RegExp(`^export const ${name} = '(0x[0-9a-fA-F]{40})';$`, 'm').exec(text);
  if (!match) throw new Error(`ADDRESS_BOOK_FIELD_MISSING ${library}.${name}`);
  return address(match[1], `${library}.${name}`);
}
function parse(text, market) {
  const chain = /^export const CHAIN_ID = (\d+);$/m.exec(text);
  if (!chain || Number(chain[1]) !== market.chainId) throw new Error(`ADDRESS_BOOK_CHAIN_MISMATCH ${market.library}`);
  const start = text.indexOf('export const ASSETS = {');
  if (start < 0) throw new Error(`ADDRESS_BOOK_ASSETS_MISSING ${market.library}`);
  const body = text.slice(start);
  const end = body.indexOf('\n} as const;');
  const assets = body.slice(0, end < 0 ? body.length : end);
  const entry = /^ {2}([A-Za-z0-9_]+): \{\n((?: {4}[A-Za-z_]+: [^\n]+\n)+) {2}\},?$/gm;
  const reserves = [];
  let match;
  while ((match = entry.exec(assets))) {
    const fields = Object.fromEntries(match[2].trim().split('\n').map(line => {
      const field = /^([A-Za-z_]+): (?:'(0x[0-9a-fA-F]{40})'|(\d+)),?$/.exec(line.trim());
      if (!field) throw new Error(`ADDRESS_BOOK_FIELD_INVALID ${market.library}.${match[1]}: ${line.trim()}`);
      return [field[1], field[2] ?? Number(field[3])];
    }));
    for (const key of ['decimals', 'id', 'UNDERLYING', 'A_TOKEN', 'V_TOKEN', 'ORACLE'])
      if (fields[key] === undefined) throw new Error(`ADDRESS_BOOK_FIELD_MISSING ${market.library}.${match[1]}.${key}`);
    if (!Number.isSafeInteger(fields.decimals) || fields.decimals < 0 || fields.decimals > 36 || !Number.isSafeInteger(fields.id) || fields.id < 0 || fields.id > 127)
      throw new Error(`ADDRESS_BOOK_RESERVE_INVALID ${market.library}.${match[1]}`);
    reserves.push({ key: match[1], id: fields.id, decimals: fields.decimals, underlying: address(fields.UNDERLYING, match[1]), aToken: address(fields.A_TOKEN, match[1]),
      variableDebtToken: address(fields.V_TOKEN, match[1]), oracle: address(fields.ORACLE, match[1]) });
  }
  if (!reserves.length) throw new Error(`ADDRESS_BOOK_ASSETS_EMPTY ${market.library}`);
  for (const field of ['id', 'underlying', 'aToken', 'variableDebtToken'])
    if (new Set(reserves.map(r => r[field])).size !== reserves.length) throw new Error(`ADDRESS_BOOK_DUPLICATE ${market.library}.${field}`);
  return {
    library: market.library, chain: market.chain, chainId: market.chainId,
    pool: constant(text, 'POOL', market.library), provider: constant(text, 'POOL_ADDRESSES_PROVIDER', market.library),
    oracle: constant(text, 'ORACLE', market.library), dataProvider: constant(text, 'AAVE_PROTOCOL_DATA_PROVIDER', market.library),
    poolImplementation: constant(text, 'POOL_IMPL', market.library), wethGateway: constant(text, 'WETH_GATEWAY', market.library),
    reserves: reserves.sort((a, b) => a.id - b.id),
  };
}
function render(markets) {
  const line = r => `    { key: '${r.key}', id: ${r.id}, decimals: ${r.decimals}, underlying: '${r.underlying}', aToken: '${r.aToken}', variableDebtToken: '${r.variableDebtToken}', oracle: '${r.oracle}' },`;
  return `// SPDX-License-Identifier: Apache-2.0
// GENERATED by scripts/generate-aave-v3-reserves.mjs — do not edit by hand.
// Source: Aave DAO address book (MIT), https://github.com/aave-dao/aave-address-book/tree/${COMMIT}/src/ts
// Market contracts and the identity of each listed reserve only. Runtime reads re-verify every field on chain and fail closed.
export const AAVE_V3_ADDRESS_BOOK_COMMIT = '${COMMIT}';
export type AaveAddressBookReserve = { readonly key: string; readonly id: number; readonly decimals: number; readonly underlying: string;
  readonly aToken: string; readonly variableDebtToken: string; readonly oracle: string };
export type AaveAddressBookMarket = { readonly library: string; readonly chain: string; readonly chainId: number; readonly pool: string; readonly provider: string;
  readonly oracle: string; readonly dataProvider: string; readonly poolImplementation: string; readonly wethGateway: string; readonly reserves: readonly AaveAddressBookReserve[] };
export const AAVE_V3_ADDRESS_BOOK: readonly AaveAddressBookMarket[] = Object.freeze([
${markets.map(m => `  Object.freeze({ library: '${m.library}', chain: '${m.chain}', chainId: ${m.chainId}, pool: '${m.pool}', provider: '${m.provider}',
    oracle: '${m.oracle}', dataProvider: '${m.dataProvider}', poolImplementation: '${m.poolImplementation}', wethGateway: '${m.wethGateway}',
    reserves: Object.freeze([
${m.reserves.map(line).map(text => '  ' + text).join('\n')}
    ].map(reserve => Object.freeze(reserve))) }),`).join('\n')}
]);
`;
}

const markets = [];
for (const market of MARKETS) markets.push(parse(await source(market.library), market));
const output = render(markets);
if (check) {
  const current = await readFile(OUT, 'utf8').catch(() => '');
  if (current !== output) { console.error('aave-v3-reserves.generated.ts is out of date; run node scripts/generate-aave-v3-reserves.mjs'); process.exit(1); }
  console.log('aave-v3-reserves.generated.ts is current');
} else {
  await writeFile(OUT, output);
  console.log(markets.map(m => `${m.library}: ${m.reserves.length} reserves`).join('\n'));
}
