// Independent USER-FUNDS verifier for the "Move position" flow (KNTQ/USDC 2% -> KNTQ/HYPE 0.8%), anvil fork port 8571.
//   node test/verify-migrate.test.mjs
// Unlike migrate.test.mjs (which re-implements the panel with lib calls), this test runs the page's OWN code: it
// extracts readMigState / runMigStep / runUsdcSwap / openMigration / sendTx / loadMig / saveMig … from app.js and
// evaluates them with a fake DOM + in-memory localStorage, against a fork where an anvil dev account is funded with
// USDC + KNTQ from impersonated real token holders, mints its OWN KNTQ/USDC position with the page builders and lets
// a second dev account trade through the pool so the position earns fees (step (a) then pays the 10% tool fee).
// The user's HYPE is set to a small realistic amount (reserve + 0.3 HYPE). A "page reload" = a fresh evaluation of
// app.js code that keeps only the localStorage map; every decision is re-read from the chain.
// Scenarios (each from the same fork snapshot):
//   A. happy path with a reload after EVERY step (a) -> reload -> (b) -> reload -> (c) -> reload -> finish
//   B. page dies after the (b) swap is mined but before the page saved its progress -> reload -> resume
//   C. page dies after the (c) mint is mined but before the page saved its progress -> reload -> resume
//   D. user cancels the swap in (b) after the approvals landed -> resume
//   E. page dies after the (a) remove is mined, before saving progress -> reload -> resume
//   F. the (b) swap's saved hash is ALSO lost -> the page finds the swap in the logs (USDC you had is never swapped)
//   G. "Continue a move" with NO saved record at all (another browser): after (a), after (b), after (c)
// Needs anvil (PATH or ~/.foundry/bin). Skips the fork part (exit 0) if the RPC is unreachable.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, encodeAbiParameters, keccak256, decodeAbiParameters, decodeFunctionData, parseAbi } from 'viem';
import * as L from '../lib.mjs';
import { reachable, startAnvil, forkClients, fundFromHolders, makeTrader, mintLikePage } from './fork-helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8571;
let USER = null; // anvil dev account, set in fork()
let TOKEN_ID = null; // its own KNTQ/USDC position, minted in fork()
const POSM = getAddress('0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518');
const PM = getAddress('0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1');
const UR = getAddress('0xA13f7611115752DEB2B13813BDDE16A5073e4b45');
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');
const USDC = getAddress('0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65');
const KNTQ = getAddress('0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0');
const ZERO = '0x0000000000000000000000000000000000000000';

let failed = 0, total = 0;
const check = (name, ok, detail = '') => { total++; if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const log = (...a) => console.log('•', ...a);
const H = (x) => `${L.fmtAmount(x, 18, 6)} HYPE`;
const U = (x) => `${L.fmtAmount(x, 6, 6)} USDC`;
const K = (x) => `${L.fmtAmount(x, 18, 6)} KNTQ`;

// ------------------------------------------------------------------ independent encodings (not from lib)
const KEY_T = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }];
const myPoolId = (k) => keccak256(encodeAbiParameters(KEY_T, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const PK_TUPLE = { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] };
const unlock = (data) => decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data);
const POSM_IN = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable']);
const UR_IN = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const ERC20_IN = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const P2_IN = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

// ------------------------------------------------------------------ app.js extraction
const APP = readFileSync(join(ROOT, 'app.js'), 'utf8');
function extract(decl) {
  const i = APP.indexOf(decl);
  if (i < 0) throw new Error(`app.js: '${decl}' not found`);
  const eol = APP.indexOf('\n', i);
  const line = APP.slice(i, eol);
  if (!/\{\s*$/.test(line)) return line; // one-line const
  let depth = 0;
  for (let j = APP.indexOf('{', i + decl.length - 1); j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) return APP.slice(i, j + 1) + (APP[j + 1] === ';' ? ';' : '');
  }
  throw new Error(`app.js: unbalanced '${decl}'`);
}
const SEND_SRC = extract('async function sendTx(');
const MIG_SRC = [
  'function errMsg(', 'const MIN_USDC_TO_SWAP =', 'const migKey =', 'function loadMig(', 'function saveMig(', 'const big =', 'async function withReadRetry(',
  'const migSlipBps =', 'const fmtHype =', 'const PENDING_DROP_MS =', 'function isNotFound(', 'const readUsdc =', 'async function migLivePosition(',
  'async function openMigration(', 'async function applyMigReceipt(', 'async function reconcilePending(', 'async function recoverStepA(',
  'async function recoverStepB(', 'async function recoverStepC(', 'async function readMigState(', 'async function runMigStep(',
  'async function runUsdcSwap(',
].map(extract).join('\n');
const build = (src, scope, names) => new Function(...Object.keys(scope), `${src}\nreturn { ${names.join(', ')} };`)(...Object.values(scope));

function staticChecks() {
  console.log('-- static (sources + app.js) --');
  // PoolKey / poolId of the target pool, computed here with my own encoder
  const target = { currency0: ZERO, currency1: KNTQ, fee: 8000, tickSpacing: 120, hooks: ZERO };
  check('poolId(native 0x0, KNTQ, 8000, 120, 0x0) == 0xd210…3472 (own keccak(abi.encode(PoolKey)))', myPoolId(target) === '0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472');
  const hk = L.LP_POOLS.HYPE.key;
  check('lib LP_POOLS.HYPE key is exactly that key', hk.currency0 === ZERO && getAddress(hk.currency1) === KNTQ && hk.fee === 8000 && hk.tickSpacing === 120 && hk.hooks === ZERO && myPoolId(hk) === L.LP_POOLS.HYPE.poolId);
  const uk = L.SWAP_POOLS.USDC.key;
  check('USDC/HYPE 0.3% key: currency0 = native 0x0 < currency1 = USDC, so USDC in => zeroForOne=false', uk.currency0 === ZERO && getAddress(uk.currency1) === USDC && BigInt(uk.currency0) < BigInt(uk.currency1) && myPoolId(uk) === L.SWAP_POOLS.USDC.id);
  check('action bytes (v4-periphery 545a5d2 Actions.sol): MINT 0x02 SETTLE_PAIR 0x0d TAKE 0x0e TAKE_PAIR 0x11 SWEEP 0x14 DECREASE 0x01 BURN 0x03 SWAP_IN_SINGLE 0x06 SETTLE_ALL 0x0c TAKE_ALL 0x0f',
    L.ACTIONS.MINT_POSITION === 2 && L.ACTIONS.SETTLE_PAIR === 13 && L.ACTIONS.TAKE === 14 && L.ACTIONS.TAKE_PAIR === 17 && L.ACTIONS.SWEEP === 20 && L.ACTIONS.DECREASE_LIQUIDITY === 1 && L.ACTIONS.BURN_POSITION === 3 && L.ACTIONS.SWAP_EXACT_IN_SINGLE === 6 && L.ACTIONS.SETTLE_ALL === 12 && L.ACTIONS.TAKE_ALL === 15);
  check('universal-router Commands.sol: V4_SWAP 0x10, SWEEP 0x04', L.UR_COMMANDS.V4_SWAP === 0x10 && L.UR_COMMANDS.SWEEP === 0x04);
  // the sendTx / confirmTx code the page really runs
  check('app.js confirmTx simulates exactly {address, abi, functionName, args, account, ...req.tx}', APP.includes('await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: S.account, ...req.tx })'));
  check('app.js sendTx writes the simulated request', /S\.wallet\.writeContract\(\{ \.\.\.request, \.\.\.fees, account: S\.account, chain: L\.elysium \}\)/.test(SEND_SRC));
  check('app.js migration code extracted and parses', (() => { try { build(MIG_SRC, { L, S: {}, pub: null }, ['readMigState', 'runMigStep']); return true; } catch (e) { log(e.message); return false; } })());
  check('app.js sendTx hands the tx hash to req.onHash BEFORE waiting for the receipt', /writeContract\([^\n]*\);\s*\/\/[^\n]*\n\s*try \{ req\.onHash\?\.\(hash\); \} catch \{\}[\s\S]*waitForTransactionReceipt/.test(SEND_SRC));
  check('readMigState: (b) swaps only USDC above what the wallet held before (a), capped by what (a) returned', /const fresh = usdcBefore === null \? usdc : usdc > usdcBefore \? usdc - usdcBefore : 0n;\s*usdcToSwap = usdcRec !== null && usdcRec < fresh \? usdcRec : fresh;/.test(MIG_SRC));
  check('runMigStep step (a) builds the remove with the fees re-read right before signing (sets the 10% tool fee)', /const fresh = await L\.readPosition\(pub, m\.pos\.tokenId, state, 'USDC'\);[\s\S]{0,700}expected: \{ \.\.\.d\.expected, fees: fresh\.fees \}/.test(MIG_SRC));
  check('runMigStep step (c) caps HYPE with migrationHypeForMint(ctx, recorded hypeReceived) and guards the mint', /migrationHypeForMint\(ctx, big\(rec\.hypeReceived\)\)/.test(MIG_SRC) && /guardNativeMint\(pub, fresh, S\.account\)/.test(MIG_SRC));
}

// ------------------------------------------------------------------ fork harness (test/fork-helpers.mjs)
async function main() {
  console.log('== verify-migrate: page code, self-funded dev account, crash/resume ==');
  staticChecks();
  if (!(await reachable(L.RPC_URL))) { console.log('SKIP fork part: RPC unreachable'); return summary(); }
  const { proc, url } = await startAnvil(PORT);
  process.on('SIGINT', () => { try { proc.kill(); } catch {} process.exit(130); });
  try { await fork(url); } finally { try { proc.kill(); } catch {} }
  return summary();
}
function summary() { console.log(`\n== SUMMARY ==\n${failed === 0 ? 'PASS' : 'FAIL'}: ${total - failed}/${total} checks passed`); return failed === 0 ? 0 : 1; }

async function fork(url) {
  const { pub, test, walletOf } = forkClients(url);
  const accts = (await pub.request({ method: 'eth_accounts' })).map((a) => getAddress(a));
  USER = accts[3];
  const trader = makeTrader(pub, test, url, accts[0]);
  await trader.ready();
  const wallet = walletOf(USER);
  const latestTs = async () => Number((await pub.getBlock()).timestamp);
  const bal = (t, a = USER) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [a] });
  const hype = (a = USER) => pub.getBalance({ address: a });
  const ownerOf = (id) => pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
  const gasOf = (r) => r.gasUsed * r.effectiveGasPrice;
  const snapshot = () => test.snapshot();
  const revert = (id) => test.revert({ id });

  // ---- setup: fund the dev account from real holders, mint its own KNTQ/USDC position, a trader makes fees ----
  {
    const setupSend = async (req) => {
      const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER, ...req.tx });
      const r = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ ...request, ...(await L.readGasFees(pub)), account: USER, chain: L.elysium }) });
      if (r.status !== 'success') throw new Error('setup tx reverted');
      return r;
    };
    await fundFromHolders(pub, test, url, USDC, [[USER, 150_000000n]]);
    await fundFromHolders(pub, test, url, KNTQ, [[USER, 2000n * 10n ** 18n]]);
    await test.setBalance({ address: USER, value: 10n ** 19n });
    const own = await mintLikePage(pub, setupSend, USER, { pool: 'USDC', preset: 'full', amount0: 100_000000n });
    TOKEN_ID = own.tokenId;
    const tr = await trader.roundTrip('USDC', 20_000000n);
    const c = await L.readSwapContext(pub, USER);
    await test.setBalance({ address: USER, value: c.reserve + 3n * 10n ** 17n }); // realistic: reserve + 0.3 HYPE
    log(`setup: dev account ${USER} minted KNTQ/USDC #${TOKEN_ID} (100 USDC + ${K(own.plan.amount1)}); trader round trip, fee growth ${tr.feesUp ? 'up' : 'NOT up'}`);
  }

  const H0 = await hype(), U0 = await bal(USDC), K0 = await bal(KNTQ);
  const ctx0 = await L.readSwapContext(pub, USER);
  log(`block ${await pub.getBlockNumber()}: user ${H(H0)} (reserve ${H(ctx0.reserve)}, HYPE $${ctx0.hypeUsd.toFixed(4)}), ${U(U0)}, ${K(K0)}`);
  check(`start: #${TOKEN_ID} owned by the user`, getAddress(await ownerOf(TOKEN_ID)) === USER);
  const contracts = [POSM, UR, PM];
  const held = async () => Object.fromEntries(await Promise.all(contracts.map(async (c) => [c, [await hype(c), await bal(USDC, c), await bal(KNTQ, c)]])));
  const held0 = await held();
  // PoolManager is the vault: its balances move by exactly what users pay in/out. PosM and UR must stay flat.
  const flat = async (when) => {
    const h = await held();
    check(`${when}: PositionManager and UniversalRouter hold no extra HYPE / USDC / KNTQ`, [POSM, UR].every((c) => h[c].every((v, i) => v === held0[c][i])));
  };
  const S0 = await snapshot();

  // ---------------------------------------------------------- a "page" = fresh evaluation of app.js code
  const storage = new Map();
  function page(hooks = {}) {
    const S = { account: USER, wallet, swapOk: true, pmOk: true, busy: false, migPreset: 'full' };
    const els = {};
    const $ = (id) => (els[id] ||= { value: id === 'migSlip' ? '0.5' : '', disabled: false, textContent: '', title: '', innerHTML: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, scrollIntoView() {}, insertAdjacentHTML() {} });
    const localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    const toasts = [];
    const toast = (m, isErr = false) => { toasts.push({ m, isErr }); console.log(`    [page${isErr ? ' ERROR' : ''}] ${m}`); };
    const confirmTx = async (req) => {
      if (hooks.cancel?.(req)) return null;
      const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: S.account, ...req.tx });
      return request;
    };
    const { sendTx: realSend } = build(SEND_SRC, { canWrite: () => true, writeBlockReason: () => '', S, L, ensureChain: async () => {}, confirmTx, logTx: () => () => {}, toast, pub }, ['sendTx']);
    const sent = [];
    const sendTx = async (req) => {
      const hBefore = await hype();
      const r = await realSend(req);
      if (r) {
        const tx = await pub.getTransaction({ hash: r.transactionHash });
        sent.push({ req, receipt: r, tx, hBefore, hAfter: await hype() });
        if (hooks.crashAfter?.(req)) throw new Error('SIMULATED: page closed after the tx was mined, before the page saved progress');
      }
      return r;
    };
    const idsKey = `ids:${USER}`;
    const loadIds = () => JSON.parse(storage.get(idsKey) || '[]');
    const saveIds = (ids) => storage.set(idsKey, JSON.stringify([...new Set(ids.map(String))]));
    const scope = { $, S, L, pub, getAddress, toast, ensureChain: async () => {}, sendTx, latestTs, saveIds, loadIds, showMinted: () => {}, refreshAll: async () => {}, refreshMigration: async () => {}, localStorage, confirm: () => true };
    const fns = build(MIG_SRC, scope, ['readMigState', 'runMigStep', 'runUsdcSwap', 'openMigration', 'loadMig', 'saveMig']);
    // what refreshMigration does on load: the preset comes from the record
    const rec = fns.loadMig();
    if (rec) S.migPreset = rec.preset || 'full';
    return { ...fns, S, toasts, sent, errors: () => toasts.filter((t) => t.isErr) };
  }
  const step = async (p) => { const n = p.errors().length; await p.runMigStep(); return p.errors().slice(n); };
  const decodeSent = (s) => {
    const { req, tx } = s;
    if (getAddress(tx.to) === POSM) {
      const { args } = decodeFunctionData({ abi: POSM_IN, data: tx.input });
      const [acts, params] = unlock(args[0]);
      return { to: 'POSM', acts: [...Buffer.from(acts.slice(2), 'hex')], params };
    }
    if (getAddress(tx.to) === UR) {
      const { args } = decodeFunctionData({ abi: UR_IN, data: tx.input });
      const [acts, params] = unlock(args[1][0]);
      return { to: 'UR', cmds: args[0], acts: [...Buffer.from(acts.slice(2), 'hex')], params, nInputs: args[1].length };
    }
    if (getAddress(tx.to) === PERMIT2) return { to: 'PERMIT2', args: decodeFunctionData({ abi: P2_IN, data: tx.input }).args };
    return { to: getAddress(tx.to), args: decodeFunctionData({ abi: ERC20_IN, data: tx.input }).args };
  };

  // ======================================================================== A. happy path, reload after every step
  console.log('\n-- A. migration with a page reload after every step --');
  storage.clear();
  let pg = page();
  await pg.openMigration(TOKEN_ID);
  const recStart = pg.loadMig();
  check(`A: openMigration stores a record for #${TOKEN_ID} with preset full`, recStart?.tokenId === String(TOKEN_ID) && recStart.preset === 'full');
  let m = await pg.readMigState();
  check('A: chain says next = (a)', !m.aDone && !m.bDone && !m.cDone && m.pos.liquidity > 0n, `L ${m.pos?.liquidity}`);
  const usdcState = await L.readPoolState(pub);
  const pos0 = await L.readPosition(pub, TOKEN_ID, usdcState, 'USDC');
  check('A: the position earned fees in both tokens (step (a) pays the 10% tool fee)', pos0.fees.amount0 > 0n && pos0.fees.amount1 > 0n, `${U(pos0.fees.amount0)} + ${K(pos0.fees.amount1)}`);
  const fee0 = L.toolFeeSplit(pos0.fees);
  const trBefore = [await bal(USDC, L.FEE_RECIPIENT), await bal(KNTQ, L.FEE_RECIPIENT)];

  // (a)
  let errs = await step(pg);
  check('A(a): no page error', errs.length === 0, errs.map((e) => e.m).join(' | '));
  const sa = pg.sent.at(-1); const da = decodeSent(sa);
  const MOD = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }];
  const dec0A = decodeAbiParameters(MOD, da.params[0]); // fees-only DECREASE(0)
  const decA = decodeAbiParameters(MOD, da.params[4]); // principal DECREASE(all)
  const take1A = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], da.params[3]);
  const takeA = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], da.params.at(-1));
  const feeTakes = da.params.slice(1, 3).map((x) => decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], x));
  check('A(a): tx = POSM modifyLiquidities [DECREASE(0), TAKE, TAKE, TAKE_PAIR, DECREASE(all), BURN, TAKE_PAIR], value 0', da.to === 'POSM' && da.acts.join() === '1,14,14,17,1,3,17' && sa.tx.value === 0n);
  check('A(a): fees-only segment first: DECREASE(#id, 0, 0, 0) then TAKE_PAIR(USDC, KNTQ, user)', dec0A[0] === TOKEN_ID && dec0A[1] === 0n && dec0A[2] === 0n && dec0A[3] === 0n && getAddress(take1A[0]) === USDC && getAddress(take1A[1]) === KNTQ && getAddress(take1A[2]) === USER);
  check('A(a): TAKE(USDC, FEE_RECIPIENT, 10% of fees0), TAKE(KNTQ, FEE_RECIPIENT, 10% of fees1), no amount 0', feeTakes.length === 2 && getAddress(feeTakes[0][0]) === USDC && getAddress(feeTakes[1][0]) === KNTQ && feeTakes.every((t) => getAddress(t[1]) === L.FEE_RECIPIENT && t[2] > 0n) && feeTakes[0][2] === fee0.fee0 && feeTakes[1][2] === fee0.fee1, `${U(feeTakes[0]?.[2] ?? 0n)} + ${K(feeTakes[1]?.[2] ?? 0n)}`);
  check('A(a): fee recipient received exactly those amounts (10% of the fees, nothing of the principal)', (await bal(USDC, L.FEE_RECIPIENT)) - trBefore[0] === fee0.fee0 && (await bal(KNTQ, L.FEE_RECIPIENT)) - trBefore[1] === fee0.fee1);
  check(`A(a): removes ALL liquidity of #${TOKEN_ID} with NON-ZERO minimums`, decA[0] === TOKEN_ID && decA[1] === pos0.liquidity && decA[2] > 0n && decA[3] > 0n, `min ${U(decA[2])} + ${K(decA[3])}`);
  check('A(a): TAKE_PAIR(USDC, KNTQ, user)', getAddress(takeA[0]) === USDC && getAddress(takeA[1]) === KNTQ && getAddress(takeA[2]) === USER);
  const gotU = (await bal(USDC)) - U0, gotK = (await bal(KNTQ)) - K0;
  let rec = pg.loadMig();
  check('A(a): page recorded usdcReceived / kntqReceived == wallet deltas, txA', rec.usdcReceived === gotU.toString() && rec.kntqReceived === gotK.toString() && !!rec.txA, `${U(gotU)} + ${K(gotK)}`);
  check('A(a): user got 100% of the principal + 90% of the fees', gotU === L.getAmountsForLiquidity(usdcState, pos0.tickLower, pos0.tickUpper, pos0.liquidity, false).amount0 + fee0.user0 && gotK === L.getAmountsForLiquidity(usdcState, pos0.tickLower, pos0.tickUpper, pos0.liquidity, false).amount1 + fee0.user1);
  check('A(a): NFT burned; HYPE spent = gas only', (await ownerOf(TOKEN_ID)) === null && sa.hBefore - sa.hAfter === gasOf(sa.receipt));

  // reload
  pg = page();
  m = await pg.readMigState();
  check('A reload after (a): chain says next = (b), USDC to swap == only what (a) returned (wallet USDC that was there before stays)', m.aDone && !m.bDone && m.usdcToSwap === gotU, `${U(m.usdcToSwap)} (wallet ${U(m.usdc)})`);

  // (b)
  const hB0 = await hype();
  errs = await step(pg);
  check('A(b): no page error', errs.length === 0, errs.map((e) => e.m).join(' | '));
  const bTxs = pg.sent;
  const swapS = bTxs.find((s) => s.req.kind === 'swap');
  const appr = bTxs.filter((s) => s.req.kind !== 'swap').map(decodeSent);
  check('A(b): approvals are exactly USDC.approve(Permit2, amount) and Permit2.approve(USDC, UniversalRouter, amount, ≤ now+30min)',
    appr.length <= 2 && appr.every((a) => (a.to === USDC && getAddress(a.args[0]) === PERMIT2 && a.args[1] === gotU) || (a.to === 'PERMIT2' && getAddress(a.args[0]) === USDC && getAddress(a.args[1]) === UR && a.args[2] === gotU)),
    appr.map((a) => a.to).join(', '));
  const ds = decodeSent(swapS);
  const [single] = decodeAbiParameters([{ type: 'tuple', components: [PK_TUPLE, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bytes' }] }], ds.params[0]);
  const settleAll = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], ds.params[1]);
  const takeAll = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], ds.params[2]);
  check('A(b): UR.execute([V4_SWAP]) [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL], value 0, sent by the user', ds.to === 'UR' && ds.cmds === '0x10' && ds.nInputs === 1 && ds.acts.join() === '6,12,15' && swapS.tx.value === 0n && getAddress(swapS.tx.from) === USER);
  check('A(b): HYPE/USDC 0.3% key, zeroForOne=false, amountIn == USDC from (a), minOut > 0', single[0][0] === ZERO && getAddress(single[0][1]) === USDC && single[0][2] === 3000 && single[0][3] === 60 && single[0][4] === ZERO && single[1] === false && single[2] === gotU && single[3] > 0n, `min ${H(single[3])}`);
  check('A(b): SETTLE_ALL(USDC, amountIn) and TAKE_ALL(native 0x0, minOut) (TAKE_ALL pays msgSender = user)', getAddress(settleAll[0]) === USDC && settleAll[1] === gotU && takeAll[0] === ZERO && takeAll[1] === single[3]);
  rec = pg.loadMig();
  const hypeFromSwap = BigInt(rec.hypeReceived);
  check('A(b): recorded hypeReceived == wallet HYPE delta + swap gas, >= minOut', hypeFromSwap === swapS.hAfter - swapS.hBefore + gasOf(swapS.receipt) && hypeFromSwap >= single[3], H(hypeFromSwap));
  check('A(b): wallet USDC back to exactly what the user had before', (await bal(USDC)) === U0, U(await bal(USDC)));
  const a2 = await L.readAllowances(pub, USER, USDC, UR);
  check('A(b): no USDC allowance left (ERC20->Permit2 and Permit2->router)', a2.erc20Allowance === 0n && a2.p2.amount === 0n, `${a2.erc20Allowance}/${a2.p2.amount}`);
  check('A(b): HYPE reserve untouched (balance moved only by +swap output − gas)', (await hype()) === hB0 + hypeFromSwap - bTxs.reduce((s, t) => s + gasOf(t.receipt), 0n));
  await flat('A after (b)');

  // reload
  pg = page();
  m = await pg.readMigState();
  check('A reload after (b): chain + record say next = (c)', m.aDone && m.bDone && !m.cDone);

  // (c)
  const ctxC = await L.readSwapContext(pub, USER);
  const pmH = await hype(PM), posmH = await hype(POSM);
  errs = await step(pg);
  check('A(c): no page error', errs.length === 0, errs.map((e) => e.m).join(' | '));
  const mintS = pg.sent.find((s) => s.req.kind === 'mint');
  check('A(b): Swap event read-back (used on resume) == the balance-based HYPE received', L.hypeOutFromSwapReceipt(swapS.receipt) === hypeFromSwap, H(L.hypeOutFromSwapReceipt(swapS.receipt) ?? 0n));
  const kAppr = pg.sent.filter((s) => s.req.kind !== 'mint').map(decodeSent);
  const dm = decodeSent(mintS);
  const [mk, tl, tu, liq, a0Max, a1Max, owner] = decodeAbiParameters([PK_TUPLE, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }], dm.params[0]);
  const sp = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], dm.params[1]);
  const sw = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], dm.params[2]);
  check('A(c): mint = [MINT_POSITION, SETTLE_PAIR, SWEEP] in key d210, full range ±887160, owner user', dm.acts.join() === '2,13,20' && myPoolId({ currency0: mk[0], currency1: mk[1], fee: mk[2], tickSpacing: mk[3], hooks: mk[4] }) === L.LP_POOLS.HYPE.poolId && tl === -887160 && tu === 887160 && getAddress(owner) === USER);
  check('A(c): SETTLE_PAIR(0x0, KNTQ), SWEEP(0x0, user)', sp[0] === ZERO && getAddress(sp[1]) === KNTQ && sw[0] === ZERO && getAddress(sw[1]) === USER);
  check('A(c): msg.value == amount0Max <= HYPE the swap brought (reserve never deposited)', mintS.tx.value === a0Max && a0Max <= hypeFromSwap && a0Max > 0n, `${H(a0Max)} of ${H(hypeFromSwap)}`);
  check('A(c): msg.value <= balance − reserve − mint gas at signing time', a0Max <= L.maxHypeForLp(ctxC), `lpMax ${H(L.maxHypeForLp(ctxC))}`);
  check('A(c): KNTQ approvals exact (amount1Max), spender Permit2 then PositionManager only', kAppr.every((a) => (a.to === KNTQ && getAddress(a.args[0]) === PERMIT2 && a.args[1] === a1Max) || (a.to === 'PERMIT2' && getAddress(a.args[0]) === KNTQ && getAddress(a.args[1]) === POSM && a.args[2] === a1Max)), kAppr.map((a) => a.to).join(', '));
  rec = pg.loadMig();
  const newId = BigInt(rec.newTokenId);
  const [key] = await pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'getPoolAndPositionInfo', args: [newId] });
  check('A(c): new NFT in pool 0xd210…3472, owner user, liquidity == signed liquidity', myPoolId({ ...key, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing) }) === L.LP_POOLS.HYPE.poolId && getAddress(await ownerOf(newId)) === USER && (await pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'getPositionLiquidity', args: [newId] })) === liq, `#${newId} L ${liq}`);
  const userSpent = mintS.hBefore - mintS.hAfter - gasOf(mintS.receipt);
  check('A(c): native settle came from msg.value: PoolManager HYPE += user HYPE spent (≤ value), PositionManager HYPE unchanged (SWEEP returned the rest)', (await hype(PM)) - pmH === userSpent && userSpent <= a0Max && (await hype(POSM)) === posmH, `spent ${H(userSpent)} of ${H(a0Max)}`);
  const ctxEnd = await L.readSwapContext(pub, USER);
  const hEnd = await hype();
  check('A(c): HYPE after >= reserve and worth >= $8 (on-chain price)', hEnd >= ctxEnd.reserve && Number((hEnd * ctxEnd.usdcPerHypeE6) / 10n ** 18n) / 1e6 >= 8, `${H(hEnd)} ≈ $${(Number((hEnd * ctxEnd.usdcPerHypeE6) / 10n ** 18n) / 1e6).toFixed(2)}`);
  await flat('A after (c)');
  {
    const hs = ctxEnd.pools.KNTQ;
    const kUsd = L.usdPerKntqInPool('HYPE', hs.sqrtPriceX96, ctxEnd.hypeUsd);
    const np = await L.readPosition(pub, newId, hs, 'HYPE');
    const v = (u, k, h) => Number(u) / 1e6 + (Number(k) / 1e18) * kUsd + (Number(h) / 1e18) * ctxEnd.hypeUsd;
    const v0 = v(U0 + pos0.amounts.amount0 + pos0.fees.amount0, K0 + pos0.amounts.amount1 + pos0.fees.amount1, H0);
    const v1 = v(await bal(USDC), (await bal(KNTQ)) + np.amounts.amount1, hEnd + np.amounts.amount0);
    const moved = v(pos0.amounts.amount0 + pos0.fees.amount0, pos0.amounts.amount1 + pos0.fees.amount1, 0n);
    check('A: realized migration cost (fees + impact + gas) < 2% of value moved', (v0 - v1) / moved < 0.02 && v1 <= v0, `$${(v0 - v1).toFixed(4)} = ${(((v0 - v1) / moved) * 100).toFixed(3)}% of $${moved.toFixed(2)}`);
    log(`A: new position ${H(np.amounts.amount0)} + ${K(np.amounts.amount1)}; wallet ${H(hEnd)}, ${U(await bal(USDC))}, ${K(await bal(KNTQ))}`);
  }
  // reload -> finish
  pg = page();
  m = await pg.readMigState();
  check('A reload after (c): all three steps recognised as done', m.aDone && m.bDone && m.cDone);
  await step(pg);
  check('A: Finish marks the record finished', pg.loadMig()?.finished === true);
  // independent check of native TAKE_PAIR: remove 100% + burn the new position with the page's builder
  {
    const hs = await L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId);
    const fp = await L.readPosition(pub, newId, hs, 'HYPE');
    const d = L.planDecrease(hs, fp, fp.liquidity, 50);
    const req = L.buildDecrease({ tokenId: newId, liquidity: fp.liquidity, amount0Min: d.amount0Min, amount1Min: d.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: true, expected: d.expected, pool: 'HYPE' });
    const tp = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], unlock(req.args[0])[1].at(-1));
    const pmBefore = await hype(PM);
    const p2 = page();
    const n = p2.sent.length;
    const { sendTx } = build(SEND_SRC, { canWrite: () => true, writeBlockReason: () => '', S: p2.S, L, ensureChain: async () => {}, confirmTx: async (r) => (await pub.simulateContract({ address: r.address, abi: r.abi, functionName: r.functionName, args: r.args, account: USER, ...r.tx })).request, logTx: () => () => {}, toast: () => {}, pub }, ['sendTx']);
    const h0 = await hype();
    const r = await sendTx(req);
    const got = (await hype()) - h0 + gasOf(r);
    check('HYPE pool remove: TAKE_PAIR(0x0, KNTQ, user) sends native HYPE straight to the user (= PoolManager HYPE decrease), >= min', getAddress(tp[2]) === USER && tp[0] === ZERO && got === pmBefore - (await hype(PM)) && got >= d.amount0Min && n === 0, H(got));
  }
  await flat('A end');

  // ======================================================================== B. die after the (b) swap is mined
  console.log('\n-- B. page dies after the (b) swap is mined, before saving progress --');
  await revert(S0); const S1 = await snapshot();
  storage.clear();
  pg = page();
  await pg.openMigration(TOKEN_ID);
  await step(pg); // (a)
  const usdcFromA = BigInt(pg.loadMig().usdcReceived);
  pg = page({ crashAfter: (req) => req.kind === 'swap' });
  await step(pg); // (b), dies after the swap is mined
  const realSwapHype = (() => { const s = pg.sent.find((x) => x.req.kind === 'swap'); return s.hAfter - s.hBefore + gasOf(s.receipt); })();
  const swapHash = pg.sent.find((x) => x.req.kind === 'swap').receipt.transactionHash;
  check('B: swap mined, record has no txB / hypeReceived (progress lost), only the hash saved before the receipt', !pg.loadMig().txB && !pg.loadMig().hypeReceived && pg.loadMig().pending?.hash === swapHash && pg.loadMig().pending?.step === 'b' && (await bal(USDC)) === U0, `swap brought ${H(realSwapHype)}`);
  pg = page();
  m = await pg.readMigState();
  check('B reload: page recognises (b) as done (must not propose swapping the USDC the user already had)', m.bDone && !m.pending, `next would be (b) again with usdcToSwap ${U(m.usdcToSwap)} (pre-existing wallet USDC ${U(U0)}; (a) returned ${U(usdcFromA)})`);
  check("B reload: hypeReceived recovered from the saved hash's receipt == HYPE the swap really brought; txB recorded", pg.loadMig().hypeReceived === realSwapHype.toString() && pg.loadMig().txB === swapHash, pg.loadMig().hypeReceived ? H(BigInt(pg.loadMig().hypeReceived)) : '—');
  // follow the page to the end and measure what the user ends up with
  for (let i = 0; i < 3; i++) {
    const mm = await pg.readMigState();
    if (mm.cDone) break;
    const e = await step(pg);
    if (e.length) { log('B: page error', e.map((x) => x.m).join(' | ')); break; }
    pg = page();
  }
  {
    const r = pg.loadMig();
    const np = r.newTokenId ? await L.readPosition(pub, BigInt(r.newTokenId), await L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId), 'HYPE') : null;
    const hNow = await hype();
    const ctx = await L.readSwapContext(pub, USER);
    log(`B outcome: new position #${r.newTokenId}: ${np ? `${H(np.amounts.amount0)} + ${K(np.amounts.amount1)}` : 'none'}; wallet ${H(hNow)}, ${U(await bal(USDC))}, ${K(await bal(KNTQ))}; recorded hypeReceived ${r.hypeReceived ? H(BigInt(r.hypeReceived)) : '—'}`);
    check('B outcome: the new position holds >= 95% of the HYPE the real swap brought', !!np && np.amounts.amount0 * 100n >= realSwapHype * 95n, np ? `${H(np.amounts.amount0)} of ${H(realSwapHype)}` : 'no position');
    check('B outcome (safety): HYPE >= reserve, worth >= $8, nothing lost to contracts', hNow >= ctx.reserve && Number((hNow * ctx.usdcPerHypeE6) / 10n ** 18n) / 1e6 >= 8);
    await flat('B end');
  }

  // ======================================================================== C. die after the (c) mint is mined
  console.log('\n-- C. page dies after the (c) mint is mined, before saving progress --');
  await revert(S1); const S2 = await snapshot();
  storage.clear();
  pg = page(); await pg.openMigration(TOKEN_ID); await step(pg); // (a)
  pg = page(); await step(pg); // (b)
  pg = page({ crashAfter: (req) => req.kind === 'mint' }); await step(pg); // (c) dies
  const firstMint = pg.sent.find((x) => x.req.kind === 'mint');
  const firstId = L.parseMintedTokenId(firstMint.receipt, USER);
  check('C: mint mined (#' + firstId + '), record has no newTokenId (only the pending hash)', firstId !== null && !pg.loadMig().newTokenId && pg.loadMig().pending?.step === 'c');
  pg = page();
  m = await pg.readMigState();
  check('C reload: page recognises (c) as done (must not offer a second mint)', m.cDone, `next would be (c) again; wallet ${H(await hype())}, ${K(m.kntq)}`);
  check('C reload: recovered newTokenId == the minted NFT, and it is saved to the ids list', pg.loadMig().newTokenId === String(firstId) && JSON.parse(storage.get(`ids:${USER}`) || '[]').includes(String(firstId)));
  {
    const nBefore = (await pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'balanceOf', args: [USER] }));
    await step(pg);
    const nAfter = (await pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'balanceOf', args: [USER] }));
    check('C: resuming does not mint a second position', nAfter === nBefore, `NFTs ${nBefore} -> ${nAfter}`);
    const ctx = await L.readSwapContext(pub, USER);
    check('C (safety): HYPE >= reserve after resuming', (await hype()) >= ctx.reserve);
    await flat('C end');
  }

  // ======================================================================== D. cancel the swap after the approvals
  console.log('\n-- D. user rejects the (b) swap after the approvals landed, then resumes --');
  await revert(S2); const S3 = await snapshot();
  storage.clear();
  pg = page(); await pg.openMigration(TOKEN_ID); await step(pg); // (a)
  let cancelled = false;
  pg = page({ cancel: (req) => req.kind === 'swap' && !cancelled && (cancelled = true) });
  await step(pg);
  const aD = await L.readAllowances(pub, USER, USDC, UR);
  check('D: after cancel, approvals are still exact (USDC->Permit2 and Permit2->router == amount from (a)), no swap', cancelled && pg.sent.every((s) => s.req.kind !== 'swap') && aD.p2.amount === BigInt(pg.loadMig().usdcReceived));
  pg = page();
  await step(pg);
  check('D: resume sends only the swap (no repeated approvals); record completed', pg.sent.length === 1 && pg.sent[0].req.kind === 'swap' && !!pg.loadMig().hypeReceived);
  pg = page(); await step(pg); // (c)
  check('D: (c) completes', !!pg.loadMig().newTokenId);
  const ctx = await L.readSwapContext(pub, USER);
  check('D (safety): HYPE >= reserve', (await hype()) >= ctx.reserve);
  // Step 2 MAX in the HYPE pool must respect the reserve (on the post-migration wallet)
  {
    const lpMax = L.maxHypeForLp(ctx);
    for (const bps of [5, 50, 100, 2000]) {
      const mMax = lpMax > 2n ? ((lpMax - 2n) * 10000n) / BigInt(10000 + bps) : 0n; // app.js max0 for the HYPE pool
      if (mMax === 0n) { check(`MAX (slippage ${bps / 100}%): nothing free above the reserve -> 0`, lpMax <= 2n || mMax === 0n); continue; }
      const r = L.rangeForPreset('full', ctx.pools.KNTQ.tick, {}, 'HYPE');
      const plan = L.planMint(ctx.pools.KNTQ, r.tickLower, r.tickUpper, { amount0: mMax, anchor: 'amount0' }, bps, 'HYPE');
      const ok = await L.planMintTxs(pub, USER, plan, { nowSec: await latestTs() }).then(() => true, () => false);
      check(`MAX (slippage ${bps / 100}%): amount0Max <= balance − reserve − mint gas, and planMintTxs accepts it`, plan.amount0Max <= lpMax && ctx.balance - plan.amount0Max >= ctx.reserve && ok, `${H(plan.amount0Max)} / lpMax ${H(lpMax)}`);
    }
  }
  await flat('D end');

  // ======================================================================== E. die after the (a) remove is mined
  console.log('\n-- E. page dies after the (a) remove is mined, before saving progress --');
  await revert(S3); const S4 = await snapshot();
  storage.clear();
  pg = page(); await pg.openMigration(TOKEN_ID);
  check(`E: openMigration records the USDC already in the wallet (usdcBefore) while #${TOKEN_ID} is live`, pg.loadMig().usdcBefore === U0.toString() && !!pg.loadMig().startBlock, pg.loadMig().usdcBefore);
  pg = page({ crashAfter: (req) => getAddress(req.address) === POSM });
  await step(pg);
  const aRec = pg.sent[0];
  const gotUE = (await bal(USDC)) - U0;
  check('E: remove mined, record has only the pending hash', !pg.loadMig().txA && !pg.loadMig().usdcReceived && pg.loadMig().pending?.step === 'a' && (await ownerOf(TOKEN_ID)) === null);
  pg = page();
  m = await pg.readMigState();
  check('E reload: (a) recovered from the receipt (usdcReceived == wallet delta), next = (b) with only that USDC', m.aDone && !m.bDone && pg.loadMig().usdcReceived === gotUE.toString() && pg.loadMig().txA === aRec.receipt.transactionHash && m.usdcToSwap === gotUE, U(m.usdcToSwap));

  // ======================================================================== F. the swap hash is lost as well
  console.log('\n-- F. (b) swap mined and its hash lost too: the page finds it in the logs --');
  pg = page({ crashAfter: (req) => req.kind === 'swap' });
  await step(pg);
  const fSwap = pg.sent.find((x) => x.req.kind === 'swap');
  const fHype = fSwap.hAfter - fSwap.hBefore + gasOf(fSwap.receipt);
  { const r = pg.loadMig(); delete r.pending; pg.saveMig(r); }
  pg = page();
  m = await pg.readMigState();
  check('F reload: (b) done from balances (wallet USDC == usdcBefore), swap found in the logs, hypeReceived == real swap HYPE', m.bDone && m.usdcToSwap === 0n && pg.loadMig().txB === fSwap.receipt.transactionHash && pg.loadMig().hypeReceived === fHype.toString(), `${U(m.usdcToSwap)}, ${pg.loadMig().hypeReceived ? H(BigInt(pg.loadMig().hypeReceived)) : '—'}`);
  {
    const e = await step(pg);
    const r = pg.loadMig();
    const np = r.newTokenId ? await L.readPosition(pub, BigInt(r.newTokenId), await L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId), 'HYPE') : null;
    check("F: (c) mints with the swap's HYPE (>= 95% of it in the position, <= 100%)", e.length === 0 && !!np && np.amounts.amount0 * 100n >= fHype * 95n && np.amounts.amount0 <= fHype, np ? `${H(np.amounts.amount0)} of ${H(fHype)}` : e.map((x) => x.m).join(' | '));
    const ctx = await L.readSwapContext(pub, USER);
    check('F (safety): HYPE >= reserve', (await hype()) >= ctx.reserve);
    await flat('F end');
  }

  // ======================================================================== G. continue in a browser with no record
  console.log('\n-- G. "Continue a move" with no saved record (another browser) --');
  await revert(S4); const S5 = await snapshot();
  storage.clear();
  pg = page(); await pg.openMigration(TOKEN_ID); await step(pg); // (a)
  const gotUG = BigInt(pg.loadMig().usdcReceived);
  storage.clear(); // other browser: nothing saved
  pg = page(); await pg.openMigration(TOKEN_ID);
  check('G: openMigration on a burned NFT starts a record without usdcBefore (not live)', pg.loadMig().usdcBefore === undefined && pg.loadMig().continued === true);
  m = await pg.readMigState();
  check('G after (a): burn found in the logs; usdcReceived / usdcBefore derived; next = (b) with ONLY the USDC (a) returned', m.aDone && !m.bDone && !m.problem && pg.loadMig().usdcReceived === gotUG.toString() && pg.loadMig().usdcBefore === U0.toString() && m.usdcToSwap === gotUG && !m.usdcUnsure, `${U(m.usdcToSwap)} (wallet ${U(m.usdc)})`);
  await step(pg); // (b)
  const gSwapHype = BigInt(pg.loadMig().hypeReceived);
  storage.clear();
  pg = page(); await pg.openMigration(TOKEN_ID);
  m = await pg.readMigState();
  check('G after (b): swap found in the logs, hypeReceived == recorded by the first browser, next = (c)', m.aDone && m.bDone && !m.cDone && pg.loadMig().hypeReceived === gSwapHype.toString(), pg.loadMig().hypeReceived ? H(BigInt(pg.loadMig().hypeReceived)) : '—');
  await step(pg); // (c)
  const gNew = pg.loadMig().newTokenId;
  check('G: (c) minted', !!gNew);
  storage.clear();
  pg = page(); await pg.openMigration(TOKEN_ID);
  m = await pg.readMigState();
  check('G after (c): mint found in the logs, all done, same new tokenId; no second mint offered', m.aDone && m.bDone && m.cDone && pg.loadMig().newTokenId === gNew, `#${pg.loadMig().newTokenId}`);
  {
    const nBefore = await pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'balanceOf', args: [USER] });
    await step(pg);
    const nAfter = await pub.readContract({ address: POSM, abi: L.POSM_ABI, functionName: 'balanceOf', args: [USER] });
    check('G: Finish sends nothing and marks the record finished', nAfter === nBefore && pg.loadMig()?.finished === true && pg.sent.length === 0);
  }
  storage.clear();
  pg = page(); await pg.openMigration(999999999n);
  m = await pg.readMigState();
  check('G: continuing a tokenId that this wallet never burned reports a problem (nothing to continue)', !!m.problem, m.problem || '');
  await flat('G end');
  await revert(S5);
}

main().then((c) => process.exit(c), (e) => { console.error('FAIL: crashed:', e.shortMessage || e.message, String(e.stack).split('\n').slice(0, 8).join('\n')); process.exit(1); });
