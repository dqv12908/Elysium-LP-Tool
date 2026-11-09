// Migration fork test: move a KNTQ/USDC 2% position into the official KNTQ/HYPE 0.8% pool with the EXACT lib builders
// the page's "Move position" panel uses, on an anvil fork of Elysium mainnet (port 8570). Self-contained:
//   node test/migrate.test.mjs
// Setup: an anvil dev account is funded with USDC + KNTQ from impersonated real token holders (fork.test.mjs pattern),
// mints its OWN full-range KNTQ/USDC position with the page builders, a second dev account trades through the pool
// so the position earns fees, and the user's HYPE is set to a small, realistic amount (reserve + 0.3 HYPE), so every
// later tx's gas really comes out of it. No private keys anywhere.
//   (a) Remove 100% + burn                 -> USDC + KNTQ principal + 90% of the fees to the user, 10% tool fee
//   (b) USDC -> HYPE (UniversalRouter)     -> approvals (exact) + swap; native HYPE to the user
//   (c) mint full range in KNTQ/HYPE 0.8%  -> HYPE = only what the swap brought (reserve rule), + all KNTQ;
//                                              msg.value = amount0Max, SWEEP returns the unused HYPE
// Then: a trader makes fees, collect (native HYPE arrives), remove 100% + burn, then the same for a ±50% range.
// Needs Foundry's anvil (PATH or ~/.foundry/bin). Skips (exit 0) if the RPC is unreachable.

import { getAddress, parseAbi, decodeAbiParameters, formatUnits } from 'viem';
import * as L from '../lib.mjs';
import { reachable, startAnvil, forkClients, fundFromHolders, makeTrader, mintLikePage } from './fork-helpers.mjs';

const PORT = 8570;
const SLIP = 50; // the panel's default migration slippage, 0.5%
const QUOTER = getAddress('0x379f556c5a748bd7cc9baf0f7a344094ac1814f5'); // Uniswap V4Quoter (cross-check only)
const QABI = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);

let failed = 0, total = 0;
const check = (name, ok, detail = '') => { total++; if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const log = (...a) => console.log('•', ...a);
const H = (x) => `${L.fmtAmount(x, 18, 6)} HYPE`;
const U = (x) => `${L.fmtAmount(x, 6, 6)} USDC`;
const K = (x) => `${L.fmtAmount(x, 18, 6)} KNTQ`;

function staticChecks() {
  console.log('-- static --');
  check('both LP pool ids recomputed client-side match', L.LP_POOL_IDS_OK && L.POOL_ID_OK);
  const hp = L.LP_POOLS.HYPE;
  check('HYPE LP pool: key == SWAP_POOLS.KNTQ.key (native 0x0 / KNTQ, fee 8000, spacing 120, no hooks), id 0xd210…3472',
    hp.key === L.SWAP_POOLS.KNTQ.key && hp.key.currency0 === L.ZERO_ADDRESS && hp.key.currency1 === L.ADDR.KNTQ && hp.key.fee === 8000 && hp.key.tickSpacing === 120 && hp.key.hooks === L.ZERO_ADDRESS && hp.poolId === '0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472');
  check('LP_POOLS frozen', Object.isFrozen(L.LP_POOLS) && Object.isFrozen(L.LP_POOLS.HYPE) && Object.isFrozen(L.LP_POOLS.HYPE.key));
  check('assertLpPool refuses unknown pool', (() => { try { L.assertLpPool('WETH'); return false; } catch { return true; } })());
  const u = L.usableTicks('HYPE');
  check('HYPE pool usable ticks ±887160 (spacing 120)', u.min === -887160 && u.max === 887160);
  let ok = true;
  // realistic ticks (the float price path is not meant for absurd prices near MIN/MAX_TICK, same as the USDC pool)
  for (const t of [53258, 53266, 40000, 70000, -53258, 0, 120, -121, 119])
    for (const p of ['pm20', 'pm50', 'pm80']) {
      const r = L.rangeForPreset(p, t, {}, 'HYPE');
      if (r.tickLower % 120 || r.tickUpper % 120 || !(r.tickLower <= t && t < r.tickUpper)) { ok = false; log('bad range', p, t, r); }
    }
  check('HYPE pool presets aligned to 120 and contain the current tick', ok);
  check('validateTicks refuses spacing-200 ticks in the HYPE pool (e.g. 200)', (() => { try { L.validateTicks(-200, 200, 'HYPE'); return false; } catch { return true; } })());
  const owner = '0x000000000000000000000000000000000000dEaD';
  const plan = { pool: 'HYPE', tickLower: -120, tickUpper: 120, liquidity: 5n, amount0: 6n, amount1: 7n, amount0Max: 9n, amount1Max: 8n };
  const m = L.buildMint({ plan, owner, deadline: 1n });
  const [actHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], m.args[0]);
  const sw = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], params[2]);
  const sp = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], params[1]);
  check('native mint: actions MINT_POSITION 0x02, SETTLE_PAIR 0x0d, SWEEP 0x14; tx value == amount0Max', actHex === '0x020d14' && m.tx.value === 9n && L.txValueAllowed(m));
  check('native mint: SETTLE_PAIR(0x0, KNTQ), SWEEP(0x0 native, owner)', sp[0] === L.ZERO_ADDRESS && getAddress(sp[1]) === L.ADDR.KNTQ && sw[0] === L.ZERO_ADDRESS && getAddress(sw[1]) === owner);
  check('txValueAllowed refuses value != amount0Max, and value on a USDC-pool mint', !L.txValueAllowed({ ...m, tx: { value: 10n } }) && !L.txValueAllowed({ ...L.buildMint({ plan: { ...plan, pool: 'USDC', tickLower: -200, tickUpper: 200 }, owner, deadline: 1n }), tx: { value: 1n } }));
  const s = L.buildSwapUsdcToHype({ amountIn: 5n, minAmountOut: 1n, recipient: owner, deadline: 1n });
  const [cmds, inputs] = s.args;
  const [a2, p2] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]);
  const PK = { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] };
  const [single] = decodeAbiParameters([{ type: 'tuple', components: [PK, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bytes' }] }], p2[0]);
  const settle = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], p2[1]);
  const take = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], p2[2]);
  check('USDC->HYPE: commands [V4_SWAP], actions 06 0c 0f, zeroForOne=false on the HYPE/USDC 0.3% key, no tx value',
    cmds === '0x10' && a2 === '0x060c0f' && single[1] === false && single[0][0] === L.ZERO_ADDRESS && getAddress(single[0][1]) === L.ADDR.USDC && single[0][2] === 3000 && single[0][3] === 60 && s.tx === undefined);
  check('USDC->HYPE: SETTLE_ALL(USDC, amountIn), TAKE_ALL(native, minOut)', getAddress(settle[0]) === L.ADDR.USDC && settle[1] === 5n && take[0] === L.ZERO_ADDRESS && take[1] === 1n);
  check('Permit2 approve refuses an unknown spender', (() => { try { L.buildPermit2Approve(L.ADDR.USDC, 1n, 1, '0x000000000000000000000000000000000000dEaD'); return false; } catch { return true; } })());
}

async function main() {
  console.log('== lp-helper migrate (KNTQ/USDC 2% -> KNTQ/HYPE 0.8%) fork test ==');
  staticChecks();
  if (!(await reachable(L.RPC_URL))) { console.log('SKIP fork part: RPC unreachable'); return summary(); }
  const { proc, url } = await startAnvil(PORT);
  process.on('SIGINT', () => { try { proc.kill(); } catch {} process.exit(130); });
  try { await fork(url); } finally { try { proc.kill(); } catch {} }
  return summary();
}
function summary() { console.log(`\n== SUMMARY ==\n${failed === 0 ? 'PASS' : 'FAIL'}: ${total - failed}/${total} checks passed`); return failed === 0 ? 0 : 1; }

async function fork(url) {
  console.log('-- fork', url, '--');
  const { chain, pub, test, walletOf } = forkClients(url);
  const accts = (await pub.request({ method: 'eth_accounts' })).map((a) => getAddress(a));
  const USER = accts[3]; // anvil dev account (unlocked), funded below
  const trader = makeTrader(pub, test, url, accts[0]);
  await trader.ready();
  const wallet = walletOf(USER);
  const latestTs = async () => Number((await pub.getBlock()).timestamp);
  const bal = (t, a = USER) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [a] });
  const hype = (a = USER) => pub.getBalance({ address: a });
  const ownerOf = (id) => pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
  const posL = (id) => pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPositionLiquidity', args: [id] });
  const sent = [];
  // == app.js sendTx (minus the dialog): value guard, pool guard, simulate with ...req.tx, write the simulated request ==
  const sendTx = async (req) => {
    if (req.tx && !L.txValueAllowed(req)) throw new Error('Only swaps and native-HYPE mints may carry a transaction value.');
    if (req.pool) L.assertLpPool(req.pool);
    L.assertTargetPool();
    const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER, ...req.tx });
    const fees = req.tx?.maxFeePerGas ? {} : await L.readGasFees(pub);
    const hash = await wallet.writeContract({ ...request, ...fees, account: USER, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('reverted ' + hash);
    const tx = await pub.getTransaction({ hash });
    sent.push({ kind: req.kind, to: tx.to, value: tx.value, gasPaid: r.gasUsed * r.effectiveGasPrice });
    return r;
  };
  const gasOf = (r) => r.gasUsed * r.effectiveGasPrice;

  // ---- setup: fund the dev account from real holders, mint its own KNTQ/USDC position, let it earn fees ----
  await fundFromHolders(pub, test, url, L.ADDR.USDC, [[USER, 150_000000n]]);
  await fundFromHolders(pub, test, url, L.ADDR.KNTQ, [[USER, 2000n * 10n ** 18n]]);
  await test.setBalance({ address: USER, value: 10n ** 19n }); // gas for the setup only; set to a realistic amount below
  const own = await mintLikePage(pub, sendTx, USER, { pool: 'USDC', preset: 'full', amount0: 100_000000n });
  const TOKEN_ID = own.tokenId;
  log(`setup: user ${USER} minted KNTQ/USDC #${TOKEN_ID}: ${U(own.plan.amount0)} + ${K(own.plan.amount1)} (L ${own.plan.liquidity})`);
  const tr = await trader.roundTrip('USDC', 20_000000n);
  check('setup: trader round trip through KNTQ/USDC 2% raised fee growth in both tokens', tr.feesUp);
  sent.length = 0;
  {
    const c = await L.readSwapContext(pub, USER);
    await test.setBalance({ address: USER, value: c.reserve + 3n * 10n ** 17n }); // reserve + 0.3 HYPE
  }

  // ---- start: the user's state ----
  const H0 = await hype(), U0 = await bal(L.ADDR.USDC), K0 = await bal(L.ADDR.KNTQ);
  const posmH0 = await hype(L.ADDR.POSITION_MANAGER), posmK0 = await bal(L.ADDR.KNTQ, L.ADDR.POSITION_MANAGER), posmU0 = await bal(L.ADDR.USDC, L.ADDR.POSITION_MANAGER);
  const urH0 = await hype(L.UNIVERSAL_ROUTER), urU0 = await bal(L.ADDR.USDC, L.UNIVERSAL_ROUTER), urK0 = await bal(L.ADDR.KNTQ, L.UNIVERSAL_ROUTER);
  log(`block ${await pub.getBlockNumber()}; user ${USER}: ${H(H0)}, ${U(U0)}, ${K(K0)}`);
  check(`#${TOKEN_ID} owned by the user`, getAddress(await ownerOf(TOKEN_ID)) === USER);
  let usdcState = await L.readPoolState(pub);
  const pos = await L.readPosition(pub, TOKEN_ID, usdcState, 'USDC');
  check(`#${TOKEN_ID} is a full-range KNTQ/USDC 2% position`, pos.samePool && pos.tickLower === -887200 && pos.tickUpper === 887200, `L ${pos.liquidity}`);
  check(`#${TOKEN_ID} liquidity == minted liquidity; it earned fees in both tokens`, pos.liquidity === own.plan.liquidity && pos.fees.amount0 > 0n && pos.fees.amount1 > 0n, `${pos.liquidity}; fees ${U(pos.fees.amount0)} + ${K(pos.fees.amount1)}`);
  const ctx0 = await L.readSwapContext(pub, USER);
  const posUsdAtSource = L.usdValue(pos.amounts.amount0 + pos.fees.amount0, pos.amounts.amount1 + pos.fees.amount1, usdcState.sqrtPriceX96);
  log(`#${TOKEN_ID}: ${U(pos.amounts.amount0)} + ${K(pos.amounts.amount1)} (+ fees ${U(pos.fees.amount0)} + ${K(pos.fees.amount1)}) ≈ $${posUsdAtSource.toFixed(2)}; HYPE $${ctx0.hypeUsd.toFixed(4)}; reserve ${H(ctx0.reserve)}`);

  // ---- the panel's estimate before step (a) ----
  const est = await L.estimateMigration(pub, { account: USER, pos, usdcToSwap: 0n, kntqAvail: K0, preset: 'full', slippageBps: SLIP });
  log(`estimate: before $${est.before.toFixed(2)} (KNTQ @ HYPE-pool $${est.kntqUsdTarget.toFixed(5)}; @ USDC-pool $${est.kntqUsdSource.toFixed(5)}, gap ${est.priceGapPct.toFixed(2)}%)`);
  log(`estimate: swap ${U(est.usdcIn)} -> ${H(est.quote)} (fee+impact ${est.swapFeeImpactPct.toFixed(3)}%), mint ${H(est.plan.amount0)} + ${K(est.plan.amount1)} ≈ $${est.positionUsd.toFixed(2)}, leftovers $${est.leftoverUsd.toFixed(2)}, extra HYPE ${H(est.extraHype)}, gas ${H(est.gasHype)}; cost $${est.costUsd.toFixed(2)} (${est.costPct.toFixed(3)}%)`);
  check('estimate: cost < 2% of the position value', est.costPct < 2 && est.costPct > 0, `${est.costPct.toFixed(3)}%`);

  // ================= (a) Remove 100% + burn =================
  console.log(`-- (a) remove 100% + burn #${TOKEN_ID} --`);
  usdcState = await L.readPoolState(pub);
  const fa = await L.readPosition(pub, TOKEN_ID, usdcState, 'USDC');
  const da = L.planDecrease(usdcState, fa, fa.liquidity, SLIP);
  const reqA = L.buildDecrease({ tokenId: TOKEN_ID, liquidity: fa.liquidity, amount0Min: da.amount0Min, amount1Min: da.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: true, expected: { ...da.expected, fees: fa.fees }, pool: 'USDC' });
  const feeA = L.toolFeeSplit(fa.fees);
  {
    const [, prm] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], reqA.args[0]);
    const takes = prm.slice(1, 3).map((x) => decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], x));
    const pair1 = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], prm[3]);
    const pair = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], prm.at(-1));
    const dec0 = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], prm[0]);
    const decL = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], prm[4]);
    check('(a) actions DECREASE(0), TAKE(USDC, FEE_RECIPIENT, 10% fees0), TAKE(KNTQ, FEE_RECIPIENT, 10% fees1), TAKE_PAIR(user), DECREASE(all), BURN, TAKE_PAIR(user); no value',
      reqA.actions.join() === '1,14,14,17,1,3,17' && !reqA.tx && dec0[1] === 0n && decL[1] === fa.liquidity && takes.length === 2 && getAddress(takes[0][0]) === L.ADDR.USDC && getAddress(takes[0][1]) === L.FEE_RECIPIENT && takes[0][2] === feeA.fee0 &&
      getAddress(takes[1][0]) === L.ADDR.KNTQ && getAddress(takes[1][1]) === L.FEE_RECIPIENT && takes[1][2] === feeA.fee1 && getAddress(pair1[2]) === USER && getAddress(pair[2]) === USER && feeA.fee0 > 0n);
  }
  const trU0 = await bal(L.ADDR.USDC, L.FEE_RECIPIENT), trK0 = await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT);
  const hA = await hype();
  const rA = await sendTx(reqA);
  const gotU = (await bal(L.ADDR.USDC)) - U0, gotK = (await bal(L.ADDR.KNTQ)) - K0;
  check('(a) received == expected principal + 90% of the fees, >= mins', gotU === da.expected.amount0 + feeA.user0 && gotK === da.expected.amount1 + feeA.user1 && gotU >= da.amount0Min && gotK >= da.amount1Min, `${U(gotU)} + ${K(gotK)}`);
  check('(a) fee recipient received exactly 10% of the earned fees (tool fee), nothing of the principal', (await bal(L.ADDR.USDC, L.FEE_RECIPIENT)) - trU0 === feeA.fee0 && (await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT)) - trK0 === feeA.fee1, `${U(feeA.fee0)} + ${K(feeA.fee1)}`);
  check(`(a) NFT #${TOKEN_ID} burned`, (await ownerOf(TOKEN_ID)) === null);
  check('(a) HYPE spent == gas only', hA - (await hype()) === gasOf(rA), H(gasOf(rA)));

  // ================= (b) USDC -> HYPE =================
  console.log('-- (b) swap the received USDC -> HYPE --');
  const usdcIn = gotU; // only the USDC (a) returned; the ~50 USDC already in the wallet stays
  let pb = await L.planUsdcSwap(pub, { amountIn: usdcIn, account: USER, slippageBps: SLIP, nowSec: await latestTs() });
  log(`(b) plan: ${U(usdcIn)} -> quote ${H(pb.quote)} min ${H(pb.minOut)} impact ${pb.priceImpactPct.toFixed(4)}% fee ${pb.feePct}%; txs ${pb.txs.map((t) => t.kind).join(' → ')}`);
  try {
    const { result } = await pub.simulateContract({ address: QUOTER, abi: QABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: L.SWAP_POOLS.USDC.key, zeroForOne: false, exactAmount: usdcIn, hookData: '0x' }] });
    check('(b) revert-trick quote == Uniswap V4Quoter (zeroForOne=false)', result[0] === pb.quote, `${result[0]}`);
  } catch (e) { log('V4Quoter cross-check unavailable:', e.shortMessage || e.message); }
  check('(b) read-only quote (placeholder sender, no USDC) == user quote', (await L.quoteUsdcToHype(pub, { amountIn: usdcIn })) === pb.quote);
  for (const t of pb.txs.filter((x) => x.kind !== 'swap')) {
    if (t.kind === 'erc20-approve') check('(b) USDC.approve(Permit2, exact amountIn)', t.address === L.ADDR.USDC && getAddress(t.args[0]) === L.ADDR.PERMIT2 && t.args[1] === usdcIn);
    else check('(b) Permit2.approve(USDC, UniversalRouter, exact amountIn, now+30min)', t.address === L.ADDR.PERMIT2 && getAddress(t.args[0]) === L.ADDR.USDC && getAddress(t.args[1]) === L.UNIVERSAL_ROUTER && t.args[2] === usdcIn);
    await sendTx(t);
  }
  pb = await L.planUsdcSwap(pub, { amountIn: usdcIn, account: USER, slippageBps: SLIP, nowSec: await latestTs() }); // after approvals: re-quote + exact gas
  check('(b) after approvals the re-plan is just the swap, gas-estimated, no value', pb.txs.length === 1 && pb.req.tx.gas === pb.gasLimit && pb.req.tx.value === undefined && pb.gasEstimate > 50000n);
  const hB = await hype(), uB = await bal(L.ADDR.USDC);
  const rB = await sendTx(pb.req);
  const hypeReceived = L.hypeReceivedFromSwap({ balanceBefore: hB, balanceAfter: await hype(), receipt: rB });
  check('(b) native HYPE received == quote >= min', hypeReceived === pb.quote && hypeReceived >= pb.minOut, H(hypeReceived));
  check('(b) USDC paid == amountIn exactly', uB - (await bal(L.ADDR.USDC)) === usdcIn);
  check('(b) leftover approvals 0 (ERC20->Permit2 and Permit2->router)', await (async () => { const a = await L.readAllowances(pub, USER, L.ADDR.USDC, L.UNIVERSAL_ROUTER); return a.p2.amount === 0n && a.erc20Allowance < usdcIn; })());
  check('(b) router holds no HYPE / USDC', (await hype(L.UNIVERSAL_ROUTER)) === urH0 && (await bal(L.ADDR.USDC, L.UNIVERSAL_ROUTER)) === urU0);

  // ================= (c) mint full range in KNTQ/HYPE 0.8% =================
  console.log('-- (c) mint full range in KNTQ/HYPE 0.8% --');
  const fullPos = await mintHype('full', hypeReceived);
  check('(c) HYPE in the position <= HYPE the swap brought (the reserve is never deposited)', fullPos.plan.amount0Max <= hypeReceived);

  // ---- value migrated ----
  {
    const ctx = await L.readSwapContext(pub, USER);
    const hs = ctx.pools.KNTQ;
    const kUsd = L.usdPerKntqInPool('HYPE', hs.sqrtPriceX96, ctx.hypeUsd);
    const toUsd = (u, k, h) => Number(u) / 1e6 + (Number(k) / 1e18) * kUsd + (Number(h) / 1e18) * ctx.hypeUsd;
    // Whole account (wallet + position) before and after, at ONE set of prices (KNTQ priced in the target pool).
    const posNow = await L.readPosition(pub, fullPos.tokenId, hs, 'HYPE');
    const v0 = toUsd(U0 + pos.amounts.amount0 + pos.fees.amount0, K0 + pos.amounts.amount1 + pos.fees.amount1, H0);
    const v1 = toUsd(await bal(L.ADDR.USDC), (await bal(L.ADDR.KNTQ)) + posNow.amounts.amount1, (await hype()) + posNow.amounts.amount0);
    const moved = toUsd(pos.amounts.amount0 + pos.fees.amount0, pos.amounts.amount1 + pos.fees.amount1, 0n);
    const lossPct = ((v0 - v1) / moved) * 100;
    log(`value: account $${v0.toFixed(4)} -> $${v1.toFixed(4)}; moved $${moved.toFixed(2)}; realized cost $${(v0 - v1).toFixed(4)} (${lossPct.toFixed(3)}%); estimate ${est.costPct.toFixed(3)}%`);
    check('value migrated: realized cost (swap fee + impact + gas) < 2%', lossPct >= 0 && lossPct < 2, `${lossPct.toFixed(3)}%`);
    check('realized cost within 0.25 pp of the panel estimate', Math.abs(lossPct - est.costPct) < 0.25, `${lossPct.toFixed(3)}% vs ${est.costPct.toFixed(3)}%`);
    const newPosUsd = L.poolUsdValue('HYPE', posNow.amounts.amount0, posNow.amounts.amount1, hs.sqrtPriceX96, ctx.hypeUsd);
    const mixed = ((posUsdAtSource - newPosUsd) / posUsdAtSource) * 100;
    // Informational only: this mixes two different market prices for KNTQ (the pools' gap moves on its own, ~1–1.5%)
    // and leaves out the leftovers, so it is a mark-to-market difference, not a migration cost.
    log(`info, marked to each pool's own KNTQ price: #${TOKEN_ID} $${posUsdAtSource.toFixed(2)} -> new position $${newPosUsd.toFixed(2)} (${mixed.toFixed(3)}%, incl. the ${est.priceGapPct.toFixed(2)}% KNTQ price gap between the pools and the leftovers)`);
    const kntqMoved = Number(formatUnits(pos.amounts.amount1 + pos.fees.amount1, 18));
    log(`info: of that, the KNTQ price gap alone is $${(kntqMoved * (est.kntqUsdSource - kUsd)).toFixed(2)} (${kntqMoved.toFixed(2)} KNTQ × ($${est.kntqUsdSource.toFixed(5)} − $${kUsd.toFixed(5)}))`);
    const hNow = await hype();
    check('after migration: HYPE >= reserve and worth >= $8 (on-chain HYPE price)', hNow >= ctx.reserve && (Number(ctx.usdcPerHypeE6 * hNow / 10n ** 18n) / 1e6) >= 8, `${H(hNow)} ≈ $${(Number(ctx.usdcPerHypeE6 * hNow / 10n ** 18n) / 1e6).toFixed(2)}`);
    check('after migration: user HYPE >= start HYPE - gas (reserve untouched)', hNow + sent.reduce((s, t) => s + t.gasPaid, 0n) >= H0, `start ${H(H0)} now ${H(hNow)}`);
  }
  await noFundsParked('after migration');

  // ---- fees -> collect (native HYPE arrives) -> remove 100% + burn ----
  await traderSwaps();
  await collectAndRemove(fullPos, true);

  // ================= ±50% in the HYPE pool with the returned funds =================
  console.log('-- ±50% range in KNTQ/HYPE 0.8% --');
  const pm50 = await mintHype('pm50', null);
  await traderSwaps();
  await collectAndRemove(pm50, false);

  // ---- refusals ----
  console.log('-- refusals --');
  {
    const ctx = await L.readSwapContext(pub, USER);
    const hs = ctx.pools.KNTQ;
    const r = L.rangeForPreset('full', hs.tick, {}, 'HYPE');
    // HYPE side = balance - half the reserve: more than balance - reserve - gas allows
    const greedy = L.planMint(hs, r.tickLower, r.tickUpper, { amount0: ctx.balance - ctx.reserve / 2n, anchor: 'amount0' }, SLIP, 'HYPE');
    const msg = await L.planMintTxs(pub, USER, greedy, { nowSec: await latestTs() }).then(() => null, (e) => e.message);
    check('planMintTxs refuses a HYPE amount that dips into the reserve', !!msg && /Refused/.test(msg), msg);
    const g = L.buildMint({ plan: greedy, owner: USER, deadline: L.deadlineFromNow(600, await latestTs()) });
    const msg2 = await L.guardNativeMint(pub, g, USER).then(() => null, (e) => e.message);
    check('guardNativeMint refuses it too', !!msg2 && /Refused/.test(msg2), msg2);
  }

  const fin = await hype();
  const p = (await L.readSwapContext(pub, null)).usdcPerHypeE6;
  check('FINAL HYPE worth >= $8', Number((fin * p) / 10n ** 18n) / 1e6 >= 8, `${H(fin)}`);
  check('every value-carrying tx was a native mint to the PositionManager or a swap to the router', sent.filter((t) => t.value > 0n).every((t) => (t.kind === 'mint' && getAddress(t.to) === L.ADDR.POSITION_MANAGER) || (t.kind === 'swap' && getAddress(t.to) === L.UNIVERSAL_ROUTER)));
  await noFundsParked('end');

  async function traderSwaps() {
    const t = await trader.roundTrip('HYPE', 20n * 10n ** 18n);
    log(`trader: 20 HYPE -> KNTQ -> back to HYPE; fee growth ${t.feesUp ? 'up in both tokens' : 'NOT up'}`);
  }

  // ---------------------------------------------------------------- helpers using the page's builders
  async function mintHype(preset, hypeFromSwap) {
    const ctx = await L.readSwapContext(pub, USER);
    const hs = ctx.pools.KNTQ;
    const range = L.rangeForPreset(preset, hs.tick, {}, 'HYPE');
    const hypeAvail = L.migrationHypeForMint(ctx, hypeFromSwap);
    const kntq = await bal(L.ADDR.KNTQ);
    const plan = L.planMintFromBalances(hs, range.tickLower, range.tickUpper, { avail0: hypeAvail, avail1: kntq }, SLIP, 'HYPE');
    log(`${preset}: ticks [${range.tickLower}, ${range.tickUpper}] (tick ${hs.tick}); HYPE avail ${H(hypeAvail)} (balance ${H(ctx.balance)} - reserve ${H(ctx.reserve)} - gas), KNTQ ${K(kntq)}`);
    log(`${preset}: mint ${H(plan.amount0)} + ${K(plan.amount1)} (max ${H(plan.amount0Max)} + ${K(plan.amount1Max)}); leftovers ${H(plan.leftover0)} + ${K(plan.leftover1)}; limiting ${plan.limiting}`);
    check(`${preset}: ticks aligned to 120 and contain the price`, range.tickLower % 120 === 0 && range.tickUpper % 120 === 0 && range.tickLower <= hs.tick && hs.tick < range.tickUpper);
    check(`${preset}: amountMax fits the available amounts; limiting side leftover <= slippage share`,
      plan.amount0Max <= hypeAvail && plan.amount1Max <= kntq && (plan.limiting === 'amount0' ? plan.leftover0 * 10000n <= hypeAvail * BigInt(SLIP + 1) : plan.leftover1 * 10000n <= kntq * BigInt(SLIP + 1)));
    const txs = await L.planMintTxs(pub, USER, plan, { nowSec: await latestTs() });
    check(`${preset}: txs = KNTQ approvals (if needed) + mint; no HYPE approval`, txs.at(-1).kind === 'mint' && txs.slice(0, -1).every((t) => t.address === L.ADDR.KNTQ || getAddress(t.args[0]) === L.ADDR.KNTQ), txs.map((t) => t.kind).join(' → '));
    let receipt, hBefore, kBefore, posmHBefore;
    for (let i = 0; i < txs.length; i++) {
      if (txs[i].kind === 'mint') {
        const fresh = L.buildMint({ plan, owner: USER, deadline: L.deadlineFromNow(600, await latestTs()) });
        await L.guardNativeMint(pub, fresh, USER);
        Object.assign(txs[i], fresh);
        check(`${preset}: mint tx value == amount0Max, gas pinned by guardNativeMint`, txs[i].tx.value === plan.amount0Max && txs[i].tx.gas > 0n);
        hBefore = await hype(); kBefore = await bal(L.ADDR.KNTQ); posmHBefore = await hype(L.ADDR.POSITION_MANAGER);
      }
      receipt = await sendTx(txs[i]);
    }
    const tokenId = L.parseMintedTokenId(receipt, USER);
    check(`${preset}: minted, tokenId parsed`, tokenId !== null, `#${tokenId}`);
    const [key] = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPoolAndPositionInfo', args: [tokenId] });
    check(`${preset}: position is in pool 0xd210…3472`, L.lpPoolOfKey(key) === 'HYPE' && L.poolIdOf({ ...key, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing) }) === L.LP_POOLS.HYPE.poolId);
    check(`${preset}: owner == user`, getAddress(await ownerOf(tokenId)) === USER);
    check(`${preset}: liquidity == planned`, (await posL(tokenId)) === plan.liquidity, `${plan.liquidity}`);
    const spentH = hBefore - (await hype()) - gasOf(receipt);
    check(`${preset}: HYPE spent == owed amount0 exactly (SWEEP returned the rest of msg.value)`, spentH === plan.amount0, `${H(spentH)} of ${H(plan.amount0Max)} sent`);
    check(`${preset}: KNTQ pulled == owed amount1 exactly`, kBefore - (await bal(L.ADDR.KNTQ)) === plan.amount1);
    check(`${preset}: PositionManager keeps no HYPE`, (await hype(L.ADDR.POSITION_MANAGER)) === posmHBefore && posmHBefore === posmH0);
    const ctx2 = await L.readSwapContext(pub, USER);
    check(`${preset}: HYPE after mint >= reserve (worth >= $8)`, ctx2.balance >= ctx2.reserve, H(ctx2.balance));
    return { preset, tokenId, plan };
  }

  async function collectAndRemove(p, burn) {
    let hs = await L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId);
    const pos = await L.readPosition(pub, p.tokenId, hs, 'HYPE');
    check(`${p.preset}: fees accrued in both tokens`, pos.fees.amount0 > 0n && pos.fees.amount1 > 0n, `${H(pos.fees.amount0)} + ${K(pos.fees.amount1)}`);
    const c = L.buildCollect({ tokenId: p.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: pos.fees, pool: 'HYPE' });
    const tp = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], c.args[0])[1].at(-1));
    check(`${p.preset}: collect TAKE_PAIR(0x0 native, KNTQ, user) last`, c.actions.at(-1) === L.ACTIONS.TAKE_PAIR && tp[0] === L.ZERO_ADDRESS && getAddress(tp[1]) === L.ADDR.KNTQ && getAddress(tp[2]) === USER);
    const sc = L.toolFeeSplit(pos.fees);
    let h = await hype(), k = await bal(L.ADDR.KNTQ), th = await hype(L.FEE_RECIPIENT), tk = await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT);
    let r = await sendTx(c);
    check(`${p.preset}: collect: native HYPE arrives (balance delta + gas == 90% of fees0), KNTQ == 90% of fees1`, (await hype()) - h + gasOf(r) === sc.user0 && (await bal(L.ADDR.KNTQ)) - k === sc.user1);
    check(`${p.preset}: collect: fee recipient got 10% of the fees (native HYPE + KNTQ)`, (await hype(L.FEE_RECIPIENT)) - th === sc.fee0 && (await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT)) - tk === sc.fee1);
    hs = await L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId);
    const fresh = await L.readPosition(pub, p.tokenId, hs, 'HYPE');
    const d = L.planDecrease(hs, fresh, fresh.liquidity, SLIP);
    const sr = L.toolFeeSplit(fresh.fees);
    h = await hype(); k = await bal(L.ADDR.KNTQ); th = await hype(L.FEE_RECIPIENT); tk = await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT);
    r = await sendTx(L.buildDecrease({ tokenId: p.tokenId, liquidity: fresh.liquidity, amount0Min: d.amount0Min, amount1Min: d.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn, expected: { ...d.expected, fees: fresh.fees }, pool: 'HYPE' }));
    const g0 = (await hype()) - h + gasOf(r), g1 = (await bal(L.ADDR.KNTQ)) - k;
    check(`${p.preset}: remove 100%${burn ? ' + burn' : ''}: native HYPE + KNTQ == expected principal + 90% of fees, >= mins`, g0 === d.expected.amount0 + sr.user0 && g1 === d.expected.amount1 + sr.user1 && g0 >= d.amount0Min && g1 >= d.amount1Min, `${H(g0)} + ${K(g1)}`);
    check(`${p.preset}: remove: fee recipient got exactly 10% of the fee part`, (await hype(L.FEE_RECIPIENT)) - th === sr.fee0 && (await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT)) - tk === sr.fee1);
    if (burn) check(`${p.preset}: NFT burned`, (await ownerOf(p.tokenId)) === null);
    else {
      check(`${p.preset}: liquidity 0, NFT still owned`, (await posL(p.tokenId)) === 0n && getAddress(await ownerOf(p.tokenId)) === USER);
      h = await hype(); k = await bal(L.ADDR.KNTQ);
      r = await sendTx(L.buildBurnEmpty({ tokenId: p.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), pool: 'HYPE' }));
      check(`${p.preset}: Burn empty NFT burns it, moves no tokens`, (await ownerOf(p.tokenId)) === null && (await hype()) + gasOf(r) === h && (await bal(L.ADDR.KNTQ)) === k);
    }
    const ctx = await L.readSwapContext(pub, USER);
    check(`${p.preset}: HYPE after remove worth >= $8`, Number((ctx.balance * ctx.usdcPerHypeE6) / 10n ** 18n) / 1e6 >= 8, H(ctx.balance));
  }

  async function noFundsParked(when) {
    check(`${when}: PositionManager holds no extra HYPE / KNTQ / USDC`, (await hype(L.ADDR.POSITION_MANAGER)) === posmH0 && (await bal(L.ADDR.KNTQ, L.ADDR.POSITION_MANAGER)) === posmK0 && (await bal(L.ADDR.USDC, L.ADDR.POSITION_MANAGER)) === posmU0);
    check(`${when}: UniversalRouter holds no extra HYPE / KNTQ / USDC`, (await hype(L.UNIVERSAL_ROUTER)) === urH0 && (await bal(L.ADDR.KNTQ, L.UNIVERSAL_ROUTER)) === urK0 && (await bal(L.ADDR.USDC, L.UNIVERSAL_ROUTER)) === urU0);
  }
}

main().then((c) => process.exit(c), (e) => { console.error('FAIL: crashed:', e.shortMessage || e.message, String(e.stack).split('\n').slice(0, 8).join('\n')); process.exit(1); });
