// Step 1 fork test: HYPE -> USDC / KNTQ swaps with the EXACT lib builders the page uses, then the LP flow with
// the swapped tokens. Runs on an anvil fork of Elysium mainnet (port 8566).
//   node lp-helper/test/swap.test.mjs
// Needs Foundry's anvil (PATH or ~/.foundry/bin). Skips (exit 0) if the RPC is unreachable.
// No private keys: the test account is an anvil dev account (unlocked); its HYPE is set with anvil_setBalance.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, createTestClient, http, getAddress, parseAbi } from 'viem';
import * as L from '../lib.mjs';

const PORT = 8566;
const FORK_RPC = `http://127.0.0.1:${PORT}`;
const START_HYPE = 40156n * 10n ** 14n; // 4.0156 HYPE

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const log = (...a) => console.log('•', ...a);
const H = (x) => `${L.fmtAmount(x, 18, 6)} HYPE`;

async function rpcReachable(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: ctl.signal });
    clearTimeout(t);
    return Number((await r.json()).result) === L.CHAIN_ID;
  } catch {
    return false;
  }
}
function findAnvil() {
  const local = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  return existsSync(local) ? local : 'anvil';
}
async function startAnvil() {
  const proc = spawn(findAnvil(), ['--fork-url', L.RPC_URL, '--port', String(PORT), '--chain-id', String(L.CHAIN_ID), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('anvil exited: ' + stderr);
    if (await rpcReachable(FORK_RPC)) {
      // Elysium headers lack excessBlobGas: mine one local block so calls on "latest" work.
      await fetch(FORK_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) });
      return proc;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('anvil did not come up in 60s: ' + stderr);
}

async function main() {
  console.log('== lp-helper swap (Step 1) fork test ==');
  staticChecks();
  if (!(await rpcReachable(L.RPC_URL))) {
    console.log(`SKIP fork part: ${L.RPC_URL} unreachable or wrong chain id`);
    return summary();
  }
  const anvil = await startAnvil();
  process.on('SIGINT', () => { try { anvil.kill(); } catch {} process.exit(130); });
  try {
    await run();
  } finally {
    try { anvil.kill(); } catch {}
  }
  return summary();
}
function summary() {
  console.log('\n== SUMMARY ==');
  const passed = results.filter((r) => r.ok).length;
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'}: ${passed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

function staticChecks() {
  console.log('-- static --');
  check('HYPE/USDC + HYPE/KNTQ pool ids computed client-side match', L.SWAP_POOL_IDS_OK);
  for (const k of ['USDC', 'KNTQ']) check(`assertSwapPool(${k})`, (() => { try { L.assertSwapPool(k); return true; } catch { return false; } })());
  check('swap PoolKeys frozen', Object.isFrozen(L.SWAP_POOLS.USDC.key) && Object.isFrozen(L.SWAP_POOLS.KNTQ.key));
  check('assertSwapPool refuses unknown output', (() => { try { L.assertSwapPool('WETH'); return false; } catch { return true; } })());
  // reserve formula: exactly $8 worth of HYPE, rounded UP to the wei
  for (const px of [74_330000n, 8_000000n, 7_990000n, 2_500000n]) {
    const r = L.hypeReserveWei(px);
    check(`reserve @ $${Number(px) / 1e6}/HYPE is $8 worth (ceil wei)`, r * px >= 8_000_000n * 10n ** 18n && (r - 1n) * px < 8_000_000n * 10n ** 18n);
  }
  check('maxHypeSwap never negative', L.maxHypeSwap({ balance: 1n, reserve: 10n, gasCost: 5n }) === 0n);
  const sp = L.splitHypeForLp(1000n, 0.25);
  check('splitHypeForLp sums to spendable', sp.toUsdc + sp.toKntq === 1000n && sp.toUsdc === 250n);
  const req = L.buildSwapHype({ out: 'USDC', amountIn: 5n, minAmountOut: 4n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 1n });
  check('swap builder: router, value == amountIn, commands V4_SWAP+SWEEP', req.address === L.UNIVERSAL_ROUTER && req.tx.value === 5n && req.args[0] === '0x1004');
}

async function run() {
  const chain = { ...L.elysium, rpcUrls: { default: { http: [FORK_RPC] } } };
  const pub = createPublicClient({ chain, transport: http(FORK_RPC), pollingInterval: 100 });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_RPC) });
  const accts = await pub.request({ method: 'eth_accounts' });
  const USER = getAddress(accts[3]);
  const wallet = createWalletClient({ chain, transport: http(FORK_RPC), account: USER });
  const nowSec = async () => Number((await pub.getBlock()).timestamp);
  const bal = (t) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [USER] });
  log('fork block', await pub.getBlockNumber(), 'test account', USER);

  // ---- on-chain identity checks (same as page load) ----
  console.log('-- router / pools on-chain --');
  const urPm = await pub.readContract({ address: L.UNIVERSAL_ROUTER, abi: L.UR_ABI, functionName: 'poolManager' });
  check('UniversalRouter.poolManager() == official PoolManager', getAddress(urPm) === L.ADDR.POOL_MANAGER, urPm);
  const code = await pub.getCode({ address: L.UNIVERSAL_ROUTER });
  check('UniversalRouter embeds canonical Permit2 immutable', code.toLowerCase().includes('7f000000000000000000000000' + L.ADDR.PERMIT2.slice(2).toLowerCase()));
  for (const k of ['USDC', 'KNTQ']) {
    const s = await L.readPoolState(pub, undefined, L.SWAP_POOLS[k].id);
    check(`HYPE/${k} pool initialized on PM, lpFee == key fee`, s.initialized && s.lpFee === L.SWAP_POOLS[k].key.fee, `tick ${s.tick}, L ${s.liquidity}`);
  }

  // ---- fund: exactly 4.0156 HYPE, no tokens ----
  await test.setBalance({ address: USER, value: START_HYPE });
  const startUsdc = await bal(L.ADDR.USDC), startKntq = await bal(L.ADDR.KNTQ);
  check('start: 4.0156 HYPE', (await pub.getBalance({ address: USER })) === START_HYPE, `USDC ${startUsdc}, KNTQ ${startKntq}`);

  // ---- context the page shows ----
  let ctx = await L.readSwapContext(pub, USER);
  log(`HYPE ≈ $${ctx.hypeUsd.toFixed(4)} (USDC/HYPE pool), ${ctx.kntqPerHype.toFixed(4)} KNTQ/HYPE; reserve ${H(ctx.reserve)}; max ${H(ctx.max)}; maxFee ${ctx.fees.maxFeePerGas} wei`);
  check('reserve == $8 +3% + LP-flow gas budget, well under 1 HYPE', ctx.reserve > L.hypeReserveWei(ctx.usdcPerHypeE6, 8.24) && ctx.reserve < 10n ** 18n / 5n &&Number(ctx.usdcPerHypeE6 * ctx.reserve / 10n ** 18n) / 1e6 >= 8, `${H(ctx.reserve)} ≈ $${(Number(ctx.usdcPerHypeE6 * ctx.reserve / 10n ** 18n) / 1e6).toFixed(2)}`);
  check('max == balance - reserve - gas buffer', ctx.max === START_HYPE - ctx.reserve - ctx.gasBuffer);

  // ---- refusals ----
  console.log('-- refusals --');
  const refused = async (amountIn) => L.planHypeSwap(pub, { out: 'USDC', amountIn, account: USER, nowSec: await nowSec() }).then(() => null, (e) => e.message);
  let r = await refused(START_HYPE - ctx.reserve + 1n);
  check('refuses a swap that dips into the reserve', !!r && /Refused/.test(r), r);
  r = await refused(START_HYPE - ctx.reserve); // leaves exactly the reserve, but no room for gas
  check('refuses a swap that leaves reserve but not gas', !!r && /Refused/.test(r), r);
  r = await L.planHypeSwap(pub, { out: 'USDC', amountIn: 10n ** 15n, account: USER, slippageBps: 501, nowSec: await nowSec() }).then(() => null, (e) => e.message);
  check('refuses slippage > 5%', !!r, r);

  // ---- split for LP (±50% range, the LP flow below) ----
  let lp = await L.readPoolState(pub);
  const range = L.rangeForPreset('pm50', lp.tick);
  const frac = L.lpUsdcValueFraction(lp, range.tickLower, range.tickUpper);
  const spendable = L.maxHypeSwap({ balance: ctx.balance, reserve: ctx.reserve, gasCost: 2n * ctx.gasBuffer }); // two swaps
  const split = L.splitHypeForLp(spendable, frac);
  log(`±50% range USDC value share ${(frac * 100).toFixed(2)}%; split ${H(split.toUsdc)} → USDC, ${H(split.toKntq)} → KNTQ`);
  check('split uses all spendable HYPE', split.toUsdc + split.toKntq === spendable && split.toUsdc > 0n && split.toKntq > 0n);

  // ---- swaps: quote (revert trick) -> plan -> simulate -> send, exactly as the page ----
  console.log('-- swaps --');
  const sendPage = async (req) => {
    // identical to app.js sendTx: simulate with ...req.tx, then write the simulated request
    const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER, ...req.tx });
    const hash = await wallet.writeContract({ ...request, account: USER, chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`reverted ${hash}`);
    return rc;
  };
  const QUOTER = getAddress('0x379f556c5a748bd7cc9baf0f7a344094ac1814f5'); // Uniswap V4Quoter on Elysium (cross-check only)
  const QABI = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);
  for (const [out, amountIn] of [['USDC', split.toUsdc], ['KNTQ', split.toKntq]]) {
    const token = L.SWAP_POOLS[out].out;
    const roQuote = await L.quoteHypeSwap(pub, { out, amountIn }); // read-only (placeholder sender)
    const plan = await L.planHypeSwap(pub, { out, amountIn, account: USER, slippageBps: 100, nowSec: await nowSec() });
    check(`${out}: user quote == read-only quote`, plan.quote === roQuote, `${L.fmtAmount(plan.quote, token.decimals, 6)} ${out}`);
    try {
      const { result } = await pub.simulateContract({ address: QUOTER, abi: QABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: L.SWAP_POOLS[out].key, zeroForOne: true, exactAmount: amountIn, hookData: '0x' }] });
      check(`${out}: revert-trick quote == Uniswap V4Quoter`, result[0] === plan.quote, `${result[0]}`);
    } catch (e) {
      log(`V4Quoter cross-check unavailable: ${e.shortMessage || e.message}`);
    }
    log(`${out}: in ${H(amountIn)} quote ${L.fmtAmount(plan.quote, token.decimals, 6)} min ${L.fmtAmount(plan.minOut, token.decimals, 6)} impact ${plan.priceImpactPct.toFixed(4)}% fee ${plan.feePct}% gas est ${plan.gasEstimate} limit ${plan.gasLimit}`);
    check(`${out}: min out == quote - 1%`, plan.minOut === L.withSlippageDown(plan.quote, 100));
    check(`${out}: tx value == amountIn, gas from eth_estimateGas`, plan.req.tx.value === amountIn && plan.req.tx.gas === plan.gasLimit && plan.gasEstimate > 50000n);
    check(`${out}: plan keeps reserve + gas`, plan.balanceAfterMin >= plan.reserve, `after ≥ ${H(plan.balanceAfterMin)}`);
    const hb = await pub.getBalance({ address: USER });
    const tb = await bal(token.address);
    const rc = await sendPage(plan.req);
    const sent = await pub.getTransaction({ hash: rc.transactionHash });
    check(`${out}: broadcast tx carries value == amountIn, gas == planned limit, maxFee == planned`, sent.value === amountIn && sent.gas === plan.gasLimit && sent.maxFeePerGas === plan.req.tx.maxFeePerGas && getAddress(sent.to) === L.UNIVERSAL_ROUTER, `gas ${sent.gas}, value ${sent.value}`);
    const got = (await bal(token.address)) - tb;
    const gasPaid = rc.gasUsed * rc.effectiveGasPrice;
    const spent = hb - (await pub.getBalance({ address: USER }));
    check(`${out}: received == quote (same state)`, got === plan.quote, `${L.fmtAmount(got, token.decimals, 6)} ${out}`);
    check(`${out}: received >= min out`, got >= plan.minOut);
    check(`${out}: parseTokenReceived == balance delta`, L.parseTokenReceived(rc, token.address, USER) === got);
    check(`${out}: HYPE spent == amountIn + gas (nothing stuck in router)`, spent === amountIn + gasPaid, `gas ${H(gasPaid)}, router HYPE ${await pub.getBalance({ address: L.UNIVERSAL_ROUTER })}`);
    check(`${out}: gas paid <= planned max gas cost`, gasPaid <= plan.gasCost);
  }
  ctx = await L.readSwapContext(pub, USER);
  const hypeAfterSwaps = ctx.balance;
  check('after swaps: HYPE >= reserve', hypeAfterSwaps >= ctx.reserve, `${H(hypeAfterSwaps)} (reserve ${H(ctx.reserve)})`);
  check('after swaps: HYPE worth >= $8', Number(ctx.usdcPerHypeE6 * hypeAfterSwaps / 10n ** 18n) / 1e6 >= 8, `≈ $${(Number(ctx.usdcPerHypeE6 * hypeAfterSwaps / 10n ** 18n) / 1e6).toFixed(2)}`);
  const r2 = await refused(ctx.balance - ctx.reserve);
  check('after swaps: a swap leaving no room for gas is refused', !!r2 && /Refused/.test(r2), r2);
  if (ctx.max > 0n) {
    const atMax = await L.planHypeSwap(pub, { out: 'USDC', amountIn: ctx.max, account: USER, nowSec: await nowSec() }).then((p) => p, (e) => e.message);
    check('after swaps: MAX (balance - reserve - gas buffer) plans fine and keeps the reserve', typeof atMax === 'object' && atMax.balanceAfterMin >= ctx.reserve, typeof atMax === 'string' ? atMax : `max ${H(ctx.max)}`);
  }

  // ---- LP flow with the swapped tokens: mint ±50% using as much of both balances as possible, then remove ----
  console.log('-- LP with swapped tokens --');
  const usdc = await bal(L.ADDR.USDC), kntq = await bal(L.ADDR.KNTQ);
  lp = await L.readPoolState(pub);
  const rg = L.rangeForPreset('pm50', lp.tick);
  let plan = L.planMint(lp, rg.tickLower, rg.tickUpper, { amount0: usdc, anchor: 'amount0' }, 100);
  if (plan.amount1 > kntq) plan = L.planMint(lp, rg.tickLower, rg.tickUpper, { amount1: kntq, anchor: 'amount1' }, 100);
  log(`balances ${L.fmtUsdc(usdc, 6)} USDC + ${L.fmtKntq(kntq, 6)} KNTQ; mint ${L.fmtUsdc(plan.amount0, 6)} USDC + ${L.fmtKntq(plan.amount1, 6)} KNTQ`);
  check('mint plan fits both balances', plan.amount0 <= usdc && plan.amount1 <= kntq && plan.liquidity > 0n);
  const used = Math.max(Number(plan.amount0 * 10000n / (usdc || 1n)), Number(plan.amount1 * 10000n / (kntq || 1n))) / 100;
  check('mint uses ≥ 99% of the limiting balance', used >= 99, `${used.toFixed(2)}%`);
  const txs = await L.planMintTxs(pub, USER, plan, { nowSec: await nowSec() });
  let receipt;
  for (const tx of txs) {
    if (tx.kind === 'mint') Object.assign(tx, L.buildMint({ plan, owner: USER, deadline: L.deadlineFromNow(600, await nowSec()) }));
    receipt = await sendPage(tx);
  }
  const tokenId = L.parseMintedTokenId(receipt, USER);
  check('minted ±50% position with swapped tokens', tokenId !== null, `#${tokenId}, txs ${txs.map((t) => t.kind).join(' → ')}`);
  check('pulled == planned exact amounts', usdc - (await bal(L.ADDR.USDC)) === plan.amount0 && kntq - (await bal(L.ADDR.KNTQ)) === plan.amount1);
  const posL = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPositionLiquidity', args: [tokenId] });
  check('position liquidity == planned', posL === plan.liquidity);

  const st = await L.readPoolState(pub);
  const pos = await L.readPosition(pub, tokenId, st);
  const d = L.planDecrease(st, pos, pos.liquidity, 100);
  const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
  await sendPage(L.buildDecrease({ tokenId, liquidity: d.liquidity, amount0Min: d.amount0Min, amount1Min: d.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await nowSec()), burn: true, expected: { ...d.expected, fees: pos.fees } }));
  const g0 = (await bal(L.ADDR.USDC)) - b0, g1 = (await bal(L.ADDR.KNTQ)) - b1;
  const tf = L.toolFeeSplit(pos.fees);
  check('remove 100% + burn: withdrawn == expected principal + 90% of fees (10% tool fee)', g0 === d.expected.amount0 + tf.user0 && g1 === d.expected.amount1 + tf.user1, `${L.fmtUsdc(g0, 6)} USDC + ${L.fmtKntq(g1, 6)} KNTQ`);
  const gone = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [tokenId] }).then(() => false, () => true);
  check('NFT burned', gone);
  const dep = L.usdValue(plan.amount0, plan.amount1, st.sqrtPriceX96), back = L.usdValue(g0, g1, st.sqrtPriceX96);
  check('value back within 1% of deposit', back >= dep * 0.99 && back <= dep * 1.01, `$${dep.toFixed(4)} → $${back.toFixed(4)}`);

  // ---- reverse swap USDC -> HYPE (planUsdcSwap: exact approvals to the router, then the swap) ----
  console.log('-- USDC -> HYPE --');
  {
    const usdcNow = await bal(L.ADDR.USDC);
    const amountIn = usdcNow / 2n;
    let p = await L.planUsdcSwap(pub, { amountIn, account: USER, slippageBps: 100, nowSec: await nowSec() });
    check('USDC->HYPE: approvals planned (exact amount, spender UniversalRouter) before the swap', p.needsApprovals && p.txs.at(-1).kind === 'swap' && p.txs.slice(0, -1).every((t) => (t.kind === 'erc20-approve' ? t.args[1] === amountIn : getAddress(t.args[1]) === L.UNIVERSAL_ROUTER && t.args[2] === amountIn)), p.txs.map((t) => t.kind).join(' → '));
    for (const t of p.txs.slice(0, -1)) await sendPage(t);
    p = await L.planUsdcSwap(pub, { amountIn, account: USER, slippageBps: 100, nowSec: await nowSec() });
    const hb = await pub.getBalance({ address: USER });
    const rc = await sendPage(p.req);
    const got = L.hypeReceivedFromSwap({ balanceBefore: hb, balanceAfter: await pub.getBalance({ address: USER }), receipt: rc });
    check('USDC->HYPE: native HYPE received == quote >= min; USDC paid == amountIn', got === p.quote && got >= p.minOut && usdcNow - (await bal(L.ADDR.USDC)) === amountIn, `${L.fmtUsdc(amountIn, 6)} USDC -> ${H(got)}`);
    check('USDC->HYPE: router keeps no HYPE', (await pub.getBalance({ address: L.UNIVERSAL_ROUTER })) === 0n);
  }

  const finalHype = await pub.getBalance({ address: USER });
  const fctx = await L.readSwapContext(pub, USER);
  const finalUsd = Number(fctx.usdcPerHypeE6 * finalHype / 10n ** 18n) / 1e6;
  check('final HYPE (after swaps + approvals + mint + remove) worth >= $8', finalUsd >= 8, `${H(finalHype)} ≈ $${finalUsd.toFixed(2)}`);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('FAIL: test crashed:', e);
    process.exit(1);
  }
);
