// Independent verifier: USER FUNDS SAFETY & real E2E on an anvil fork of Elysium mainnet (port 8568).
//   cd lp-helper && node test/verify-funds.test.mjs
// Mirrors app.js call-for-call: planMint(anchor) -> planMintTxs(pub, user, plan, {infinite:false, nowSec}) ->
// per tx: pub.simulateContract -> wallet.writeContract({...request, account, chain: L.elysium}) over an EIP-1193
// `custom` transport (like MetaMask), mint rebuilt with buildMint(deadline = latestTs + 600) right before signing.
// No private keys: anvil dev accounts are unlocked; holders are impersonated for funding only.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, createTestClient, http, custom,
  encodeAbiParameters, decodeAbiParameters, decodeFunctionData, toHex, getAddress, parseAbi, parseUnits,
} from 'viem';
import * as L from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 8568;
const FORK = `http://127.0.0.1:${PORT}`;
const UNIVERSAL_ROUTER = getAddress('0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a');
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const NFT_ABI = parseAbi([
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
]);

let failed = 0, total = 0;
const check = (name, ok, detail = '') => {
  total++; if (!ok) failed++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const log = (...a) => console.log('•', ...a);

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
async function reachable(url) {
  try { const j = await Promise.race([rpc(url, 'eth_chainId'), new Promise((_, r) => setTimeout(() => r(new Error('t')), 10000))]); return Number(j.result) === L.CHAIN_ID; } catch { return false; }
}

async function startAnvil() {
  const bin = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  const proc = spawn(existsSync(bin) ? bin : 'anvil', ['--fork-url', L.RPC_URL, '--port', String(PORT), '--chain-id', String(L.CHAIN_ID), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('anvil exited: ' + err);
    if (await reachable(FORK)) { await rpc(FORK, 'evm_mine'); return proc; }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill(); throw new Error('anvil did not start: ' + err);
}

// ---------------- static review checks (no chain) ----------------
function staticChecks() {
  console.log('\n-- static: no key handling, app.js uses lib the same way --');
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { if (f === 'node_modules' || f.startsWith('.')) continue; const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(m?js|html)$/.test(f) && files.push(p); } };
  walk(ROOT);
  const bad = /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|signTypedData|personal_sign|eth_sign\b|\.secrets|privateKey\s*[:=]/;
  const hits = files.filter((f) => !f.endsWith('verify-funds.test.mjs') && bad.test(readFileSync(f, 'utf8')));
  check('no private-key / signing-of-messages / .secrets code in page or lib', hits.length === 0, hits.join(', '));
  const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
  const must = [
    ['mint owner is connected account', /buildMint\(\{\s*plan,\s*owner:\s*S\.account,\s*deadline:\s*L\.deadlineFromNow\(600,\s*await latestTs\(\)\)\s*\}\)/],
    ['planMintTxs called with (pub, S.account, plan, {infinite, nowSec})', /L\.planMintTxs\(pub,\s*S\.account,\s*plan,\s*\{\s*infinite:\s*\$\('infinite'\)\.checked,\s*nowSec:\s*await latestTs\(\)\s*\}\)/],
    ['collect recipient is connected account', /buildCollect\(\{\s*tokenId:\s*pos\.tokenId,\s*recipient:\s*S\.account/],
    ['decrease recipient is connected account', /recipient:\s*S\.account,\s*deadline:\s*L\.deadlineFromNow\(600/],
    ['burn-empty recipient is connected account', /buildBurnEmpty\(\{\s*tokenId:\s*pos\.tokenId,\s*recipient:\s*S\.account/],
    ['empty position (liquidity 0) gets a Burn empty NFT action', /pos\.liquidity === 0n\)\s*\{[\s\S]{0,900}data-a="burn"[\s\S]{0,400}burnEmpty\(pos\)/],
    ['range change never reuses the calculated amount', /const calcField = S\.anchor === 'amount0' \? 'amt1' : 'amt0';\s*\$\(calcField\)\.value = '';/],
    ['planDecrease with fresh state + slippage', /L\.planDecrease\(state,\s*fresh,\s*liquidity,\s*slipBps\(\)\)/],
    // Step 1 swaps add `...req.tx` (value/gas/fees, set only by L.planHypeSwap); LP requests have no req.tx.
    ['sendTx simulates then writes the simulated request', /simulateContract\(\{ address: req\.address, abi: req\.abi, functionName: req\.functionName, args: req\.args, account: S\.account, \.\.\.req\.tx \}\)/],
    // Multi-pool: a native-HYPE mint (KNTQ/HYPE 0.8%) also carries value (= amount0Max, swept back if unused);
    // L.txValueAllowed allows exactly swaps to the router and native-pool mints to the PositionManager.
    ['sendTx refuses req.tx (value) on anything but a swap or a native-HYPE mint', /if \(req\.tx && !L\.txValueAllowed\(req\)\) throw/],
    ['sendTx re-asserts the LP pool id of the request', /if \(req\.pool\) L\.assertLpPool\(req\.pool\);/],
    ['swap request comes only from L.planHypeSwap with the connected account', /L\.planHypeSwap\(pub,\s*\{\s*out,\s*amountIn,\s*account:\s*S\.account,/],
    ['writeContract pins chain to Elysium', /writeContract\(\{\s*\.\.\.request,\s*(?:\.\.\.fees,\s*)?account:\s*S\.account,\s*chain:\s*L\.elysium\s*\}\)/],
    ['sendTx re-asserts pool id', /L\.assertTargetPool\(\);\s*await ensureChain\(\);/],
  ];
  for (const [n, re] of must) check(`app.js: ${n}`, re.test(app));
  {
    const mints = [...app.matchAll(/const fresh = L\.buildMint\(/g)];
    const guarded = mints.every((mm) => /^[\s\S]{0,300}?await L\.guardNativeMint\(pub, fresh, S\.account\);\s*Object\.assign\(txs\[i\], fresh\);/.test(app.slice(mm.index)));
    check(`app.js: every mint (${mints.length}) is reserve-checked by guardNativeMint right before signing`, mints.length >= 2 && guarded);
  }
  check('app.js never sets a tx value itself (no `value:`; only lib swap req.tx carries one)', !/\bvalue:\s*[^'"]/.test(app.replace(/\.value/g, '')));
  check('app.js never assigns req.tx itself', !/\.tx\s*=/.test(app));
  // lib: the only req.tx is the swap's, its value is exactly amountIn and it targets the UniversalRouter
  const sw = L.buildSwapHype({ out: 'KNTQ', amountIn: 123n, minAmountOut: 1n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 1n });
  check('lib swap: tx.value == amountIn, to UniversalRouter', sw.tx.value === 123n && sw.address === L.UNIVERSAL_ROUTER && Object.keys(sw.tx).join() === 'value');
  const noTx = [L.buildCollect({ tokenId: 1n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 1n }), L.buildBurnEmpty({ tokenId: 1n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 1n })];
  check('lib LP builders carry no tx value', noTx.every((t) => t.tx === undefined));
  // multi-pool: KNTQ/USDC mint has no value; KNTQ/HYPE mint value == amount0Max and is the only other value carrier
  const dead = '0x000000000000000000000000000000000000dEaD';
  const usdcMint = L.buildMint({ plan: { tickLower: -200, tickUpper: 200, liquidity: 1n, amount0: 1n, amount1: 1n, amount0Max: 2n, amount1Max: 2n }, owner: dead, deadline: 1n });
  const hypeMint = L.buildMint({ plan: { pool: 'HYPE', tickLower: -120, tickUpper: 120, liquidity: 1n, amount0: 1n, amount1: 1n, amount0Max: 2n, amount1Max: 2n }, owner: dead, deadline: 1n });
  check('USDC-pool mint carries no value; HYPE-pool mint value == amount0Max with SWEEP last', usdcMint.tx === undefined && hypeMint.tx.value === 2n && hypeMint.actions.at(-1) === L.ACTIONS.SWEEP && L.txValueAllowed(hypeMint));
  check('txValueAllowed refuses: value on collect, value != amount0Max on a mint, value to another contract',
    !L.txValueAllowed({ ...noTx[0], kind: 'collect', tx: { value: 1n } }) && !L.txValueAllowed({ ...hypeMint, tx: { value: 3n } }) && !L.txValueAllowed({ ...hypeMint, address: L.ADDR.PERMIT2 }));
  const usdcSwap = L.buildSwapUsdcToHype({ amountIn: 5n, minAmountOut: 1n, recipient: dead, deadline: 1n });
  check('USDC->HYPE swap carries no value (USDC via Permit2)', usdcSwap.tx === undefined && usdcSwap.address === L.UNIVERSAL_ROUTER);
}

// ---------------- lib-level refusal checks ----------------
async function refusalChecks() {
  console.log('\n-- refusal: wrong pool / wrong chain --');
  check('POOL_ID_OK and computed id == target', L.POOL_ID_OK && L.COMPUTED_POOL_ID === L.TARGET_POOL_ID);
  const tampered = [
    { ...L.POOL_KEY, fee: 3000 },
    { ...L.POOL_KEY, tickSpacing: 60 },
    { ...L.POOL_KEY, hooks: '0x0000000000000000000000000000000000000001' },
    { ...L.POOL_KEY, currency0: L.POOL_KEY.currency1, currency1: L.POOL_KEY.currency0 },
  ];
  check('assertTargetPool throws for every tampered key', tampered.every((k) => { try { L.assertTargetPool(k); return false; } catch { return true; } }));
  check('POOL_KEY is frozen (cannot be mutated at runtime)', Object.isFrozen(L.POOL_KEY) && (() => { try { L.POOL_KEY.fee = 1; } catch {} return L.POOL_KEY.fee === 20000; })());
  // wrong chain: an EIP-1193 provider on chain 1; writeContract({chain: L.elysium}) must refuse before sending
  let sent = false;
  const wrong = { request: async ({ method }) => { if (method === 'eth_chainId') return '0x1'; if (method === 'eth_sendTransaction') { sent = true; return '0x' + '00'.repeat(32); } return null; } };
  const w = createWalletClient({ account: '0x000000000000000000000000000000000000dEaD', chain: L.elysium, transport: custom(wrong) });
  const req = L.buildCollect({ tokenId: 1n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 9999999999n });
  let err = null;
  try { await w.writeContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: '0x000000000000000000000000000000000000dEaD', chain: L.elysium }); } catch (e) { err = e; }
  const cm = err?.walk?.((x) => x?.name === 'ChainMismatchError');
  check('wallet on chain 1 + chain: L.elysium -> ChainMismatchError, nothing sent', !!cm && !sent, cm?.shortMessage);
}

// ---------------- helpers ----------------
function decodeUnlock(tx) {
  const { args } = decodeFunctionData({ abi: L.POSM_ABI, data: encodeCall(tx) });
  const [actionsHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], args[0]);
  const actions = [...Buffer.from(actionsHex.slice(2), 'hex')];
  return { actions, params, deadline: args[1] };
}
import { encodeFunctionData } from 'viem';
const encodeCall = (tx) => encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args });

async function main() {
  console.log('== lp-helper verify-funds (independent) ==');
  staticChecks();
  await refusalChecks();
  if (!(await reachable(L.RPC_URL))) { console.log('SKIP fork part: RPC unreachable'); return summary(); }
  const anvil = await startAnvil();
  try { await forkE2E(); } finally { try { anvil.kill(); } catch {} }
  return summary();
}
function summary() {
  console.log(`\n== SUMMARY ==\n${failed === 0 ? 'PASS' : 'FAIL'}: ${total - failed}/${total} checks passed`);
  return failed === 0 ? 0 : 1;
}

async function forkE2E() {
  console.log('\n-- fork E2E on', FORK, '--');
  const forkChain = { ...L.elysium, rpcUrls: { default: { http: [FORK] } } };
  const pub = createPublicClient({ chain: forkChain, transport: http(FORK), pollingInterval: 100 });
  const test = createTestClient({ chain: forkChain, mode: 'anvil', transport: http(FORK) });
  const accts = (await pub.request({ method: 'eth_accounts' })).map((a) => getAddress(a));
  const USER = accts[4], TRADER = accts[5];
  // EIP-1193 "MetaMask" that forwards to the fork; page wallet code path verbatim.
  const provider = { request: async ({ method, params }) => { const j = await rpc(FORK, method, params ?? []); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result; } };
  const wallet = createWalletClient({ account: USER, chain: L.elysium, transport: custom(provider) });
  const latestTs = async () => Number((await pub.getBlock()).timestamp);
  const bal = (t, a = USER) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [a] });
  const posmBal = async () => [await bal(L.ADDR.USDC, L.ADDR.POSITION_MANAGER), await bal(L.ADDR.KNTQ, L.ADDR.POSITION_MANAGER)];
  const ownerOf = (id) => pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
  const posL = (id) => pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPositionLiquidity', args: [id] });

  // == app.js sendTx (minus the dialog) ==
  const sendTx = async (req) => {
    L.assertTargetPool();
    const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER });
    const hash = await wallet.writeContract({ ...request, account: USER, chain: L.elysium });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('reverted ' + hash);
    return r;
  };

  await fund(pub, test, L.ADDR.USDC, [[USER, 200_000000n], [TRADER, 100_000000n]]);
  await fund(pub, test, L.ADDR.KNTQ, [[USER, 1500n * 10n ** 18n], [TRADER, 800n * 10n ** 18n]]);
  await test.setBalance({ address: USER, value: 10n ** 20n });
  await test.setBalance({ address: TRADER, value: 10n ** 20n });
  const start0 = await bal(L.ADDR.USDC), start1 = await bal(L.ADDR.KNTQ);
  check('user funded', start0 >= 200_000000n && start1 >= 1500n * 10n ** 18n, `${L.fmtUsdc(start0)} USDC ${L.fmtKntq(start1)} KNTQ`);
  const posm0 = await posmBal();
  let pulled0 = 0n, pulled1 = 0n, got0 = 0n, got1 = 0n, fee0 = 0n, fee1 = 0n;

  // == app.js reviewMint (no dialog) ==
  async function mintLikePage(label, preset, inputs, custom = {}) {
    const state = await L.readPoolState(pub);
    const { tickLower, tickUpper } = L.rangeForPreset(preset, state.tick, custom);
    const a0 = inputs.usdc != null ? parseUnits(inputs.usdc, 6) : 0n;
    const a1 = inputs.kntq != null ? parseUnits(inputs.kntq, 18) : 0n;
    const anchor = inputs.usdc != null ? 'amount0' : 'amount1';
    const plan = L.planMint(state, tickLower, tickUpper, { amount0: a0, amount1: a1, anchor }, 100);
    const nowSec = await latestTs();
    const txs = await L.planMintTxs(pub, USER, plan, { infinite: false, nowSec });
    log(`${label}: ticks [${tickLower},${tickUpper}] tick ${state.tick} L=${plan.liquidity} owed ${L.fmtUsdc(plan.amount0, 6)} USDC + ${L.fmtKntq(plan.amount1, 6)} KNTQ; ${txs.map((t) => t.kind).join(' → ')}`);
    check(`${label}: tick range aligned to 200 and inside usable range`, tickLower % 200 === 0 && tickUpper % 200 === 0 && tickLower >= L.MIN_USABLE_TICK && tickUpper <= L.MAX_USABLE_TICK && tickLower < tickUpper);
    check(`${label}: amountMax = owed * 1.01 (rounded up), 0 when not needed`,
      plan.amount0Max === (plan.amount0 === 0n ? 0n : (plan.amount0 * 10100n + 9999n) / 10000n) && plan.amount1Max === (plan.amount1 === 0n ? 0n : (plan.amount1 * 10100n + 9999n) / 10000n));
    // approvals: exact amountMax, ERC20 spender Permit2, Permit2 spender POSM, expiry now+1800
    for (const t of txs.filter((x) => x.kind !== 'mint')) {
      const tok = getAddress(t.kind === 'erc20-approve' ? t.address : t.args[0]);
      const max = tok === L.ADDR.USDC ? plan.amount0Max : plan.amount1Max;
      if (t.kind === 'erc20-approve') check(`${label}: ERC20 approve(Permit2, exact amountMax) on ${L.tokenMeta(tok).symbol}`, getAddress(t.args[0]) === L.ADDR.PERMIT2 && t.args[1] === max, `${t.args[1]}`);
      else check(`${label}: Permit2.approve(${L.tokenMeta(tok).symbol}, POSM, exact amountMax, now+1800)`, t.address === L.ADDR.PERMIT2 && getAddress(t.args[1]) === L.ADDR.POSITION_MANAGER && t.args[2] === max && t.args[3] === nowSec + 1800);
    }
    // mint calldata: owner = user, pool key = target, deadline sane
    const m = txs.at(-1);
    const dm = decodeUnlock(m);
    const mp = decodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] }, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }], dm.params[0]);
    const key = { currency0: mp[0][0], currency1: mp[0][1], fee: mp[0][2], tickSpacing: mp[0][3], hooks: mp[0][4] };
    check(`${label}: mint calldata = [MINT_POSITION, SETTLE_PAIR], key hashes to target, owner == user, no value`,
      dm.actions.join() === '2,13' && L.poolIdOf(key) === L.TARGET_POOL_ID && getAddress(mp[6]) === USER && mp[3] === plan.liquidity && mp[4] === plan.amount0Max && mp[5] === plan.amount1Max && m.value === undefined);
    check(`${label}: mint deadline = chain time + 600s`, dm.deadline === BigInt(nowSec + 600), `${dm.deadline - BigInt(nowSec)}s`);

    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const poolBefore = (await L.readPoolState(pub)).liquidity;
    let receipt;
    for (let i = 0; i < txs.length; i++) {
      if (txs[i].kind === 'mint') {
        // after the approvals land, re-planning must need no further approvals (skip logic works)
        const again = await L.planMintTxs(pub, USER, plan, { infinite: false, nowSec: await latestTs() });
        check(`${label}: after approvals, re-plan needs only the mint`, again.length === 1 && again[0].kind === 'mint');
        Object.assign(txs[i], L.buildMint({ plan, owner: USER, deadline: L.deadlineFromNow(600, await latestTs()) }));
      }
      receipt = await sendTx(txs[i]);
    }
    const tokenId = L.parseMintedTokenId(receipt, USER);
    const p0 = b0 - (await bal(L.ADDR.USDC)), p1 = b1 - (await bal(L.ADDR.KNTQ));
    pulled0 += p0; pulled1 += p1;
    check(`${label}: tokenId parsed`, tokenId !== null, `#${tokenId}`);
    const owner = await ownerOf(tokenId);
    check(`${label}: NFT owner == user (not POSM/PoolManager/helper)`, owner && getAddress(owner) === USER, owner);
    check(`${label}: NFT has no approved operator`, (await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: NFT_ABI, functionName: 'getApproved', args: [tokenId] })) === '0x0000000000000000000000000000000000000000');
    check(`${label}: pulled == plan owed exactly and <= amountMax`, p0 === plan.amount0 && p1 === plan.amount1 && p0 <= plan.amount0Max && p1 <= plan.amount1Max, `${p0}/${plan.amount0} ${p1}/${plan.amount1}`);
    check(`${label}: position liquidity == planned L`, (await posL(tokenId)) === plan.liquidity);
    const after = await L.readPoolState(pub);
    if (plan.inRange) check(`${label}: active pool liquidity += L`, after.liquidity - poolBefore === plan.liquidity);
    // leftover approvals never exceed what was intended
    for (const [tok, max, pulled] of [[L.ADDR.USDC, plan.amount0Max, p0], [L.ADDR.KNTQ, plan.amount1Max, p1]]) {
      const { erc20Allowance, p2 } = await L.readAllowances(pub, USER, tok);
      const sym = L.tokenMeta(tok).symbol;
      if (max === 0n) { check(`${label}: no ${sym} approval touched for single-sided`, true); continue; }
      check(`${label}: leftover ${sym} ERC20->Permit2 allowance == amountMax - pulled (${erc20Allowance})`, erc20Allowance === max - pulled);
      check(`${label}: leftover ${sym} Permit2->POSM allowance == amountMax - pulled, expiry <= now+1800`, p2.amount === max - pulled && p2.expiration <= (await latestTs()) + 1800, `${p2.amount}, exp in ${p2.expiration - (await latestTs())}s`);
      check(`${label}: no direct ${sym} allowance to PositionManager`, (await pub.readContract({ address: tok, abi: L.ERC20_ABI, functionName: 'allowance', args: [USER, L.ADDR.POSITION_MANAGER] })) === 0n);
    }
    return { label, tokenId, plan };
  }

  const small = await mintLikePage('small ±20% (1 USDC)', 'pm20', { usdc: '1' });
  const full = await mintLikePage('full range (40 KNTQ anchor)', 'full', { kntq: '40' });
  // single-sided: range entirely above current USD price (tick below range... i.e. tick >= tickUpper) -> KNTQ only (tests SETTLE_PAIR with a zero delta)
  const st = await L.readPoolState(pub);
  const px = L.tickToUsdPerKntq(st.tick);
  const single = await mintLikePage('out-of-range KNTQ-only (range above price)', 'custom', { kntq: '5' }, { minUsd: px * 1.6, maxUsd: px * 2.6 });
  check('single-sided plan needs no USDC', single.plan.amount0 === 0n && single.plan.amount0Max === 0n && single.plan.amount1 > 0n);
  check('Transfer-log scan finds all 3 ids', (await L.scanTokenIdsTo(pub, USER, { fromBlock: (await pub.getBlockNumber()) - 200n, chunk: 1000n })).length >= 3);

  // == reverted mint can't strand funds ==
  console.log('\n-- reverted / expired / slippage paths --');
  {
    const state = await L.readPoolState(pub);
    const { tickLower, tickUpper } = L.rangeForPreset('pm50', state.tick);
    const plan = L.planMint(state, tickLower, tickUpper, { amount0: 5_000000n, anchor: 'amount0' }, 100);
    const txs = await L.planMintTxs(pub, USER, plan, { nowSec: await latestTs() });
    for (const t of txs.slice(0, -1)) await sendTx(t);
    // price moves against the plan (trader dumps 15 USDC -> KNTQ) after approvals, before mint
    await traderSwap(pub, test, TRADER, true, 15_000000n);
    const mint = L.buildMint({ plan, owner: USER, deadline: L.deadlineFromNow(600, await latestTs()) });
    let simErr = null;
    try { await pub.simulateContract({ address: mint.address, abi: mint.abi, functionName: mint.functionName, args: mint.args, account: USER }); } catch (e) { simErr = e; }
    check('stale plan after price move: page simulation refuses (MaximumAmountExceeded)', !!simErr && /MaximumAmountExceeded/.test(simErr.message + (simErr.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? '')), simErr?.shortMessage);
    // force-send anyway (bypassing simulation, fixed gas) -> on-chain revert; nothing must move
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ), pb = await posmBal();
    const nftBefore = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'balanceOf', args: [USER] });
    const hash = await wallet.writeContract({ address: mint.address, abi: mint.abi, functionName: mint.functionName, args: mint.args, account: USER, chain: L.elysium, gas: 3_000_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    const pa = await posmBal();
    check('forced stale mint reverts on-chain', r.status === 'reverted');
    check('reverted mint: user USDC/KNTQ unchanged, no NFT, POSM holds nothing extra',
      (await bal(L.ADDR.USDC)) === b0 && (await bal(L.ADDR.KNTQ)) === b1 && pa[0] === pb[0] && pa[1] === pb[1] &&
      (await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'balanceOf', args: [USER] })) === nftBefore);
    // expired deadline refused
    const old = L.buildMint({ plan, owner: USER, deadline: BigInt((await latestTs()) - 1) });
    let dErr = null;
    try { await pub.simulateContract({ address: old.address, abi: old.abi, functionName: old.functionName, args: old.args, account: USER }); } catch (e) { dErr = e; }
    check('past deadline -> DeadlinePassed', !!dErr && /DeadlinePassed/.test(dErr.message), dErr?.shortMessage);
    // Permit2 allowance expires after 30 min -> approvalNeeds asks again, mint sim fails without it
    await test.increaseTime({ seconds: 1860 }); await test.mine({ blocks: 1 });
    const st2 = await L.readPoolState(pub);
    const plan2 = L.planMint(st2, tickLower, tickUpper, { amount0: 1_000000n, anchor: 'amount0' }, 100);
    const t2 = await L.planMintTxs(pub, USER, plan2, { nowSec: await latestTs() });
    check('expired Permit2 allowance is detected (permit2-approve re-planned)', t2.some((t) => t.kind === 'permit2-approve'), t2.map((t) => t.kind).join(','));
    let eErr = null;
    const m2 = t2.at(-1);
    try { await pub.simulateContract({ address: m2.address, abi: m2.abi, functionName: m2.functionName, args: m2.args, account: USER }); } catch (e) { eErr = e; }
    check('mint without the fresh Permit2 approval is refused by simulation', !!eErr, eErr?.shortMessage?.slice(0, 80));
    // swap back so price is roughly restored
    await traderSwap(pub, test, TRADER, false, 0n);
  }

  // == fees ==
  await traderSwap(pub, test, TRADER, true, 10_000000n);
  await traderSwap(pub, test, TRADER, false, 0n);

  // == collect (app.js collect) ==
  console.log('\n-- collect / remove --');
  for (const p of [small, full, single]) {
    const state = await L.readPoolState(pub);
    const fresh = await L.readPosition(pub, p.tokenId, state);
    const req = L.buildCollect({ tokenId: p.tokenId, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: fresh.fees });
    const du = decodeUnlock(req);
    const tf = L.toolFeeSplit(fresh.fees);
    const tp = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], du.params.at(-1));
    const takes = du.params.slice(1, -1).map((x) => decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], x));
    const expActs = ['1', ...(tf.fee0 > 0n ? ['14'] : []), ...(tf.fee1 > 0n ? ['14'] : []), '17'].join();
    check(`${p.label}: collect = [DECREASE_LIQUIDITY(0), TAKE(fee) per currency with fee > 0, TAKE_PAIR -> user]`, du.actions.join() === expActs && getAddress(tp[2]) === USER && decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], du.params[0])[1] === 0n &&
      takes.every((t) => getAddress(t[1]) === L.FEE_RECIPIENT && t[2] > 0n), du.actions.join());
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const f0 = await bal(L.ADDR.USDC, L.FEE_RECIPIENT), f1 = await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT);
    await sendTx(req);
    const g0 = (await bal(L.ADDR.USDC)) - b0, g1 = (await bal(L.ADDR.KNTQ)) - b1;
    got0 += g0; got1 += g1;
    fee0 += tf.fee0; fee1 += tf.fee1;
    check(`${p.label}: collected == computed fees − 10% tool fee; fee recipient got exactly the 10%`, g0 === tf.user0 && g1 === tf.user1 && (await bal(L.ADDR.USDC, L.FEE_RECIPIENT)) - f0 === tf.fee0 && (await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT)) - f1 === tf.fee1, `${L.fmtUsdc(g0, 6)} USDC + ${L.fmtKntq(g1, 8)} KNTQ`);
    if (p !== single) check(`${p.label}: in-range position earned fees`, g0 > 0n || g1 > 0n);
    check(`${p.label}: liquidity unchanged by collect`, (await posL(p.tokenId)) === p.plan.liquidity);
  }

  // == app.js remove(pos, pct, burn) ==
  async function removeLikePage(p, pct, burn) {
    const state = await L.readPoolState(pub);
    const fresh = await L.readPosition(pub, p.tokenId, state);
    const liquidity = pct === 100 ? fresh.liquidity : (fresh.liquidity * BigInt(pct)) / 100n;
    const d = L.planDecrease(state, fresh, liquidity, 100);
    const req = L.buildDecrease({ tokenId: p.tokenId, liquidity, amount0Min: d.amount0Min, amount1Min: d.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()), burn: burn && pct === 100, expected: { ...d.expected, fees: fresh.fees } });
    const du = decodeUnlock(req);
    const tf = L.toolFeeSplit(fresh.fees);
    const tp = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], du.params.at(-1));
    const feeActs = [...(tf.fee0 > 0n ? ['14'] : []), ...(tf.fee1 > 0n ? ['14'] : [])];
    const feeSeg = feeActs.length ? ['1', ...feeActs, '17'] : [];
    check(`${p.label} remove ${pct}%${burn ? '+burn' : ''}: actions ${du.actions.join(',')} = [fees-only DECREASE(0) + fee TAKEs + TAKE_PAIR if a fee share > 0] + DECREASE${burn ? ' + BURN' : ''} + TAKE_PAIR -> user`,
      du.actions.join() === [...feeSeg, ...(burn ? ['1', '3'] : ['1']), '17'].join() && getAddress(tp[2]) === USER && (!feeSeg.length || decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], du.params[0])[1] === 0n));
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const f0 = await bal(L.ADDR.USDC, L.FEE_RECIPIENT), f1 = await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT);
    await sendTx(req);
    const g0 = (await bal(L.ADDR.USDC)) - b0, g1 = (await bal(L.ADDR.KNTQ)) - b1;
    got0 += g0; got1 += g1;
    fee0 += tf.fee0; fee1 += tf.fee1;
    check(`${p.label} remove ${pct}%: received == expected principal + 90% of fees, >= mins; fee recipient got 10% of the fees`, g0 === d.expected.amount0 + tf.user0 && g1 === d.expected.amount1 + tf.user1 && g0 >= d.amount0Min && g1 >= d.amount1Min &&
      (await bal(L.ADDR.USDC, L.FEE_RECIPIENT)) - f0 === tf.fee0 && (await bal(L.ADDR.KNTQ, L.FEE_RECIPIENT)) - f1 === tf.fee1, `${L.fmtUsdc(g0, 6)} USDC + ${L.fmtKntq(g1, 6)} KNTQ`);
    const own = await ownerOf(p.tokenId);
    if (burn) check(`${p.label}: NFT burned`, own === null);
    else check(`${p.label}: NFT still owned by user, liquidity == ${fresh.liquidity - liquidity}`, own && getAddress(own) === USER && (await posL(p.tokenId)) === fresh.liquidity - liquidity);
    return d;
  }
  // slippage floor actually protects: decrease with mins from a pre-move state reverts after the price moves
  {
    const state = await L.readPoolState(pub);
    const fresh = await L.readPosition(pub, full.tokenId, state);
    const d = L.planDecrease(state, fresh, fresh.liquidity / 2n, 100);
    await traderSwap(pub, test, TRADER, true, 15_000000n);
    const req = L.buildDecrease({ tokenId: full.tokenId, liquidity: d.liquidity, amount0Min: d.amount0Min, amount1Min: d.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await latestTs()) });
    let e = null;
    try { await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: USER }); } catch (x) { e = x; }
    check('stale decrease mins after price move -> MinimumAmountInsufficient', !!e && /MinimumAmountInsufficient/.test(e.message), e?.shortMessage);
    await traderSwap(pub, test, TRADER, false, 0n);
  }
  // a stranger cannot touch the user's position
  {
    const req = L.buildDecrease({ tokenId: full.tokenId, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, recipient: TRADER, deadline: L.deadlineFromNow(600, await latestTs()) });
    let e = null;
    try { await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: TRADER }); } catch (x) { e = x; }
    check('non-owner decrease is refused (NotApproved)', !!e && /NotApproved/.test(e.message), e?.shortMessage);
  }
  await removeLikePage(small, 50, false);
  await removeLikePage(small, 100, true);
  await removeLikePage(full, 50, false);
  await removeLikePage(full, 100, false);
  await removeLikePage(single, 100, true);
  check('full-range NFT left empty but still owned (no burn)', (await posL(full.tokenId)) === 0n && getAddress(await ownerOf(full.tokenId)) === USER);

  // == final accounting ==
  console.log('\n-- final balances / approvals --');
  const end0 = await bal(L.ADDR.USDC), end1 = await bal(L.ADDR.KNTQ);
  // pulled0/1 also include the 'reverted' block's approvals? no: only mintLikePage adds; reverted mint moved nothing.
  check('exact accounting: end = start - deposited + collected + withdrawn (USDC)', end0 === start0 - pulled0 + got0, `${end0} vs ${start0 - pulled0 + got0}`);
  check('exact accounting: end = start - deposited + collected + withdrawn (KNTQ)', end1 === start1 - pulled1 + got1, `${end1} vs ${start1 - pulled1 + got1}`);
  const fs = await L.readPoolState(pub);
  const vin = L.usdValue(start0, start1, fs.sqrtPriceX96), vout = L.usdValue(end0, end1, fs.sqrtPriceX96);
  log(`tool fees paid over the run: ${L.fmtUsdc(fee0, 6)} USDC + ${L.fmtKntq(fee1, 8)} KNTQ (10% of the earned fees, never principal)`);
  check('user total value within 2% of start (at final price)', Math.abs(vout - vin) / vin < 0.02, `$${vin.toFixed(4)} -> $${vout.toFixed(4)}`);
  const pa = await posmBal();
  check('PositionManager token balances unchanged (no funds parked in helper path)', pa[0] === posm0[0] && pa[1] === posm0[1], `${pa} vs ${posm0}`);
  for (const tok of [L.ADDR.USDC, L.ADDR.KNTQ]) {
    const { erc20Allowance, p2 } = await L.readAllowances(pub, USER, tok);
    const now = await latestTs();
    check(`final ${L.tokenMeta(tok).symbol}: no unlimited approvals left (ERC20->Permit2 ${erc20Allowance}, Permit2 ${p2.amount})`, erc20Allowance < 10n ** 30n && p2.amount < 10n ** 30n);
    check(`final ${L.tokenMeta(tok).symbol}: Permit2 allowance expiry <= now+1800`, p2.expiration <= now + 1800);
  }
  check('user granted no NFT operator approval to anyone', !(await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: NFT_ABI, functionName: 'isApprovedForAll', args: [USER, L.ADDR.POSITION_MANAGER] })));
}

// ---------------- funding + trader (test-only) ----------------
async function fund(pub, test, token, targets) {
  const need = targets.reduce((s, [, a]) => s + a, 0n);
  const latest = await pub.getBlockNumber();
  const cands = new Set();
  for (let end = latest, i = 0; i < 20 && cands.size < 40; i++, end -= 5000n) {
    try {
      const logs = await pub.request({ method: 'eth_getLogs', params: [{ address: token, fromBlock: toHex(end - 4999n), toBlock: toHex(end), topics: [L.TRANSFER_TOPIC] }] });
      for (const l of logs.slice(-200)) cands.add(getAddress('0x' + l.topics[2].slice(26)));
    } catch {}
  }
  let best = null, bb = 0n;
  for (const c of cands) {
    if (c === L.ADDR.POOL_MANAGER || c === L.ADDR.POSITION_MANAGER) continue;
    const b = await pub.readContract({ address: token, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [c] });
    if (b > bb) { best = c; bb = b; }
  }
  if (!best || bb < need) throw new Error(`no holder with enough ${L.tokenMeta(token).symbol}`);
  await test.impersonateAccount({ address: best });
  await test.setBalance({ address: best, value: 10n ** 20n });
  const w = createWalletClient({ chain: pub.chain, transport: http(FORK), account: best });
  for (const [to, amt] of targets) {
    const h = await w.writeContract({ address: token, abi: L.ERC20_ABI, functionName: 'transfer', args: [to, amt], chain: pub.chain });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  await test.stopImpersonatingAccount({ address: best });
  log(`funded ${L.tokenMeta(token).symbol} from ${best}`);
}

let trApproved = false, trLayout = null, lastOut = 0n;
async function traderSwap(pub, test, TRADER, zeroForOne, amountIn) {
  const w = createWalletClient({ chain: pub.chain, transport: http(FORK), account: TRADER });
  const send = async (req) => { const { request } = await pub.simulateContract({ ...req, account: TRADER, chain: pub.chain }); const h = await w.writeContract(request); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('trader tx reverted'); };
  const ts = async () => Number((await pub.getBlock()).timestamp);
  if (!trApproved) {
    for (const t of [L.ADDR.USDC, L.ADDR.KNTQ]) {
      await send({ address: t, abi: L.ERC20_ABI, functionName: 'approve', args: [L.ADDR.PERMIT2, 2n ** 255n] });
      await send({ address: L.ADDR.PERMIT2, abi: L.PERMIT2_ABI, functionName: 'approve', args: [t, UNIVERSAL_ROUTER, L.MAX_UINT160, (await ts()) + 86400 * 30] });
    }
    trApproved = true;
  }
  // zeroForOne=false with amountIn 0 -> sell back exactly what the last USDC->KNTQ swap bought
  const K = L.POOL_KEY;
  const [cin, cout] = zeroForOne ? [K.currency0, K.currency1] : [K.currency1, K.currency0];
  if (!zeroForOne && amountIn === 0n) amountIn = lastOut;
  const outBefore = await pub.readContract({ address: cout, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [TRADER] });
  const PK = { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] };
  const keyArr = [K.currency0, K.currency1, K.fee, K.tickSpacing, K.hooks];
  const enc = (layout) => layout === 'legacy'
    ? encodeAbiParameters([{ type: 'tuple', components: [PK, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }] }], [[keyArr, zeroForOne, amountIn, 0n, '0x']])
    : encodeAbiParameters([{ type: 'tuple', components: [PK, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bytes' }] }], [[keyArr, zeroForOne, amountIn, 0n, 0n, '0x']]);
  const go = async (layout) => {
    const params = [enc(layout), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cin, amountIn]), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, 0n])];
    const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(Uint8Array.from([0x06, 0x0c, 0x0f])), params]);
    await send({ address: UNIVERSAL_ROUTER, abi: UR_ABI, functionName: 'execute', args: [toHex(Uint8Array.from([0x10])), [input], BigInt((await ts()) + 600)] });
  };
  if (trLayout) await go(trLayout);
  else { try { await go('v2'); trLayout = 'v2'; } catch { await go('legacy'); trLayout = 'legacy'; } }
  const got = (await pub.readContract({ address: cout, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [TRADER] })) - outBefore;
  if (zeroForOne) lastOut = got;
  const s = await L.readPoolState(pub);
  log(`trader ${zeroForOne ? 'USDC->KNTQ' : 'KNTQ->USDC'} in ${amountIn} out ${got}; tick now ${s.tick}`);
}

main().then((c) => process.exit(c), (e) => { console.error('FAIL: crashed:', e.shortMessage || e.message, String(e.stack).split('\n').slice(0, 8).join('\n')); process.exit(1); });
