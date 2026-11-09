// Elysium LP helper – page logic. All math/encoding lives in lib.mjs.
import { createPublicClient, createWalletClient, custom, http, fallback, formatUnits, parseUnits, getAddress } from 'viem';
import * as L from './lib.mjs';

const $ = (id) => document.getElementById(id);
// Reads go through the local server's /rpc proxy (private RPC, key kept server-side) and fall back to the public RPC.
const PROXY_RPC = new URL('/rpc', location.href).href;
const rawPub = createPublicClient({
  chain: L.elysium,
  transport: fallback([http(PROXY_RPC, { batch: { batchSize: 20 }, retryCount: 2 }), http(L.RPC_URL, { batch: true, retryCount: 3 })]),
});
// Reads retry with back-off when the RPC answers "Rate Limit Exceeded" (the public RPC does under load). Reverts and
// every other error pass straight through, so revert-trick quotes and simulations behave exactly as before.
const isRateLimited = (e) => /rate limit|too many requests|\b429\b/i.test(`${e?.shortMessage || ''} ${e?.details || ''} ${e?.message || ''}`);
const pub = createPublicClient({
  chain: L.elysium,
  transport: custom({
    async request({ method, params }) {
      for (let i = 1; ; i++) {
        try { return await rawPub.request({ method, params }); } catch (e) {
          if (i >= 5 || !isRateLimited(e)) throw e;
          await new Promise((r) => setTimeout(r, 800 * i));
        }
      }
    },
  }),
  pollingInterval: 2000,
});

const lpPref = (() => { try { return localStorage.getItem('lp-helper:v1:lpPool') === 'HYPE' ? 'HYPE' : 'USDC'; } catch { return 'USDC'; } })();
const S = {
  lp: lpPref, // selected LP pool in Step 2: 'USDC' (KNTQ/USDC 2%) | 'HYPE' (KNTQ/HYPE 0.8%)
  states: { USDC: null, HYPE: null }, // pool states of both LP pools
  tvls: { USDC: null, HYPE: null },
  pool: null, // = S.states[S.lp]
  tvl: null,
  hypeUsd: null, // USD per HYPE from the USDC/HYPE pool
  pmOk: null,
  account: null,
  wallet: null,
  walletChainId: null,
  balances: null,
  preset: 'full',
  anchor: null, // 'amount0' | 'amount1'
  plan: null,
  busy: false,
  swapOk: null, // UniversalRouter + HYPE pool checks passed
  swap: null, // L.readSwapContext result
  migPreset: 'full',
};
const P = () => L.LP_POOLS[S.lp];

// ---------------------------------------------------------------- helpers
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), isErr ? 9000 : 4000);
}
function errMsg(e) {
  if (!e) return 'Unknown error';
  if (e.code === 4001 || /User (rejected|denied)/i.test(e.message || '')) return 'You rejected the request in MetaMask.';
  const inner = e.walk ? e.walk((x) => x?.data?.errorName) : null;
  if (inner?.data?.errorName) return `Reverted: ${inner.data.errorName}(${(inner.data.args || []).join(', ')})`;
  return e.shortMessage || e.details || e.message || String(e);
}
const fmtUsd = (x) => (x >= 1000 ? `$${x.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${x.toFixed(2)}`);
const fmtPrice = (x) => (x === 0 ? '0' : !Number.isFinite(x) || x > 1e12 ? '∞' : x < 0.0001 ? x.toExponential(3) : x.toPrecision(5));
function parseAmt(str, dec) {
  const s = (str || '').replace(/,/g, '').trim();
  if (!s) return null;
  if (!/^\d*\.?\d*$/.test(s) || s === '.') throw new Error('Invalid number');
  return parseUnits(s, dec);
}
const trimZeros = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const slipBps = () => {
  const v = Number($('slip').value);
  if (!(v >= 0.05 && v <= 20)) throw new Error('Slippage must be between 0.05% and 20%');
  return Math.round(v * 100);
};
const latestTs = async () => Number((await pub.getBlock()).timestamp);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** amount of a pool's quote token (USDC or HYPE) */
const fmtQ = (pool, x, d = 6) => `${L.fmtAmount(x, L.LP_POOLS[pool].token0.decimals, d)} ${L.LP_POOLS[pool].token0.symbol}`;

// ---------------------------------------------------------------- safety checks
function setCheck(id, ok, text) {
  const el = $(id);
  el.className = 'check ' + (ok === true ? 'ok' : ok === false ? 'bad' : '');
  el.lastChild.textContent = text;
}
function canWrite() {
  return L.POOL_ID_OK && L.LP_POOL_IDS_OK && S.pmOk === true && !!S.account;
}
function writeBlockReason() {
  if (!L.POOL_ID_OK || !L.LP_POOL_IDS_OK) return 'Pool id mismatch: writes disabled.';
  if (S.pmOk !== true) return 'PositionManager check not passed: writes disabled.';
  if (!S.account) return 'Connect MetaMask first.';
  return '';
}
async function verifyContracts() {
  const idsOk = L.POOL_ID_OK && L.LP_POOL_IDS_OK;
  setCheck('chkPool', idsOk, idsOk ? 'Pool ids verified (KNTQ/USDC 2%, KNTQ/HYPE 0.8%)' : `Pool id MISMATCH ${L.COMPUTED_POOL_ID}`);
  try {
    const pm = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'poolManager' });
    const p2 = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'permit2' });
    S.pmOk = getAddress(pm) === L.ADDR.POOL_MANAGER && getAddress(p2) === L.ADDR.PERMIT2;
    setCheck('chkPm', S.pmOk, S.pmOk ? 'PositionManager verified' : `PositionManager points to ${pm}`);
  } catch (e) {
    S.pmOk = false;
    setCheck('chkPm', false, 'PositionManager check failed: ' + errMsg(e));
  }
  // Step 1 swaps: both HYPE pool ids recomputed client-side, router bound to the official PoolManager.
  try {
    if (!L.SWAP_POOL_IDS_OK) throw new Error('HYPE pool id MISMATCH');
    const [urPm, code] = await Promise.all([
      pub.readContract({ address: L.UNIVERSAL_ROUTER, abi: L.UR_ABI, functionName: 'poolManager' }),
      pub.getCode({ address: L.UNIVERSAL_ROUTER }),
    ]);
    S.swapOk = getAddress(urPm) === L.ADDR.POOL_MANAGER && !!code && code.length > 2;
    setCheck('chkSwap', S.swapOk, S.swapOk ? 'Swap router & HYPE pools verified' : `UniversalRouter points to ${urPm}`);
  } catch (e) {
    S.swapOk = false;
    setCheck('chkSwap', false, 'Swap check failed: ' + errMsg(e));
  }
}

// ---------------------------------------------------------------- pool
async function refreshPool() {
  try {
    const [u, h, uh] = await Promise.all([
      L.readPoolState(pub),
      L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId),
      L.readPoolState(pub, undefined, L.SWAP_POOLS.USDC.id),
    ]);
    if (!u.initialized || !h.initialized || !uh.initialized) throw new Error('Pool not initialized');
    S.states = { USDC: u, HYPE: h };
    S.hypeUsd = Number(L.usdcPerHypeE6(uh.sqrtPriceX96)) / 1e6;
    S.pool = S.states[S.lp];
    renderPool();
    try {
      S.tvls[S.lp] = await L.readPoolTvl(pub, S.pool, S.lp);
      S.tvl = S.tvls[S.lp];
      const usd = L.poolUsdValue(S.lp, S.tvl.amount0, S.tvl.amount1, S.pool.sqrtPriceX96, S.hypeUsd);
      $('tvl').textContent = `≈ ${fmtUsd(usd)}`;
      $('tvlComp').textContent = `${fmtQ(S.lp, S.tvl.amount0, 2)} + ${L.fmtKntq(S.tvl.amount1, 2)} KNTQ`;
    } catch (e) {
      $('tvl').textContent = 'unavailable';
      $('tvlComp').textContent = errMsg(e);
    }
    $('poolUpdated').textContent = `Updated ${new Date().toLocaleTimeString()} via local RPC proxy (fallback ${L.RPC_URL})` +
      (S.lp === 'HYPE' ? ` · KNTQ in USD = HYPE per KNTQ × $${S.hypeUsd.toFixed(4)} (HYPE price from the HYPE/USDC 0.3% pool)` : '');
    recalc();
  } catch (e) {
    $('poolUpdated').textContent = 'Could not read pool: ' + errMsg(e);
  }
}
function renderPool() {
  const st = S.pool;
  if (!st) return;
  const p = P();
  const usdK = L.usdPerKntqInPool(S.lp, st.sqrtPriceX96, S.hypeUsd);
  $('poolTitle').textContent = `Pool · ${p.label}`;
  $('pUsd').textContent = `$${usdK.toPrecision(4)}`;
  $('pKntqLabel').textContent = `KNTQ per ${p.token0.symbol}`;
  $('pKntq').textContent = (1 / L.sqrtPriceToQuotePerKntq(st.sqrtPriceX96, S.lp)).toPrecision(5);
  $('tick').textContent = st.tick;
  $('activeL').textContent = st.liquidity.toString();
  $('poolId').textContent = p.poolId;
  $('feeTier').textContent = `${p.key.fee / 10000}% (tick spacing ${p.key.tickSpacing})`;
  if (S.tvls[S.lp] !== S.tvl) { $('tvl').textContent = '…'; $('tvlComp').textContent = '…'; }
  $('amt0Sym').textContent = p.token0.symbol;
  $('amt0').placeholder = '0.0';
  $('lpPoolHint').textContent = p.native0
    ? 'Official KNTQ/HYPE 0.8% pool (native HYPE, no wrapping). The HYPE side is sent as the transaction value and any unused HYPE is swept straight back to you. Your HYPE gas reserve is never deposited.'
    : 'KNTQ/USDC 2% pool (thin).';
  if (!$('minUsd').value) {
    $('minUsd').value = (usdK * 0.7).toPrecision(4);
    $('maxUsd').value = (usdK * 1.3).toPrecision(4);
  }
}
function selectLp(pool) {
  if (pool === S.lp || !L.LP_POOLS[pool]) return;
  S.lp = pool;
  try { localStorage.setItem('lp-helper:v1:lpPool', pool); } catch {}
  document.querySelectorAll('#lpPools .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.pool === pool));
  // amounts and a custom range belong to the old pool: never carry them over
  $('amt0').value = '';
  $('amt1').value = '';
  $('minUsd').value = '';
  $('maxUsd').value = '';
  S.anchor = null;
  S.pool = S.states[S.lp];
  S.tvl = S.tvls[S.lp];
  renderPool();
  recalc();
  refreshPool();
}

// ---------------------------------------------------------------- wallet
// Pick MetaMask explicitly. Other wallets (Phantom, Rabby, OKX…) often overwrite window.ethereum, so we use
// EIP-6963 discovery (each wallet announces itself with an rdns id) and only fall back to legacy injection
// when the injected provider really is MetaMask (Phantom also sets isMetaMask=true for compatibility).
const announced = new Map(); // rdns -> { info, provider }
window.addEventListener('eip6963:announceProvider', (ev) => {
  const d = ev.detail;
  if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function isRealMetaMask(p) {
  return !!p && p.isMetaMask && !p.isPhantom && !p.isRabby && !p.isBraveWallet && !p.isOkxWallet && !p.isCoinbaseWallet;
}
async function findMetaMask() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  for (let i = 0; i < 10 && !announced.has('io.metamask'); i++) await new Promise((r) => setTimeout(r, 50));
  const mm = announced.get('io.metamask') || announced.get('io.metamask.flask');
  if (mm) return { provider: mm.provider, name: mm.info.name };
  const legacy = window.ethereum?.providers?.find?.(isRealMetaMask) || (isRealMetaMask(window.ethereum) ? window.ethereum : null);
  return legacy ? { provider: legacy, name: 'MetaMask' } : null;
}

async function connect() {
  const found = await findMetaMask();
  if (!found) {
    const others = [...announced.values()].map((d) => d.info.name).join(', ');
    toast(`MetaMask not found${others ? ` (detected: ${others})` : ''}. Install/enable MetaMask in this Chrome profile, or disable the other wallet extension for this page.`, true);
    return;
  }
  if (S.eth !== found.provider) {
    S.eth = found.provider;
    S.eth.on?.('accountsChanged', (a) => onAccounts(a));
    S.eth.on?.('chainChanged', () => { updateChainBadge(); recalc(); });
  }
  try {
    const accts = await S.eth.request({ method: 'eth_requestAccounts' });
    await onAccounts(accts);
    await ensureChain();
  } catch (e) {
    toast(errMsg(e), true);
  }
}
async function onAccounts(accts) {
  S.account = accts && accts[0] ? getAddress(accts[0]) : null;
  S.wallet = S.account ? createWalletClient({ account: S.account, chain: L.elysium, transport: custom(S.eth) }) : null;
  $('acct').textContent = S.account ? short(S.account) : '';
  $('connectBtn').textContent = S.account ? 'Connected' : 'Connect MetaMask';
  $('connectBtn').disabled = !!S.account;
  await updateChainBadge();
  await refreshBalances();
  await refreshSwap();
  await renderPositions();
  recalc();
  const rec = loadMig();
  if (rec && !rec.finished) { $('migrateCard').classList.remove('hidden'); await refreshMigration(); }
  else $('migrateCard').classList.add('hidden');
}
async function updateChainBadge() {
  if (!S.eth || !S.account) {
    $('netBadge').textContent = 'Read-only';
    $('netBadge').className = 'badge';
    setCheck('chkChain', null, 'Wallet not connected');
    return;
  }
  S.walletChainId = Number(await S.eth.request({ method: 'eth_chainId' }));
  const ok = S.walletChainId === L.CHAIN_ID;
  $('netBadge').textContent = ok ? 'Elysium' : `Wrong network (${S.walletChainId})`;
  $('netBadge').className = 'badge ' + (ok ? 'ok' : 'bad');
  setCheck('chkChain', ok, ok ? 'MetaMask on Elysium (99901)' : 'MetaMask on another network — will ask to switch');
}
async function ensureChain() {
  const hex = '0x' + L.CHAIN_ID.toString(16);
  const cur = Number(await S.eth.request({ method: 'eth_chainId' }));
  if (cur !== L.CHAIN_ID) {
    try {
      await S.eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code === 4902 || e?.data?.originalError?.code === 4902 || /Unrecognized chain/i.test(e.message || '')) {
        await S.eth.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: hex, chainName: 'Elysium', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: [L.RPC_URL], blockExplorerUrls: [L.EXPLORER] }],
        });
      } else throw e;
    }
  }
  await updateChainBadge();
  if (S.walletChainId !== L.CHAIN_ID) throw new Error('MetaMask is not on Elysium (99901).');
}
// USD value of wallet holdings. Prices come from the on-chain Uniswap v4 pools on Elysium:
// HYPE = USDC/HYPE 0.3% pool, KNTQ = KNTQ/HYPE 0.8% pool × HYPE price, USDC counted as $1.
async function refreshWalletUsd() {
  if (!S.balances) return;
  const fmt = (n) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    const ctx = await L.readSwapContext(pub, null);
    const hypeUsd = ctx.hypeUsd;
    const kntqUsd = hypeUsd / ctx.kntqPerHype;
    const { b0, b1, h } = S.balances;
    const u = Number(formatUnits(b0, 6));
    const k = Number(formatUnits(b1, 18)) * kntqUsd;
    const y = Number(formatUnits(h, 18)) * hypeUsd;
    $('vUsdc').textContent = fmt(u);
    $('vKntq').textContent = fmt(k);
    $('vHype').textContent = fmt(y);
    $('vTotal').textContent = fmt(u + k + y);
    $('vPrices').textContent = `KNTQ $${kntqUsd.toFixed(4)} · HYPE $${hypeUsd.toFixed(2)} · on-chain Uniswap v4 prices, updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    ['vUsdc', 'vKntq', 'vHype', 'vTotal'].forEach((id) => ($(id).textContent = '—'));
    $('vPrices').textContent = 'USD prices unavailable: ' + errMsg(e);
  }
}

async function refreshBalances() {
  if (!S.account) {
    ['bUsdc', 'bKntq', 'bHype', 'vUsdc', 'vKntq', 'vHype', 'vTotal'].forEach((id) => ($(id).textContent = '—'));
    $('vPrices').textContent = '';
    S.balances = null;
    return;
  }
  try {
    const [b0, b1, h] = await Promise.all([
      pub.readContract({ address: L.ADDR.USDC, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [S.account] }),
      pub.readContract({ address: L.ADDR.KNTQ, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [S.account] }),
      pub.getBalance({ address: S.account }),
    ]);
    S.balances = { b0, b1, h };
    $('bUsdc').textContent = L.fmtUsdc(b0, 6);
    $('bKntq').textContent = L.fmtKntq(b1, 6);
    $('bHype').textContent = L.fmtAmount(h, 18, 6);
    await refreshWalletUsd();
  } catch (e) {
    $('bUsdc').textContent = 'error';
    toast('Balance read failed: ' + errMsg(e), true);
  }
}

// ---------------------------------------------------------------- transactions
const modal = $('modal');
function confirmTx(req) {
  return new Promise(async (resolve) => {
    const p = req.preview;
    $('mTitle').textContent = p.title;
    $('mContract').textContent = p.contract;
    $('mFn').textContent = p.fn;
    $('mLines').innerHTML = '';
    for (const line of p.lines) {
      const li = document.createElement('li');
      li.textContent = line;
      if (/^(Tool fee|You receive)/.test(line)) li.className = 'fee-line';
      $('mLines').appendChild(li);
    }
    const sim = $('mSim');
    sim.className = 'sim';
    sim.textContent = 'Simulating on-chain…';
    $('mOk').disabled = true;
    modal.returnValue = '';
    modal.showModal();
    modal.addEventListener('close', () => resolve(modal.returnValue === 'ok' ? req._simulated : null), { once: true });
    try {
      // req.tx is set only by the lib: HYPE swaps (value = amountIn), USDC->HYPE swaps (gas/fee caps only) and
      // native-HYPE mints (value = amount0Max, swept back if unused). LP requests in the USDC pool have none.
      const { request } = await pub.simulateContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, account: S.account, ...req.tx });
      req._simulated = request;
      sim.className = 'sim ok';
      sim.textContent = 'Simulation OK — this transaction should succeed.';
      $('mOk').disabled = false;
    } catch (e) {
      sim.className = 'sim bad';
      sim.textContent = 'Simulation failed, not sending: ' + errMsg(e);
    }
  });
}
function logTx(label, hash) {
  const ul = $('txlog');
  if (ul.firstElementChild?.classList.contains('muted')) ul.innerHTML = '';
  const li = document.createElement('li');
  li.innerHTML = `<span></span><span><span class="st st-pend">pending</span> · <a target="_blank" rel="noopener"></a></span>`;
  li.firstChild.textContent = label;
  const a = li.querySelector('a');
  a.href = L.txUrl(hash);
  a.textContent = short(hash);
  ul.prepend(li);
  return (ok) => {
    const st = li.querySelector('.st');
    st.className = 'st ' + (ok ? 'st-ok' : 'st-fail');
    st.textContent = ok ? 'confirmed' : 'reverted';
  };
}
/** Preview → simulate → MetaMask sign → wait. Returns the receipt, or null if cancelled. */
async function sendTx(req) {
  if (!canWrite()) throw new Error(writeBlockReason());
  if (req.kind === 'swap' && S.swapOk !== true) throw new Error('Swap router / HYPE pool checks not passed: swaps disabled.');
  if (req.tx && !L.txValueAllowed(req)) throw new Error('Only swaps and native-HYPE mints may carry a transaction value.');
  if (req.pool) L.assertLpPool(req.pool);
  L.assertTargetPool();
  await ensureChain();
  const request = await confirmTx(req);
  if (!request) return null;
  // Always send explicit fee caps with headroom (see L.readGasFees); swaps / native mints already carry them in req.tx.
  const fees = req.tx?.maxFeePerGas ? {} : await L.readGasFees(pub);
  const hash = await S.wallet.writeContract({ ...request, ...fees, account: S.account, chain: L.elysium });
  // let the caller persist the hash BEFORE waiting (the move panel resumes from it if the page dies here)
  try { req.onHash?.(hash); } catch {}
  const done = logTx(req.preview.title, hash);
  toast('Submitted. Waiting for confirmation…');
  const receipt = await pub.waitForTransactionReceipt({ hash });
  done(receipt.status === 'success');
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${L.txUrl(hash)}`);
  toast('Confirmed ✓');
  return receipt;
}

// ---------------------------------------------------------------- step 1: get tokens (HYPE -> USDC / KNTQ, USDC -> HYPE)
const OUTS = ['USDC', 'KNTQ'];
const fmtHype = (x) => `${L.fmtAmount(x, 18, 6)} HYPE`;
const swapSlipBps = () => {
  const v = Number($('swSlip').value);
  if (!(v >= 0.05 && v <= L.MAX_SWAP_SLIPPAGE_BPS / 100)) throw new Error(`Swap slippage must be between 0.05% and ${L.MAX_SWAP_SLIPPAGE_BPS / 100}%`);
  return Math.round(v * 100);
};
const swapInput = (out) => $('swIn' + out);
const swapBtn = (out) => document.querySelector(`[data-swap="${out}"]`);

async function refreshSwap() {
  try {
    S.swap = await L.readSwapContext(pub, S.account);
  } catch (e) {
    S.swap = null;
    $('swHypeUsd').textContent = 'unavailable: ' + errMsg(e);
    OUTS.forEach((o) => (swapBtn(o).disabled = true));
    $('usBtn').disabled = true;
    return;
  }
  const c = S.swap;
  S.hypeUsd = c.hypeUsd;
  $('swHypeUsd').textContent = `$${c.hypeUsd.toFixed(4)} · ${c.kntqPerHype.toPrecision(5)} KNTQ`;
  $('swReserve').textContent = `${fmtHype(c.reserve)} ≈ $${((c.hypeUsd * Number(c.reserve)) / 1e18).toFixed(2)} (≥ $${L.HYPE_RESERVE_USD})`;
  if (c.balance === null) {
    $('swBal').textContent = 'connect wallet';
    $('swSpendable').textContent = '—';
  } else {
    $('swBal').textContent = fmtHype(c.balance);
    $('swSpendable').textContent = c.max > 0n ? `${fmtHype(c.max)} (after reserve and a gas buffer of ${fmtHype(c.gasBuffer)})` : 'nothing: your HYPE is at or below the reserve';
  }
  OUTS.forEach((o) => updateSwapRow(o));
  updateUsdcRow();
}

/** Validates the typed amount against the reserve and enables the button. Quote is fetched separately (debounced). */
function updateSwapRow(out) {
  const btn = swapBtn(out);
  btn.disabled = true;
  btn.title = '';
  let amt;
  try {
    amt = parseAmt(swapInput(out).value, 18);
    swapSlipBps();
  } catch (e) {
    $('swQuote' + out).innerHTML = `<span class="err"></span>`;
    $('swQuote' + out).firstChild.textContent = e.message;
    return null;
  }
  if (!amt) return null;
  if (!canWrite() || S.swapOk !== true) {
    btn.title = S.swapOk !== true ? 'Swap checks not passed' : writeBlockReason();
  } else if (S.swap?.max !== null && S.swap?.max !== undefined && amt > S.swap.max && S.swap.max === 0n) {
    btn.title = 'Nothing spendable: your HYPE is at or below the reserve';
  } else if (!S.busy) {
    // amt > max (max > 0) stays enabled: swapHype re-reads balance/reserve/gas and clamps to max.
    btn.disabled = false;
    if (S.swap?.max !== null && S.swap?.max !== undefined && amt > S.swap.max) btn.title = 'More than spendable: Swap will clamp it to max';
  }
  return amt;
}

const quoteTimers = {};
function scheduleQuote(out) {
  clearTimeout(quoteTimers[out]);
  const amt = updateSwapRow(out);
  const box = $('swQuote' + out);
  if (!amt) {
    if (!swapInput(out).value) box.textContent = `Pool fee ${(L.SWAP_POOLS[out].key.fee / 10000).toFixed(1)}%. Type an amount to get a quote.`;
    return;
  }
  box.textContent = 'Quoting…';
  quoteTimers[out] = setTimeout(() => showQuote(out, amt), 350);
}
async function showQuote(out, amt) {
  const box = $('swQuote' + out);
  const tok = L.SWAP_POOLS[out].out;
  try {
    const bps = swapSlipBps();
    // Same execute() the swap signs, eth_call'd with min out = 2^128-1; the revert carries the exact output.
    const [q, st] = await Promise.all([
      L.quoteHypeSwap(pub, { out, amountIn: amt, from: S.account || undefined }),
      L.readPoolState(pub, undefined, L.SWAP_POOLS[out].id),
    ]);
    if (swapInput(out).value === '' || parseAmt(swapInput(out).value, 18) !== amt) return; // input changed meanwhile
    const impact = L.priceImpactPct(L.midOutForHype(st.sqrtPriceX96, amt), st.lpFee, q);
    const min = L.withSlippageDown(q, bps);
    const usd = S.swap ? (S.swap.hypeUsd * Number(amt)) / 1e18 : null;
    let warn = '';
    if (S.swap?.max !== null && S.swap?.max !== undefined && amt > S.swap.max) {
      warn = S.swap.max > 0n
        ? `<div class="warn">More than spendable (${fmtHype(S.swap.max)}). Swap will clamp it to max.</div>`
        : `<div class="warn">Nothing spendable: your HYPE is at or below the ${fmtHype(S.swap.reserve)} reserve.</div>`;
    }
    box.innerHTML = `≈ <b>${L.fmtAmount(q, tok.decimals, 6)} ${out}</b>${usd !== null ? ` for ≈ $${usd.toFixed(2)}` : ''}<br>
      min ${L.fmtAmount(min, tok.decimals, 6)} at ${(bps / 100).toFixed(2)}% · impact ${impact.toFixed(3)}% · fee ${(st.lpFee / 10000).toFixed(1)}%${warn}`;
    if (impact > 3) box.insertAdjacentHTML('beforeend', `<div class="warn">High price impact. Consider a smaller amount.</div>`);
  } catch (e) {
    box.innerHTML = `<span class="err"></span>`;
    box.firstChild.textContent = errMsg(e);
  }
}

function setMax(out) {
  if (!S.swap || S.swap.max === null) return toast('Connect your wallet first.', true);
  // MAX = balance - reserve - gas buffer
  swapInput(out).value = S.swap.max > 0n ? trimZeros(formatUnits(S.swap.max, 18)) : '0';
  scheduleQuote(out);
}

function splitForLp() {
  if (!S.swap || S.swap.balance === null) return toast('Connect your wallet first.', true);
  if (S.lp === 'HYPE') {
    // KNTQ/HYPE pool: swap only the KNTQ share; the HYPE share stays as HYPE for the mint (one swap + the mint's gas).
    const spendable = L.maxHypeSwap({ balance: S.swap.balance, reserve: S.swap.reserve, gasCost: S.swap.gasBuffer + L.LP_MINT_GAS_BUFFER_UNITS * S.swap.fees.maxFeePerGas });
    if (spendable === 0n) return toast('Nothing to split: your HYPE is at or below the reserve.', true);
    let frac0 = 0.5;
    let why = 'no range selected yet: 50 / 50 by value';
    if (S.pool) {
      try {
        const r = currentRange();
        frac0 = L.lpToken0ValueFraction(S.pool, r.tickLower, r.tickUpper, 'HYPE');
        why = `this range needs ${(frac0 * 100).toFixed(1)}% HYPE / ${(100 - frac0 * 100).toFixed(1)}% KNTQ by value`;
      } catch {}
    }
    const s = L.splitHypeForLp(spendable, frac0); // toUsdc = HYPE share kept, toKntq = swapped
    swapInput('USDC').value = '';
    swapInput('KNTQ').value = s.toKntq > 0n ? trimZeros(formatUnits(s.toKntq, 18)) : '';
    $('splitDesc').textContent = `KNTQ/HYPE pool selected: swap ${fmtHype(s.toKntq)} → KNTQ and keep ${fmtHype(s.toUsdc)} as the HYPE side (${why}).`;
    OUTS.forEach(scheduleQuote);
    return;
  }
  // two swaps -> two gas buffers
  const spendable = L.maxHypeSwap({ balance: S.swap.balance, reserve: S.swap.reserve, gasCost: 2n * S.swap.gasBuffer });
  if (spendable === 0n) return toast('Nothing to split: your HYPE is at or below the reserve.', true);
  let frac = 0.5;
  let why = 'no range selected yet: 50 / 50 by value';
  if (S.pool) {
    try {
      const r = currentRange();
      frac = L.lpUsdcValueFraction(S.pool, r.tickLower, r.tickUpper);
      const d = L.describeRange(r.tickLower, r.tickUpper);
      why = `${d.full ? 'full range' : S.preset === 'custom' ? 'custom range' : S.preset.replace('pm', '±') + '%'} needs ${(frac * 100).toFixed(1)}% USDC / ${(100 - frac * 100).toFixed(1)}% KNTQ by value`;
    } catch {}
  }
  const s = L.splitHypeForLp(spendable, frac);
  swapInput('USDC').value = trimZeros(formatUnits(s.toUsdc, 18));
  swapInput('KNTQ').value = trimZeros(formatUnits(s.toKntq, 18));
  $('splitDesc').textContent = `Suggested from ${fmtHype(spendable)} spendable: ${why}. Swap fees and price impact shift it a little.`;
  OUTS.forEach(scheduleQuote);
}

async function swapHype(out) {
  if (S.busy) return;
  S.busy = true;
  OUTS.forEach((o) => (swapBtn(o).disabled = true));
  try {
    if (S.swapOk !== true) throw new Error('Swap router / HYPE pool checks not passed: swaps disabled.');
    await ensureChain();
    let amountIn = parseAmt(swapInput(out).value, 18);
    if (!amountIn) throw new Error('Enter a HYPE amount.');
    await refreshSwap(); // fresh balance, price, reserve
    if (!S.swap || S.swap.max === null) throw new Error('Could not read HYPE price / balance. Try again.');
    if (amountIn > S.swap.max) {
      if (S.swap.max === 0n) throw new Error(`Refused: your HYPE is at or below the ${fmtHype(S.swap.reserve)} reserve.`);
      amountIn = S.swap.max; // clamp
      swapInput(out).value = trimZeros(formatUnits(amountIn, 18));
      toast(`Clamped to the max you can swap: ${fmtHype(amountIn)} (reserve ${fmtHype(S.swap.reserve)} kept).`);
    }
    const plan = await L.planHypeSwap(pub, { out, amountIn, account: S.account, slippageBps: swapSlipBps(), nowSec: await latestTs() });
    const receipt = await sendTx(plan.req);
    if (!receipt) return toast('Cancelled. Nothing was sent.');
    const got = L.parseTokenReceived(receipt, plan.token.address, S.account);
    toast(`Received ${L.fmtAmount(got, plan.token.decimals, 6)} ${out} ✓`);
    swapInput(out).value = '';
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    S.busy = false;
    await refreshBalances();
    await refreshSwap();
    OUTS.forEach(scheduleQuote);
    recalc();
  }
}

// ---- USDC -> HYPE (exact USDC in; approvals USDC -> Permit2 -> UniversalRouter, exact amount, 30 min)
function updateUsdcRow() {
  const btn = $('usBtn');
  btn.disabled = true;
  btn.title = '';
  let amt;
  try {
    amt = parseAmt($('usIn').value, 6);
    swapSlipBps();
  } catch (e) {
    $('usQuote').innerHTML = `<span class="err"></span>`;
    $('usQuote').firstChild.textContent = e.message;
    return null;
  }
  if (!amt) return null;
  if (!canWrite() || S.swapOk !== true) btn.title = S.swapOk !== true ? 'Swap checks not passed' : writeBlockReason();
  else if (S.balances && amt > S.balances.b0) btn.title = 'More USDC than you have';
  else if (!S.busy) btn.disabled = false;
  return amt;
}
let usTimer = null;
function scheduleUsdcQuote() {
  clearTimeout(usTimer);
  const amt = updateUsdcRow();
  const box = $('usQuote');
  if (!amt) {
    if (!$('usIn').value) box.textContent = 'Pool fee 0.3%. Type a USDC amount to get a quote.';
    return;
  }
  box.textContent = 'Quoting…';
  usTimer = setTimeout(async () => {
    try {
      const bps = swapSlipBps();
      const [q, st] = await Promise.all([
        L.quoteUsdcToHype(pub, { amountIn: amt, from: S.account || undefined }),
        L.readPoolState(pub, undefined, L.SWAP_POOLS.USDC.id),
      ]);
      if (parseAmt($('usIn').value, 6) !== amt) return;
      const impact = L.priceImpactPct(L.midHypeForUsdc(st.sqrtPriceX96, amt), st.lpFee, q);
      const min = L.withSlippageDown(q, bps);
      box.innerHTML = `≈ <b>${L.fmtAmount(q, 18, 6)} HYPE</b><br>min ${L.fmtAmount(min, 18, 6)} at ${(bps / 100).toFixed(2)}% · impact ${impact.toFixed(3)}% · fee ${(st.lpFee / 10000).toFixed(1)}%` +
        (S.balances && amt > S.balances.b0 ? `<div class="warn">You have only ${L.fmtUsdc(S.balances.b0, 6)} USDC.</div>` : '');
    } catch (e) {
      box.innerHTML = `<span class="err"></span>`;
      box.firstChild.textContent = errMsg(e);
    }
  }, 350);
}
/**
 * Runs a planUsdcSwap plan: approvals (if any) -> re-plan on fresh state -> swap. Returns { receipt, received } or null.
 * onSwapHash(hash) is called as soon as the wallet returns the swap's hash (before it is mined).
 */
async function runUsdcSwap(amountIn, slippageBps, onSwapHash) {
  let plan = await L.planUsdcSwap(pub, { amountIn, account: S.account, slippageBps, nowSec: await latestTs() });
  for (const t of plan.txs.filter((x) => x.kind !== 'swap')) {
    const r = await sendTx(t);
    if (!r) return null;
  }
  if (plan.needsApprovals) plan = await L.planUsdcSwap(pub, { amountIn, account: S.account, slippageBps, nowSec: await latestTs() });
  if (onSwapHash) plan.req.onHash = onSwapHash;
  const before = await pub.getBalance({ address: S.account });
  const receipt = await sendTx(plan.req);
  if (!receipt) return null;
  const after = await pub.getBalance({ address: S.account, blockNumber: receipt.blockNumber });
  return { receipt, received: L.hypeReceivedFromSwap({ balanceBefore: before, balanceAfter: after, receipt }), plan };
}
async function swapUsdc() {
  if (S.busy) return;
  S.busy = true;
  $('usBtn').disabled = true;
  try {
    if (S.swapOk !== true) throw new Error('Swap router / HYPE pool checks not passed: swaps disabled.');
    await ensureChain();
    const amountIn = parseAmt($('usIn').value, 6);
    if (!amountIn) throw new Error('Enter a USDC amount.');
    const r = await runUsdcSwap(amountIn, swapSlipBps());
    if (!r) return toast('Cancelled. Nothing else was sent.');
    toast(`Received ${fmtHype(r.received)} ✓`);
    $('usIn').value = '';
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    S.busy = false;
    await refreshBalances();
    await refreshSwap();
    scheduleUsdcQuote();
    recalc();
  }
}

// ---------------------------------------------------------------- add liquidity
function currentRange() {
  const custom = { minUsd: Number($('minUsd').value), maxUsd: Number($('maxUsd').value), usdPerQuote: S.hypeUsd };
  return L.rangeForPreset(S.preset, S.pool.tick, custom, S.lp);
}
/** HYPE that may go into a KNTQ/HYPE mint as amount0Max (balance - reserve - mint gas), or null without a wallet. */
const hypeLpMax = () => (S.swap && S.swap.balance !== null ? L.maxHypeForLp(S.swap) : null);
function recalc() {
  const btn = $('reviewMint');
  const sum = $('mintSummary');
  btn.disabled = true;
  S.plan = null;
  if (!S.pool) return;
  const p = P();
  const dec0 = p.token0.decimals;
  let range;
  try {
    range = currentRange();
  } catch (e) {
    $('rangeDesc').textContent = e.message;
    sum.innerHTML = '';
    return;
  }
  const d = L.describeRange(range.tickLower, range.tickUpper, S.lp, L.usdPerQuote(S.lp, S.hypeUsd));
  const inR = S.pool.tick >= range.tickLower && S.pool.tick < range.tickUpper;
  $('rangeDesc').innerHTML = '';
  $('rangeDesc').textContent = d.full
    ? `Full range: $0 → ∞ per KNTQ (ticks ${range.tickLower} … ${range.tickUpper}). Always in range, lowest fee concentration.`
    : `$${fmtPrice(d.minUsdPerKntq)} → $${fmtPrice(d.maxUsdPerKntq)} per KNTQ${S.lp === 'HYPE' ? ` (${fmtPrice(d.minQuotePerKntq)} → ${fmtPrice(d.maxQuotePerKntq)} HYPE)` : ''} (ticks ${range.tickLower} … ${range.tickUpper}, aligned to ${p.key.tickSpacing})${inR ? '' : ' — OUT OF RANGE: single-sided deposit'}`;
  const needs0 = S.pool.tick < range.tickUpper;
  const needs1 = S.pool.tick >= range.tickLower;
  $('amt0').disabled = !needs0;
  $('amt1').disabled = !needs1;
  $('amt0Hint').textContent = needs0 ? (S.lp === 'HYPE' ? 'max = HYPE above your gas reserve' : '') : 'Not needed for this range';
  $('amt1Hint').textContent = needs1 ? '' : 'Not needed for this range';
  // S.anchor is the field the user TYPED; the other field is calculated. If the range no longer uses the
  // typed token, never fall back to the calculated number from the old range: clear it and ask again.
  let askAgain = null;
  if ((!needs0 && S.anchor === 'amount0') || (!needs1 && S.anchor === 'amount1')) {
    const calcField = S.anchor === 'amount0' ? 'amt1' : 'amt0';
    $(calcField).value = '';
    askAgain = S.anchor === 'amount0' ? 'KNTQ' : p.token0.symbol;
    S.anchor = null;
  }
  // The calculated side of a token this range does not use is stale: clear it so it is never reused.
  if (S.anchor === 'amount0' && !needs1) $('amt1').value = '';
  if (S.anchor === 'amount1' && !needs0) $('amt0').value = '';
  if (askAgain) {
    sum.innerHTML = `<span class="err">This range only takes ${askAgain}. Enter a ${askAgain} amount.</span>`;
    return;
  }

  let a0, a1, bps;
  try {
    a0 = needs0 ? parseAmt($('amt0').value, dec0) : 0n;
    a1 = needs1 ? parseAmt($('amt1').value, 18) : 0n;
    bps = slipBps();
  } catch (e) {
    sum.innerHTML = `<span class="err"></span>`;
    sum.firstChild.textContent = e.message;
    return;
  }
  const anchor = S.anchor || (a0 ? 'amount0' : a1 ? 'amount1' : null);
  if (!anchor || (anchor === 'amount0' ? !a0 : !a1)) {
    sum.textContent = 'Enter an amount to see the plan.';
    return;
  }
  // Remember which side is the user's number, so the side filled in below is never treated as typed later.
  S.anchor = anchor;
  let plan;
  try {
    plan = L.planMint(S.pool, range.tickLower, range.tickUpper, { amount0: a0, amount1: a1, anchor }, bps, S.lp);
  } catch (e) {
    sum.innerHTML = `<span class="err"></span>`;
    sum.firstChild.textContent = e.message;
    return;
  }
  // fill the derived side
  if (anchor === 'amount0' && needs1) $('amt1').value = trimZeros(formatUnits(plan.amount1, 18));
  if (anchor === 'amount1' && needs0) $('amt0').value = trimZeros(formatUnits(plan.amount0, dec0));
  S.plan = plan;
  const usd = L.poolUsdValue(S.lp, plan.amount0, plan.amount1, S.pool.sqrtPriceX96, S.hypeUsd);
  const tvlUsd = S.tvl ? L.poolUsdValue(S.lp, S.tvl.amount0, S.tvl.amount1, S.pool.sqrtPriceX96, S.hypeUsd) : null;
  const share = inR && S.pool.liquidity > 0n ? Number((plan.liquidity * 10000n) / (S.pool.liquidity + plan.liquidity)) / 100 : null;
  const problems = [];
  if (plan.liquidity === 0n) problems.push('Amount too small: liquidity rounds to 0.');
  if (S.balances) {
    if (S.lp === 'USDC' && plan.amount0 > S.balances.b0) problems.push(`Not enough USDC (need ${L.fmtUsdc(plan.amount0, 6)}).`);
    if (plan.amount1 > S.balances.b1) problems.push(`Not enough KNTQ (need ${L.fmtKntq(plan.amount1, 6)}).`);
    if (S.balances.h === 0n) problems.push('You have no HYPE for gas.');
  }
  if (S.lp === 'HYPE' && plan.amount0Max > 0n) {
    const lpMax = hypeLpMax();
    if (lpMax !== null && plan.amount0Max > lpMax) problems.push(`Needs ${fmtHype(plan.amount0Max)} incl. slippage, but only ${fmtHype(lpMax)} is free above your HYPE gas reserve (${S.swap ? fmtHype(S.swap.reserve) : '—'}).`);
  }
  sum.innerHTML = `<table>
    <tr><td>Deposit</td><td>${fmtQ(S.lp, plan.amount0)} + ${L.fmtKntq(plan.amount1, 6)} KNTQ ≈ ${fmtUsd(usd)}</td></tr>
    <tr><td>Max with ${(bps / 100).toFixed(2)}% slippage</td><td>${fmtQ(S.lp, plan.amount0Max)} + ${L.fmtKntq(plan.amount1Max, 6)} KNTQ</td></tr>
    ${S.lp === 'HYPE' && plan.amount0Max > 0n ? `<tr><td>Transaction value</td><td>${fmtHype(plan.amount0Max)} (unused HYPE is swept back)</td></tr>` : ''}
    <tr><td>Liquidity units</td><td class="mono">${plan.liquidity}</td></tr>
    ${share !== null ? `<tr><td>Share of active liquidity</td><td>${share.toFixed(2)}%</td></tr>` : ''}
    ${tvlUsd ? `<tr><td>Pool TVL now</td><td>${fmtUsd(tvlUsd)}</td></tr>` : ''}
  </table>${problems.map((x) => `<div class="err">${esc(x)}</div>`).join('')}`;
  btn.disabled = !canWrite() || problems.length > 0 || S.busy;
  btn.title = canWrite() ? '' : writeBlockReason();
}

async function reviewMint() {
  if (S.busy) return;
  S.busy = true;
  $('reviewMint').disabled = true;
  const stepsEl = $('mintSteps');
  stepsEl.innerHTML = '';
  try {
    await ensureChain();
    await refreshPool(); // fresh price right before planning
    await refreshBalances();
    await refreshSwap();
    recalc();
    const plan = S.plan;
    if (!plan) throw new Error('No valid plan. Check the amounts.');
    const txs = await L.planMintTxs(pub, S.account, plan, { infinite: $('infinite').checked, nowSec: await latestTs() });
    const lis = txs.map((t) => {
      const li = document.createElement('li');
      li.textContent = t.preview.title;
      stepsEl.appendChild(li);
      return li;
    });
    let receipt;
    for (let i = 0; i < txs.length; i++) {
      lis[i].className = 'active';
      if (txs[i].kind === 'mint') {
        // deadline relative to the chain clock at signing time
        const fresh = L.buildMint({ plan, owner: S.account, deadline: L.deadlineFromNow(600, await latestTs()) });
        // native HYPE pool: exact gas estimate + reserve check (balance - value - gas >= reserve), pins req.tx
        await L.guardNativeMint(pub, fresh, S.account);
        Object.assign(txs[i], fresh);
      }
      receipt = await sendTx(txs[i]);
      if (!receipt) {
        lis[i].className = 'fail';
        lis[i].textContent += ' — cancelled';
        toast('Cancelled. Nothing else was sent.');
        return;
      }
      lis[i].className = 'done';
      lis[i].textContent += ' ✓';
    }
    const tokenId = L.parseMintedTokenId(receipt, S.account);
    if (tokenId === null) throw new Error('Minted, but could not find the tokenId in the receipt. Check the explorer.');
    saveIds([...loadIds(), tokenId.toString()]);
    showMinted(tokenId, receipt, P().label);
    $('amt0').value = '';
    $('amt1').value = '';
    S.anchor = null;
  } catch (e) {
    toast(errMsg(e), true);
    const act = stepsEl.querySelector('li.active');
    if (act) { act.className = 'fail'; act.textContent += ' — failed: ' + errMsg(e); }
  } finally {
    S.busy = false;
    await refreshPool();
    await refreshBalances();
    await refreshSwap();
    await renderPositions();
    recalc();
  }
}
function showMinted(tokenId, receipt, label) {
  const b = $('mintedBanner');
  b.classList.remove('hidden');
  b.innerHTML = `<div class="label">Position minted in ${esc(label)} — write this down</div><div class="id">#${tokenId}</div>
    <div class="hint">Saved in this browser. You can always re-add it under “My positions”. <a target="_blank" rel="noopener" href="${L.txUrl(receipt.transactionHash)}">View transaction</a></div>`;
}

// ---------------------------------------------------------------- positions
const idsKey = () => `lp-helper:v1:${L.CHAIN_ID}:${(S.account || '').toLowerCase()}`;
function loadIds() {
  try {
    return JSON.parse(localStorage.getItem(idsKey()) || '[]');
  } catch {
    return [];
  }
}
function saveIds(ids) {
  const uniq = [...new Set(ids.map(String))].sort((a, b) => Number(a) - Number(b));
  try {
    localStorage.setItem(idsKey(), JSON.stringify(uniq));
  } catch {}
}

/** Reads a position in whichever LP pool it is in (KNTQ/USDC 2% or KNTQ/HYPE 0.8%). */
async function readAnyPosition(id) {
  const first = await L.readPosition(pub, BigInt(id), S.states.USDC, 'USDC');
  if (first.exists === false || first.samePool || first.lpPool !== 'HYPE') return first;
  return L.readPosition(pub, BigInt(id), S.states.HYPE, 'HYPE');
}

async function renderPositions() {
  const box = $('positions');
  if (!S.account) {
    box.innerHTML = '<p class="muted">Connect your wallet to see positions.</p>';
    return;
  }
  const ids = loadIds();
  if (!ids.length) {
    box.innerHTML = '<p class="muted">No positions saved yet. Mint one above, add a tokenId, or scan the chain.</p>';
    return;
  }
  if (!S.states.USDC || !S.states.HYPE) await refreshPool();
  box.innerHTML = '<p class="muted">Loading positions…</p>';
  const cards = [];
  for (const id of ids) {
    const card = document.createElement('div');
    card.className = 'pos';
    try {
      const owner = await pub
        .readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [BigInt(id)] })
        .catch(() => null);
      if (!owner) {
        card.innerHTML = `<div class="pos-head"><span class="pos-id">#${id}</span><span class="pill closed">burned / does not exist</span></div>`;
        addForget(card, id);
        cards.push(card);
        continue;
      }
      const pos = await readAnyPosition(id);
      if (!pos.samePool) {
        card.innerHTML = `<div class="pos-head"><span class="pos-id">#${id}</span><span class="pill closed">different pool — not managed here</span></div>`;
        addForget(card, id);
        cards.push(card);
        continue;
      }
      const pl = pos.lpPool;
      const st = S.states[pl];
      const mine = getAddress(owner) === S.account;
      const d = L.describeRange(pos.tickLower, pos.tickUpper, pl, L.usdPerQuote(pl, S.hypeUsd));
      const usd = L.poolUsdValue(pl, pos.amounts.amount0, pos.amounts.amount1, st.sqrtPriceX96, S.hypeUsd);
      const feesUsd = L.poolUsdValue(pl, pos.fees.amount0, pos.fees.amount1, st.sqrtPriceX96, S.hypeUsd);
      // what Collect / Remove would pay out of these fees: 90% to you, 10% tool fee (same math as the tx builders)
      const tf = L.toolFeeSplit(pos.fees);
      const userFeesUsd = L.poolUsdValue(pl, tf.user0, tf.user1, st.sqrtPriceX96, S.hypeUsd);
      const status = pos.liquidity === 0n ? ['closed', 'empty'] : pos.inRange ? ['in', 'in range · earning'] : ['out', 'out of range · not earning'];
      card.innerHTML = `
        <div class="pos-head"><span class="pos-id">#${id} <span class="pill pool">${L.LP_POOLS[pl].label}</span></span><span class="pill ${status[0]}">${status[1]}</span></div>
        <dl class="kv">
          <dt>Range ($/KNTQ)</dt><dd>${d.full ? 'Full range' : `$${fmtPrice(d.minUsdPerKntq)} → $${fmtPrice(d.maxUsdPerKntq)}`} <span class="muted small mono">[${pos.tickLower}, ${pos.tickUpper}]</span></dd>
          <dt>Liquidity</dt><dd class="mono">${pos.liquidity}</dd>
          <dt>Current amounts</dt><dd>${fmtQ(pl, pos.amounts.amount0)} + ${L.fmtKntq(pos.amounts.amount1, 6)} KNTQ ≈ ${fmtUsd(usd)}</dd>
          <dt>Uncollected fees</dt><dd>${fmtQ(pl, pos.fees.amount0)} + ${L.fmtKntq(pos.fees.amount1, 6)} KNTQ ≈ ${fmtUsd(feesUsd)}</dd>
          <dt>You receive 90%</dt><dd>${fmtQ(pl, tf.user0)} + ${L.fmtKntq(tf.user1, 6)} KNTQ ≈ ${fmtUsd(userFeesUsd)} <span class="muted small">· tool fee 10%: ${fmtQ(pl, tf.fee0)} + ${L.fmtKntq(tf.fee1, 6)} KNTQ, taken only when you collect or remove</span></dd>
          ${mine ? '' : `<dt>Owner</dt><dd class="mono small">${owner} (not you — read only)</dd>`}
        </dl>`;
      if (mine && pos.liquidity === 0n) {
        // Emptied without burning (e.g. "Remove 100%" with burn unticked): nothing left to collect or remove,
        // but the NFT can still be cleaned up.
        const act = document.createElement('div');
        act.className = 'pos-actions';
        act.innerHTML = `<span class="muted small">This position is empty (liquidity 0, fees already paid out).</span>
          <button class="btn small danger" data-a="burn">Burn empty NFT</button>`;
        const b = act.querySelector('[data-a=burn]');
        b.disabled = !canWrite();
        b.title = canWrite() ? '' : writeBlockReason();
        b.addEventListener('click', () => burnEmpty(pos));
        card.appendChild(act);
      } else if (mine) {
        const act = document.createElement('div');
        act.className = 'pos-actions';
        act.innerHTML = `
          <button class="btn small" data-a="collect">Collect fees</button>
          <span class="muted small">Remove</span>
          <input type="number" min="1" max="100" step="1" value="100" aria-label="percent to remove" />%
          <button class="btn ghost small" data-pct="25">25%</button><button class="btn ghost small" data-pct="50">50%</button><button class="btn ghost small" data-pct="100">100%</button>
          <label class="chk small"><input type="checkbox" data-burn /> burn NFT (100% only)</label>
          <button class="btn small danger" data-a="remove">Remove</button>
          ${pl === 'USDC' ? '<button class="btn small primary" data-a="move">Move to KNTQ/HYPE 0.8%</button>' : ''}`;
        const pctIn = act.querySelector('input[type=number]');
        const burnIn = act.querySelector('[data-burn]');
        const syncBurn = () => { burnIn.disabled = Number(pctIn.value) !== 100; if (burnIn.disabled) burnIn.checked = false; };
        pctIn.addEventListener('input', syncBurn);
        act.querySelectorAll('[data-pct]').forEach((b) => b.addEventListener('click', () => { pctIn.value = b.dataset.pct; syncBurn(); }));
        act.querySelector('[data-a=collect]').disabled = !canWrite();
        act.querySelector('[data-a=remove]').disabled = !canWrite();
        act.querySelector('[data-a=collect]').addEventListener('click', () => collect(pos));
        act.querySelector('[data-a=remove]').addEventListener('click', () => remove(pos, Number(pctIn.value), burnIn.checked));
        act.querySelector('[data-a=move]')?.addEventListener('click', () => openMigration(pos.tokenId));
        card.appendChild(act);
      }
      addForget(card, id);
    } catch (e) {
      card.innerHTML = `<div class="pos-head"><span class="pos-id">#${id}</span><span class="pill out">error</span></div><p class="hint"></p>`;
      card.querySelector('.hint').textContent = errMsg(e);
      addForget(card, id);
    }
    cards.push(card);
  }
  box.innerHTML = '';
  cards.forEach((c) => box.appendChild(c));
}
function addForget(card, id) {
  const b = document.createElement('button');
  b.className = 'link';
  b.textContent = 'forget';
  b.style.marginTop = '8px';
  b.addEventListener('click', () => { saveIds(loadIds().filter((x) => x !== String(id))); renderPositions(); });
  card.appendChild(b);
}
const poolIdOfPos = (pos) => L.LP_POOLS[pos.lpPool || 'USDC'].poolId;

async function collect(pos) {
  if (S.busy) return;
  S.busy = true;
  try {
    const state = await L.readPoolState(pub, undefined, poolIdOfPos(pos));
    const fresh = await L.readPosition(pub, pos.tokenId, state, pos.lpPool);
    const req = L.buildCollect({ tokenId: pos.tokenId, recipient: S.account, deadline: L.deadlineFromNow(600, await latestTs()), expectedFees: fresh.fees, pool: pos.lpPool });
    await sendTx(req);
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    S.busy = false;
    await refreshAll();
  }
}
async function remove(pos, pct, burn) {
  if (S.busy) return;
  if (!(pct >= 1 && pct <= 100) || !Number.isInteger(pct)) return toast('Percent must be a whole number 1–100.', true);
  S.busy = true;
  try {
    const state = await L.readPoolState(pub, undefined, poolIdOfPos(pos));
    const fresh = await L.readPosition(pub, pos.tokenId, state, pos.lpPool);
    const liquidity = pct === 100 ? fresh.liquidity : (fresh.liquidity * BigInt(pct)) / 100n;
    if (liquidity === 0n) throw new Error('Nothing to remove.');
    const d = L.planDecrease(state, fresh, liquidity, slipBps());
    const req = L.buildDecrease({
      tokenId: pos.tokenId,
      liquidity,
      amount0Min: d.amount0Min,
      amount1Min: d.amount1Min,
      recipient: S.account,
      deadline: L.deadlineFromNow(600, await latestTs()),
      burn: burn && pct === 100,
      expected: { ...d.expected, fees: fresh.fees },
      pool: pos.lpPool,
    });
    await sendTx(req);
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    S.busy = false;
    await refreshAll();
  }
}

async function burnEmpty(pos) {
  if (S.busy) return;
  S.busy = true;
  try {
    const state = await L.readPoolState(pub, undefined, poolIdOfPos(pos));
    const fresh = await L.readPosition(pub, pos.tokenId, state, pos.lpPool);
    if (fresh.liquidity !== 0n) throw new Error('This position has liquidity again. Use Remove 100% with "burn NFT" ticked instead.');
    const req = L.buildBurnEmpty({ tokenId: pos.tokenId, recipient: S.account, deadline: L.deadlineFromNow(600, await latestTs()), pool: pos.lpPool });
    const receipt = await sendTx(req);
    if (receipt) saveIds(loadIds().filter((x) => x !== pos.tokenId.toString()));
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    S.busy = false;
    await refreshAll();
  }
}

async function scan() {
  if (!S.account) return toast('Connect your wallet first.', true);
  const st = $('scanStatus');
  $('scanBtn').disabled = true;
  try {
    const ids = await L.scanTokenIdsTo(pub, S.account, {
      onProgress: (from, to, latest) => {
        const pct = Number(((to - L.POSM_DEPLOY_BLOCK) * 100n) / (latest - L.POSM_DEPLOY_BLOCK + 1n));
        st.textContent = `Scanning PositionManager transfers to you… ${pct}%`;
      },
    });
    const owned = [];
    for (const id of ids) {
      const owner = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
      if (!owner || getAddress(owner) !== S.account) continue;
      const [key] = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'getPoolAndPositionInfo', args: [id] });
      if (L.lpPoolOfKey(key)) owned.push(id.toString()); // KNTQ/USDC 2% or KNTQ/HYPE 0.8%
    }
    saveIds([...loadIds(), ...owned]);
    st.textContent = `Scan done: ${ids.length} NFT(s) ever received, ${owned.length} currently yours in the two pools.`;
    await renderPositions();
  } catch (e) {
    st.textContent = 'Scan failed: ' + errMsg(e);
  } finally {
    $('scanBtn').disabled = false;
  }
}

// ---------------------------------------------------------------- move a KNTQ/USDC position into KNTQ/HYPE 0.8%
// Three separate signed steps; before each one the page re-reads the chain (position, balances, pools) and decides
// what is left to do. Progress (amounts received, tx hashes) is kept in localStorage so the flow can be resumed; each
// step's tx hash is saved the moment the wallet returns it, and anything missing (lost save, other browser) is
// recovered from that receipt or from the logs (burn of #id, the router swap after it, the mint after that).
const MIN_USDC_TO_SWAP = 10_000n; // 0.01 USDC: below this step (b) counts as done
const migKey = () => `lp-helper:v1:migrate:${L.CHAIN_ID}:${(S.account || '').toLowerCase()}`;
function loadMig() {
  try { return JSON.parse(localStorage.getItem(migKey()) || 'null'); } catch { return null; }
}
function saveMig(rec) {
  try { rec ? localStorage.setItem(migKey(), JSON.stringify(rec)) : localStorage.removeItem(migKey()); } catch {}
}
const big = (x) => (x === undefined || x === null ? null : BigInt(x));
/** Read-only helper: retries a read when the RPC rate-limits (the public RPC answers "Rate Limit Exceeded"). */
async function withReadRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const m = `${e?.shortMessage || ''} ${e?.details || ''} ${e?.message || ''}`;
      if (i >= tries || !/rate limit|too many requests|\b429\b|timed? ?out/i.test(m)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}
const migSlipBps = () => {
  const v = Number($('migSlip').value);
  if (!(v >= 0.05 && v <= L.MAX_SWAP_SLIPPAGE_BPS / 100)) throw new Error(`Slippage must be between 0.05% and ${L.MAX_SWAP_SLIPPAGE_BPS / 100}%`);
  return Math.round(v * 100);
};

/** A tx hash saved before its receipt that the RPC has never seen counts as dropped after this long. */
const PENDING_DROP_MS = 10 * 60 * 1000;
function isNotFound(e) {
  return /NotFoundError$/.test(e?.name || '') || /could not be found/i.test(`${e?.shortMessage || ''} ${e?.message || ''}`);
}
const readUsdc = (blockNumber) => pub.readContract({ address: L.ADDR.USDC, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [S.account], ...(blockNumber !== undefined ? { blockNumber } : {}) });
/** The KNTQ/USDC position #id if it is yours and still holds liquidity, else null (burned, emptied or not yours). */
async function migLivePosition(id) {
  const owner = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
  if (!owner || getAddress(owner) !== S.account) return null;
  const pos = await L.readPosition(pub, id, await L.readPoolState(pub), 'USDC');
  return pos.samePool && pos.liquidity > 0n ? pos : null;
}

async function openMigration(tokenId) {
  const cur = loadMig();
  if (cur && !cur.finished && cur.tokenId !== String(tokenId)) {
    if (!confirm(`A move of position #${cur.tokenId} is still in progress. Forget it and start moving #${tokenId}?`)) return;
  }
  if (!cur || cur.finished || cur.tokenId !== String(tokenId)) {
    const rec = { tokenId: String(tokenId), preset: 'full', startedAt: Date.now() };
    // While the position is still live, the USDC in the wallet is USDC you already had: step (b) never swaps it
    // (refreshed again right before step (a) is sent). If (a) already happened (e.g. continued in another browser),
    // the page finds the burn tx in the logs and derives the rest from the chain.
    try {
      const [live, usdc, block] = await Promise.all([migLivePosition(BigInt(tokenId)), readUsdc(), pub.getBlockNumber()]);
      if (live) {
        rec.usdcBefore = usdc.toString();
        rec.startBlock = block.toString();
      } else rec.continued = true;
    } catch {}
    saveMig(rec);
  }
  $('migrateCard').classList.remove('hidden');
  $('migrateCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await refreshMigration();
}

/** Records what a mined step did, from its receipt (the live path and the resume path use the same code). */
async function applyMigReceipt(rec, step, receipt, hypeOut) {
  const hash = receipt.transactionHash;
  const block = receipt.blockNumber.toString();
  if (step === 'a') {
    rec.usdcReceived = L.parseTokenReceived(receipt, L.ADDR.USDC, S.account).toString();
    rec.kntqReceived = L.parseTokenReceived(receipt, L.ADDR.KNTQ, S.account).toString();
    rec.txA = hash;
    rec.blockA = block;
    saveIds(loadIds().filter((x) => x !== String(rec.tokenId)));
  } else if (step === 'b') {
    // HYPE the swap paid out = the PoolManager Swap event in its receipt; unknown -> step (c) caps at balance - reserve - gas
    const got = hypeOut ?? L.hypeOutFromSwapReceipt(receipt);
    if (got !== null && got !== undefined) rec.hypeReceived = got.toString();
    else delete rec.hypeReceived;
    rec.txB = hash;
    rec.blockB = block;
  } else if (step === 'c') {
    const tokenId = L.parseMintedTokenId(receipt, S.account);
    if (tokenId !== null) {
      rec.newTokenId = tokenId.toString();
      saveIds([...loadIds(), rec.newTokenId]);
    }
    rec.txC = hash;
    rec.blockC = block;
  }
}

/** A step's tx hash is saved as soon as the wallet returns it. Fetch its receipt: mined -> record it; dropped -> forget. */
async function reconcilePending(rec) {
  const p = rec.pending;
  if (!p) return;
  let receipt = null;
  try {
    receipt = await pub.getTransactionReceipt({ hash: p.hash });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (receipt) {
    delete rec.pending;
    if (receipt.status === 'success') await applyMigReceipt(rec, p.step, receipt);
    saveMig(rec);
    return;
  }
  let known = true;
  try {
    await pub.getTransaction({ hash: p.hash });
  } catch (e) {
    if (!isNotFound(e)) throw e;
    known = false;
  }
  if (!known && Date.now() - p.at > PENDING_DROP_MS) {
    delete rec.pending;
    saveMig(rec);
  }
}

/** Step (a) is done on chain but not recorded (other browser / lost save): find the burn tx of #id in the logs. */
async function recoverStepA(rec, nftExists) {
  if (!rec.txA && !rec.scannedA && !nftExists) {
    const hash = await L.findBurnTx(pub, S.account, BigInt(rec.tokenId), { fromBlock: big(rec.startBlock) ?? L.POSM_DEPLOY_BLOCK });
    if (hash) await applyMigReceipt(rec, 'a', await pub.getTransactionReceipt({ hash }));
    rec.scannedA = true;
    saveMig(rec);
  }
  // USDC held before (a), if it was never recorded: wallet USDC right after the (a) block minus what (a) returned
  if (rec.usdcBefore === undefined && rec.blockA && rec.usdcReceived !== undefined && !rec.scannedUsdcBefore) {
    try {
      const after = await readUsdc(BigInt(rec.blockA));
      const got = BigInt(rec.usdcReceived);
      rec.usdcBefore = (after > got ? after - got : 0n).toString();
    } catch {}
    rec.scannedUsdcBefore = true;
    saveMig(rec);
  }
}

/** Step (b) looks done on chain (or cannot be told apart) but no swap is recorded: find the router swap after (a). */
async function recoverStepB(rec) {
  const from = big(rec.scanB) ?? big(rec.blockA);
  if (from === null) return;
  const latest = await pub.getBlockNumber();
  if (from > latest) return;
  const f = await L.findUsdcSwapTx(pub, S.account, { fromBlock: from, toBlock: latest });
  if (f) await applyMigReceipt(rec, 'b', f.receipt, f.hypeOut);
  else rec.scanB = (latest + 1n).toString();
  saveMig(rec);
}

/** Step (b) is done but no new position is recorded: find a PositionManager mint to you in KNTQ/HYPE 0.8% after (b). */
async function recoverStepC(rec) {
  const from = big(rec.scanC) ?? big(rec.blockB) ?? big(rec.blockA);
  if (from === null) return;
  const latest = await pub.getBlockNumber();
  if (from > latest) return;
  const f = await L.findMintInPool(pub, S.account, { fromBlock: from, toBlock: latest, pool: 'HYPE' });
  if (f) await applyMigReceipt(rec, 'c', await pub.getTransactionReceipt({ hash: f.hash }));
  else rec.scanC = (latest + 1n).toString();
  saveMig(rec);
}

/**
 * Everything the panel needs, recomputed from the chain (never from what the page assumed earlier). What the record
 * lacks (a hash saved before its receipt, or a step done elsewhere) is recovered from receipts / logs first.
 */
async function readMigState() {
  const rec = loadMig();
  if (!rec || !S.account) return null;
  const id = BigInt(rec.tokenId);
  const owner = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).catch(() => null);
  let pos = null;
  if (owner) {
    if (getAddress(owner) !== S.account) throw new Error(`Position #${id} is owned by ${owner}, not by you.`);
    pos = await L.readPosition(pub, id, await L.readPoolState(pub), 'USDC');
    if (!pos.samePool) throw new Error(`Position #${id} is not in the KNTQ/USDC 2% pool.`);
  }
  const aDone = !pos || pos.liquidity === 0n;
  await reconcilePending(rec);
  if (aDone && !rec.pending) await recoverStepA(rec, !!owner);
  const [usdc, kntq] = await Promise.all([
    readUsdc(),
    pub.readContract({ address: L.ADDR.KNTQ, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [S.account] }),
  ]);
  const usdcRec = big(rec.usdcReceived);
  const usdcBefore = big(rec.usdcBefore);
  // step (b) swaps only USDC that (a) returned: never the USDC the wallet held before (a), never more than (a) returned
  let usdcToSwap = 0n;
  if (aDone) {
    const fresh = usdcBefore === null ? usdc : usdc > usdcBefore ? usdc - usdcBefore : 0n;
    usdcToSwap = usdcRec !== null && usdcRec < fresh ? usdcRec : fresh;
  }
  if (aDone && !rec.pending && !rec.txB && (usdcToSwap < MIN_USDC_TO_SWAP || usdcBefore === null)) await recoverStepB(rec);
  const bDone = aDone && (!!rec.txB || usdcToSwap < MIN_USDC_TO_SWAP);
  if (bDone && !rec.pending && !rec.newTokenId) await recoverStepC(rec);
  let newPos = null;
  if (rec.newTokenId) {
    const no = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [BigInt(rec.newTokenId)] }).catch(() => null);
    if (no && getAddress(no) === S.account) newPos = await L.readPosition(pub, BigInt(rec.newTokenId), await L.readPoolState(pub, undefined, L.LP_POOLS.HYPE.poolId), 'HYPE');
  }
  const cDone = bDone && !!rec.newTokenId && (!!rec.txC || (!!newPos && newPos.samePool && newPos.liquidity > 0n));
  // (a) done, but the burn of #id by this wallet is nowhere on chain: nothing here to continue
  const problem = aDone && !owner && !rec.txA && !rec.pending && rec.scannedA ? `Position #${id} does not exist (or was not burned by this wallet). Nothing to continue.` : null;
  const usdcUnsure = aDone && !bDone && usdcBefore === null && usdcRec === null;
  return { rec, pos, aDone, bDone, cDone, usdc, kntq, usdcToSwap, newPos, pending: rec.pending || null, problem, usdcUnsure };
}

async function refreshMigration() {
  const sumEl = $('migSummary');
  const steps = $('migSteps');
  const go = $('migGo');
  go.disabled = true;
  if (!S.account) { sumEl.textContent = 'Connect your wallet.'; return; }
  let m;
  try {
    m = await withReadRetry(readMigState);
  } catch (e) {
    sumEl.innerHTML = `<span class="err"></span>`;
    sumEl.firstChild.textContent = errMsg(e);
    return;
  }
  if (!m) { $('migrateCard').classList.add('hidden'); return; }
  S.migPreset = m.rec.preset || 'full';
  document.querySelectorAll('#migPresets .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.p === S.migPreset));
  $('migTitle').textContent = `Move position #${m.rec.tokenId} → KNTQ/HYPE 0.8%`;
  const label = (done, next, text) => `<li class="${done ? 'done' : next ? 'active' : ''}">${text}${done ? ' ✓' : next ? ' ← next' : ''}</li>`;
  const next = m.problem ? null : m.pending ? m.pending.step : !m.aDone ? 'a' : !m.bDone ? 'b' : !m.cDone ? 'c' : null;
  const tx = (h) => (h ? ` <a target="_blank" rel="noopener" href="${L.txUrl(h)}">tx</a>` : '');
  steps.innerHTML =
    label(m.aDone && m.pending?.step !== 'a', next === 'a', `(a) Remove 100% of #${m.rec.tokenId} and burn the NFT${tx(m.rec.txA)}`) +
    label(m.bDone && m.pending?.step !== 'b', next === 'b', `(b) Swap ${m.aDone && !m.bDone ? L.fmtUsdc(m.usdcToSwap, 6) + ' ' : 'the received '}USDC → HYPE (approvals + swap)${tx(m.rec.txB)}`) +
    label(m.cDone, next === 'c', `(c) Mint in KNTQ/HYPE 0.8% (${rangeLabel(S.migPreset)}) with the swapped HYPE + your KNTQ (KNTQ approvals + mint)${tx(m.rec.txC)}`);
  if (m.problem) {
    sumEl.innerHTML = `<span class="err"></span>`;
    sumEl.firstChild.textContent = m.problem;
    go.textContent = 'Forget this move';
    go.disabled = false;
    return;
  }
  if (m.pending) {
    sumEl.innerHTML = `Step (${m.pending.step}) was sent and is not confirmed yet: <a target="_blank" rel="noopener" href="${L.txUrl(m.pending.hash)}">${short(m.pending.hash)}</a>.
      Press “Re-check on-chain” in a moment. Nothing else will be sent until it is mined (or dropped).`;
    go.textContent = 'Waiting for confirmation…';
    return;
  }
  if (!next) {
    const p = m.newPos;
    const st = S.states.HYPE;
    const v = p && st ? L.poolUsdValue('HYPE', p.amounts.amount0, p.amounts.amount1, st.sqrtPriceX96, S.hypeUsd) : null;
    sumEl.innerHTML = `<b>Done.</b> New position <b>#${m.rec.newTokenId}</b> in KNTQ/HYPE 0.8%${p ? `: ${fmtHype(p.amounts.amount0)} + ${L.fmtKntq(p.amounts.amount1, 6)} KNTQ${v !== null ? ` ≈ ${fmtUsd(v)}` : ''}` : ' (no longer held by this wallet, or empty)'}.
      Leftovers stay in your wallet: ${L.fmtUsdc(m.usdc, 6)} USDC, ${L.fmtKntq(m.kntq, 6)} KNTQ.`;
    go.textContent = 'Finish';
    go.disabled = false;
    return;
  }
  sumEl.textContent = 'Estimating from the current chain state…';
  let est;
  try {
    est = await withReadRetry(() => L.estimateMigration(pub, {
      account: S.account,
      pos: m.aDone ? null : m.pos,
      usdcToSwap: m.aDone && !m.bDone ? m.usdcToSwap : 0n,
      kntqAvail: m.kntq,
      hypeFromSwap: m.bDone ? big(m.rec.hypeReceived) : null,
      preset: S.migPreset,
      slippageBps: migSlipBps(),
    }));
  } catch (e) {
    sumEl.innerHTML = `<span class="err"></span>`;
    sumEl.firstChild.textContent = 'Estimate failed: ' + errMsg(e);
    return;
  }
  const bps = migSlipBps();
  const pl = est.plan;
  const rows = [];
  if (est.removeOut) rows.push(['(a) you get back', `${L.fmtUsdc(est.removeOut.amount0, 6)} USDC + ${L.fmtKntq(est.removeOut.amount1, 6)} KNTQ (principal + 90% of the earned fees; principal min ${L.fmtUsdc(est.removeOut.min0, 4)} + ${L.fmtKntq(est.removeOut.min1, 4)})`]);
  if (est.toolFee) rows.push([`(a) tool fee (${Number(L.TOOL_FEE_BPS) / 100}% of earned fees)`, `${L.fmtUsdc(est.toolFee.fee0, 6)} USDC + ${L.fmtKntq(est.toolFee.fee1, 6)} KNTQ ≈ ${fmtUsd(est.toolFeeUsd)} → ${short(L.FEE_RECIPIENT)}`]);
  if (est.usdcIn > 0n) rows.push(['(b) swap', `${L.fmtUsdc(est.usdcIn, 6)} USDC → ≈ ${fmtHype(est.quote)} (fee 0.3% + impact: −${est.swapFeeImpactPct.toFixed(3)}%; min ${fmtHype(L.withSlippageDown(est.quote, bps))})`]);
  rows.push(['(c) new position', `${fmtHype(pl.amount0)} + ${L.fmtKntq(pl.amount1, 6)} KNTQ ≈ ${fmtUsd(est.positionUsd)} · ${rangeLabel(S.migPreset)}`]);
  const hypeSrc = m.bDone && m.rec.hypeReceived === undefined
    ? `the swap's output could not be read back, so this is capped at balance − your ${fmtHype(est.ctx.reserve)} gas reserve − mint gas`
    : `only HYPE from the swap, after keeping your ${fmtHype(est.ctx.reserve)} gas reserve`;
  rows.push(['HYPE for the position', `${fmtHype(est.hypeAvail)} = ${hypeSrc}`]);
  rows.push(['Leftovers (stay in wallet)', `${fmtHype(pl.leftover0)} + ${L.fmtKntq(pl.leftover1, 6)} KNTQ ≈ ${fmtUsd(est.leftoverUsd)}${est.extraHype > 0n ? `; plus ${fmtHype(est.extraHype)} of the swapped HYPE tops up the reserve / pays gas` : ''}`]);
  rows.push(['Value moved (before)', fmtUsd(est.before)]);
  rows.push(['Value after (position + leftovers − gas)', fmtUsd(est.after)]);
  rows.push(['Estimated cost', `${fmtUsd(est.costUsd)} (${est.costPct.toFixed(2)}%) = swap fee + impact ${fmtUsd(est.swapCostUsd)} + gas ≈ ${fmtUsd(est.gasUsd)}${est.toolFee ? ` + tool fee ${fmtUsd(est.toolFeeUsd)}` : ''}; worst case with ${(bps / 100).toFixed(2)}% slippage ≈ ${fmtUsd(est.costUsd + (est.before * bps) / 10000)}`]);
  sumEl.innerHTML = `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${esc(b)}</td></tr>`).join('')}</table>
    <p class="hint">Values price KNTQ at the KNTQ/HYPE pool ($${est.kntqUsdTarget.toFixed(5)}) and HYPE at $${est.hypeUsd.toFixed(4)}.
    The KNTQ/USDC pool prices KNTQ at $${est.kntqUsdSource.toFixed(5)} (${est.priceGapPct >= 0 ? '+' : ''}${est.priceGapPct.toFixed(2)}% gap). That gap changes how the
    position is <i>marked</i>, not what you hold: your KNTQ moves 1:1. Marked at the USDC-pool price the position is ${fmtUsd(est.beforeAtSource)}.</p>`;
  if (m.usdcUnsure) sumEl.insertAdjacentHTML('beforeend', `<div class="warn">This move was continued without its saved progress and the page could not tell which USDC came from step (a): step (b) would swap all ${esc(L.fmtUsdc(m.usdcToSwap, 6))} USDC in your wallet. Swap a smaller amount by hand in Step 1 if part of it is yours.</div>`);
  if (pl.liquidity === 0n) sumEl.insertAdjacentHTML('beforeend', '<div class="err">Nothing to deposit: liquidity rounds to 0.</div>');
  go.textContent = next === 'a' ? `Step (a): remove & burn #${m.rec.tokenId}` : next === 'b' ? `Step (b): swap ${L.fmtUsdc(m.usdcToSwap, 2)} USDC → HYPE` : 'Step (c): mint in KNTQ/HYPE 0.8%';
  go.disabled = !canWrite() || S.busy || (next === 'b' && S.swapOk !== true) || (next === 'c' && pl.liquidity === 0n);
  go.title = canWrite() ? '' : writeBlockReason();
}
const rangeLabel = (p) => ({ full: 'full range', pm20: '±20%', pm50: '±50%', pm80: '±80%' })[p] || p;

async function runMigStep() {
  if (S.busy) return;
  const rec0 = loadMig();
  if (!rec0) return;
  S.busy = true;
  $('migGo').disabled = true;
  try {
    const m = await withReadRetry(readMigState); // recompute from chain right before the step
    const rec = m.rec;
    // the tx hash is saved before waiting for the receipt, so a page that dies mid-wait resumes from it
    const savePending = (step) => (hash) => { rec.pending = { step, hash, at: Date.now() }; saveMig(rec); };
    if (m.problem) {
      saveMig(null);
      $('migrateCard').classList.add('hidden');
      return;
    }
    if (m.pending) throw new Error(`Step (${m.pending.step}) is still waiting for confirmation (${m.pending.hash}). Re-check in a moment.`);
    if (m.aDone && m.bDone && m.cDone) {
      rec.finished = true;
      saveMig(rec);
      $('migrateCard').classList.add('hidden');
      return;
    }
    await ensureChain();
    if (!m.aDone) {
      const state = await L.readPoolState(pub);
      const fresh = await L.readPosition(pub, m.pos.tokenId, state, 'USDC');
      const d = L.planDecrease(state, fresh, fresh.liquidity, migSlipBps());
      const req = L.buildDecrease({
        tokenId: fresh.tokenId,
        liquidity: fresh.liquidity,
        amount0Min: d.amount0Min,
        amount1Min: d.amount1Min,
        recipient: S.account,
        deadline: L.deadlineFromNow(600, await latestTs()),
        burn: true,
        expected: { ...d.expected, fees: fresh.fees },
        pool: 'USDC',
      });
      // USDC already in the wallet right before (a) is yours: step (b) never swaps it
      rec.usdcBefore = m.usdc.toString();
      if (!rec.startBlock) rec.startBlock = (await pub.getBlockNumber()).toString();
      saveMig(rec);
      req.onHash = savePending('a');
      const receipt = await sendTx(req);
      if (!receipt) return toast('Cancelled. Nothing was sent.');
      delete rec.pending;
      await applyMigReceipt(rec, 'a', receipt);
      saveMig(rec);
      toast(`Removed: ${L.fmtUsdc(BigInt(rec.usdcReceived), 6)} USDC + ${L.fmtKntq(BigInt(rec.kntqReceived), 6)} KNTQ. Next: swap the USDC.`);
    } else if (!m.bDone) {
      if (S.swapOk !== true) throw new Error('Swap router / HYPE pool checks not passed: swaps disabled.');
      const r = await runUsdcSwap(m.usdcToSwap, migSlipBps(), savePending('b'));
      if (!r) return toast('Cancelled. Nothing else was sent.');
      delete rec.pending;
      await applyMigReceipt(rec, 'b', r.receipt, r.received);
      saveMig(rec);
      toast(`Swapped: received ${fmtHype(r.received)}. Next: mint in KNTQ/HYPE 0.8%.`);
    } else {
      const ctx = await L.readSwapContext(pub, S.account);
      const hs = ctx.pools.KNTQ;
      // HYPE = only what the swap brought (if recorded), limited by balance - reserve - mint gas
      const hypeAvail = L.migrationHypeForMint(ctx, big(rec.hypeReceived));
      const range = L.rangeForPreset(S.migPreset, hs.tick, {}, 'HYPE');
      const plan = L.planMintFromBalances(hs, range.tickLower, range.tickUpper, { avail0: hypeAvail, avail1: m.kntq }, migSlipBps(), 'HYPE');
      if (plan.liquidity === 0n) throw new Error('Nothing to deposit: liquidity rounds to 0.');
      const txs = await L.planMintTxs(pub, S.account, plan, { infinite: false, nowSec: await latestTs() });
      let receipt;
      for (let i = 0; i < txs.length; i++) {
        if (txs[i].kind === 'mint') {
          const fresh = L.buildMint({ plan, owner: S.account, deadline: L.deadlineFromNow(600, await latestTs()) });
          await L.guardNativeMint(pub, fresh, S.account);
          Object.assign(txs[i], fresh);
          txs[i].onHash = savePending('c');
        }
        receipt = await sendTx(txs[i]);
        if (!receipt) return toast('Cancelled. Nothing else was sent.');
      }
      delete rec.pending;
      await applyMigReceipt(rec, 'c', receipt);
      saveMig(rec);
      if (!rec.newTokenId) throw new Error('Minted, but could not find the tokenId in the receipt. Check the explorer.');
      const tokenId = BigInt(rec.newTokenId);
      showMinted(tokenId, receipt, 'KNTQ/HYPE 0.8%');
      toast(`Moved ✓ New position #${tokenId} in KNTQ/HYPE 0.8%.`);
    }
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    S.busy = false;
    await refreshAll();
  }
}

async function refreshAll() {
  await refreshPool();
  await refreshBalances();
  await refreshSwap();
  await renderPositions();
  recalc();
  if (!$('migrateCard').classList.contains('hidden')) await refreshMigration();
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('connectBtn').addEventListener('click', connect);
  $('refreshBtn').addEventListener('click', refreshAll);
  $('lpPools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pool]');
    if (b) selectLp(b.dataset.pool);
  });
  document.querySelectorAll('#lpPools .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.pool === S.lp));
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    S.preset = b.dataset.p;
    document.querySelectorAll('#presets .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('customRow').classList.toggle('hidden', S.preset !== 'custom');
    recalc();
  });
  $('minUsd').addEventListener('input', recalc);
  $('maxUsd').addEventListener('input', recalc);
  $('amt0').addEventListener('input', () => { S.anchor = 'amount0'; if (!$('amt0').value) $('amt1').value = ''; recalc(); });
  $('amt1').addEventListener('input', () => { S.anchor = 'amount1'; if (!$('amt1').value) $('amt0').value = ''; recalc(); });
  $('max0').addEventListener('click', (e) => {
    e.preventDefault();
    if (!S.balances) return;
    if (S.lp === 'HYPE') {
      // MAX HYPE = (balance - reserve - mint gas) scaled down by the slippage, so amount0Max still fits
      const lpMax = hypeLpMax();
      if (lpMax === null) return;
      let bps = 100;
      try { bps = slipBps(); } catch {}
      const m = lpMax > 2n ? ((lpMax - 2n) * 10000n) / BigInt(10000 + bps) : 0n;
      if (m === 0n) toast('No HYPE free above your gas reserve.', true);
      $('amt0').value = trimZeros(formatUnits(m, 18));
    } else $('amt0').value = trimZeros(formatUnits(S.balances.b0, 6));
    S.anchor = 'amount0';
    recalc();
  });
  $('max1').addEventListener('click', (e) => { e.preventDefault(); if (S.balances) { $('amt1').value = trimZeros(formatUnits(S.balances.b1, 18)); S.anchor = 'amount1'; recalc(); } });
  $('slip').addEventListener('input', recalc);
  $('reviewMint').addEventListener('click', reviewMint);
  $('addTokenBtn').addEventListener('click', () => {
    const v = $('addTokenId').value.trim().replace(/^#/, '');
    if (!/^\d+$/.test(v)) return toast('tokenId must be a number.', true);
    if (!S.account) return toast('Connect your wallet first.', true);
    saveIds([...loadIds(), v]);
    $('addTokenId').value = '';
    renderPositions();
  });
  $('scanBtn').addEventListener('click', scan);
  for (const out of OUTS) {
    swapInput(out).addEventListener('input', () => scheduleQuote(out));
    document.querySelector(`[data-max="${out}"]`).addEventListener('click', (e) => { e.preventDefault(); setMax(out); });
    swapBtn(out).addEventListener('click', () => swapHype(out));
  }
  $('usIn').addEventListener('input', scheduleUsdcQuote);
  $('usMax').addEventListener('click', (e) => { e.preventDefault(); if (!S.balances) return toast('Connect your wallet first.', true); $('usIn').value = trimZeros(formatUnits(S.balances.b0, 6)); scheduleUsdcQuote(); });
  $('usBtn').addEventListener('click', swapUsdc);
  $('swSlip').addEventListener('input', () => { OUTS.forEach(scheduleQuote); scheduleUsdcQuote(); });
  $('splitBtn').addEventListener('click', splitForLp);
  $('migPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const rec = loadMig();
    if (rec) { rec.preset = b.dataset.p; saveMig(rec); }
    S.migPreset = b.dataset.p;
    refreshMigration();
  });
  let migT = null;
  $('migSlip').addEventListener('input', () => { clearTimeout(migT); migT = setTimeout(refreshMigration, 400); });
  $('migRefresh').addEventListener('click', refreshAll);
  $('migGo').addEventListener('click', runMigStep);
  $('migClose').addEventListener('click', () => $('migrateCard').classList.add('hidden'));
  // Entry point that needs no live KNTQ/USDC card: after step (a) burned the NFT, or in a browser without the record.
  $('migResumeBtn').addEventListener('click', () => {
    if (!S.account) return toast('Connect your wallet first.', true);
    const cur = loadMig();
    let v = $('addTokenId').value.trim().replace(/^#/, '');
    if (!/^\d+$/.test(v) && cur && !cur.finished) v = cur.tokenId;
    if (!/^\d+$/.test(v)) v = (prompt('tokenId of the KNTQ/USDC position you were moving (for example 1234):') || '').trim().replace(/^#/, '');
    if (!/^\d+$/.test(v)) return toast('Type the tokenId of the KNTQ/USDC position you were moving.', true);
    $('addTokenId').value = '';
    openMigration(v).catch((e) => toast(errMsg(e), true));
  });
  for (const el of document.querySelectorAll('[data-fee-recipient]')) {
    el.href = L.addrUrl(L.FEE_RECIPIENT);
    el.textContent = L.FEE_RECIPIENT;
  }
  for (const el of document.querySelectorAll('[data-fee-pct]')) el.textContent = `${Number(L.TOOL_FEE_BPS) / 100}%`;
  for (const [id, a] of [['lPm', L.ADDR.POOL_MANAGER], ['lPosm', L.ADDR.POSITION_MANAGER], ['lP2', L.ADDR.PERMIT2], ['lUr', L.UNIVERSAL_ROUTER]]) {
    $(id).href = L.addrUrl(a);
    $(id).textContent = a;
  }
  // Silent reconnect only if MetaMask itself (not Phantom etc.) already authorised this page.
  findMetaMask().then((found) => {
    if (!found) { setCheck('chkChain', null, 'MetaMask not detected (read-only)'); return; }
    S.eth = found.provider;
    S.eth.on?.('accountsChanged', (a) => onAccounts(a));
    S.eth.on?.('chainChanged', () => { updateChainBadge(); recalc(); });
    S.eth.request({ method: 'eth_accounts' }).then((a) => a?.length && onAccounts(a)).catch(() => {});
  });
}

wire();
setCheck('chkPool', L.POOL_ID_OK && L.LP_POOL_IDS_OK, L.POOL_ID_OK && L.LP_POOL_IDS_OK ? 'Pool ids verified' : 'Pool id MISMATCH');
verifyContracts().then(() => Promise.all([refreshPool(), refreshSwap()]));
setInterval(() => { if (!S.busy && document.visibilityState === 'visible') { refreshPool(); refreshSwap(); if (S.account) refreshBalances(); } }, 20000);
