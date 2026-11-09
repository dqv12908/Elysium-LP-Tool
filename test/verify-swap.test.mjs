// Independent verifier for Step 1 (HYPE -> USDC / KNTQ swaps) focused on USER FUNDS.
// Anvil fork of Elysium mainnet on port 8569. Full user journey from an account holding exactly 4.0156 HYPE:
//   split spendable HYPE half/half -> swap HYPE->USDC, HYPE->KNTQ -> mint full range -> (trader makes fees) ->
//   collect -> remove 100% + burn. Asserts the final HYPE is still worth >= $8.
// Every user tx goes through an EIP-1193 "MetaMask" stub (custom transport) that records eth_sendTransaction
// params, and every swap's calldata is decoded here with an ABI written independently of lib.mjs.
//   node test/verify-swap.test.mjs
// No private keys: anvil dev accounts are unlocked; HYPE is set with anvil_setBalance.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, createWalletClient, createTestClient, http, custom, parseAbi, getAddress, toHex,
  decodeFunctionData, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, decodeErrorResult, keccak256,
} from 'viem';
import * as L from '../lib.mjs';

const PORT = 8569;
const FORK = `http://127.0.0.1:${PORT}`;
const START_HYPE = 40156n * 10n ** 14n; // 4.0156 HYPE
const ZERO = '0x0000000000000000000000000000000000000000';

let failed = 0, total = 0;
const check = (name, ok, detail = '') => { total++; if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const log = (...a) => console.log('•', ...a);
const H = (x) => `${L.fmtAmount(x, 18, 6)} HYPE`;

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
async function reachable(url) { try { return Number((await rpc(url, 'eth_chainId')).result) === L.CHAIN_ID; } catch { return false; } }
function anvilBin() { const p = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil'); return existsSync(p) ? p : 'anvil'; }
async function startAnvil() {
  const proc = spawn(anvilBin(), ['--fork-url', L.RPC_URL, '--port', String(PORT), '--chain-id', String(L.CHAIN_ID), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('anvil exited: ' + err);
    if (await reachable(FORK)) { await rpc(FORK, 'evm_mine'); return proc; } // Elysium headers lack excessBlobGas
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill(); throw new Error('anvil did not start');
}

// ---- independent ABI / layout (from universal-router 2.1.2 @802fe4c + v4-periphery @545a5d2 sources) ----
const UR = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooLittleReceivedPerHopSingle(uint256 minPrice, uint256 price)',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
]);
const PK = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const EXACT_IN_SINGLE = [{ type: 'tuple', components: [{ name: 'poolKey', ...PK }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }];
const EXPECTED = {
  USDC: { id: '0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc', key: [ZERO, '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65', 3000, 60, ZERO] },
  KNTQ: { id: '0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472', key: [ZERO, '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0', 8000, 120, ZERO] },
};
const ROUTER = '0xA13f7611115752DEB2B13813BDDE16A5073e4b45';

/** Decode a swap tx's calldata with the independent layout and check every funds-relevant field. */
function decodeSwap(data) {
  const { functionName, args } = decodeFunctionData({ abi: UR, data });
  const [commands, inputs, deadline] = args;
  const [actionsHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]);
  const [sp] = decodeAbiParameters(EXACT_IN_SINGLE, params[0]);
  const [settleCur, settleMax] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]);
  const [takeCur, takeMin] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]);
  const sweep = inputs[1] ? decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint160' }], inputs[1]) : null;
  return { functionName, commands, inputs, deadline, actions: actionsHex, nParams: params.length, sp, settleCur, settleMax, takeCur, takeMin, sweep };
}

async function main() {
  console.log('== verify-swap (independent, user funds) ==');
  console.log('-- static --');
  for (const [out, e] of Object.entries(EXPECTED)) {
    const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], e.key));
    check(`${out}: independent poolId == expected`, id === e.id, id);
    const k = L.SWAP_POOLS[out].key;
    check(`${out}: lib PoolKey == expected key, currency0 = native (0x0) < currency1`, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks].map(String).join() === e.key.map((x) => (typeof x === 'string' ? getAddress(x) : String(x))).join() && BigInt(k.currency0) < BigInt(k.currency1) && L.SWAP_POOLS[out].id === e.id);
  }
  check('lib router == 0xA13f… (UR 2.1.2)', L.UNIVERSAL_ROUTER === getAddress(ROUTER));
  check('tampered swap key refused', (() => { const p = L.SWAP_POOLS.USDC; try { Object.assign(p.key, { fee: 500 }); } catch {} return p.key.fee === 3000 && L.SWAP_POOL_IDS_OK; })());
  // reserve math edge cases: never < $8 worth, never more than $8 + 1 wei
  for (const px of [1n, 7_999_999n, 8_000_000n, 8_000_001n, 74_895_835n, 10_000_000_000n]) {
    const r = L.hypeReserveWei(px);
    check(`reserve @ ${Number(px) / 1e6} USD/HYPE = ${H(r)} worth >= $8`, r * px >= 8_000_000n * 10n ** 18n && (r - 1n) * px < 8_000_000n * 10n ** 18n);
  }
  check('reserve refuses price 0', (() => { try { L.hypeReserveWei(0n); return false; } catch { return true; } })());
  // minOut==0 edge: withSlippageDown(1, bps) == 0 — planHypeSwap and buildSwapHype must refuse it
  check('withSlippageDown(quote=1, 100bps) is 0 (dust-only edge)', L.withSlippageDown(1n, 100) === 0n);
  check('buildSwapHype refuses minAmountOut 0', (() => { try { L.buildSwapHype({ out: 'USDC', amountIn: 5n, minAmountOut: 0n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 1n }); return false; } catch (e) { return /> 0/.test(e.message); } })());

  if (!(await reachable(L.RPC_URL))) { console.log('SKIP fork part: RPC unreachable'); return summary(); }
  const anvil = await startAnvil();
  try { await fork(); } finally { try { anvil.kill(); } catch {} }
  return summary();
}
function summary() { console.log(`\n== SUMMARY ==\n${failed === 0 ? 'PASS' : 'FAIL'}: ${total - failed}/${total} checks passed`); return failed === 0 ? 0 : 1; }

async function fork() {
  console.log('-- fork', FORK, '--');
  const chain = { ...L.elysium, rpcUrls: { default: { http: [FORK] } } };
  const pub = createPublicClient({ chain, transport: http(FORK), pollingInterval: 100 });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK) });
  const accts = (await pub.request({ method: 'eth_accounts' })).map((a) => getAddress(a));
  const USER = accts[6], TRADER = accts[7];
  const sent = []; // every eth_sendTransaction the "MetaMask" stub sees
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_sendTransaction') sent.push(params[0]);
    const j = await rpc(FORK, method, params ?? []);
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  } };
  const wallet = createWalletClient({ account: USER, chain: L.elysium, transport: custom(provider) });
  const latestTs = async () => Number((await pub.getBlock()).timestamp);
  const bal = (t, a = USER) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [a] });
  const hype = (a = USER) => pub.getBalance({ address: a });
  const priceE6 = async () => (await L.readSwapContext(pub, null)).usdcPerHypeE6;
  const usdOf = (wei, p) => Number((wei * p) / 10n ** 18n) / 1e6;

  // app.js sendTx verbatim (minus dialog): guards, simulate with ...req.tx, write the simulated request
  const sendTx = async (req) => {
    if (req.tx && req.kind !== 'swap') throw new Error('Only swaps may carry a transaction value.');
    L.assertTargetPool();
    const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER, ...req.tx });
    const hash = await wallet.writeContract({ ...request, account: USER, chain: L.elysium });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('reverted ' + hash);
    return r;
  };

  // ---- on-chain identity ----
  const urPm = await pub.readContract({ address: ROUTER, abi: L.UR_ABI, functionName: 'poolManager' });
  check('router.poolManager() == official PM', getAddress(urPm) === L.ADDR.POOL_MANAGER);
  for (const out of ['USDC', 'KNTQ']) {
    const s = await L.readPoolState(pub, undefined, EXPECTED[out].id);
    check(`HYPE/${out} pool initialized, lpFee == key fee, has liquidity`, s.initialized && s.lpFee === EXPECTED[out].key[2] && s.liquidity > 0n, `tick ${s.tick}`);
  }

  // ---- deployed layout proof: a nonzero minHopPriceX36 must be READ by the router (per-hop revert) ----
  {
    const amountIn = 10n ** 17n;
    const r = L.buildSwapHype({ out: 'USDC', amountIn, minAmountOut: 1n, recipient: USER, deadline: 1n << 40n });
    const d = decodeSwap(encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args }));
    const sp = { ...d.sp, minHopPriceX36: (1n << 255n) };
    const actions = d.actions;
    const params = [encodeAbiParameters(EXACT_IN_SINGLE, [sp]), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ZERO, amountIn]), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [d.takeCur, 1n])];
    const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
    let name = null;
    try {
      await pub.call({ account: USER, to: ROUTER, value: amountIn, data: encodeFunctionData({ abi: UR, functionName: 'execute', args: ['0x10', [input], 1n << 40n] }), stateOverride: [{ address: USER, balance: 10n ** 21n }] });
    } catch (e) { const rd = L.revertDataOf(e); try { name = decodeErrorResult({ abi: UR, data: rd }).errorName; } catch { name = 'undecodable ' + rd?.slice(0, 10); } }
    check('deployed router decodes minHopPriceX36 (huge value -> V4TooLittleReceivedPerHopSingle)', name === 'V4TooLittleReceivedPerHopSingle', String(name));
  }

  // ---- user: exactly 4.0156 HYPE ----
  await test.setBalance({ address: USER, value: START_HYPE });
  const u0 = await bal(L.ADDR.USDC), k0 = await bal(L.ADDR.KNTQ);
  check('start: 4.0156 HYPE', (await hype()) === START_HYPE, `pre-existing USDC ${u0} KNTQ ${k0}`);
  let ctx = await L.readSwapContext(pub, USER);
  log(`HYPE $${ctx.hypeUsd} reserve ${H(ctx.reserve)} max ${H(ctx.max)} maxFee ${ctx.fees.maxFeePerGas}`);
  check('reserve worth >= $8', usdOf(ctx.reserve, ctx.usdcPerHypeE6) >= 8);

  // ---- reserve can't be bypassed ----
  const plan = (out, amountIn, extra = {}) => L.planHypeSwap(pub, { out, amountIn, account: USER, nowSec: Date.now() / 1000 | 0, ...extra });
  const refusedMsg = (p) => p.then(() => null, (e) => e.message);
  check('refuse amount = balance', !!(await refusedMsg(plan('USDC', START_HYPE))));
  check('refuse amount = balance - reserve (no gas room)', !!(await refusedMsg(plan('KNTQ', START_HYPE - ctx.reserve))));
  check('refuse amount = balance - reserve - 1 wei', !!(await refusedMsg(plan('KNTQ', START_HYPE - ctx.reserve - 1n))));
  check('refuse slippage 0 / 501 bps / 1.5', !!(await refusedMsg(plan('USDC', 10n ** 16n, { slippageBps: 0 }))) && !!(await refusedMsg(plan('USDC', 10n ** 16n, { slippageBps: 501 }))) && !!(await refusedMsg(plan('USDC', 10n ** 16n, { slippageBps: 1.5 }))));
  check('refuse amount 0 / negative', !!(await refusedMsg(plan('USDC', 0n))) && !!(await refusedMsg(plan('USDC', -1n))));
  check('refuse unknown output', !!(await refusedMsg(plan('WHYPE', 10n ** 16n))));
  {
    // dust: an amount whose quote is exactly 1 base unit (1e-6 USDC) -> min out at 1% rounds to 0 -> refused
    const dust = (15n * 10n ** 17n) / ctx.usdcPerHypeE6;
    const qd = await L.quoteHypeSwap(pub, { out: 'USDC', amountIn: dust, from: USER });
    const msg = await refusedMsg(plan('USDC', dust));
    check('refuse dust swap whose min received rounds to 0', qd === 1n && /rounds to 0/.test(String(msg)), `amountIn ${dust} wei, quote ${qd}, ${msg}`);
  }
  const atMax = await plan('USDC', ctx.max);
  check('MAX plans and keeps reserve after worst-case gas', atMax.balanceAfterMin >= ctx.reserve && atMax.gasCost <= ctx.gasBuffer, `after >= ${H(atMax.balanceAfterMin)}, gas ≤ ${H(atMax.gasCost)}`);

  // ---- swaps: half / half of spendable (two gas buffers, like Split for LP) ----
  const spendable = L.maxHypeSwap({ balance: ctx.balance, reserve: ctx.reserve, gasCost: 2n * ctx.gasBuffer });
  const split = L.splitHypeForLp(spendable, 0.5);
  log(`spendable ${H(spendable)} -> ${H(split.toUsdc)} USDC side, ${H(split.toKntq)} KNTQ side`);
  for (const [out, amountIn] of [['USDC', split.toUsdc], ['KNTQ', split.toKntq]]) {
    const token = L.SWAP_POOLS[out].out.address;
    const p = await plan(out, amountIn);
    const nSent = sent.length;
    const hb = await hype(), tb = await bal(token), routerHype0 = await hype(ROUTER), pmHype0 = await hype(L.ADDR.POOL_MANAGER);
    const rc = await sendTx(p.req);
    const tx = sent[nSent];
    check(`${out}: exactly one eth_sendTransaction, to router, value == amountIn`, sent.length === nSent + 1 && getAddress(tx.to) === getAddress(ROUTER) && BigInt(tx.value) === amountIn, `value ${BigInt(tx.value)}`);
    const d = decodeSwap(tx.data);
    const e = EXPECTED[out];
    check(`${out}: commands = V4_SWAP(0x10) + SWEEP(0x04), actions = 06 0c 0f`, d.commands === '0x1004' && d.actions === '0x060c0f' && d.nParams === 3);
    check(`${out}: decoded PoolKey == expected, zeroForOne, minHopPriceX36 0, hookData empty`, [d.sp.poolKey.currency0, d.sp.poolKey.currency1, d.sp.poolKey.fee, d.sp.poolKey.tickSpacing, d.sp.poolKey.hooks].map(String).join().toLowerCase() === e.key.map(String).join().toLowerCase() && d.sp.zeroForOne === true && d.sp.minHopPriceX36 === 0n && d.sp.hookData === '0x');
    check(`${out}: swap amountIn == SETTLE_ALL max == tx value; SETTLE currency native`, d.sp.amountIn === amountIn && d.settleMax === amountIn && d.settleCur === ZERO);
    check(`${out}: amountOutMinimum == TAKE_ALL min == quote*(1-1%) > 0; TAKE currency = ${out}`, d.sp.amountOutMinimum === p.minOut && d.takeMin === p.minOut && p.minOut > 0n && getAddress(d.takeCur) === getAddress(token));
    check(`${out}: SWEEP(native, USER, 0)`, d.sweep && d.sweep[0] === ZERO && getAddress(d.sweep[1]) === USER && d.sweep[2] === 0n);
    check(`${out}: gas == planned limit, maxFee == planned`, BigInt(tx.gas) === p.gasLimit && BigInt(tx.maxFeePerGas) === p.req.tx.maxFeePerGas);
    // output went to the signer (TAKE_ALL -> msgSender): the only Transfer of `token` in the receipt is PM -> USER
    const transfers = rc.logs.filter((l) => getAddress(l.address) === getAddress(token) && l.topics[0] === L.TRANSFER_TOPIC);
    const toUser = transfers.filter((l) => getAddress('0x' + l.topics[2].slice(26)) === USER);
    check(`${out}: token Transfer logs: all to USER, from PoolManager`, transfers.length >= 1 && toUser.length === transfers.length && transfers.every((l) => getAddress('0x' + l.topics[1].slice(26)) === L.ADDR.POOL_MANAGER));
    const got = (await bal(token)) - tb;
    const gas = rc.gasUsed * rc.effectiveGasPrice;
    check(`${out}: received == quote >= min`, got === p.quote && got >= p.minOut, `${L.fmtAmount(got, L.SWAP_POOLS[out].out.decimals, 6)} ${out}`);
    check(`${out}: HYPE spent == amountIn + gas; router keeps 0; PM gains amountIn`, hb - (await hype()) === amountIn + gas && (await hype(ROUTER)) === routerHype0 && (await hype(L.ADDR.POOL_MANAGER)) - pmHype0 === amountIn);
    check(`${out}: HYPE after >= reserve`, (await hype()) >= ctx.reserve, H(await hype()));
  }
  // minOut enforcement: execute with min = quote + 1 must revert
  {
    const q = await L.quoteHypeSwap(pub, { out: 'USDC', amountIn: 10n ** 15n, from: USER });
    const r = L.buildSwapHype({ out: 'USDC', amountIn: 10n ** 15n, minAmountOut: q + 1n, recipient: USER, deadline: BigInt(await latestTs() + 600) });
    const ok = await pub.simulateContract({ address: r.address, abi: r.abi, functionName: r.functionName, args: r.args, account: USER, ...r.tx }).then(() => true, () => false);
    check('swap with min = quote + 1 reverts (min enforced on-chain)', !ok);
  }
  ctx = await L.readSwapContext(pub, USER);
  check('after swaps: HYPE >= reserve and max ≈ 0 (all spendable used)', ctx.balance >= ctx.reserve && ctx.max <= ctx.gasBuffer + 10n ** 12n, `${H(ctx.balance)}, max ${H(ctx.max)}`);

  // ---- LP: mint full range with the swapped tokens ----
  const usdc = (await bal(L.ADDR.USDC)) - u0, kntq = (await bal(L.ADDR.KNTQ)) - k0;
  let lp = await L.readPoolState(pub);
  const rg = L.rangeForPreset('full', lp.tick);
  let mp = L.planMint(lp, rg.tickLower, rg.tickUpper, { amount0: usdc, anchor: 'amount0' }, 100);
  if (mp.amount1Max > kntq) mp = L.planMint(lp, rg.tickLower, rg.tickUpper, { amount1: (kntq * 100n) / 101n, anchor: 'amount1' }, 100);
  if (mp.amount0Max > usdc) mp = L.planMint(lp, rg.tickLower, rg.tickUpper, { amount0: (usdc * 100n) / 101n, anchor: 'amount0' }, 100);
  log(`mint ${L.fmtUsdc(mp.amount0, 6)} USDC + ${L.fmtKntq(mp.amount1, 6)} KNTQ of ${L.fmtUsdc(usdc, 6)} + ${L.fmtKntq(kntq, 6)}`);
  const nBeforeLp = sent.length;
  const txs = await L.planMintTxs(pub, USER, mp, { nowSec: await latestTs() });
  let receipt;
  for (const t of txs) {
    if (t.kind === 'mint') Object.assign(t, L.buildMint({ plan: mp, owner: USER, deadline: L.deadlineFromNow(600, await latestTs()) }));
    receipt = await sendTx(t);
  }
  const tokenId = L.parseMintedTokenId(receipt, USER);
  check('minted full-range position', tokenId !== null, `#${tokenId}; ${txs.map((t) => t.kind).join(' → ')}`);

  // ---- trader generates fees in the LP pool (test-only, independent encoding, router 2.1.2) ----
  await traderSwaps(pub, test, TRADER);
  const st = await L.readPoolState(pub);
  const pos = await L.readPosition(pub, tokenId, st);
  check('fees accrued', pos.fees.amount0 > 0n || pos.fees.amount1 > 0n, `${pos.fees.amount0} USDC-wei, ${pos.fees.amount1} KNTQ-wei`);
  const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
  await sendTx(L.buildCollect({ tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: pos.fees }));
  const tf = L.toolFeeSplit(pos.fees);
  check('collect pays fees − 10% tool fee to USER exactly', (await bal(L.ADDR.USDC)) - b0 === tf.user0 && (await bal(L.ADDR.KNTQ)) - b1 === tf.user1);

  const st2 = await L.readPoolState(pub);
  const pos2 = await L.readPosition(pub, tokenId, st2);
  const dec = L.planDecrease(st2, pos2, pos2.liquidity, 100);
  const c0 = await bal(L.ADDR.USDC), c1 = await bal(L.ADDR.KNTQ);
  await sendTx(L.buildDecrease({ tokenId, liquidity: dec.liquidity, amount0Min: dec.amount0Min, amount1Min: dec.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: true, expected: { ...dec.expected, fees: pos2.fees } }));
  const g0 = (await bal(L.ADDR.USDC)) - c0, g1 = (await bal(L.ADDR.KNTQ)) - c1;
  const tf2 = L.toolFeeSplit(pos2.fees);
  check('remove 100% + burn: got expected (principal + 90% of fees) >= mins', g0 === dec.expected.amount0 + tf2.user0 && g1 === dec.expected.amount1 + tf2.user1 && g0 >= dec.amount0Min && g1 >= dec.amount1Min);
  check('NFT burned', await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [tokenId] }).then(() => false, () => true));

  // ---- value: no tx other than the two swaps carried HYPE ----
  const lpSent = sent.slice(nBeforeLp);
  check('no LP tx (approvals, mint, collect, remove) carried value', lpSent.every((t) => !t.value || BigInt(t.value) === 0n), `${lpSent.length} txs`);
  check('only 2 txs ever carried value, both to the router', sent.filter((t) => t.value && BigInt(t.value) > 0n).length === 2 && sent.filter((t) => t.value && BigInt(t.value) > 0n).every((t) => getAddress(t.to) === getAddress(ROUTER)));

  const fin = await hype();
  const p = await priceE6();
  check('FINAL HYPE worth >= $8', usdOf(fin, p) >= 8, `${H(fin)} ≈ $${usdOf(fin, p).toFixed(2)} (${sent.length} txs sent)`);
  const finalUsdc = (await bal(L.ADDR.USDC)) - u0, finalKntq = (await bal(L.ADDR.KNTQ)) - k0;
  log(`final tokens: ${L.fmtUsdc(finalUsdc, 6)} USDC + ${L.fmtKntq(finalKntq, 6)} KNTQ`);
}

async function traderSwaps(pub, test, TRADER) {
  await test.setBalance({ address: TRADER, value: 10n ** 21n });
  const w = createWalletClient({ chain: pub.chain, transport: http(FORK), account: TRADER });
  const ts = async () => Number((await pub.getBlock()).timestamp);
  const send = async (req) => { const { request } = await pub.simulateContract({ ...req, account: TRADER }); const h = await w.writeContract(request); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('trader reverted'); };
  // trader buys USDC with HYPE via the lib (other account), then trades USDC<->KNTQ in the LP pool
  const q = await L.planHypeSwap(pub, { out: 'USDC', amountIn: 2n * 10n ** 18n, account: TRADER, nowSec: await ts() });
  await send({ address: q.req.address, abi: q.req.abi, functionName: q.req.functionName, args: q.req.args, ...q.req.tx });
  for (const t of [L.ADDR.USDC, L.ADDR.KNTQ]) {
    await send({ address: t, abi: L.ERC20_ABI, functionName: 'approve', args: [L.ADDR.PERMIT2, 2n ** 255n] });
    await send({ address: L.ADDR.PERMIT2, abi: L.PERMIT2_ABI, functionName: 'approve', args: [t, ROUTER, L.MAX_UINT160, (await ts()) + 86400] });
  }
  const K = L.POOL_KEY;
  const lpSwap = async (zeroForOne, amountIn) => {
    const [cin, cout] = zeroForOne ? [K.currency0, K.currency1] : [K.currency1, K.currency0];
    const params = [
      encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: K, zeroForOne, amountIn, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: '0x' }]),
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cin, amountIn]),
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, 0n]),
    ];
    const before = await pub.readContract({ address: cout, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [TRADER] });
    await send({ address: ROUTER, abi: UR, functionName: 'execute', args: ['0x10', [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', params])], BigInt((await ts()) + 600)] });
    return (await pub.readContract({ address: cout, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [TRADER] })) - before;
  };
  const k = await lpSwap(true, 30_000000n);
  await lpSwap(false, k);
  log(`trader: 30 USDC -> ${L.fmtKntq(k, 4)} KNTQ -> back`);
}

main().then((c) => process.exit(c), (e) => { console.error('FAIL: crashed:', e.shortMessage || e.message, String(e.stack).split('\n').slice(0, 6).join('\n')); process.exit(1); });
