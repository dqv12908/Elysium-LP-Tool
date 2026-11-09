// Shared helpers for the self-contained fork tests (fee.test.mjs, migrate.test.mjs, verify-migrate.test.mjs).
// No private keys: anvil dev accounts are unlocked (eth_sendTransaction), token holders are impersonated
// (anvil_impersonateAccount) only to FUND a dev account, exactly like fork.test.mjs does.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, createTestClient, http, getAddress, toHex } from 'viem';
import * as L from '../lib.mjs';

export async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
export async function reachable(url) {
  try {
    const j = await Promise.race([rpc(url, 'eth_chainId'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))]);
    return Number(j.result) === L.CHAIN_ID;
  } catch {
    return false;
  }
}
function anvilBin() {
  const p = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  return existsSync(p) ? p : 'anvil';
}
/** anvil --fork-url <public RPC> on `port`; mines one block (Elysium headers lack excessBlobGas). */
export async function startAnvil(port) {
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(anvilBin(), ['--fork-url', L.RPC_URL, '--port', String(port), '--chain-id', String(L.CHAIN_ID), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('anvil exited: ' + err);
    if (await reachable(url)) {
      await rpc(url, 'evm_mine');
      return { proc, url };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('anvil did not start: ' + err);
}
export function forkClients(url) {
  const chain = { ...L.elysium, rpcUrls: { default: { http: [url] } } };
  return {
    chain,
    pub: createPublicClient({ chain, transport: http(url), pollingInterval: 100 }),
    test: createTestClient({ chain, mode: 'anvil', transport: http(url) }),
    walletOf: (account) => createWalletClient({ account, chain, transport: http(url) }),
  };
}

/**
 * Fund `targets` ([[address, amount], …]) with `token` from the largest recent holder found in the token's Transfer
 * logs (impersonated on the fork; its HYPE is topped up for gas). Falls back to the PoolManager's reserves.
 */
export async function fundFromHolders(pub, test, url, token, targets) {
  const need = targets.reduce((s, [, a]) => s + a, 0n);
  const latest = await pub.getBlockNumber();
  const cands = new Set();
  for (let end = latest, i = 0; i < 20 && cands.size < 40; i++, end -= 5000n) {
    try {
      const logs = await pub.request({ method: 'eth_getLogs', params: [{ address: token, fromBlock: toHex(end - 4999n), toBlock: toHex(end), topics: [L.TRANSFER_TOPIC] }] });
      for (const l of logs.slice(-200)) cands.add(getAddress('0x' + l.topics[2].slice(26)));
    } catch {}
  }
  const skip = new Set([L.ADDR.POOL_MANAGER, L.ADDR.POSITION_MANAGER, L.UNIVERSAL_ROUTER, ...targets.map(([a]) => getAddress(a))]);
  let best = null, bestBal = 0n;
  for (const c of cands) {
    if (skip.has(c)) continue;
    const b = await pub.readContract({ address: token, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [c] });
    if (b > bestBal) { best = c; bestBal = b; }
  }
  if (!best || bestBal < need) best = L.ADDR.POOL_MANAGER;
  await test.impersonateAccount({ address: best });
  await test.setBalance({ address: best, value: 10n ** 20n });
  const w = createWalletClient({ chain: pub.chain, transport: http(url), account: best });
  for (const [to, amount] of targets) {
    const h = await w.writeContract({ address: token, abi: L.ERC20_ABI, functionName: 'transfer', args: [to, amount], chain: pub.chain });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error('funding transfer reverted');
  }
  await test.stopImpersonatingAccount({ address: best });
  return best;
}

/**
 * Test-only trader (an anvil dev account with plenty of HYPE). Generates LP fees by trading through a pool and
 * back (round trip), so the price ends close to where it started:
 *   pool 'USDC': HYPE -> USDC (lib swap), then USDC -> KNTQ -> USDC in the KNTQ/USDC 2% pool (UniversalRouter V4_SWAP)
 *   pool 'HYPE': HYPE -> KNTQ (lib swap), then KNTQ -> HYPE in the KNTQ/HYPE 0.8% pool
 * Returns the pool state before / after.
 */
export function makeTrader(pub, test, url, trader) {
  const T = getAddress(trader);
  const w = createWalletClient({ chain: pub.chain, transport: http(url), account: T });
  const ts = async () => Number((await pub.getBlock()).timestamp);
  const send = async (req) => {
    const { request } = await pub.simulateContract({ ...req, account: T });
    const h = await w.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error('trader tx reverted');
    return r;
  };
  const bal = (t) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [T] });
  const approved = new Set();
  const approve = async (token) => {
    if (approved.has(token)) return;
    await send({ address: token, abi: L.ERC20_ABI, functionName: 'approve', args: [L.ADDR.PERMIT2, 2n ** 255n] });
    await send({ address: L.ADDR.PERMIT2, abi: L.PERMIT2_ABI, functionName: 'approve', args: [token, L.UNIVERSAL_ROUTER, L.MAX_UINT160, (await ts()) + 86400 * 30] });
    approved.add(token);
  };
  const hypeIn = async (out, amountIn) => {
    const q = await L.planHypeSwap(pub, { out, amountIn, account: T, nowSec: await ts() });
    const b = await bal(q.token.address);
    await send({ address: q.req.address, abi: q.req.abi, functionName: q.req.functionName, args: q.req.args, ...q.req.tx });
    return (await bal(q.token.address)) - b;
  };
  // exact-in single-hop swap through `key` (ERC20 in), output to the trader
  const swapIn = async (key, zeroForOne, amountIn) => {
    const [cin, cout] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
    if (BigInt(cin) !== 0n) await approve(cin);
    const params = [
      L.encodeExactInputSingle({ poolKey: key, zeroForOne, amountIn, amountOutMinimum: 1n }),
      L.encodeCurrencyAmount(cin, amountIn),
      L.encodeCurrencyAmount(cout, 1n),
    ];
    const outBal = async () => (BigInt(cout) === 0n ? pub.getBalance({ address: T }) : bal(cout));
    const b = await outBal();
    const r = await send({ address: L.UNIVERSAL_ROUTER, abi: L.UR_ABI, functionName: 'execute', args: ['0x10', [L.encodeUnlockData([L.ACTIONS.SWAP_EXACT_IN_SINGLE, L.ACTIONS.SETTLE_ALL, L.ACTIONS.TAKE_ALL], params)], BigInt((await ts()) + 600)] });
    const gas = r.gasUsed * r.effectiveGasPrice;
    return (await outBal()) - b + (BigInt(cout) === 0n ? gas : 0n);
  };
  return {
    address: T,
    async ready() { await test.setBalance({ address: T, value: 10n ** 23n }); },
    /** Round trip through the LP pool `pool` ('USDC' | 'HYPE'): usdcIn (6 dec) or hypeIn (18 dec). */
    async roundTrip(pool, amount) {
      const P = L.LP_POOLS[pool];
      const before = await L.readPoolState(pub, undefined, P.poolId);
      if (pool === 'USDC') {
        let usdc = await bal(L.ADDR.USDC);
        if (usdc < amount) { await hypeIn('USDC', 10n * 10n ** 18n); usdc = await bal(L.ADDR.USDC); }
        const k = await swapIn(P.key, true, amount); // USDC -> KNTQ
        await swapIn(P.key, false, k); // KNTQ -> USDC
      } else {
        const k = await hypeIn('KNTQ', amount); // HYPE -> KNTQ through this very pool
        await swapIn(P.key, false, k); // KNTQ -> HYPE
      }
      const after = await L.readPoolState(pub, undefined, P.poolId);
      return { before, after, feesUp: after.feeGrowthGlobal0X128 > before.feeGrowthGlobal0X128 && after.feeGrowthGlobal1X128 > before.feeGrowthGlobal1X128 };
    },
  };
}

/**
 * The page's own mint path for `user` (reviewMint): planMint(anchor amount0) -> planMintTxs -> rebuild the mint with
 * buildMint right before signing -> guardNativeMint (native pool) -> send. sendTx(req) must behave like app.js sendTx.
 */
export async function mintLikePage(pub, sendTx, user, { pool = 'USDC', preset = 'full', amount0, slippageBps = 100 }) {
  const P = L.LP_POOLS[pool];
  const state = await L.readPoolState(pub, undefined, P.poolId);
  const { tickLower, tickUpper } = L.rangeForPreset(preset, state.tick, {}, pool);
  const plan = L.planMint(state, tickLower, tickUpper, { amount0, anchor: 'amount0' }, slippageBps, pool);
  const latestTs = async () => Number((await pub.getBlock()).timestamp);
  const txs = await L.planMintTxs(pub, user, plan, { nowSec: await latestTs() });
  let receipt;
  for (const tx of txs) {
    if (tx.kind === 'mint') {
      const fresh = L.buildMint({ plan, owner: user, deadline: L.deadlineFromNow(600, await latestTs()) });
      await L.guardNativeMint(pub, fresh, user);
      Object.assign(tx, fresh);
    }
    receipt = await sendTx(tx);
  }
  const tokenId = L.parseMintedTokenId(receipt, user);
  if (tokenId === null) throw new Error('mint: no tokenId in receipt');
  return { tokenId, plan, receipt };
}
