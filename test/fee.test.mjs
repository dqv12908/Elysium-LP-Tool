// Tool-fee test: 10% of the EARNED LP fees goes to L.FEE_RECIPIENT, only when fees are paid out; never principal.
//   node test/fee.test.mjs
// Static part: toolFeeSplit math, encodeTake refusal of amount 0 (= OPEN_DELTA), and a decode of every builder's
// calldata for many fee values (no TAKE with amount 0, every TAKE -> FEE_RECIPIENT, TAKE_PAIR -> user, last; the fee
// TAKEs sit in a fees-only segment DECREASE(0) -> TAKEs -> TAKE_PAIR before any principal is credited).
// Fork part (anvil fork of Elysium on port 8572), for BOTH the KNTQ/USDC 2% pool and the native KNTQ/HYPE 0.8% pool:
// an anvil dev account is funded with USDC/KNTQ from impersonated holders, mints its own position with the page's
// builders, a second dev account trades through the pool to generate fees, then
//   (a) collect, (a2) collect built from a stale fee read (fees grew before inclusion), (b) partial remove,
//   (c) 100% remove + burn, (d) zero-fee position: no TAKE, treasury delta 0, (e) calldata decode of each tx sent,
//   (r) a remove built from a stale fee read whose fees were collected by another tx first: it REVERTS (the fee is
//       never paid out of the principal) and nothing moves.
// Every balance check is exact to the wei (native HYPE: balance delta + gas).
// Needs Foundry's anvil (PATH or ~/.foundry/bin). Skips the fork part (exit 0) if the RPC is unreachable.

import { getAddress, decodeAbiParameters, decodeFunctionData } from 'viem';
import * as L from '../lib.mjs';
import { reachable, startAnvil, forkClients, fundFromHolders, makeTrader, mintLikePage } from './fork-helpers.mjs';

const PORT = 8572;
const ZERO = '0x0000000000000000000000000000000000000000';
const TREASURY = getAddress('0xd977de5063b91abeae53bc19b56c08b0904b09c3');

let failed = 0, total = 0;
const check = (name, ok, detail = '') => { total++; if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const log = (...a) => console.log('•', ...a);

/** Independent decode of a modifyLiquidities request: [{ action, ...decoded params }]. */
function decodeLp(req) {
  const data = req.args[0];
  const [actHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data);
  const acts = [...Buffer.from(actHex.slice(2), 'hex')];
  return acts.map((a, i) => {
    const p = params[i];
    if (a === 0x0e) { const [currency, recipient, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], p); return { a, currency: getAddress(currency), recipient: getAddress(recipient), amount }; }
    if (a === 0x11) { const [c0, c1, recipient] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], p); return { a, c0: getAddress(c0), c1: getAddress(c1), recipient: getAddress(recipient) }; }
    if (a === 0x01) { const [tokenId, liquidity, min0, min1] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], p); return { a, tokenId, liquidity, min0, min1 }; }
    if (a === 0x03) { const [tokenId] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], p); return { a, tokenId }; }
    return { a };
  });
}
/** (e) structural rules for a payout tx. Returns '' if OK, else the reason. */
function payoutRules(req, user, pool, fees) {
  const P = L.LP_POOLS[pool];
  const d = decodeLp(req);
  const takes = d.filter((x) => x.a === 0x0e);
  const pairs = d.filter((x) => x.a === 0x11);
  const exp = fees ? L.toolFeeSplit(fees) : { fee0: 0n, fee1: 0n };
  if (takes.some((t) => t.amount === 0n)) return 'TAKE with amount 0 (OPEN_DELTA)';
  if (takes.some((t) => t.recipient !== L.FEE_RECIPIENT)) return 'TAKE recipient != FEE_RECIPIENT';
  if (pairs.length < 1 || d.at(-1).a !== 0x11) return 'TAKE_PAIR missing or not last';
  if (pairs.some((p) => p.recipient !== getAddress(user))) return 'TAKE_PAIR recipient != user';
  if (pairs.some((p) => p.c0 !== getAddress(P.key.currency0) || p.c1 !== getAddress(P.key.currency1))) return 'TAKE_PAIR currencies != pool currencies';
  const firstTake = d.findIndex((x) => x.a === 0x0e);
  if (firstTake >= 0) {
    // fees-only segment: [DECREASE(liquidity 0), TAKE…, TAKE_PAIR] at the very start, before any principal is credited
    const lastTake = d.length - 1 - [...d].reverse().findIndex((x) => x.a === 0x0e);
    if (firstTake !== 1 || d[0].a !== 0x01 || d[0].liquidity !== 0n) return 'fee TAKEs not right after a DECREASE_LIQUIDITY(0)';
    if (d.slice(firstTake, lastTake + 1).some((x) => x.a !== 0x0e)) return 'fee TAKEs not contiguous';
    if (d[lastTake + 1]?.a !== 0x11) return 'fee TAKEs not followed by TAKE_PAIR (the guard)';
    const rest = d.slice(lastTake + 2);
    if (req.kind === 'collect' && rest.length) return 'collect has extra actions';
    if (req.kind === 'decrease' && !(rest[0]?.a === 0x01 && rest.at(-1).a === 0x11 && rest.every((x) => [0x01, 0x03, 0x11].includes(x.a)))) return 'principal segment malformed';
  } else if (req.kind === 'decrease' && d.some((x) => x.a === 0x01 && x.liquidity === 0n)) return 'no fee but a DECREASE(0) segment (old shape expected)';
  const sum = (c) => takes.filter((t) => t.currency === getAddress(c)).reduce((s, t) => s + t.amount, 0n);
  if (takes.some((t) => t.currency !== getAddress(P.key.currency0) && t.currency !== getAddress(P.key.currency1))) return 'TAKE currency not in the pool';
  if (sum(P.key.currency0) !== exp.fee0 || sum(P.key.currency1) !== exp.fee1) return `TAKE sums ${sum(P.key.currency0)}/${sum(P.key.currency1)} != fee share ${exp.fee0}/${exp.fee1}`;
  if (takes.length !== (exp.fee0 > 0n ? 1 : 0) + (exp.fee1 > 0n ? 1 : 0)) return 'unexpected TAKE count';
  return '';
}

function staticChecks() {
  console.log('-- static: constants, split math, encoding rules --');
  check('TOOL_FEE_BPS == 1000n (10%)', L.TOOL_FEE_BPS === 1000n);
  check('FEE_RECIPIENT == checksummed 0xd977…09c3', L.FEE_RECIPIENT === TREASURY && L.FEE_RECIPIENT === '0xd977de5063b91AbEAe53Bc19B56c08b0904b09c3');
  check('ACTIONS.TAKE == 0x0e', L.ACTIONS.TAKE === 0x0e);
  let ok = true;
  const vals = [0n, 1n, 9n, 10n, 11n, 19n, 99n, 100n, 101n, 10n ** 6n + 7n, 10n ** 18n + 3n, 2n ** 127n + 9n];
  let seed = 7n;
  for (let i = 0; i < 300; i++) { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); vals.push(seed >> BigInt(i % 60)); }
  for (const a of vals) for (const b of [0n, a, a + 13n]) {
    const s = L.toolFeeSplit({ amount0: a, amount1: b });
    if (s.fee0 !== (a * 1000n) / 10000n || s.fee1 !== (b * 1000n) / 10000n || s.user0 + s.fee0 !== a || s.user1 + s.fee1 !== b || s.fee0 * 10n > a || s.fee1 * 10n > b) { ok = false; log('split', a, b, s); }
  }
  check(`toolFeeSplit: fee = floor(fees*1000/10000), fee + user = fees, fee <= 10% (${vals.length * 3} cases)`, ok);
  check('toolFeeSplit: fees < 10 wei -> fee 0', L.toolFeeSplit({ amount0: 9n, amount1: 1n }).fee0 === 0n && L.toolFeeSplit({ amount0: 9n, amount1: 1n }).fee1 === 0n);
  check('toolFeeSplit refuses negative fees', (() => { try { L.toolFeeSplit({ amount0: -1n, amount1: 0n }); return false; } catch { return true; } })());
  check('encodeTake refuses amount 0 (OPEN_DELTA = take the whole credit)', (() => { try { L.encodeTake(L.ADDR.USDC, L.FEE_RECIPIENT, 0n); return false; } catch { return true; } })());
  const enc = L.encodeTake(L.ADDR.USDC, L.FEE_RECIPIENT, 5n);
  check('encodeTake layout = abi.encode(Currency, address, uint256): 3 words', enc.length === 2 + 3 * 64 && BigInt('0x' + enc.slice(2, 66)) === BigInt(L.ADDR.USDC) && BigInt('0x' + enc.slice(66, 130)) === BigInt(L.FEE_RECIPIENT) && BigInt('0x' + enc.slice(130)) === 5n);

  const user = '0x000000000000000000000000000000000000dEaD';
  let bad = '';
  let n = 0;
  for (const pool of ['USDC', 'HYPE']) {
    for (const a of vals.slice(0, 80)) for (const b of [0n, 5n, a, a * 3n + 11n]) {
      const fees = { amount0: a, amount1: b };
      const reqs = [
        L.buildCollect({ tokenId: 1n, recipient: user, deadline: 1n, expectedFees: fees, pool }),
        L.buildDecrease({ tokenId: 1n, liquidity: 10n, amount0Min: 1n, amount1Min: 1n, recipient: user, deadline: 1n, expected: { amount0: 3n, amount1: 4n, fees }, pool }),
        L.buildDecrease({ tokenId: 1n, liquidity: 10n, amount0Min: 1n, amount1Min: 1n, recipient: user, deadline: 1n, burn: true, expected: { amount0: 3n, amount1: 4n, fees }, pool }),
      ];
      for (const r of reqs) {
        n++;
        const why = payoutRules(r, user, pool, fees);
        if (why && !bad) bad = `${pool} ${r.kind} fees ${a}/${b}: ${why}`;
        if (r.toolFee.fee0 !== L.toolFeeSplit(fees).fee0 || r.toolFee.fee1 !== L.toolFeeSplit(fees).fee1 || r.tx) bad ||= `${pool} ${r.kind}: toolFee object / tx value`;
      }
    }
  }
  check(`(e) ${n} built collect/remove/remove+burn txs: no TAKE amount 0, TAKE -> FEE_RECIPIENT with exactly the fee share, TAKE_PAIR(pool currencies, user) last, no value`, !bad, bad);
  const z = L.buildCollect({ tokenId: 1n, recipient: user, deadline: 1n, expectedFees: { amount0: 0n, amount1: 0n } });
  const zd = L.buildDecrease({ tokenId: 1n, liquidity: 10n, amount0Min: 0n, amount1Min: 0n, recipient: user, deadline: 1n, burn: true, expected: { amount0: 1n, amount1: 1n, fees: { amount0: 9n, amount1: 0n } } });
  check('(d) zero (or < 10 wei) fees: no TAKE at all ([DECREASE, TAKE_PAIR] / [DECREASE, BURN, TAKE_PAIR])', z.actions.join() === '1,17' && zd.actions.join() === '1,3,17');
  const nf = L.buildDecrease({ tokenId: 1n, liquidity: 10n, amount0Min: 0n, amount1Min: 0n, recipient: user, deadline: 1n });
  check('no fee figures given -> no TAKE, preview says no fee is taken', nf.actions.join() === '1,17' && nf.preview.lines.some((l) => /^Tool fee: none/.test(l)));
  const be = L.buildBurnEmpty({ tokenId: 1n, recipient: user, deadline: 1n, pool: 'HYPE' });
  check('buildBurnEmpty: no TAKE (it can never pay fees), preview says tool fee none', be.actions.join() === '3,17' && be.preview.lines.includes('Tool fee: none (no fees are paid out)'));
  const pc = L.buildCollect({ tokenId: 1n, recipient: user, deadline: 1n, expectedFees: { amount0: 1_000000n, amount1: 3n * 10n ** 18n } });
  check('collect preview: "Tool fee (10% of earned fees): 0.1 USDC + 0.3 KNTQ → 0xd977…09c3" and "You receive: 0.9 USDC + 2.7 KNTQ …"',
    pc.preview.lines.includes('Tool fee (10% of earned fees): 0.1 USDC + 0.3 KNTQ → 0xd977…09c3') && pc.preview.lines.some((l) => l.startsWith('You receive: 0.9 USDC + 2.7 KNTQ')), pc.preview.lines.join(' | '));
  const pd = L.buildDecrease({ tokenId: 1n, liquidity: 10n, amount0Min: 0n, amount1Min: 0n, recipient: user, deadline: 1n, burn: true, pool: 'HYPE', expected: { amount0: 10n ** 18n, amount1: 5n * 10n ** 18n, fees: { amount0: 10n ** 17n, amount1: 10n ** 18n } } });
  check('remove preview (HYPE pool): tool fee 0.01 HYPE + 0.1 KNTQ, you receive principal + 90% = 1.09 HYPE + 5.9 KNTQ',
    pd.preview.lines.includes('Tool fee (10% of earned fees): 0.01 HYPE + 0.1 KNTQ → 0xd977…09c3') && pd.preview.lines.some((l) => l.startsWith('You receive: 1.09 HYPE + 5.9 KNTQ')), pd.preview.lines.join(' | '));
  check('mint / swaps carry no tool fee (no TAKE to FEE_RECIPIENT)', (() => {
    const m = L.buildMint({ plan: { pool: 'HYPE', tickLower: -120, tickUpper: 120, liquidity: 1n, amount0: 1n, amount1: 1n, amount0Max: 2n, amount1Max: 2n }, owner: user, deadline: 1n });
    const s1 = L.buildSwapHype({ out: 'KNTQ', amountIn: 5n, minAmountOut: 1n, recipient: user, deadline: 1n });
    const s2 = L.buildSwapUsdcToHype({ amountIn: 5n, minAmountOut: 1n, recipient: user, deadline: 1n });
    const hasFee = (hex) => hex.toLowerCase().includes(L.FEE_RECIPIENT.slice(2).toLowerCase());
    return !m.actions.includes(L.ACTIONS.TAKE) && !hasFee(m.args[0]) && !hasFee(s1.args[1].join('')) && !hasFee(s2.args[1].join(''));
  })());
}

async function main() {
  console.log('== lp-helper tool fee test ==');
  staticChecks();
  if (!(await reachable(L.RPC_URL))) { console.log('SKIP fork part: RPC unreachable'); return summary(); }
  const { proc, url } = await startAnvil(PORT);
  process.on('SIGINT', () => { try { proc.kill(); } catch {} process.exit(130); });
  try { await fork(url); } finally { try { proc.kill(); } catch {} }
  return summary();
}
function summary() { console.log(`\n== SUMMARY ==\n${failed === 0 ? 'PASS' : 'FAIL'}: ${total - failed}/${total} checks passed`); return failed === 0 ? 0 : 1; }

async function fork(url) {
  console.log('\n-- fork', url, '--');
  const { pub, test, walletOf } = forkClients(url);
  const accts = (await pub.request({ method: 'eth_accounts' })).map((a) => getAddress(a));
  const USER = accts[2];
  const trader = makeTrader(pub, test, url, accts[1]);
  await trader.ready();
  const wallet = walletOf(USER);
  const latestTs = async () => Number((await pub.getBlock()).timestamp);
  const bal = (t, a = USER) => (BigInt(t) === 0n ? pub.getBalance({ address: a }) : pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [a] }));
  const ownerOf = (id) => pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
  const gasOf = (r) => r.gasUsed * r.effectiveGasPrice;

  // == app.js sendTx (minus the dialog): value guard, pool guards, simulate with ...req.tx, write the simulated request ==
  const sendTx = async (req) => {
    if (req.tx && !L.txValueAllowed(req)) throw new Error('value not allowed');
    if (req.pool) L.assertLpPool(req.pool);
    L.assertTargetPool();
    const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER, ...req.tx });
    const fees = req.tx?.maxFeePerGas ? {} : await L.readGasFees(pub);
    const hash = await wallet.writeContract({ ...request, ...fees, account: USER, chain: L.elysium });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('reverted ' + hash);
    return r;
  };

  log('user', USER, '(anvil dev account), trader', trader.address, ', fee recipient', L.FEE_RECIPIENT);
  const code = await pub.getCode({ address: L.FEE_RECIPIENT });
  check('FEE_RECIPIENT has no code on Elysium (EOA: native HYPE TAKE cannot be refused by a receive hook)', !code || code === '0x');
  await fundFromHolders(pub, test, url, L.ADDR.USDC, [[USER, 300_000000n]]);
  await fundFromHolders(pub, test, url, L.ADDR.KNTQ, [[USER, 3000n * 10n ** 18n]]);
  await test.setBalance({ address: USER, value: 1000n * 10n ** 18n });
  check('user funded by impersonated holders', (await bal(L.ADDR.USDC)) >= 300_000000n && (await bal(L.ADDR.KNTQ)) >= 3000n * 10n ** 18n);
  const posm0 = [await bal(ZERO, L.ADDR.POSITION_MANAGER), await bal(L.ADDR.USDC, L.ADDR.POSITION_MANAGER), await bal(L.ADDR.KNTQ, L.ADDR.POSITION_MANAGER)];

  for (const pool of ['USDC', 'HYPE']) {
    const P = L.LP_POOLS[pool];
    const c0 = P.key.currency0, c1 = P.key.currency1;
    const S0 = P.token0.symbol;
    const fmt = (x0, x1) => `${L.fmtAmount(x0, P.token0.decimals, 8)} ${S0} + ${L.fmtAmount(x1, 18, 8)} KNTQ`;
    console.log(`\n-- ${P.label} --`);
    const readPos = async (id) => L.readPosition(pub, id, await L.readPoolState(pub, undefined, P.poolId), pool);
    const trade = async () => {
      const t = await trader.roundTrip(pool, pool === 'USDC' ? 20_000000n : 20n * 10n ** 18n);
      if (!t.feesUp) log('warning: fee growth not up in both tokens');
      return t;
    };
    /** Sends a payout request; returns exact deltas of user (native: + gas) and treasury per currency. */
    const payout = async (req) => {
      const u0 = await bal(c0), u1 = await bal(c1), t0 = await bal(c0, TREASURY), t1 = await bal(c1, TREASURY);
      const r = await sendTx(req);
      const g = BigInt(c0) === 0n ? gasOf(r) : 0n;
      return { r, user0: (await bal(c0)) - u0 + g, user1: (await bal(c1)) - u1, tr0: (await bal(c0, TREASURY)) - t0, tr1: (await bal(c1, TREASURY)) - t1 };
    };
    const amount0 = pool === 'USDC' ? 100_000000n : 2n * 10n ** 18n;

    // ---- (d) zero fees: fresh position, collect + remove/burn before any trade ----
    const z = await mintLikePage(pub, sendTx, USER, { pool, preset: 'pm50', amount0 });
    const zp = await readPos(z.tokenId);
    check(`${pool} (d): fresh position has exactly 0 uncollected fees`, zp.fees.amount0 === 0n && zp.fees.amount1 === 0n);
    const zc = L.buildCollect({ tokenId: z.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: zp.fees, pool });
    check(`${pool} (d)/(e): zero-fee collect = [DECREASE(0), TAKE_PAIR(user)], no TAKE`, zc.actions.join() === '1,17' && !payoutRules(zc, USER, pool, zp.fees), payoutRules(zc, USER, pool, zp.fees));
    let d = await payout(zc);
    check(`${pool} (d): zero-fee collect: treasury delta 0, user delta 0 (both currencies)`, d.tr0 === 0n && d.tr1 === 0n && d.user0 === 0n && d.user1 === 0n);
    {
      const st = await L.readPoolState(pub, undefined, P.poolId);
      const fp = await L.readPosition(pub, z.tokenId, st, pool);
      const dd = L.planDecrease(st, fp, fp.liquidity, 100);
      const req = L.buildDecrease({ tokenId: z.tokenId, liquidity: fp.liquidity, amount0Min: dd.amount0Min, amount1Min: dd.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: true, expected: { ...dd.expected, fees: fp.fees }, pool });
      check(`${pool} (d)/(e): zero-fee remove 100% + burn = [DECREASE, BURN, TAKE_PAIR], no TAKE`, req.actions.join() === '1,3,17' && !payoutRules(req, USER, pool, fp.fees));
      d = await payout(req);
      check(`${pool} (d): zero-fee remove: treasury delta 0; user gets 100% of the principal exactly`, d.tr0 === 0n && d.tr1 === 0n && d.user0 === dd.expected.amount0 && d.user1 === dd.expected.amount1, fmt(d.user0, d.user1));
      check(`${pool} (d): NFT burned`, (await ownerOf(z.tokenId)) === null);
    }

    // ---- main position, then fees ----
    const m = await mintLikePage(pub, sendTx, USER, { pool, preset: 'full', amount0 });
    log(`${pool}: minted #${m.tokenId} (${fmt(m.plan.amount0, m.plan.amount1)})`);
    await trade();

    // ---- (a) collect ----
    {
      const fp = await readPos(m.tokenId);
      check(`${pool} (a): fees earned in both tokens`, fp.fees.amount0 > 0n && fp.fees.amount1 > 0n, fmt(fp.fees.amount0, fp.fees.amount1));
      const s = L.toolFeeSplit(fp.fees);
      const req = L.buildCollect({ tokenId: m.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: fp.fees, pool });
      const why = payoutRules(req, USER, pool, fp.fees);
      check(`${pool} (a)/(e): collect = [DECREASE(0), TAKE(${S0}), TAKE(KNTQ), TAKE_PAIR(user)]; TAKEs -> FEE_RECIPIENT, amounts = fee share > 0`, !why && req.actions.join() === '1,14,14,17', why || req.actions.join());
      d = await payout(req);
      check(`${pool} (a): treasury delta == computed fee share exactly (${S0} and KNTQ)`, d.tr0 === s.fee0 && d.tr1 === s.fee1, `${fmt(d.tr0, d.tr1)} vs ${fmt(s.fee0, s.fee1)}`);
      check(`${pool} (a): user delta == fees − fee share exactly${pool === 'HYPE' ? ' (native: balance delta + gas)' : ''}`, d.user0 === fp.fees.amount0 - s.fee0 && d.user1 === fp.fees.amount1 - s.fee1, fmt(d.user0, d.user1));
      if (pool === 'HYPE') check('HYPE (a): TAKE(0x0, FEE_RECIPIENT, fee) delivered NATIVE HYPE to the recipient', d.tr0 === s.fee0 && s.fee0 > 0n);
      const again = await readPos(m.tokenId);
      check(`${pool} (a): nothing left uncollected, liquidity unchanged`, again.fees.amount0 === 0n && again.fees.amount1 === 0n && again.liquidity === m.plan.liquidity);
    }

    // ---- (a2) fees grow between the read and inclusion: the user keeps the extra ----
    await trade();
    {
      const fp = await readPos(m.tokenId);
      const s = L.toolFeeSplit(fp.fees);
      const req = L.buildCollect({ tokenId: m.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: fp.fees, pool });
      await trade(); // more fees accrue after the tx was built
      const actual = (await readPos(m.tokenId)).fees;
      d = await payout(req);
      check(`${pool} (a2): fees grew after the read (${fmt(fp.fees.amount0, fp.fees.amount1)} -> ${fmt(actual.amount0, actual.amount1)})`, actual.amount0 > fp.fees.amount0 && actual.amount1 > fp.fees.amount1);
      check(`${pool} (a2): treasury got exactly 10% of the COMPUTED fees (never more)`, d.tr0 === s.fee0 && d.tr1 === s.fee1);
      check(`${pool} (a2): user got all the rest (actual fees − computed fee share)`, d.user0 === actual.amount0 - s.fee0 && d.user1 === actual.amount1 - s.fee1);
    }

    // ---- (b) partial remove (40%) ----
    await trade();
    {
      const st = await L.readPoolState(pub, undefined, P.poolId);
      const fp = await L.readPosition(pub, m.tokenId, st, pool);
      const liq = (fp.liquidity * 40n) / 100n;
      const dd = L.planDecrease(st, fp, liq, 100);
      const s = L.toolFeeSplit(fp.fees);
      const req = L.buildDecrease({ tokenId: m.tokenId, liquidity: liq, amount0Min: dd.amount0Min, amount1Min: dd.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expected: { ...dd.expected, fees: fp.fees }, pool });
      const why = payoutRules(req, USER, pool, fp.fees);
      check(`${pool} (b)/(e): partial remove = [DECREASE(0), TAKE, TAKE, TAKE_PAIR(user), DECREASE(40%), TAKE_PAIR(user)]`, !why && req.actions.join() === '1,14,14,17,1,17', why || req.actions.join());
      d = await payout(req);
      check(`${pool} (b): treasury == 10% of the fee part only`, d.tr0 === s.fee0 && d.tr1 === s.fee1 && s.fee0 > 0n && s.fee1 > 0n, fmt(d.tr0, d.tr1));
      check(`${pool} (b): user == 100% of the principal + 90% of the fees, exactly`, d.user0 === dd.expected.amount0 + s.user0 && d.user1 === dd.expected.amount1 + s.user1, fmt(d.user0, d.user1));
      check(`${pool} (b): principal part >= slippage mins; liquidity left == 60%`, d.user0 - s.user0 >= dd.amount0Min && d.user1 - s.user1 >= dd.amount1Min && (await readPos(m.tokenId)).liquidity === fp.liquidity - liq);
    }

    // ---- (r) stale remove: fees collected by another tx after the read -> the remove must revert, nothing moves ----
    await trade();
    {
      const st = await L.readPoolState(pub, undefined, P.poolId);
      const fp = await L.readPosition(pub, m.tokenId, st, pool);
      const dd = L.planDecrease(st, fp, fp.liquidity, 100);
      const stale = L.buildDecrease({ tokenId: m.tokenId, liquidity: fp.liquidity, amount0Min: dd.amount0Min, amount1Min: dd.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: true, expected: { ...dd.expected, fees: fp.fees }, pool });
      check(`${pool} (r): stale remove built with fee TAKEs (${fmt(stale.toolFee.fee0, stale.toolFee.fee1)})`, stale.actions.join() === '1,14,14,17,1,3,17');
      // the fees are collected by a separate tx before the stale remove is mined
      await payout(L.buildCollect({ tokenId: m.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: fp.fees, pool }));
      const left = await readPos(m.tokenId);
      check(`${pool} (r): after the separate collect, uncollected fees == 0`, left.fees.amount0 === 0n && left.fees.amount1 === 0n);
      let simErr = null;
      try { await pub.simulateContract({ address: stale.address, abi: stale.abi, functionName: stale.functionName, args: stale.args, account: USER }); } catch (e) { simErr = e; }
      const msg = simErr ? `${simErr.shortMessage || ''} ${simErr.message || ''}` : '';
      check(`${pool} (r): simulation of the stale remove reverts with DeltaNotPositive (fee would exceed the fees credited)`, !!simErr && /DeltaNotPositive/.test(msg), simErr?.shortMessage?.split('\n')[0]);
      // force it on-chain anyway (fixed gas, no simulation): it must revert and move nothing
      const u0 = await bal(c0), u1 = await bal(c1), t0 = await bal(c0, TREASURY), t1 = await bal(c1, TREASURY);
      const hash = await wallet.writeContract({ address: stale.address, abi: stale.abi, functionName: stale.functionName, args: stale.args, account: USER, chain: L.elysium, gas: 2_000_000n, ...(await L.readGasFees(pub)) });
      const r = await pub.waitForTransactionReceipt({ hash });
      const g = BigInt(c0) === 0n ? gasOf(r) : 0n;
      check(`${pool} (r): forced stale remove REVERTS on-chain`, r.status === 'reverted');
      check(`${pool} (r): nothing moved: treasury delta 0, user delta 0 (native: only gas), principal still in the position, NFT kept`,
        (await bal(c0, TREASURY)) === t0 && (await bal(c1, TREASURY)) === t1 && (await bal(c0)) + g === u0 && (await bal(c1)) === u1 &&
        (await readPos(m.tokenId)).liquidity === fp.liquidity && getAddress(await ownerOf(m.tokenId)) === USER);
    }

    // ---- (c) 100% remove + burn ----
    await trade();
    {
      const st = await L.readPoolState(pub, undefined, P.poolId);
      const fp = await L.readPosition(pub, m.tokenId, st, pool);
      const dd = L.planDecrease(st, fp, fp.liquidity, 100);
      const s = L.toolFeeSplit(fp.fees);
      const req = L.buildDecrease({ tokenId: m.tokenId, liquidity: fp.liquidity, amount0Min: dd.amount0Min, amount1Min: dd.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: true, expected: { ...dd.expected, fees: fp.fees }, pool });
      const why = payoutRules(req, USER, pool, fp.fees);
      check(`${pool} (c)/(e): remove 100% + burn = [DECREASE(0), TAKE, TAKE, TAKE_PAIR(user), DECREASE(all), BURN, TAKE_PAIR(user)]`, !why && req.actions.join() === '1,14,14,17,1,3,17', why || req.actions.join());
      const preview = req.preview.lines.join(' | ');
      check(`${pool} (c): preview discloses "Tool fee (10% of earned fees): … → 0xd977…09c3" and "You receive: …"`, /Tool fee \(10% of earned fees\): .* → 0xd977…09c3/.test(preview) && /You receive: /.test(preview));
      d = await payout(req);
      check(`${pool} (c): treasury == 10% of the fee part only`, d.tr0 === s.fee0 && d.tr1 === s.fee1 && s.fee0 > 0n, fmt(d.tr0, d.tr1));
      check(`${pool} (c): user == 100% of the principal + 90% of the fees, exactly`, d.user0 === dd.expected.amount0 + s.user0 && d.user1 === dd.expected.amount1 + s.user1, fmt(d.user0, d.user1));
      check(`${pool} (c): NFT burned`, (await ownerOf(m.tokenId)) === null);
      // the decoded TAKE amounts in the calldata the chain executed == what the treasury received
      const tx = await pub.getTransaction({ hash: d.r.transactionHash });
      const { args } = decodeFunctionData({ abi: L.POSM_ABI, data: tx.input });
      const sent = decodeLp({ args: [args[0]] }).filter((x) => x.a === 0x0e);
      check(`${pool} (c)/(e): TAKEs in the mined calldata sum to the treasury deltas`, sent.reduce((s2, t) => s2 + (t.currency === getAddress(c0) ? t.amount : 0n), 0n) === d.tr0 && sent.reduce((s2, t) => s2 + (t.currency === getAddress(c1) ? t.amount : 0n), 0n) === d.tr1);
    }
    const posm = [await bal(ZERO, L.ADDR.POSITION_MANAGER), await bal(L.ADDR.USDC, L.ADDR.POSITION_MANAGER), await bal(L.ADDR.KNTQ, L.ADDR.POSITION_MANAGER)];
    check(`${pool}: PositionManager holds no extra HYPE / USDC / KNTQ`, posm.every((v, i) => v === posm0[i]));
  }
}

main().then((c) => process.exit(c), (e) => { console.error('FAIL: crashed:', e.shortMessage || e.message, String(e.stack).split('\n').slice(0, 8).join('\n')); process.exit(1); });
