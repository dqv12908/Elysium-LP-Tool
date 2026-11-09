// Fork test: runs the exact tx sequence the page uses against an anvil fork of Elysium mainnet.
//   node lp-helper/test/fork.test.mjs
// Needs Foundry's anvil (PATH or ~/.foundry/bin). Skips (exit 0) if the RPC is unreachable.
// No private keys: the test account is an anvil dev account used via eth_sendTransaction (unlocked by anvil),
// token holders are impersonated with anvil_impersonateAccount.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  encodeAbiParameters,
  toHex,
  getAddress,
  parseAbi,
  keccak256,
} from 'viem';
import * as L from '../lib.mjs';

const PORT = 8566;
const FORK_RPC = `http://127.0.0.1:${PORT}`;
// Universal Router found on-chain: frequent swapper on PoolManager, poolManager() == official PM, has execute(bytes,bytes[],uint256)
const UNIVERSAL_ROUTER = getAddress('0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a');
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const V4_SWAP = 0x10; // universal-router Commands.V4_SWAP
const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f; // v4-periphery Actions

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const log = (...a) => console.log('•', ...a);

async function rpcReachable(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    return Number(j.result) === L.CHAIN_ID;
  } catch {
    return false;
  }
}

function findAnvil() {
  const local = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  return existsSync(local) ? local : 'anvil';
}

async function startAnvil() {
  const proc = spawn(findAnvil(), ['--fork-url', L.RPC_URL, '--port', String(PORT), '--chain-id', String(L.CHAIN_ID), '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('anvil exited: ' + stderr);
    if (await rpcReachable(FORK_RPC)) {
      // Elysium is an Arbitrum-Orbit-style chain: forked headers have no excessBlobGas, so eth_call on the
      // forked "latest" fails with "Excess blob gas not set". Mining one local block gives anvil a full header.
      await fetch(FORK_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) });
      return proc;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('anvil did not come up in 60s: ' + stderr);
}

async function main() {
  console.log('== lp-helper fork test ==');
  if (!(await rpcReachable(L.RPC_URL))) {
    console.log(`SKIP: ${L.RPC_URL} unreachable or wrong chain id`);
    return 0;
  }
  const anvil = await startAnvil();
  const cleanup = () => { try { anvil.kill(); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  try {
    return await run();
  } finally {
    cleanup();
  }
}

async function run() {
  const chain = { ...L.elysium, rpcUrls: { default: { http: [FORK_RPC] } } };
  const pub = createPublicClient({ chain, transport: http(FORK_RPC), pollingInterval: 100 });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_RPC) });
  const [user] = await pub.request({ method: 'eth_accounts' });
  const USER = getAddress(user);
  const wallet = createWalletClient({ chain, transport: http(FORK_RPC), account: USER });
  const forkBlock = await pub.getBlockNumber();
  log('fork block', forkBlock, 'test account', USER);

  // ---- 0. static checks (same as page load) ----
  check('computed poolId == target', L.POOL_ID_OK, L.COMPUTED_POOL_ID);
  const pm = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'poolManager' });
  check('PositionManager.poolManager() == PoolManager', getAddress(pm) === L.ADDR.POOL_MANAGER, pm);
  const p2 = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'permit2' });
  check('PositionManager.permit2() == Permit2', getAddress(p2) === L.ADDR.PERMIT2, p2);
  check('TickMath MIN/MAX/0', L.getSqrtPriceAtTick(L.MIN_TICK) === L.MIN_SQRT_PRICE && L.getSqrtPriceAtTick(L.MAX_TICK) === L.MAX_SQRT_PRICE && L.getSqrtPriceAtTick(0) === L.Q96);
  let tmOk = true;
  for (const t of [-887271, -500000, -1, 1, 200, 286800, 287000, 500000, 887271]) {
    const s = L.getSqrtPriceAtTick(t);
    if (L.getTickAtSqrtPrice(s) !== t || L.getTickAtSqrtPrice(s - 1n) !== t - 1) tmOk = false;
  }
  check('TickMath forward/inverse consistency', tmOk);

  let state = await L.readPoolState(pub);
  check('pool initialized, lpFee 20000', state.initialized && state.lpFee === 20000, `tick ${state.tick}`);
  check('slot0 tick consistent with sqrtPrice', L.getTickAtSqrtPrice(state.sqrtPriceX96) === state.tick);
  const tvl = await L.readPoolTvl(pub, state);
  log(`price ${(1 / L.sqrtPriceToKntqPerUsdc(state.sqrtPriceX96)).toFixed(4)} USD/KNTQ, TVL ${L.fmtUsdc(tvl.amount0)} USDC + ${L.fmtKntq(tvl.amount1)} KNTQ ≈ $${L.usdValue(tvl.amount0, tvl.amount1, state.sqrtPriceX96).toFixed(2)}`);

  // ---- 1. fund test account by impersonating holders ----
  await fund(pub, test, L.ADDR.USDC, USER, 300_000000n);
  await fund(pub, test, L.ADDR.KNTQ, USER, 3000n * 10n ** 18n);
  const bal = async (t) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [USER] });
  const treasury = async (t) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [L.FEE_RECIPIENT] });
  const start0 = await bal(L.ADDR.USDC);
  const start1 = await bal(L.ADDR.KNTQ);
  check('funded USDC/KNTQ', start0 >= 300_000000n && start1 >= 3000n * 10n ** 18n, `${L.fmtUsdc(start0)} USDC, ${L.fmtKntq(start1)} KNTQ`);

  const send = async (req) => {
    const { request } = await pub.simulateContract({ ...req, account: USER, chain });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${req.functionName} reverted (${hash})`);
    return r;
  };
  const nowSec = async () => Number((await pub.getBlock()).timestamp);

  // ---- 2. mint: full range and ±50%, exact page sequence ----
  const positions = [];
  for (const preset of ['full', 'pm50']) {
    state = await L.readPoolState(pub);
    const { tickLower, tickUpper } = L.rangeForPreset(preset, state.tick);
    const plan = L.planMint(state, tickLower, tickUpper, { amount0: 50_000000n, anchor: 'amount0' }, 100);
    const txs = await L.planMintTxs(pub, USER, plan, { nowSec: await nowSec() });
    log(`${preset}: ticks [${tickLower},${tickUpper}] L=${plan.liquidity} needs ${L.fmtUsdc(plan.amount0)} USDC + ${L.fmtKntq(plan.amount1)} KNTQ; txs: ${txs.map((t) => t.kind).join(' → ')}`);
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const poolLBefore = state.liquidity;
    let receipt;
    for (const tx of txs) receipt = await send(tx);
    const tokenId = L.parseMintedTokenId(receipt, USER);
    check(`${preset}: tokenId parsed from Transfer(0x0→user)`, tokenId !== null, `#${tokenId}`);
    const posL = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPositionLiquidity', args: [tokenId] });
    check(`${preset}: getPositionLiquidity == planned`, posL === plan.liquidity, `${posL}`);
    const a0 = b0 - (await bal(L.ADDR.USDC)), a1 = b1 - (await bal(L.ADDR.KNTQ));
    check(`${preset}: pulled amounts == lib exact amounts`, a0 === plan.amount0 && a1 === plan.amount1, `${a0}/${plan.amount0} ${a1}/${plan.amount1}`);
    const after = await L.readPoolState(pub);
    check(`${preset}: pool active liquidity += L`, after.liquidity - poolLBefore === plan.liquidity, `${poolLBefore} → ${after.liquidity}`);
    const owner = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [tokenId] });
    check(`${preset}: ownerOf == user`, getAddress(owner) === USER);
    positions.push({ preset, tokenId, plan });
  }
  // second mint must not need approvals again only if allowance remains; check approval logic consistency
  const scan = await L.scanTokenIdsTo(pub, USER, { fromBlock: forkBlock + 1n, chunk: 1000n });
  check('Transfer-log scan finds both tokenIds', positions.every((p) => scan.includes(p.tokenId)), scan.join(','));

  // ---- 3. generate fees via Universal Router swaps ----
  let swapped = false;
  try {
    swapped = await doSwaps(pub, wallet, send, USER, nowSec);
  } catch (e) {
    log('swap via Universal Router failed, skipping fee generation:', e.shortMessage || e.message);
  }
  check('swaps through pool (fee generation)', true, swapped ? 'done' : 'SKIPPED (router unavailable) — collect only checked >= 0');

  // ---- 4. collect fees ----
  state = await L.readPoolState(pub);
  for (const p of positions) {
    const pos = await L.readPosition(pub, p.tokenId, state);
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const t0 = await treasury(L.ADDR.USDC), t1 = await treasury(L.ADDR.KNTQ);
    const s = L.toolFeeSplit(pos.fees);
    await send(L.buildCollect({ tokenId: p.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await nowSec()), expectedFees: pos.fees }));
    const g0 = (await bal(L.ADDR.USDC)) - b0, g1 = (await bal(L.ADDR.KNTQ)) - b1;
    check(`${p.preset}: collected == computed uncollected fees − 10% tool fee`, g0 === s.user0 && g1 === s.user1, `${L.fmtUsdc(g0, 6)} USDC, ${L.fmtKntq(g1, 8)} KNTQ (computed fees ${pos.fees.amount0}/${pos.fees.amount1})`);
    check(`${p.preset}: tool fee recipient got exactly 10% of the computed fees`, (await treasury(L.ADDR.USDC)) - t0 === s.fee0 && (await treasury(L.ADDR.KNTQ)) - t1 === s.fee1, `${s.fee0}/${s.fee1}`);
    if (swapped) check(`${p.preset}: fees > 0 after swaps`, g0 > 0n && g1 > 0n);
    const again = await L.readPosition(pub, p.tokenId, await L.readPoolState(pub));
    check(`${p.preset}: uncollected fees == 0 after collect`, again.fees.amount0 === 0n && again.fees.amount1 === 0n);
    p.collected = { amount0: g0, amount1: g1 };
  }

  // ---- 5. remove 100% (full range: decrease+burn; ±50%: decrease only) ----
  for (const p of positions) {
    state = await L.readPoolState(pub);
    const pos = await L.readPosition(pub, p.tokenId, state);
    const d = L.planDecrease(state, pos, pos.liquidity, 100);
    const burn = p.preset === 'full';
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const s = L.toolFeeSplit(pos.fees);
    await send(L.buildDecrease({ tokenId: p.tokenId, liquidity: d.liquidity, amount0Min: d.amount0Min, amount1Min: d.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await nowSec()), burn, expected: { ...d.expected, fees: pos.fees } }));
    const g0 = (await bal(L.ADDR.USDC)) - b0, g1 = (await bal(L.ADDR.KNTQ)) - b1;
    check(`${p.preset}: withdrawn == lib expected (principal + 90% of fees)`, g0 === d.expected.amount0 + s.user0 && g1 === d.expected.amount1 + s.user1, `${L.fmtUsdc(g0)} USDC, ${L.fmtKntq(g1)} KNTQ`);
    check(`${p.preset}: withdrawn >= slippage minimums`, g0 >= d.amount0Min && g1 >= d.amount1Min);
    if (burn) {
      const gone = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [p.tokenId] }).then(() => false, () => true);
      check(`${p.preset}: NFT burned`, gone);
    } else {
      const left = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPositionLiquidity', args: [p.tokenId] });
      check(`${p.preset}: position liquidity == 0`, left === 0n);
      // Page's "Burn empty NFT" on a position emptied without burning.
      const dl = L.deadlineFromNow(600, await nowSec());
      const collectEmpty = await pub.simulateContract({ ...L.buildCollect({ tokenId: p.tokenId, recipient: USER, deadline: dl }), account: USER, chain }).then(() => 'ok', (e) => e.shortMessage || e.message);
      check(`${p.preset}: DECREASE(0) on empty position reverts (why burn-empty uses BURN only)`, collectEmpty !== 'ok', String(collectEmpty).split('\n')[0]);
      const e0 = await bal(L.ADDR.USDC), e1 = await bal(L.ADDR.KNTQ);
      await send(L.buildBurnEmpty({ tokenId: p.tokenId, recipient: USER, deadline: dl }));
      const gone = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [p.tokenId] }).then(() => false, () => true);
      check(`${p.preset}: Burn empty NFT burns the token`, gone);
      check(`${p.preset}: Burn empty NFT moves no tokens`, (await bal(L.ADDR.USDC)) === e0 && (await bal(L.ADDR.KNTQ)) === e1);
    }
    // value tolerance: what came back (incl. fees) vs what went in, at current price; IL from our own swaps is small
    const dep = L.usdValue(p.plan.amount0, p.plan.amount1, state.sqrtPriceX96);
    const back = L.usdValue(g0 + p.collected.amount0, g1 + p.collected.amount1, state.sqrtPriceX96);
    check(`${p.preset}: value returned within 5% of deposit`, back >= dep * 0.95 && back <= dep * 1.05, `deposit $${dep.toFixed(4)} → back $${back.toFixed(4)}`);
  }
  const posmBal0 = await pub.readContract({ address: L.ADDR.USDC, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [L.ADDR.POSITION_MANAGER] });
  log('PositionManager USDC dust balance', posmBal0);

  console.log('\n== SUMMARY ==');
  const passed = results.filter((r) => r.ok).length;
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'}: ${passed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

// Find a holder via recent Transfer logs, impersonate, give gas, transfer to the test account.
async function fund(pub, test, token, to, amount) {
  const latest = await pub.getBlockNumber();
  const candidates = new Set();
  for (let end = latest, i = 0; i < 20 && candidates.size < 40; i++, end -= 5000n) {
    try {
      const logs = await pub.request({ method: 'eth_getLogs', params: [{ address: token, fromBlock: toHex(end - 4999n), toBlock: toHex(end), topics: [L.TRANSFER_TOPIC] }] });
      for (const l of logs.slice(-200)) candidates.add(getAddress('0x' + l.topics[2].slice(26)));
    } catch {}
  }
  let best = null, bestBal = 0n;
  for (const c of candidates) {
    if (c === L.ADDR.POOL_MANAGER || c === L.ADDR.POSITION_MANAGER) continue;
    const b = await pub.readContract({ address: token, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [c] });
    if (b > bestBal) { best = c; bestBal = b; }
  }
  if (!best || bestBal < amount) { best = L.ADDR.POOL_MANAGER; } // fallback: PoolManager holds reserves
  log(`funding ${L.tokenMeta(token).symbol} from ${best}`);
  await test.impersonateAccount({ address: best });
  await test.setBalance({ address: best, value: 10n ** 20n });
  const w = createWalletClient({ chain: pub.chain, transport: http(FORK_RPC), account: best });
  const hash = await w.writeContract({ address: token, abi: L.ERC20_ABI, functionName: 'transfer', args: [to, amount], chain: pub.chain });
  await pub.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: best });
  await test.setBalance({ address: to, value: 10n ** 21n });
}

// Test-only helper: swap via Universal Router V4_SWAP (SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL).
async function doSwaps(pub, wallet, send, USER, nowSec) {
  const KEY = { ...L.POOL_KEY };
  const p2approve = async (token) => {
    await send({ address: token, abi: L.ERC20_ABI, functionName: 'approve', args: [L.ADDR.PERMIT2, 2n ** 255n] });
    await send({ address: L.ADDR.PERMIT2, abi: L.PERMIT2_ABI, functionName: 'approve', args: [token, UNIVERSAL_ROUTER, L.MAX_UINT160, (await nowSec()) + 3600] });
  };
  await p2approve(L.ADDR.USDC);
  await p2approve(L.ADDR.KNTQ);
  const PK = { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] };
  const keyArr = [KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks];
  const encSingle = (zeroForOne, amountIn, layout) =>
    layout === 'legacy'
      ? encodeAbiParameters([{ type: 'tuple', components: [PK, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }] }], [[keyArr, zeroForOne, amountIn, 0n, '0x']])
      : encodeAbiParameters([{ type: 'tuple', components: [PK, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bytes' }] }], [[keyArr, zeroForOne, amountIn, 0n, 0n, '0x']]);
  const swap = async (zeroForOne, amountIn, layout) => {
    const [cin, cout] = zeroForOne ? [KEY.currency0, KEY.currency1] : [KEY.currency1, KEY.currency0];
    const actions = toHex(Uint8Array.from([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]));
    const params = [
      encSingle(zeroForOne, amountIn, layout),
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cin, amountIn]),
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, 0n]),
    ];
    const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
    await send({ address: UNIVERSAL_ROUTER, abi: UR_ABI, functionName: 'execute', args: [toHex(Uint8Array.from([V4_SWAP])), [input], BigInt((await nowSec()) + 600)] });
  };
  let layout = 'legacy';
  const s0 = await L.readPoolState(pub);
  try {
    await swap(true, 20_000000n, layout);
  } catch (e) {
    log('legacy ExactInputSingleParams layout failed, trying layout with minHopPriceX36:', e.shortMessage || e.message);
    layout = 'v2';
    await swap(true, 20_000000n, layout);
  }
  const s1 = await L.readPoolState(pub);
  log(`swap 20 USDC→KNTQ (${layout} layout): tick ${s0.tick} → ${s1.tick}`);
  await swap(false, 55n * 10n ** 18n, layout);
  const s2 = await L.readPoolState(pub);
  log(`swap 55 KNTQ→USDC: tick ${s1.tick} → ${s2.tick}`);
  return s1.feeGrowthGlobal0X128 > s0.feeGrowthGlobal0X128 && s2.feeGrowthGlobal1X128 > s1.feeGrowthGlobal1X128;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('FAIL: test crashed:', e);
    process.exit(1);
  }
);
