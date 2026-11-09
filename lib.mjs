// lp-helper/lib.mjs
// ALL encoding + math for the Elysium USDC/KNTQ Uniswap v4 LP helper.
// Used by the browser page (via an import map: "viem" -> esm.sh) and by the Node fork test (node_modules/viem).
//
// Sources ported / verified against (fetched from GitHub raw, main branch):
//   v4-core/src/libraries/TickMath.sol            getSqrtPriceAtTick (exact port, bigint)
//   v4-core/src/libraries/SqrtPriceMath.sol       getAmount0Delta / getAmount1Delta (rounding exact)
//   v4-core/src/libraries/StateLibrary.sol        POOLS_SLOT=6, offsets 1,2,3,4,5,6, slot0 packing, getFeeGrowthInside
//   v4-core/src/libraries/Position.sol            calculatePositionKey = keccak256(abi.encodePacked(owner,tickLower,tickUpper,salt))
//   v4-periphery/src/libraries/LiquidityAmounts.sol getLiquidityForAmount0/1/Amounts
//   v4-periphery/src/libraries/Actions.sol        action byte values
//   v4-periphery/src/PositionManager.sol          _handleAction param layouts
//   v4-periphery/src/libraries/CalldataDecoder.sol decodeActionsRouterParams = abi.encode(bytes actions, bytes[] params),
//                                                 decodeCurrencyAddressAndUint256 (TAKE params)
//   v4-periphery/src/libraries/ActionConstants.sol OPEN_DELTA = 0 (TAKE amount 0 = whole credit; never encoded here)
//   v4-periphery/src/base/DeltaResolver.sol       _take (amount 0 -> no-op), _getFullCredit, _mapTakeAmount
//   v4-periphery/src/libraries/PositionInfoLibrary.sol  200b poolId | 24b tickUpper | 24b tickLower | 8b hasSubscriber

import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  formatUnits,
  parseUnits,
  getAddress,
  toHex,
  hexToBigInt,
  defineChain,
  encodeFunctionData,
  decodeErrorResult,
} from 'viem';

// ---------------------------------------------------------------------------
// Chain + addresses
// ---------------------------------------------------------------------------
export const RPC_URL = 'https://rpc.elysium.kinetiq.xyz';
export const EXPLORER = 'https://elysium.kinetiq.xyz/explorer';
export const CHAIN_ID = 99901;

export const elysium = defineChain({
  id: CHAIN_ID,
  name: 'Elysium',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Elysium Explorer', url: EXPLORER } },
});

export const ADDR = {
  POOL_MANAGER: getAddress('0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1'),
  POSITION_MANAGER: getAddress('0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518'),
  PERMIT2: getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  USDC: getAddress('0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65'),
  KNTQ: getAddress('0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0'),
};
// First block where PositionManager has code (binary-searched on mainnet). Used as the start of Transfer-log scans.
export const POSM_DEPLOY_BLOCK = 256086n;

export const TOKEN0 = { address: ADDR.USDC, symbol: 'USDC', decimals: 6 };
export const TOKEN1 = { address: ADDR.KNTQ, symbol: 'KNTQ', decimals: 18 };

export const POOL_KEY = Object.freeze({
  currency0: ADDR.USDC,
  currency1: ADDR.KNTQ,
  fee: 20000,
  tickSpacing: 200,
  hooks: '0x0000000000000000000000000000000000000000',
});
export const TARGET_POOL_ID = '0xd5ed6cd3a66b0631b92a54e1e3abde3c1bcd2d34f7786a30651c7b1634dd1f43';

// ---------------------------------------------------------------------------
// Tool fee (disclosed on the page): 10% of the LP fees a position has EARNED, taken only when those fees are paid
// out (Collect fees / Remove liquidity / Move position step (a)). Never the deposited principal, never swaps,
// never mints. The fee amounts come from the exact on-chain fee computation (readPosition().fees, re-read right
// before signing) and are encoded as fixed TAKE amounts, so the tool never takes more than 10% of the fees it
// computed; fees that accrue between reading and inclusion go 100% to the user (TAKE_PAIR takes the rest).
// The fee TAKEs always follow a DECREASE_LIQUIDITY(0) that credits ONLY fees and precede a TAKE_PAIR, which reverts
// if the fee share exceeded the fees actually credited: the fee can never be paid out of the principal.
// ---------------------------------------------------------------------------
/** Tool fee in basis points of the earned LP fees (1000 = 10%). */
export const TOOL_FEE_BPS = 1000n;
/** Where the tool fee goes (an externally owned account on Elysium). */
export const FEE_RECIPIENT = getAddress('0xd977de5063b91AbEAe53Bc19B56c08b0904b09c3');
/**
 * Split earned fees { amount0, amount1 } into the tool's share and the user's share.
 * fee_i = floor(fees_i * TOOL_FEE_BPS / 10000), user_i = fees_i - fee_i.
 */
export function toolFeeSplit(fees) {
  const a0 = BigInt(fees?.amount0 ?? 0n);
  const a1 = BigInt(fees?.amount1 ?? 0n);
  if (a0 < 0n || a1 < 0n) throw new Error('fees must be >= 0');
  const fee0 = (a0 * TOOL_FEE_BPS) / 10000n;
  const fee1 = (a1 * TOOL_FEE_BPS) / 10000n;
  return { fee0, fee1, user0: a0 - fee0, user1: a1 - fee1 };
}

// ---------------------------------------------------------------------------
// Actions (v4-periphery src/libraries/Actions.sol)
// ---------------------------------------------------------------------------
export const ACTIONS = Object.freeze({
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  // TAKE: params (Currency currency, address recipient, uint256 amount) -> CalldataDecoder.decodeCurrencyAddressAndUint256,
  // PositionManager: _take(currency, _mapRecipient(recipient), _mapTakeAmount(amount, currency)).
  // amount == ActionConstants.OPEN_DELTA (= 0) means "take the WHOLE open credit": this lib never encodes amount 0.
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PAIR: 0x11,
  // PositionManager SWEEP: params (Currency currency, address to) -> _sweep: transfers this contract's whole
  // balance of `currency` to `to`. Used after a native-HYPE mint to return the unused part of msg.value.
  SWEEP: 0x14,
});
export const ACTION_NAMES = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const PERMIT2_ABI = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const POOL_KEY_TUPLE = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
export const POSM_ABI = parseAbi([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function poolManager() view returns (address)',
  'function permit2() view returns (address)',
  'function nextTokenId() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  `function getPoolAndPositionInfo(uint256 tokenId) view returns (${POOL_KEY_TUPLE} poolKey, uint256 info)`,
  'function positionInfo(uint256 tokenId) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
  // errors that can bubble out of modifyLiquidities (for readable messages)
  'error DeadlinePassed(uint256 deadline)',
  'error MaximumAmountExceeded(uint128 maximumAmount, uint128 amountRequested)',
  'error MinimumAmountInsufficient(uint128 minimumAmount, uint128 amountReceived)',
  'error NotApproved(address caller)',
  'error PoolManagerMustBeLocked()',
  'error InputLengthMismatch()',
  'error UnsupportedAction(uint256 action)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error TickMisaligned(int24 tick, int24 tickSpacing)',
  'error TicksMisordered(int24 tickLower, int24 tickUpper)',
  'error PoolNotInitialized()',
  'error DeltaNotPositive(address currency)',
]);

export const POOL_MANAGER_ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function extsload(bytes32 startSlot, uint256 nSlots) view returns (bytes32[])',
  'function extsload(bytes32[] slots) view returns (bytes32[])',
]);

export const ERC721_TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)'
);
export const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));

// ---------------------------------------------------------------------------
// Constants (TickMath / FixedPoint)
// ---------------------------------------------------------------------------
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT48 = (1n << 48n) - 1n;
const MOD256 = 1n << 256n;

export const MIN_USABLE_TICK = Math.ceil(MIN_TICK / POOL_KEY.tickSpacing) * POOL_KEY.tickSpacing; // -887200
export const MAX_USABLE_TICK = Math.floor(MAX_TICK / POOL_KEY.tickSpacing) * POOL_KEY.tickSpacing; // 887200

// ---------------------------------------------------------------------------
// Pool id
// ---------------------------------------------------------------------------
/** PoolId = keccak256(abi.encode(PoolKey)) */
export function poolIdOf(key) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}
export const COMPUTED_POOL_ID = poolIdOf(POOL_KEY);
export const POOL_ID_OK = COMPUTED_POOL_ID.toLowerCase() === TARGET_POOL_ID.toLowerCase();

/** Throws unless the hardcoded key hashes to the target id. Every write path calls this. */
export function assertTargetPool(key = POOL_KEY) {
  const id = poolIdOf(key);
  if (id.toLowerCase() !== TARGET_POOL_ID.toLowerCase()) {
    throw new Error(`PoolKey hashes to ${id}, expected ${TARGET_POOL_ID}. Refusing to build a transaction.`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// FullMath (bigint – exact, no overflow concerns)
// ---------------------------------------------------------------------------
export function mulDiv(a, b, d) {
  if (d === 0n) throw new Error('mulDiv: division by zero');
  const r = (a * b) / d;
  if (r > MAX_UINT256) throw new Error('mulDiv: overflow');
  return r;
}
export function mulDivRoundingUp(a, b, d) {
  const prod = a * b;
  let r = prod / d;
  if (prod % d > 0n) r += 1n;
  if (r > MAX_UINT256) throw new Error('mulDivRoundingUp: overflow');
  return r;
}
function divRoundingUp(a, b) {
  return a / b + (a % b > 0n ? 1n : 0n);
}
function toUint128(x) {
  if (x > MAX_UINT128) throw new Error('SafeCastOverflow (uint128)');
  return x;
}

// ---------------------------------------------------------------------------
// TickMath.getSqrtPriceAtTick – exact port
// ---------------------------------------------------------------------------
const TICK_CONSTS = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];
export function getSqrtPriceAtTick(tick) {
  tick = Number(tick);
  if (!Number.isInteger(tick)) throw new Error('tick must be an integer');
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new Error(`InvalidTick(${tick})`);
  let price = absTick & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, c] of TICK_CONSTS) if (absTick & bit) price = (price * c) >> 128n;
  if (tick > 0) price = MAX_UINT256 / price;
  // Q128.128 -> Q128.96, rounding up
  return (price + ((1n << 32n) - 1n)) >> 32n;
}

/** Exact inverse: greatest tick such that getSqrtPriceAtTick(tick) <= sqrtPriceX96 (== TickMath.getTickAtSqrtPrice). */
export function getTickAtSqrtPrice(sqrtPriceX96) {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) throw new Error('InvalidSqrtPrice');
  // float estimate then exact correction using the exact forward function
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  let t = Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
  t = Math.max(MIN_TICK, Math.min(MAX_TICK, t));
  while (t > MIN_TICK && getSqrtPriceAtTick(t) > sqrtPriceX96) t--;
  while (t < MAX_TICK && getSqrtPriceAtTick(t + 1) <= sqrtPriceX96) t++;
  return t;
}

// ---------------------------------------------------------------------------
// LiquidityAmounts (v4-periphery) – exact port
// ---------------------------------------------------------------------------
export function getLiquidityForAmount0(sqrtA, sqrtB, amount0) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const intermediate = mulDiv(sqrtA, sqrtB, Q96);
  return toUint128(mulDiv(amount0, intermediate, sqrtB - sqrtA));
}
export function getLiquidityForAmount1(sqrtA, sqrtB, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return toUint128(mulDiv(amount1, Q96, sqrtB - sqrtA));
}
export function getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return getLiquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtP < sqrtB) {
    const l0 = getLiquidityForAmount0(sqrtP, sqrtB, amount0);
    const l1 = getLiquidityForAmount1(sqrtA, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(sqrtA, sqrtB, amount1);
}

// ---------------------------------------------------------------------------
// SqrtPriceMath (v4-core) – exact port
// ---------------------------------------------------------------------------
export function getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) throw new Error('InvalidPrice');
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}
export function getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp) {
  const numerator = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  return roundUp ? mulDivRoundingUp(liquidity, numerator, Q96) : mulDiv(liquidity, numerator, Q96);
}

/**
 * Token amounts for `liquidity` in [tickLower, tickUpper) at the current pool state.
 * Mirrors Pool.modifyLiquidity: branch on slot0.tick, amounts from sqrtPriceX96.
 * roundUp=true -> amounts owed when ADDING (mint), false -> amounts received when REMOVING.
 */
export function getAmountsForLiquidity({ sqrtPriceX96, tick }, tickLower, tickUpper, liquidity, roundUp) {
  const sa = getSqrtPriceAtTick(tickLower);
  const sb = getSqrtPriceAtTick(tickUpper);
  let amount0 = 0n;
  let amount1 = 0n;
  if (tick < tickLower) {
    amount0 = getAmount0Delta(sa, sb, liquidity, roundUp);
  } else if (tick < tickUpper) {
    amount0 = getAmount0Delta(sqrtPriceX96, sb, liquidity, roundUp);
    amount1 = getAmount1Delta(sa, sqrtPriceX96, liquidity, roundUp);
  } else {
    amount1 = getAmount1Delta(sa, sb, liquidity, roundUp);
  }
  return { amount0, amount1 };
}

// ---------------------------------------------------------------------------
// Ticks, ranges, prices
// ---------------------------------------------------------------------------
const DEC_SHIFT = TOKEN0.decimals - TOKEN1.decimals; // 6 - 18 = -12

export function floorTick(t, spacing = POOL_KEY.tickSpacing) {
  return Math.floor(t / spacing) * spacing;
}
export function ceilTick(t, spacing = POOL_KEY.tickSpacing) {
  return Math.ceil(t / spacing) * spacing;
}
export function clampUsable(t, pool) {
  const u = usableTicks(pool);
  return Math.max(u.min, Math.min(u.max, t));
}
/** Usable tick bounds for a pool's tickSpacing (USDC pool: ±887200, HYPE pool: ±887160). */
export function usableTicks(pool) {
  const sp = pool === undefined ? POOL_KEY.tickSpacing : lpPool(pool).key.tickSpacing;
  return { min: Math.ceil(MIN_TICK / sp) * sp, max: Math.floor(MAX_TICK / sp) * sp, spacing: sp };
}

/** Human price token1 per token0 (KNTQ per USDC) from sqrtPriceX96. */
export function sqrtPriceToKntqPerUsdc(sqrtPriceX96) {
  const r = Number(sqrtPriceX96) / Number(Q96);
  return r * r * 10 ** DEC_SHIFT;
}
export function tickToKntqPerUsdc(tick) {
  return Math.pow(1.0001, tick) * 10 ** DEC_SHIFT;
}
/** USD per KNTQ (assumes USDC == $1). */
export function tickToUsdPerKntq(tick) {
  return 1 / tickToKntqPerUsdc(tick);
}
/** Exact-ish: the tick whose price (KNTQ per USDC) is <= given price. */
export function kntqPerUsdcToTick(p) {
  if (!(p > 0) || !Number.isFinite(p)) throw new Error('price must be > 0');
  const raw = p / 10 ** DEC_SHIFT; // raw token1/token0
  const sqrt = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * (1n << 48n); // ~Q96, float precision is fine before tick correction
  if (sqrt < MIN_SQRT_PRICE) return MIN_TICK;
  if (sqrt >= MAX_SQRT_PRICE) return MAX_TICK;
  return getTickAtSqrtPrice(sqrt);
}
export function usdPerKntqToTick(usd) {
  return kntqPerUsdcToTick(1 / usd);
}

// Pool-generic price helpers. Both LP pools have KNTQ as currency1; the "quote" token is currency0
// (USDC in the 2% pool, native HYPE in the 0.8% pool). quote-per-KNTQ up <=> tick down.
const decShiftOf = (pool) => { const p = lpPool(pool); return p.token0.decimals - p.token1.decimals; };
/** KNTQ per 1 quote token (token1 per token0, human units) at a tick. */
export function tickToKntqPerQuote(tick, pool) {
  return Math.pow(1.0001, tick) * 10 ** decShiftOf(pool);
}
/** Quote token (USDC or HYPE) per 1 KNTQ at a tick. */
export function tickToQuotePerKntq(tick, pool) {
  return 1 / tickToKntqPerQuote(tick, pool);
}
/** Quote token per 1 KNTQ from a sqrtPriceX96. */
export function sqrtPriceToQuotePerKntq(sqrtPriceX96, pool) {
  const r = Number(sqrtPriceX96) / Number(Q96);
  return 1 / (r * r * 10 ** decShiftOf(pool));
}
/** Greatest tick whose price (quote per KNTQ) is >= q (same rounding as usdPerKntqToTick). */
export function quotePerKntqToTick(q, pool) {
  if (!(q > 0) || !Number.isFinite(q)) throw new Error('price must be > 0');
  const raw = 1 / q / 10 ** decShiftOf(pool);
  const sqrt = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * (1n << 48n);
  if (sqrt < MIN_SQRT_PRICE) return MIN_TICK;
  if (sqrt >= MAX_SQRT_PRICE) return MAX_TICK;
  return getTickAtSqrtPrice(sqrt);
}

/**
 * Range presets. Percentages are applied to the USD-per-KNTQ price (what humans think in).
 * USD/KNTQ up  <=> KNTQ/USDC down <=> tick down.  Returns aligned, clamped ticks with lower < upper.
 * pool: 'USDC' (default, spacing 200) or 'HYPE' (spacing 120). For the HYPE pool, USD = HYPE × usdPerQuote, so
 * a ±X% band in USD is the same ±X% band in HYPE per KNTQ; custom {minUsd, maxUsd} needs custom.usdPerQuote
 * (USD per HYPE). Ticks are always rounded OUTWARD to multiples of the pool's tickSpacing.
 */
export function rangeForPreset(preset, currentTick, custom = {}, pool = 'USDC') {
  const P = lpPool(pool);
  const sp = P.key.tickSpacing;
  const u = usableTicks(P.id);
  if (preset === 'full') return { tickLower: u.min, tickUpper: u.max };
  let tl;
  let tu;
  if (preset === 'custom') {
    const { minUsd, maxUsd } = custom;
    const usdPerQuote = P.id === 'USDC' ? 1 : custom.usdPerQuote;
    if (!(usdPerQuote > 0)) throw new Error('Custom range: HYPE price unavailable');
    if (!(minUsd > 0) || !(maxUsd > 0) || !(maxUsd > minUsd)) throw new Error('Custom range: need 0 < min price < max price');
    // high USD/KNTQ -> low tick
    tl = quotePerKntqToTick(maxUsd / usdPerQuote, P.id);
    tu = quotePerKntqToTick(minUsd / usdPerQuote, P.id);
  } else {
    const pct = { pm20: 0.2, pm50: 0.5, pm80: 0.8 }[preset];
    if (pct === undefined) throw new Error(`Unknown preset ${preset}`);
    const q = tickToQuotePerKntq(currentTick, P.id);
    tl = quotePerKntqToTick(q * (1 + pct), P.id);
    tu = quotePerKntqToTick(q * (1 - pct), P.id);
  }
  let tickLower = clampUsable(floorTick(tl, sp), P.id);
  let tickUpper = clampUsable(ceilTick(tu, sp), P.id);
  if (tickUpper <= tickLower) tickUpper = tickLower + sp;
  if (tickUpper > u.max) {
    tickUpper = u.max;
    tickLower = tickUpper - sp;
  }
  return { tickLower, tickUpper };
}

export function validateTicks(tickLower, tickUpper, pool = 'USDC') {
  const u = usableTicks(pool);
  const sp = u.spacing;
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) throw new Error('ticks must be integers');
  if (tickLower % sp !== 0 || tickUpper % sp !== 0) throw new Error(`ticks must be multiples of ${sp}`);
  if (tickLower >= tickUpper) throw new Error('tickLower must be < tickUpper');
  if (tickLower < u.min || tickUpper > u.max) throw new Error('ticks out of usable range');
}

/**
 * Human-readable price range for a tick range: USD per KNTQ (min..max).
 * For the HYPE pool pass usdPerQuote = USD per HYPE (from the USDC/HYPE pool); quote prices are in HYPE.
 */
export function describeRange(tickLower, tickUpper, pool = 'USDC', usdPerQuote = 1) {
  const u = usableTicks(pool);
  const full = tickLower === u.min && tickUpper === u.max;
  const minQ = tickToQuotePerKntq(tickUpper, pool);
  const maxQ = tickToQuotePerKntq(tickLower, pool);
  return {
    full,
    minQuotePerKntq: minQ,
    maxQuotePerKntq: maxQ,
    minUsdPerKntq: minQ * usdPerQuote,
    maxUsdPerKntq: maxQ * usdPerQuote,
    minKntqPerUsdc: tickToKntqPerQuote(tickLower, pool),
    maxKntqPerUsdc: tickToKntqPerQuote(tickUpper, pool),
  };
}

// ---------------------------------------------------------------------------
// Liquidity planning (amounts -> liquidity -> exact owed amounts -> slippage max)
// ---------------------------------------------------------------------------
/** slippage in basis points (100 = 1%). */
export function withSlippageUp(x, bps) {
  return (x * BigInt(10000 + bps) + 9999n) / 10000n;
}
export function withSlippageDown(x, bps) {
  return (x * BigInt(10000 - bps)) / 10000n;
}

/**
 * Given a pool state, a range and user inputs, compute the mint plan.
 *   input: { amount0?: bigint, amount1?: bigint, anchor?: 'amount0'|'amount1' }
 * If anchor is given, the other side is derived from it (the "required other amount" shown in the UI).
 * Returns liquidity and the EXACT amounts the pool will pull (rounding up), plus amount0Max/amount1Max.
 */
export function planMint(state, tickLower, tickUpper, { amount0, amount1, anchor }, slippageBps = 100, pool = 'USDC') {
  const poolId = lpPool(pool).id;
  validateTicks(tickLower, tickUpper, poolId);
  const sa = getSqrtPriceAtTick(tickLower);
  const sb = getSqrtPriceAtTick(tickUpper);
  const P = state.sqrtPriceX96;
  const a0 = amount0 ?? 0n;
  const a1 = amount1 ?? 0n;
  const below = state.tick < tickLower; // only token0 (USDC) usable
  const above = state.tick >= tickUpper; // only token1 (KNTQ) usable
  let liquidity;
  if (anchor === 'amount0') {
    // derive the other side from amount0 alone
    liquidity = above ? 0n : getLiquidityForAmount0(below ? sa : P, sb, a0);
  } else if (anchor === 'amount1') {
    liquidity = below ? 0n : getLiquidityForAmount1(sa, above ? sb : P, a1);
  } else if (below) {
    liquidity = getLiquidityForAmount0(sa, sb, a0);
  } else if (above) {
    liquidity = getLiquidityForAmount1(sa, sb, a1);
  } else {
    liquidity = getLiquidityForAmounts(P, sa, sb, a0, a1);
  }
  const owed = getAmountsForLiquidity(state, tickLower, tickUpper, liquidity, true);
  return {
    pool: poolId,
    tickLower,
    tickUpper,
    liquidity,
    amount0: owed.amount0,
    amount1: owed.amount1,
    amount0Max: owed.amount0 === 0n ? 0n : withSlippageUp(owed.amount0, slippageBps),
    amount1Max: owed.amount1 === 0n ? 0n : withSlippageUp(owed.amount1, slippageBps),
    inRange: state.tick >= tickLower && state.tick < tickUpper,
    needs0: state.tick < tickUpper,
    needs1: state.tick >= tickLower,
  };
}

/**
 * "Use as much as possible" mint plan from two available balances (max of the limiting side).
 * Each side is first scaled down by the slippage so that amountMax = owed × (1 + slippage) still fits the
 * balance; liquidity = min over both sides (getLiquidityForAmounts); amountMax is then capped at the balance.
 * Returns the planMint result plus { avail0, avail1, leftover0, leftover1, limiting: 'amount0'|'amount1'|null }.
 */
export function planMintFromBalances(state, tickLower, tickUpper, { avail0, avail1 }, slippageBps = 100, pool = 'USDC') {
  if (avail0 < 0n || avail1 < 0n) throw new Error('available amounts must be >= 0');
  const scale = (x) => (x * 10000n) / BigInt(10000 + slippageBps);
  // keep 2 wei of headroom: owed can round up 1 wei above the target amount
  const t0 = avail0 > 2n ? scale(avail0 - 2n) : 0n;
  const t1 = avail1 > 2n ? scale(avail1 - 2n) : 0n;
  const plan = planMint(state, tickLower, tickUpper, { amount0: t0, amount1: t1 }, slippageBps, pool);
  if (plan.amount0 > avail0 || plan.amount1 > avail1) throw new Error('internal: owed exceeds balance');
  const cap = (m, a) => (m > a ? a : m);
  plan.amount0Max = cap(plan.amount0Max, avail0);
  plan.amount1Max = cap(plan.amount1Max, avail1);
  let limiting = null;
  if (plan.needs0 && plan.needs1) {
    const sa = getSqrtPriceAtTick(tickLower), sb = getSqrtPriceAtTick(tickUpper);
    const l0 = getLiquidityForAmount0(state.sqrtPriceX96, sb, t0);
    const l1 = getLiquidityForAmount1(sa, state.sqrtPriceX96, t1);
    limiting = l0 <= l1 ? 'amount0' : 'amount1';
  } else limiting = plan.needs0 ? 'amount0' : 'amount1';
  return { ...plan, avail0, avail1, leftover0: avail0 - plan.amount0, leftover1: avail1 - plan.amount1, limiting };
}

// ---------------------------------------------------------------------------
// Action-param encoders (PositionManager._handleAction layouts)
// ---------------------------------------------------------------------------
const POOL_KEY_PARAM = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
};

export function encodeMintParams({ poolKey = POOL_KEY, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData = '0x' }) {
  return encodeAbiParameters(
    [POOL_KEY_PARAM, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
    [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData]
  );
}
/** INCREASE_LIQUIDITY / DECREASE_LIQUIDITY: (uint256 tokenId, uint256 liquidity, uint128 amount0, uint128 amount1, bytes hookData) */
export function encodeModifyLiquidityParams({ tokenId, liquidity, amount0, amount1, hookData = '0x' }) {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [tokenId, liquidity, amount0, amount1, hookData]
  );
}
/** BURN_POSITION: (uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData) */
export function encodeBurnParams({ tokenId, amount0Min = 0n, amount1Min = 0n, hookData = '0x' }) {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [tokenId, amount0Min, amount1Min, hookData]
  );
}
/** SETTLE_PAIR: (Currency currency0, Currency currency1) */
export function encodeSettlePair(c0 = POOL_KEY.currency0, c1 = POOL_KEY.currency1) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [c0, c1]);
}
/** TAKE_PAIR: (Currency currency0, Currency currency1, address recipient) */
export function encodeTakePair(recipient, c0 = POOL_KEY.currency0, c1 = POOL_KEY.currency1) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [c0, c1, recipient]);
}
/**
 * TAKE: (Currency currency, address recipient, uint256 amount). Refuses amount 0: in v4-periphery amount 0 is
 * ActionConstants.OPEN_DELTA = "take the whole open credit", which would hand over everything owed.
 */
export function encodeTake(currency, recipient, amount) {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('TAKE amount must be > 0 (0 = OPEN_DELTA = the whole credit)');
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [currency, recipient, amount]);
}
/** PositionManager SWEEP: (Currency currency, address to). currency 0x0 = native HYPE. */
export function encodePosmSweep(currency, to) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [currency, to]);
}
/** unlockData = abi.encode(bytes actions, bytes[] params) */
export function encodeUnlockData(actionList, params) {
  if (actionList.length !== params.length) throw new Error('actions/params length mismatch');
  const actions = toHex(Uint8Array.from(actionList));
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
}

export function deadlineFromNow(seconds, nowSec = Math.floor(Date.now() / 1000)) {
  return BigInt(nowSec + seconds);
}

// ---------------------------------------------------------------------------
// Transaction builders – the page and the fork test call these and nothing else.
// Each returns { address, abi, functionName, args, preview } ready for writeContract.
// ---------------------------------------------------------------------------
const fmt0 = (x, pool) => { const t = pool ? lpPool(pool).token0 : TOKEN0; return `${formatUnits(x, t.decimals)} ${t.symbol}`; };
const fmt1 = (x) => `${formatUnits(x, TOKEN1.decimals)} ${TOKEN1.symbol}`;
export const tokenMeta = (addr) => {
  const a = getAddress(addr);
  if (a === TOKEN0.address) return TOKEN0;
  if (a === TOKEN1.address) return TOKEN1;
  if (BigInt(a) === 0n) return HYPE;
  throw new Error(`Unknown token ${a}`);
};

export function buildErc20Approve(token, amount) {
  const t = tokenMeta(token);
  const infinite = amount === MAX_UINT256;
  return {
    address: t.address,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [ADDR.PERMIT2, amount],
    preview: {
      title: `Approve Permit2 to move your ${t.symbol}`,
      contract: `${t.symbol} token ${t.address}`,
      fn: 'approve(spender, amount)',
      lines: [
        `spender: Permit2 ${ADDR.PERMIT2}`,
        `amount: ${infinite ? 'UNLIMITED (max uint256)' : `${formatUnits(amount, t.decimals)} ${t.symbol}`}`,
      ],
    },
  };
}

export function buildPermit2Approve(token, amount, expirationSec, spender = ADDR.POSITION_MANAGER) {
  const t = tokenMeta(token);
  if (amount > MAX_UINT160) throw new Error('permit2 amount exceeds uint160');
  const sp = getAddress(spender);
  const spName = sp === ADDR.POSITION_MANAGER ? 'PositionManager' : sp === UNIVERSAL_ROUTER ? 'UniversalRouter' : null;
  if (!spName) throw new Error(`Refusing Permit2 approval to unknown spender ${sp}`);
  return {
    address: ADDR.PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'approve',
    args: [t.address, sp, amount, Number(expirationSec)],
    preview: {
      title: `Permit2: allow ${spName} to pull ${t.symbol}`,
      contract: `Permit2 ${ADDR.PERMIT2}`,
      fn: 'approve(token, spender, uint160 amount, uint48 expiration)',
      lines: [
        `token: ${t.symbol} ${t.address}`,
        `spender: ${spName === 'PositionManager' ? 'Uniswap v4 PositionManager' : 'Uniswap UniversalRouter 2.1.2'} ${sp}`,
        `amount: ${amount === MAX_UINT160 ? 'UNLIMITED (max uint160)' : `${formatUnits(amount, t.decimals)} ${t.symbol}`}`,
        `expires: ${new Date(Number(expirationSec) * 1000).toISOString()}`,
      ],
    },
  };
}

/**
 * Mint. plan.pool selects the pool (default the USDC pool).
 *   ERC20 pool (USDC/KNTQ): actions MINT_POSITION, SETTLE_PAIR; no tx value.
 *   Native pool (HYPE/KNTQ): actions MINT_POSITION, SETTLE_PAIR, SWEEP(native, owner); tx value = amount0Max.
 *     SETTLE_PAIR settles the native debt with poolManager.settle{value: debt}() out of the PositionManager's
 *     balance (= this call's msg.value; DeltaResolver._settle), KNTQ via Permit2. SWEEP sends whatever HYPE is
 *     left in the PositionManager back to the owner (= the signer), so only the exact owed HYPE is spent.
 */
export function buildMint({ plan, owner, deadline }) {
  const P = lpPool(plan.pool);
  assertLpPool(P.id);
  validateTicks(plan.tickLower, plan.tickUpper, P.id);
  const actions = [ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR];
  const params = [
    encodeMintParams({
      poolKey: P.key,
      tickLower: plan.tickLower,
      tickUpper: plan.tickUpper,
      liquidity: plan.liquidity,
      amount0Max: plan.amount0Max,
      amount1Max: plan.amount1Max,
      owner,
    }),
    encodeSettlePair(P.key.currency0, P.key.currency1),
  ];
  if (P.native0) {
    actions.push(ACTIONS.SWEEP);
    params.push(encodePosmSweep(ZERO_ADDRESS, owner));
  }
  const r = describeRange(plan.tickLower, plan.tickUpper, P.id);
  const q = P.token0.symbol;
  const req = {
    kind: 'mint',
    pool: P.id,
    address: ADDR.POSITION_MANAGER,
    abi: POSM_ABI,
    functionName: 'modifyLiquidities',
    args: [encodeUnlockData(actions, params), deadline],
    actions,
    amount0Max: plan.amount0Max,
    preview: {
      title: `Mint a new ${P.label} position`,
      contract: `Uniswap v4 PositionManager ${ADDR.POSITION_MANAGER}`,
      fn: `modifyLiquidities(unlockData, deadline) — actions: ${actions.map((a) => ACTION_NAMES[a]).join(', ')}`,
      lines: [
        `pool: ${P.pairLabel} fee ${P.key.fee / 10000}% spacing ${P.key.tickSpacing}, id ${P.poolId}`,
        `range: ticks [${plan.tickLower}, ${plan.tickUpper}] = ${r.full ? 'FULL RANGE' : `${r.minQuotePerKntq.toPrecision(5)} – ${r.maxQuotePerKntq.toPrecision(5)} ${q} per KNTQ`}`,
        `liquidity: ${plan.liquidity}`,
        `expected deposit: ${fmt0(plan.amount0, P.id)} + ${fmt1(plan.amount1)}`,
        `max deposit (slippage cap): ${fmt0(plan.amount0Max, P.id)} + ${fmt1(plan.amount1Max)}`,
        P.native0 ? `you send ${fmt0(plan.amount0Max, P.id)} as transaction value; SWEEP returns the unused HYPE to ${owner}` : null,
        `NFT owner: ${owner}`,
        `deadline: ${new Date(Number(deadline) * 1000).toISOString()}`,
      ].filter(Boolean),
    },
  };
  if (P.native0 && plan.amount0Max > 0n) req.tx = { value: plan.amount0Max };
  return req;
}

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Tool fee for earned `fees` ({ amount0, amount1 } from readPosition): { ...toolFeeSplit(fees), recipient, known }.
 *  known = false when no fee figures were given: then no fee is taken. */
function toolFeeOf(fees) {
  return { ...toolFeeSplit(fees), recipient: FEE_RECIPIENT, known: !!fees };
}
/** true when at least one currency has a fee share > 0 (only then is any TAKE encoded). */
const hasFeeTake = (tf) => tf.fee0 > 0n || tf.fee1 > 0n;
/**
 * Appends one TAKE(currency, FEE_RECIPIENT, fee_i) per currency whose fee share is > 0 (never a TAKE with amount 0:
 * amount 0 is ActionConstants.OPEN_DELTA = the whole credit). Must sit right after a DECREASE_LIQUIDITY that credits
 * ONLY fees (liquidity 0) and right before a TAKE_PAIR(user): see buildCollect / buildDecrease.
 */
function pushFeeTakes(actions, params, P, tf) {
  if (tf.fee0 > 0n) {
    actions.push(ACTIONS.TAKE);
    params.push(encodeTake(P.key.currency0, FEE_RECIPIENT, tf.fee0));
  }
  if (tf.fee1 > 0n) {
    actions.push(ACTIONS.TAKE);
    params.push(encodeTake(P.key.currency1, FEE_RECIPIENT, tf.fee1));
  }
}
/** Preview lines that disclose the tool fee for a payout of earned fees. */
function toolFeeLines(tf, P) {
  if (!tf.known) return ['Tool fee: none (no fee figures given, nothing is taken)'];
  return [
    `Tool fee (${Number(TOOL_FEE_BPS) / 100}% of earned fees): ${fmt0(tf.fee0, P.id)} + ${fmt1(tf.fee1)} → ${shortAddr(FEE_RECIPIENT)}${tf.fee0 === 0n && tf.fee1 === 0n ? ' (nothing: no fees earned)' : ''}`,
    `tool fee recipient: ${FEE_RECIPIENT} (your deposit is never charged)`,
  ];
}

/**
 * Collect fees = DECREASE_LIQUIDITY(liquidity 0, mins 0) [+ TAKE(currency, FEE_RECIPIENT, 10% of fees) per currency
 * with a fee > 0] + TAKE_PAIR(recipient). Native HYPE fees arrive as HYPE (both for the user and the fee recipient).
 * expectedFees = readPosition().fees, read right before signing; it sets the tool fee. Without it no fee is taken.
 */
export function buildCollect({ tokenId, recipient, deadline, expectedFees, pool = 'USDC' }) {
  const P = lpPool(pool);
  assertLpPool(P.id);
  const actions = [ACTIONS.DECREASE_LIQUIDITY];
  const params = [encodeModifyLiquidityParams({ tokenId, liquidity: 0n, amount0: 0n, amount1: 0n })];
  // credit after DECREASE(0) = the fees actually accrued. If they are below the encoded fee share, the TAKEs leave a
  // negative delta and TAKE_PAIR reverts (DeltaNotPositive): the fee can only ever come out of earned fees.
  const tf = toolFeeOf(expectedFees);
  pushFeeTakes(actions, params, P, tf);
  actions.push(ACTIONS.TAKE_PAIR);
  params.push(encodeTakePair(recipient, P.key.currency0, P.key.currency1));
  return {
    kind: 'collect',
    pool: P.id,
    address: ADDR.POSITION_MANAGER,
    abi: POSM_ABI,
    functionName: 'modifyLiquidities',
    args: [encodeUnlockData(actions, params), deadline],
    actions,
    toolFee: tf,
    preview: {
      title: `Collect fees from position #${tokenId}`,
      contract: `Uniswap v4 PositionManager ${ADDR.POSITION_MANAGER}`,
      fn: `modifyLiquidities — actions: ${actions.map((a) => (a === ACTIONS.DECREASE_LIQUIDITY ? 'DECREASE_LIQUIDITY(liquidity=0)' : ACTION_NAMES[a])).join(', ')}`,
      lines: [
        `pool: ${P.label}`,
        `tokenId: ${tokenId}`,
        expectedFees ? `earned fees: ${fmt0(expectedFees.amount0, P.id)} + ${fmt1(expectedFees.amount1)}` : 'earned fees: (unknown)',
        ...toolFeeLines(tf, P),
        tf.known ? `You receive: ${fmt0(tf.user0, P.id)} + ${fmt1(tf.user1)} (90% of the earned fees, plus any fees earned before inclusion)` : null,
        `recipient: ${recipient}${P.native0 ? ' (HYPE arrives as native HYPE)' : ''}`,
        `deadline: ${new Date(Number(deadline) * 1000).toISOString()}`,
      ].filter(Boolean),
    },
  };
}

/**
 * Remove liquidity. The tool fee (10% of fees = expected.fees, readPosition().fees read right before signing) is
 * settled in a FEES-ONLY segment first, so it can never be paid out of the principal:
 *   fee share > 0:  DECREASE_LIQUIDITY(tokenId, 0, 0, 0)        credits only the accrued fees
 *                   TAKE(currency, FEE_RECIPIENT, fee_i)         per currency with a fee share > 0
 *                   TAKE_PAIR(c0, c1, user)                      90% of the fees (+ any fees accrued since the read);
 *                                                                reverts DeltaNotPositive (whole tx) if the fees
 *                                                                actually credited are below the encoded fee share,
 *                                                                e.g. collected by another tx after the read
 *                   DECREASE_LIQUIDITY(tokenId, L, min0, min1)   credits only the principal (fees already paid)
 *                   [BURN_POSITION(tokenId)]                     liquidity is 0 if L was all: no pool call
 *                   TAKE_PAIR(c0, c1, user)                      100% of the principal
 *   no fee share (zero fees, all shares < 1 wei after flooring, or no fee figures): the old shape
 *                   DECREASE_LIQUIDITY(L, mins) [+ BURN_POSITION] + TAKE_PAIR(user)
 * Verified against v4-periphery PositionManager / DeltaResolver: _takePair takes _getFullCredit per currency at that
 * point (a second TAKE_PAIR takes the credit re-accrued by the second decrease; _take of 0 is a no-op); _decrease
 * applies the slippage mins to liquidityDelta - feesAccrued (= the principal); _burn only calls the pool when the
 * position still has liquidity. In the HYPE pool, TAKE(0x0, …) / TAKE_PAIR(0x0, KNTQ, …) send native HYPE.
 */
export function buildDecrease({ tokenId, liquidity, amount0Min, amount1Min, recipient, deadline, burn = false, expected, fees = expected?.fees, pool = 'USDC' }) {
  const P = lpPool(pool);
  assertLpPool(P.id);
  const tf = toolFeeOf(fees);
  const actions = [];
  const params = [];
  if (hasFeeTake(tf)) {
    actions.push(ACTIONS.DECREASE_LIQUIDITY);
    params.push(encodeModifyLiquidityParams({ tokenId, liquidity: 0n, amount0: 0n, amount1: 0n }));
    pushFeeTakes(actions, params, P, tf);
    actions.push(ACTIONS.TAKE_PAIR);
    params.push(encodeTakePair(recipient, P.key.currency0, P.key.currency1));
  }
  actions.push(ACTIONS.DECREASE_LIQUIDITY);
  params.push(encodeModifyLiquidityParams({ tokenId, liquidity, amount0: amount0Min, amount1: amount1Min }));
  if (burn) {
    actions.push(ACTIONS.BURN_POSITION);
    params.push(encodeBurnParams({ tokenId }));
  }
  actions.push(ACTIONS.TAKE_PAIR);
  params.push(encodeTakePair(recipient, P.key.currency0, P.key.currency1));
  return {
    kind: 'decrease',
    pool: P.id,
    address: ADDR.POSITION_MANAGER,
    abi: POSM_ABI,
    functionName: 'modifyLiquidities',
    args: [encodeUnlockData(actions, params), deadline],
    actions,
    toolFee: tf,
    preview: {
      title: `Remove liquidity from position #${tokenId}${burn ? ' and burn the NFT' : ''}`,
      contract: `Uniswap v4 PositionManager ${ADDR.POSITION_MANAGER}`,
      fn: `modifyLiquidities — actions: ${actions.map((a, i) => (a === ACTIONS.DECREASE_LIQUIDITY && i === 0 && hasFeeTake(tf) ? 'DECREASE_LIQUIDITY(liquidity=0: fees only)' : ACTION_NAMES[a])).join(', ')}`,
      lines: [
        P.id !== 'USDC' ? `pool: ${P.label}` : null,
        `tokenId: ${tokenId}`,
        `liquidity removed: ${liquidity}`,
        expected ? `expected out (principal, never charged): ${fmt0(expected.amount0, P.id)} + ${fmt1(expected.amount1)}` : null,
        fees ? `plus uncollected earned fees: ${fmt0(fees.amount0, P.id)} + ${fmt1(fees.amount1)}` : null,
        ...toolFeeLines(tf, P),
        expected && tf.known
          ? `You receive: ${fmt0(expected.amount0 + tf.user0, P.id)} + ${fmt1(expected.amount1 + tf.user1)} (100% of the principal + 90% of the fees)`
          : tf.known ? `You receive: the principal + ${fmt0(tf.user0, P.id)} + ${fmt1(tf.user1)} (90% of the fees)` : null,
        `minimum out (slippage floor on the principal): ${fmt0(amount0Min, P.id)} + ${fmt1(amount1Min)}`,
        `recipient: ${recipient}`,
        hasFeeTake(tf) ? 'fees are paid out first (the tool fee comes only from them; the whole tx reverts if they were already collected), then the principal' : null,
        burn ? 'BURN_POSITION: the position NFT is destroyed' : null,
        `deadline: ${new Date(Number(deadline) * 1000).toISOString()}`,
      ].filter(Boolean),
    },
  };
}

/**
 * Burn an EMPTY position NFT (liquidity already 0): BURN_POSITION(mins 0) + TAKE_PAIR(recipient).
 * DECREASE_LIQUIDITY(0) cannot be used here: v4-core Position.update reverts with
 * CannotUpdateEmptyPosition when both the position liquidity and the delta are 0.
 * With liquidity 0, BURN_POSITION does not touch the pool, and fees were already paid out when the
 * liquidity was removed; TAKE_PAIR sweeps any credit (normally 0) to the recipient.
 * Tool fee: none. No fees can be paid out here (a position with liquidity 0 earns nothing, and its fees were
 * already credited, and charged, by the decrease that emptied it), so no TAKE is encoded.
 */
export function buildBurnEmpty({ tokenId, recipient, deadline, pool = 'USDC' }) {
  const P = lpPool(pool);
  assertLpPool(P.id);
  const actions = [ACTIONS.BURN_POSITION, ACTIONS.TAKE_PAIR];
  const params = [encodeBurnParams({ tokenId, amount0Min: 0n, amount1Min: 0n }), encodeTakePair(recipient, P.key.currency0, P.key.currency1)];
  return {
    pool: P.id,
    address: ADDR.POSITION_MANAGER,
    abi: POSM_ABI,
    functionName: 'modifyLiquidities',
    args: [encodeUnlockData(actions, params), deadline],
    actions,
    preview: {
      title: `Burn empty position NFT #${tokenId}`,
      contract: `Uniswap v4 PositionManager ${ADDR.POSITION_MANAGER}`,
      fn: 'modifyLiquidities — actions: BURN_POSITION, TAKE_PAIR',
      lines: [
        `tokenId: ${tokenId}`,
        'position liquidity is 0: no tokens move, the NFT is destroyed',
        'Tool fee: none (no fees are paid out)',
        `recipient (for any leftover credit, normally 0): ${recipient}`,
        `deadline: ${new Date(Number(deadline) * 1000).toISOString()}`,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Approval planning (ERC20 -> Permit2 -> PositionManager)
// ---------------------------------------------------------------------------
/**
 * @param need bigint amount the mint can pull (amountXMax)
 * @param erc20Allowance allowance(user, Permit2)
 * @param p2 { amount, expiration } from Permit2.allowance(user, token, POSM)
 * @returns { erc20: bool, permit2: bool }
 */
export function approvalNeeds(need, erc20Allowance, p2, nowSec = Math.floor(Date.now() / 1000), marginSec = 120) {
  if (need === 0n) return { erc20: false, permit2: false };
  return {
    erc20: erc20Allowance < need,
    permit2: BigInt(p2.amount) < need || Number(p2.expiration) < nowSec + marginSec,
  };
}

/** Read ERC20 allowance(user, Permit2) and Permit2.allowance(user, token, spender = POSM). */
export async function readAllowances(client, user, token, spender = ADDR.POSITION_MANAGER) {
  const [erc20Allowance, p2] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [user, ADDR.PERMIT2] }),
    client.readContract({ address: ADDR.PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [user, token, spender] }),
  ]);
  return { erc20Allowance, p2: { amount: p2[0], expiration: Number(p2[1]), nonce: Number(p2[2]) } };
}

/**
 * The EXACT ordered list of transactions to add liquidity (page and fork test both execute this list):
 *   per ERC20 token with amountMax>0:  [ERC20.approve(Permit2, amountMax | max)]  [Permit2.approve(token, POSM, amountMax | max160, now+30min)]
 *   then PositionManager.modifyLiquidities(MINT_POSITION + SETTLE_PAIR [+ SWEEP for native], now+10min)
 * Native HYPE needs no approval: it is the mint's transaction value. For the HYPE pool the HYPE reserve rule is
 * checked here with a gas buffer (balance - amount0Max - buffer gas >= reserve) and exactly again by
 * guardNativeMint() right before signing.
 * nowSec should be the latest block timestamp.
 */
export async function planMintTxs(client, user, plan, { infinite = false, nowSec, permitTtlSec = 1800, deadlineSec = 600 } = {}) {
  const P = lpPool(plan.pool);
  assertLpPool(P.id);
  if (P.native0 && plan.amount0Max > 0n) {
    const ctx = await readSwapContext(client, user);
    const lpMax = maxHypeForLp(ctx);
    if (plan.amount0Max > lpMax) {
      throw new Error(`Refused: ${fmtH(plan.amount0Max)} (max incl. slippage) + mint gas would dip into the ${fmtH(ctx.reserve)} gas reserve. Max HYPE for liquidity now ≈ ${fmtH(lpMax)}.`);
    }
  }
  const txs = [];
  for (const [token, need] of [
    [P.key.currency0, plan.amount0Max],
    [P.key.currency1, plan.amount1Max],
  ]) {
    if (need === 0n || BigInt(token) === 0n) continue;
    const { erc20Allowance, p2 } = await readAllowances(client, user, token);
    const needs = approvalNeeds(need, erc20Allowance, p2, nowSec);
    if (needs.erc20) txs.push({ kind: 'erc20-approve', ...buildErc20Approve(token, infinite ? MAX_UINT256 : need) });
    if (needs.permit2) txs.push({ kind: 'permit2-approve', ...buildPermit2Approve(token, infinite ? MAX_UINT160 : need, nowSec + permitTtlSec) });
  }
  txs.push({ kind: 'mint', ...buildMint({ plan, owner: user, deadline: deadlineFromNow(deadlineSec, nowSec) }) });
  return txs;
}

/** Min-out amounts for removing `liquidity` (principal only, fees come on top). */
export function planDecrease(state, pos, liquidity, slippageBps = 100) {
  const expected = getAmountsForLiquidity(state, pos.tickLower, pos.tickUpper, liquidity, false);
  return {
    liquidity,
    expected,
    amount0Min: withSlippageDown(expected.amount0, slippageBps),
    amount1Min: withSlippageDown(expected.amount1, slippageBps),
  };
}

// ---------------------------------------------------------------------------
// Pool state reading via PoolManager.extsload (StateLibrary layout)
// ---------------------------------------------------------------------------
const POOLS_SLOT = 6n;
export function poolStateSlot(poolId = TARGET_POOL_ID) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT]));
}
const slotPlus = (slot, n) => toHex(hexToBigInt(slot) + BigInt(n), { size: 32 });
export function tickInfoSlot(tick, poolId = TARGET_POOL_ID) {
  return keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'bytes32' }], [BigInt(tick), slotPlus(poolStateSlot(poolId), 4)]));
}
export function tickBitmapSlot(wordPos, poolId = TARGET_POOL_ID) {
  return keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'bytes32' }], [BigInt(wordPos), slotPlus(poolStateSlot(poolId), 5)]));
}
export function positionKey(owner, tickLower, tickUpper, salt) {
  return keccak256(encodePacked(['address', 'int24', 'int24', 'bytes32'], [owner, tickLower, tickUpper, salt]));
}
export function positionStateSlot(posKey, poolId = TARGET_POOL_ID) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [posKey, slotPlus(poolStateSlot(poolId), 6)]));
}
export const tokenIdSalt = (tokenId) => toHex(BigInt(tokenId), { size: 32 });

function signed(x, bits) {
  const b = BigInt(bits);
  const m = 1n << b;
  x &= m - 1n;
  return x >= m >> 1n ? x - m : x;
}
export function decodeSlot0(word) {
  const d = hexToBigInt(word);
  return {
    sqrtPriceX96: d & MAX_UINT160,
    tick: Number(signed(d >> 160n, 24)),
    protocolFee: Number((d >> 184n) & 0xffffffn),
    lpFee: Number((d >> 208n) & 0xffffffn),
  };
}

const pmRead = (client, args) =>
  client.readContract({ address: ADDR.POOL_MANAGER, abi: POOL_MANAGER_ABI, functionName: 'extsload', args });

/** slot0 + feeGrowthGlobals + active liquidity in one extsload(start, 4). poolId defaults to the LP pool. */
export async function readPoolState(client, blockNumber, poolId = TARGET_POOL_ID) {
  const words = await client.readContract({
    address: ADDR.POOL_MANAGER,
    abi: POOL_MANAGER_ABI,
    functionName: 'extsload',
    args: [poolStateSlot(poolId), 4n],
    blockNumber,
  });
  const s0 = decodeSlot0(words[0]);
  return {
    ...s0,
    feeGrowthGlobal0X128: hexToBigInt(words[1]),
    feeGrowthGlobal1X128: hexToBigInt(words[2]),
    liquidity: hexToBigInt(words[3]) & MAX_UINT128,
    initialized: s0.sqrtPriceX96 !== 0n,
  };
}

/** Exact pool TVL: walk the tick bitmap, read liquidityNet of each initialized tick, sum real amounts. */
export async function readPoolTvl(client, state, pool = 'USDC') {
  const P = lpPool(pool);
  const sp = P.key.tickSpacing;
  const minWord = Math.floor(Math.floor(MIN_TICK / sp) / 256);
  const maxWord = Math.floor(Math.floor(MAX_TICK / sp) / 256);
  const wordPositions = [];
  for (let w = minWord; w <= maxWord; w++) wordPositions.push(w);
  const words = await pmRead(client, [wordPositions.map((w) => tickBitmapSlot(w, P.poolId))]);
  const ticks = [];
  words.forEach((wHex, i) => {
    let bits = hexToBigInt(wHex);
    for (let b = 0; bits > 0n; b++, bits >>= 1n) {
      if (bits & 1n) ticks.push((wordPositions[i] * 256 + b) * sp);
    }
  });
  ticks.sort((a, b) => a - b);
  if (ticks.length === 0) return { amount0: 0n, amount1: 0n, ticks: [] };
  const infos = await pmRead(client, [ticks.map((t) => tickInfoSlot(t, P.poolId))]);
  let L = 0n;
  let amount0 = 0n;
  let amount1 = 0n;
  const detail = [];
  for (let i = 0; i < ticks.length; i++) {
    const word = hexToBigInt(infos[i]);
    const liquidityNet = signed(word >> 128n, 128);
    L += liquidityNet;
    detail.push({ tick: ticks[i], liquidityNet });
    if (i + 1 < ticks.length && L > 0n) {
      const a = getAmountsForLiquidity(state, ticks[i], ticks[i + 1], L, false);
      amount0 += a.amount0;
      amount1 += a.amount1;
    }
  }
  return { amount0, amount1, ticks: detail };
}

/**
 * v4 position: PositionManager owns it, salt = bytes32(tokenId). pool = which LP pool `state` belongs to.
 * If the NFT is in another pool, returns { samePool: false, lpPool: 'USDC'|'HYPE'|null } so the caller can
 * re-read it with that pool's state.
 */
export async function readPosition(client, tokenId, state, pool = 'USDC') {
  const P = lpPool(pool);
  const [poolKey, info] = await client.readContract({
    address: ADDR.POSITION_MANAGER,
    abi: POSM_ABI,
    functionName: 'getPoolAndPositionInfo',
    args: [BigInt(tokenId)],
  });
  const pi = decodePositionInfo(info);
  const samePool =
    getAddress(poolKey.currency0) === getAddress(P.key.currency0) &&
    getAddress(poolKey.currency1) === getAddress(P.key.currency1) &&
    Number(poolKey.fee) === P.key.fee &&
    Number(poolKey.tickSpacing) === P.key.tickSpacing &&
    getAddress(poolKey.hooks) === getAddress(P.key.hooks);
  if (info === 0n) return { tokenId: BigInt(tokenId), exists: false };
  if (!samePool) return { tokenId: BigInt(tokenId), exists: true, samePool: false, lpPool: lpPoolOfKey(poolKey), poolKey, tickLower: pi.tickLower, tickUpper: pi.tickUpper };
  const pk = positionKey(ADDR.POSITION_MANAGER, pi.tickLower, pi.tickUpper, tokenIdSalt(tokenId));
  const [posWords, lowerWords, upperWords] = await Promise.all([
    pmRead(client, [positionStateSlot(pk, P.poolId), 3n]),
    pmRead(client, [tickInfoSlot(pi.tickLower, P.poolId), 3n]),
    pmRead(client, [tickInfoSlot(pi.tickUpper, P.poolId), 3n]),
  ]);
  const liquidity = hexToBigInt(posWords[0]) & MAX_UINT128;
  const last0 = hexToBigInt(posWords[1]);
  const last1 = hexToBigInt(posWords[2]);
  const lower = { fgo0: hexToBigInt(lowerWords[1]), fgo1: hexToBigInt(lowerWords[2]) };
  const upper = { fgo0: hexToBigInt(upperWords[1]), fgo1: hexToBigInt(upperWords[2]) };
  const inside = feeGrowthInside(state, pi.tickLower, pi.tickUpper, lower, upper);
  const fees = {
    amount0: mulDiv((inside.fg0 - last0 + MOD256) % MOD256, liquidity, Q128),
    amount1: mulDiv((inside.fg1 - last1 + MOD256) % MOD256, liquidity, Q128),
  };
  const amounts = getAmountsForLiquidity(state, pi.tickLower, pi.tickUpper, liquidity, false);
  return {
    tokenId: BigInt(tokenId),
    exists: true,
    samePool,
    lpPool: P.id,
    poolId: pi.poolId,
    tickLower: pi.tickLower,
    tickUpper: pi.tickUpper,
    hasSubscriber: pi.hasSubscriber,
    liquidity,
    inRange: state.tick >= pi.tickLower && state.tick < pi.tickUpper,
    amounts,
    fees,
  };
}

export function decodePositionInfo(info) {
  const v = BigInt(info);
  return {
    hasSubscriber: (v & 0xffn) !== 0n,
    tickLower: Number(signed(v >> 8n, 24)),
    tickUpper: Number(signed(v >> 32n, 24)),
    poolId: toHex(v >> 56n, { size: 25 }),
  };
}

/** StateLibrary.getFeeGrowthInside (unchecked arithmetic mod 2^256). */
export function feeGrowthInside(state, tickLower, tickUpper, lower, upper) {
  const sub = (a, b) => (a - b + MOD256) % MOD256;
  if (state.tick < tickLower) return { fg0: sub(lower.fgo0, upper.fgo0), fg1: sub(lower.fgo1, upper.fgo1) };
  if (state.tick >= tickUpper) return { fg0: sub(upper.fgo0, lower.fgo0), fg1: sub(upper.fgo1, lower.fgo1) };
  return {
    fg0: sub(sub(state.feeGrowthGlobal0X128, lower.fgo0), upper.fgo0),
    fg1: sub(sub(state.feeGrowthGlobal1X128, lower.fgo1), upper.fgo1),
  };
}

// ---------------------------------------------------------------------------
// Receipts / logs
// ---------------------------------------------------------------------------
/** tokenId from the ERC721 Transfer(0x0 -> owner) emitted by PositionManager. */
export function parseMintedTokenId(receipt, owner) {
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== ADDR.POSITION_MANAGER) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 4) continue;
    const ev = decodeEventLog({ abi: [ERC721_TRANSFER_EVENT], data: log.data, topics: log.topics });
    if (BigInt(ev.args.from) === 0n && (!owner || getAddress(ev.args.to) === getAddress(owner))) return ev.args.id;
  }
  return null;
}

/**
 * Scan PositionManager Transfer(*, owner, id) logs in chunks. Returns candidate tokenIds (still need ownerOf check).
 * onProgress(fromBlock, toBlock, latest) is called per chunk.
 */
export async function scanTokenIdsTo(client, owner, { fromBlock = POSM_DEPLOY_BLOCK, chunk = 200000n, onProgress } = {}) {
  const latest = await client.getBlockNumber();
  const ids = new Set();
  const ownerTopic = encodeAbiParameters([{ type: 'address' }], [owner]);
  let step = chunk;
  for (let start = BigInt(fromBlock); start <= latest; ) {
    const end = start + step - 1n > latest ? latest : start + step - 1n;
    try {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ address: ADDR.POSITION_MANAGER, fromBlock: toHex(start), toBlock: toHex(end), topics: [TRANSFER_TOPIC, null, ownerTopic] }],
      });
      for (const l of logs) ids.add(hexToBigInt(l.topics[3]));
      onProgress?.(start, end, latest);
      start = end + 1n;
    } catch (e) {
      if (step <= 1000n) throw e;
      step /= 4n; // RPC range/limit errors -> shrink and retry
    }
  }
  return [...ids].sort((a, b) => (a < b ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Step 1: get tokens. Swap native HYPE -> USDC / KNTQ through Uniswap v4 (Universal Router, V4_SWAP).
//
// Router: Uniswap UniversalRouter 2.1.2 on Elysium, 0xA13f…4b45. Evidence it is the canonical/default one:
//   - Uniswap/contracts PR #179 (deployments/json/99901.json) records it as `UniversalRouter#v2.1.2` AND as the
//     unversioned `UniversalRouter` key; merged PR #169 defines that bare key as "the current recommended router"
//     (2.1.2) on every chain. Uniswap/universal-router PR #533/#534 add it to deploy-addresses/elysium.json.
//     (Both registry PRs were still open when this was written; the 2.2.0 router 0x1B34…3C1a is recorded too.)
//   - Its runtime bytecode is byte-identical to Uniswap's HyperEVM UniversalRouter 2.1.2 (0xeD27…d6bF, merged
//     deploy-addresses/hyperevm.json) except for constructor immutables: PoolManager 0xE2e1…23F1, PositionManager,
//     WHYPE, v2/v3 factories, chain id 99901. Permit2 0x0000…8BA3 is embedded; poolManager() == official PM.
// Layout: universal-router 2.1.2 pins v4-periphery 545a5d2, whose IV4Router.ExactInputSingleParams is
//   (PoolKey poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)
//   minHopPriceX36 = 0 disables the per-hop price check (V4Router._swapExactInputSingle).
// SETTLE_ALL(currency, maxAmount) / TAKE_ALL(currency, minAmount) pay / pay out msgSender() = the signer.
// For native HYPE, SETTLE_ALL calls poolManager.settle{value: amount}() from the router's balance (= msg.value).
// ---------------------------------------------------------------------------
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const UNIVERSAL_ROUTER = getAddress('0xA13f7611115752DEB2B13813BDDE16A5073e4b45');
/** Uniswap UniversalRouter 2.2.0 on Elysium: also genuine, NOT used by this page (kept for reference / checks). */
export const UNIVERSAL_ROUTER_V2_2 = getAddress('0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a');
export const HYPE = Object.freeze({ address: ZERO_ADDRESS, symbol: 'HYPE', decimals: 18 });

export const UR_COMMANDS = Object.freeze({ SWEEP: 0x04, V4_SWAP: 0x10 }); // universal-router Commands.sol

export const UR_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function poolManager() view returns (address)',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)',
  'error V4TooLittleReceivedPerHopSingle(uint256 minPrice, uint256 price)',
  'error TransactionDeadlinePassed()',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error InsufficientETH()',
  'error InsufficientToken()',
  'error LengthMismatch()',
  'error InvalidCommandType(uint256 commandType)',
  'error ContractLocked()',
  'error CurrencyNotSettled()',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
]);

const swapPool = (out, fee, tickSpacing, id) =>
  Object.freeze({
    out,
    key: Object.freeze({ currency0: ZERO_ADDRESS, currency1: out.address, fee, tickSpacing, hooks: ZERO_ADDRESS }),
    id,
  });
/** Both pools: hookless, on the official PoolManager, currency0 = native HYPE. zeroForOne = HYPE in. */
export const SWAP_POOLS = Object.freeze({
  USDC: swapPool(TOKEN0, 3000, 60, '0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc'),
  KNTQ: swapPool(TOKEN1, 8000, 120, '0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472'),
});
export const SWAP_POOL_IDS_OK = Object.values(SWAP_POOLS).every((p) => poolIdOf(p.key).toLowerCase() === p.id.toLowerCase());

// ---------------------------------------------------------------------------
// LP pools (Step 2 pool selector). Each has a FROZEN key and a pool id the page recomputes client-side;
// every LP write builder calls assertLpPool(pool) and refuses on mismatch.
//   USDC: the original USDC/KNTQ 2% pool (POOL_KEY / TARGET_POOL_ID, unchanged).
//   HYPE: the official KNTQ/HYPE 0.8% pool = the same key as SWAP_POOLS.KNTQ (currency0 = native HYPE 0x0).
// ---------------------------------------------------------------------------
export const LP_POOLS = Object.freeze({
  USDC: Object.freeze({
    id: 'USDC', label: 'KNTQ/USDC 2%', pairLabel: 'USDC/KNTQ', key: POOL_KEY, poolId: TARGET_POOL_ID,
    token0: TOKEN0, token1: TOKEN1, native0: false,
  }),
  HYPE: Object.freeze({
    id: 'HYPE', label: 'KNTQ/HYPE 0.8%', pairLabel: 'HYPE/KNTQ', key: SWAP_POOLS.KNTQ.key, poolId: SWAP_POOLS.KNTQ.id,
    token0: HYPE, token1: TOKEN1, native0: true,
  }),
});
export const LP_POOL_IDS_OK = Object.values(LP_POOLS).every((p) => poolIdOf(p.key).toLowerCase() === p.poolId.toLowerCase());

/** 'USDC' | 'HYPE' | pool object | undefined (= USDC) -> pool object. */
export function lpPool(pool) {
  if (pool === undefined || pool === null) return LP_POOLS.USDC;
  if (typeof pool === 'object' && pool.id && LP_POOLS[pool.id] === pool) return pool;
  const p = LP_POOLS[pool];
  if (!p) throw new Error(`Unknown LP pool ${String(pool)}`);
  return p;
}
/** Throws unless the pool's frozen key hashes to its expected id. Every LP write path calls this. */
export function assertLpPool(pool) {
  const p = lpPool(pool);
  const id = poolIdOf(p.key);
  if (id.toLowerCase() !== p.poolId.toLowerCase()) throw new Error(`${p.label} PoolKey hashes to ${id}, expected ${p.poolId}. Refusing to build a transaction.`);
  if (p.id === 'USDC') assertTargetPool(p.key);
  return id;
}
/** LP pool id ('USDC' | 'HYPE') for an on-chain PoolKey, or null if it is neither. */
export function lpPoolOfKey(key) {
  const id = poolIdOf({ currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks }).toLowerCase();
  for (const p of Object.values(LP_POOLS)) if (p.poolId.toLowerCase() === id) return p.id;
  return null;
}

/** Throws unless out is USDC/KNTQ and its hardcoded PoolKey hashes to the expected pool id. */
export function assertSwapPool(out) {
  const p = SWAP_POOLS[out];
  if (!p) throw new Error(`Unknown swap output ${out}`);
  const id = poolIdOf(p.key);
  if (id.toLowerCase() !== p.id.toLowerCase()) throw new Error(`HYPE/${out} PoolKey hashes to ${id}, expected ${p.id}. Refusing to swap.`);
  return p;
}

/** USD value of HYPE kept back for gas. */
export const HYPE_RESERVE_USD = 8;
/** Cushion on the $8 for HYPE price moves between swapping and finishing the LP flow (bps). */
export const HYPE_RESERVE_CUSHION_BPS = 300n;
/** Gas budget kept ON TOP of the $8 for the rest of the flow: 4 approvals + mint + collect + remove + burn
 *  (+ a second swap), each assumed at 500k gas (real: ~50k–350k). */
export const LP_FLOW_GAS_UNITS = 9n * 500_000n;
/** Gas units assumed per swap before an exact eth_estimateGas exists (~130k measured on Elysium; 3x margin). */
export const SWAP_GAS_BUFFER_UNITS = 400_000n;
/** Hard cap on swap slippage (bps). */
export const MAX_SWAP_SLIPPAGE_BPS = 500;

export function encodeExactInputSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36 = 0n, hookData = '0x' }) {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [POOL_KEY_PARAM, { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bytes' }] }],
    [[poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData]]
  );
}
/** SETTLE_ALL / TAKE_ALL params: (Currency currency, uint256 amount) */
export function encodeCurrencyAmount(currency, amount) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, amount]);
}
/** universal-router SWEEP input: (address token, address recipient, uint160 amountMin); token 0x0 = native. */
export function encodeSweep(token, recipient, amountMin = 0n) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint160' }], [token, recipient, amountMin]);
}

const fmtH = (x) => `${fmtAmount(x, 18, 6)} HYPE`;
const fmtT = (t, x) => `${fmtAmount(x, t.decimals, 6)} ${t.symbol}`;

/**
 * UniversalRouter.execute([V4_SWAP, SWEEP], [abi.encode(actions, params), sweep], deadline) with msg.value = amountIn.
 *   actions: SWAP_EXACT_IN_SINGLE(HYPE -> out, amountIn, minOut), SETTLE_ALL(HYPE, maxAmount = amountIn), TAKE_ALL(out, minOut)
 *   SWEEP(native, recipient, 0) returns any HYPE the swap did not use (only possible if the pool ran out of liquidity).
 * The output token goes to msg.sender (TAKE_ALL), so recipient must be the signer.
 */
export function buildSwapHype({ out, amountIn, minAmountOut, recipient, deadline, info }) {
  const p = assertSwapPool(out);
  if (!(amountIn > 0n)) throw new Error('Swap amount must be > 0');
  if (amountIn > MAX_UINT128 || minAmountOut > MAX_UINT128) throw new Error('amount exceeds uint128');
  if (!(minAmountOut > 0n)) throw new Error('Minimum received must be > 0');
  const actions = [ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL];
  const params = [
    encodeExactInputSingle({ poolKey: p.key, zeroForOne: true, amountIn, amountOutMinimum: minAmountOut }),
    encodeCurrencyAmount(HYPE.address, amountIn),
    encodeCurrencyAmount(p.out.address, minAmountOut),
  ];
  const commands = toHex(Uint8Array.from([UR_COMMANDS.V4_SWAP, UR_COMMANDS.SWEEP]));
  const inputs = [encodeUnlockData(actions, params), encodeSweep(HYPE.address, recipient, 0n)];
  const lines = [
    `you send: ${fmtH(amountIn)} (transaction value)`,
    info?.quote !== undefined ? `expected: ${fmtT(p.out, info.quote)} (exact simulation of this call)` : null,
    `minimum received: ${fmtT(p.out, minAmountOut)}${info?.slippageBps !== undefined ? ` (slippage ${(info.slippageBps / 100).toFixed(2)}%)` : ''}`,
    info?.priceImpactPct !== undefined ? `price impact vs pool mid price: ${info.priceImpactPct.toFixed(3)}% (plus ${(p.key.fee / 10000).toFixed(2)}% pool fee)` : `pool fee: ${(p.key.fee / 10000).toFixed(2)}%`,
    `pool: HYPE/${out} fee ${p.key.fee / 10000}% spacing ${p.key.tickSpacing}, no hooks, id ${p.id}`,
    info?.gasLimit ? `gas: limit ${info.gasLimit} (eth_estimateGas + ${info.gasMarginPct}%), max cost ${fmtH(info.gasCost)}` : null,
    info?.reserve !== undefined ? `HYPE kept for gas: ${fmtH(info.reserve)} (≥ $${HYPE_RESERVE_USD}); HYPE left after: ≥ ${fmtH(info.balanceAfterMin)}` : null,
    `output to: ${recipient} (the signer); unused HYPE swept back to the same address`,
    `deadline: ${new Date(Number(deadline) * 1000).toISOString()}`,
  ].filter(Boolean);
  return {
    kind: 'swap',
    address: UNIVERSAL_ROUTER,
    abi: UR_ABI,
    functionName: 'execute',
    args: [commands, inputs, deadline],
    tx: { value: amountIn },
    actions,
    preview: {
      title: `Swap ${fmtH(amountIn)} → ${out}`,
      contract: `Uniswap UniversalRouter 2.1.2 ${UNIVERSAL_ROUTER}`,
      fn: 'execute(commands, inputs, deadline) — V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL; SWEEP',
      lines,
    },
  };
}

/** Find revert data (0x + selector…) inside a viem error. */
export function revertDataOf(e) {
  let found = null;
  const look = (x) => {
    for (const d of [x?.data, x?.data?.data, x?.cause?.data]) if (typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d)) return d;
    return null;
  };
  if (e?.walk) e.walk((x) => (found = found || look(x)) && true);
  return found || look(e);
}

/** Placeholder sender for read-only quotes (no wallet). Its balance is overridden in the eth_call only. */
export const QUOTE_SENDER = '0x000000000000000000000000000000000000dEaD';

/**
 * Exact quote: eth_call of the SAME execute() (from `from`, value = amountIn) with minAmountOut = 2^128-1.
 * The router reverts V4TooLittleReceived(min, amountReceived); amountReceived is the exact output at this block.
 * The sender's balance is raised in the eth_call only (stateOverride), so quotes work before funding / read-only.
 */
export async function quoteHypeSwap(client, { out, amountIn, from = QUOTE_SENDER, blockNumber }) {
  const req = buildSwapHype({ out, amountIn, minAmountOut: MAX_UINT128, recipient: from, deadline: 1n << 40n });
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
  try {
    await client.call({
      account: from,
      to: req.address,
      data,
      value: amountIn,
      blockNumber,
      stateOverride: [{ address: from, balance: amountIn + 10n ** 21n }],
    });
  } catch (e) {
    const rd = revertDataOf(e);
    if (!rd) throw new Error('Quote failed: ' + (e.shortMessage || e.message));
    let dec;
    try {
      dec = decodeErrorResult({ abi: UR_ABI, data: rd });
    } catch {
      throw new Error(`Quote failed: unknown revert ${rd.slice(0, 10)}`);
    }
    if (dec.errorName === 'V4TooLittleReceived' && dec.args[0] === MAX_UINT128) return dec.args[1];
    throw new Error(`Quote failed: ${dec.errorName}(${(dec.args || []).join(', ')})`);
  }
  throw new Error('Quote failed: the call did not revert as expected');
}

/** USDC (6 dec) per 1 HYPE from the USDC/HYPE pool sqrtPrice (exact bigint floor). */
export function usdcPerHypeE6(sqrtPriceX96) {
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
}
/** Output (raw token1) for amountIn HYPE at the pool mid price, before fee. */
export function midOutForHype(sqrtPriceX96, amountIn) {
  return (amountIn * sqrtPriceX96 * sqrtPriceX96) >> 192n;
}
/** reserve = USD 8 worth of HYPE, in wei, rounded up. Integer math on the USDC/HYPE pool price. */
export function hypeReserveWei(usdcPerHypeE6Value, reserveUsd = HYPE_RESERVE_USD) {
  if (!(usdcPerHypeE6Value > 0n)) throw new Error('HYPE price unavailable: refusing to swap');
  const usdE6 = BigInt(Math.round(reserveUsd * 1e6));
  // Exactly reserveUsd worth of HYPE, rounded UP to the wei (never less than $8).
  return (usdE6 * 10n ** 18n + usdcPerHypeE6Value - 1n) / usdcPerHypeE6Value;
}
/** Largest swap that keeps balance >= reserve + gas. Never negative. */
export function maxHypeSwap({ balance, reserve, gasCost }) {
  const m = balance - reserve - gasCost;
  return m > 0n ? m : 0n;
}
/** Price impact (%) of a quote vs the mid price after the LP fee. */
export function priceImpactPct(midOut, lpFee, quote) {
  const afterFee = (midOut * BigInt(1_000_000 - lpFee)) / 1_000_000n;
  if (afterFee === 0n) return 0;
  return (1 - Number((quote * 10n ** 12n) / afterFee) / 1e12) * 100;
}

/**
 * Fee caps for every tx the page sends. Elysium (Arbitrum Orbit) base fee drifts up between blocks, and wallets
 * sometimes pick a cap at ~baseFee, which the node rejects ("max fee per gas less than block base fee").
 * Arbitrum charges only the actual base fee, so a 2x cap costs nothing extra; it is just headroom.
 */
export async function readGasFees(client) {
  const block = await client.getBlock({ blockTag: 'latest' });
  const base = block.baseFeePerGas ?? (await client.getGasPrice());
  let prio = 0n;
  try { prio = await client.estimateMaxPriorityFeePerGas(); } catch { prio = 0n; }
  return { maxFeePerGas: base * 2n + prio, maxPriorityFeePerGas: prio };
}

/**
 * Everything Step 1 shows: HYPE price (USDC/HYPE pool), reserve, balance, fee caps, max swappable.
 * account may be null (read-only): balance and max are then null.
 */
export async function readSwapContext(client, account) {
  const [usdcPool, kntqPool, fees, balance] = await Promise.all([
    readPoolState(client, undefined, SWAP_POOLS.USDC.id),
    readPoolState(client, undefined, SWAP_POOLS.KNTQ.id),
    readGasFees(client),
    account ? client.getBalance({ address: account }) : Promise.resolve(null),
  ]);
  if (!usdcPool.initialized || !kntqPool.initialized) throw new Error('HYPE pool not initialized');
  const priceE6 = usdcPerHypeE6(usdcPool.sqrtPriceX96);
  // $8 (+3% for price moves) stays in the wallet AFTER every later tx's gas, so keep that gas on top.
  const base = hypeReserveWei(priceE6);
  const reserve = base + (base * HYPE_RESERVE_CUSHION_BPS + 9_999n) / 10_000n + LP_FLOW_GAS_UNITS * fees.maxFeePerGas;
  const gasBuffer = SWAP_GAS_BUFFER_UNITS * fees.maxFeePerGas;
  return {
    pools: { USDC: usdcPool, KNTQ: kntqPool },
    usdcPerHypeE6: priceE6,
    hypeUsd: Number(priceE6) / 1e6,
    kntqPerHype: Number(formatUnits(midOutForHype(kntqPool.sqrtPriceX96, 10n ** 18n), 18)),
    reserve,
    fees,
    gasBuffer,
    balance,
    max: balance === null ? null : maxHypeSwap({ balance, reserve, gasCost: gasBuffer }),
    // HYPE that may go into a KNTQ/HYPE position: same rule as swaps, with the mint's gas buffer.
    lpMax: balance === null ? null : maxHypeSwap({ balance, reserve, gasCost: LP_MINT_GAS_BUFFER_UNITS * fees.maxFeePerGas }),
  };
}

/** Gas units assumed for a native-HYPE mint before an exact eth_estimateGas exists (~350–450k real; margin). */
export const LP_MINT_GAS_BUFFER_UNITS = 800_000n;
/** Max HYPE a KNTQ/HYPE mint may send as value (= amount0Max): balance - reserve - mint gas buffer. */
export function maxHypeForLp(ctx) {
  if (ctx.balance === null || ctx.balance === undefined) return 0n;
  return maxHypeSwap({ balance: ctx.balance, reserve: ctx.reserve, gasCost: LP_MINT_GAS_BUFFER_UNITS * ctx.fees.maxFeePerGas });
}

/**
 * Exact reserve check for a native-HYPE mint, right before signing (after the KNTQ approvals exist):
 * eth_estimateGas (+margin) with value = amount0Max, refuse unless balance - value - gasLimit*maxFee >= reserve,
 * then pin value, gas and fee caps on req.tx. Non-native requests are returned unchanged.
 */
export async function guardNativeMint(client, req, account, { gasMarginPct = 25 } = {}) {
  if (!req.tx?.value) return req;
  const P = lpPool(req.pool);
  if (!P.native0 || req.address !== ADDR.POSITION_MANAGER || req.tx.value !== req.amount0Max) throw new Error('Refused: unexpected transaction value on a mint.');
  const ctx = await readSwapContext(client, account);
  const value = req.tx.value;
  if (ctx.balance - value < ctx.reserve) throw new Error(`Refused: sending ${fmtH(value)} would leave less than the ${fmtH(ctx.reserve)} gas reserve. Max now ≈ ${fmtH(maxHypeForLp(ctx))}.`);
  const est = await client.estimateContractGas({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args, value, account });
  const gasLimit = (est * BigInt(100 + gasMarginPct)) / 100n;
  const gasCost = gasLimit * ctx.fees.maxFeePerGas;
  const balanceAfterMin = ctx.balance - value - gasCost;
  if (balanceAfterMin < ctx.reserve) throw new Error(`Refused: ${fmtH(value)} + gas (≤ ${fmtH(gasCost)}) would leave less than the ${fmtH(ctx.reserve)} gas reserve.`);
  req.tx = { value, gas: gasLimit, maxFeePerGas: ctx.fees.maxFeePerGas, maxPriorityFeePerGas: ctx.fees.maxPriorityFeePerGas };
  req.preview.lines = req.preview.lines.filter((l) => !l.startsWith('gas:') && !l.startsWith('HYPE kept for gas'));
  req.preview.lines.push(`gas: limit ${gasLimit} (eth_estimateGas + ${gasMarginPct}%), max cost ${fmtH(gasCost)}`);
  req.preview.lines.push(`HYPE kept for gas: ${fmtH(ctx.reserve)} (≥ $${HYPE_RESERVE_USD}); HYPE left after: ≥ ${fmtH(balanceAfterMin)} (+ the unused HYPE swept back)`);
  return req;
}

/**
 * Which requests may carry a transaction value: only a HYPE swap to the UniversalRouter (value = amountIn)
 * and a native-pool mint to the PositionManager (value = amount0Max, with SWEEP back to the signer).
 * Gas-only req.tx (no value) is allowed on swaps (USDC -> HYPE).
 */
export function txValueAllowed(req) {
  if (!req.tx) return true;
  const v = req.tx.value ?? 0n;
  if (req.kind === 'swap' && req.address === UNIVERSAL_ROUTER) return true;
  if (v === 0n && req.kind !== 'mint') return false;
  if (req.kind === 'mint' && req.address === ADDR.POSITION_MANAGER) {
    const P = lpPool(req.pool);
    return P.native0 && v === req.amount0Max && req.actions.at(-1) === ACTIONS.SWEEP;
  }
  return false;
}

/**
 * The exact swap the page signs, with every check:
 *   pool id + router checks, exact quote (revert trick), min out, eth_estimateGas (+margin), fee caps,
 *   and refusal unless balance - amountIn - gasLimit*maxFeePerGas >= reserve.
 * Returns { req, quote, minOut, ... }; req.tx carries { value, gas, maxFeePerGas, maxPriorityFeePerGas }.
 */
export async function planHypeSwap(client, { out, amountIn, account, slippageBps = 100, nowSec, deadlineSec = 600, gasMarginPct = 25 }) {
  const p = assertSwapPool(out);
  if (!account) throw new Error('Connect a wallet first');
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SWAP_SLIPPAGE_BPS) throw new Error(`Slippage must be 0.01%–${MAX_SWAP_SLIPPAGE_BPS / 100}%`);
  if (!(amountIn > 0n)) throw new Error('Swap amount must be > 0');
  const ctx = await readSwapContext(client, account);
  if (ctx.balance - amountIn < ctx.reserve) {
    throw new Error(`Refused: would leave less than the ${fmtH(ctx.reserve)} gas reserve. Max now ≈ ${fmtH(ctx.max)}.`);
  }
  const pool = ctx.pools[out];
  const quote = await quoteHypeSwap(client, { out, amountIn, from: account });
  if (quote === 0n) throw new Error('Quote is 0: amount too small');
  const minOut = withSlippageDown(quote, slippageBps);
  if (minOut === 0n) throw new Error('Amount too small: minimum received rounds to 0');
  const midOut = midOutForHype(pool.sqrtPriceX96, amountIn);
  const impact = priceImpactPct(midOut, pool.lpFee, quote);
  const deadline = deadlineFromNow(deadlineSec, nowSec);
  const base = buildSwapHype({ out, amountIn, minAmountOut: minOut, recipient: account, deadline });
  // normal eth_estimateGas from the signer, with the real value
  const est = await client.estimateContractGas({ address: base.address, abi: base.abi, functionName: base.functionName, args: base.args, value: amountIn, account });
  const gasLimit = (est * BigInt(100 + gasMarginPct)) / 100n;
  const gasCost = gasLimit * ctx.fees.maxFeePerGas;
  const balanceAfterMin = ctx.balance - amountIn - gasCost;
  if (balanceAfterMin < ctx.reserve) {
    const maxOk = maxHypeSwap({ balance: ctx.balance, reserve: ctx.reserve, gasCost });
    throw new Error(`Refused: ${fmtH(amountIn)} + gas (≤ ${fmtH(gasCost)}) would leave less than the ${fmtH(ctx.reserve)} reserve. Max ${fmtH(maxOk)}.`);
  }
  const info = { quote, slippageBps, priceImpactPct: impact, gasLimit, gasMarginPct, gasCost, reserve: ctx.reserve, balanceAfterMin };
  const req = buildSwapHype({ out, amountIn, minAmountOut: minOut, recipient: account, deadline, info });
  req.tx = { value: amountIn, gas: gasLimit, maxFeePerGas: ctx.fees.maxFeePerGas, maxPriorityFeePerGas: ctx.fees.maxPriorityFeePerGas };
  return {
    req,
    out,
    token: p.out,
    amountIn,
    quote,
    minOut,
    midOut,
    priceImpactPct: impact,
    feePct: pool.lpFee / 10000,
    gasEstimate: est,
    gasLimit,
    gasCost,
    reserve: ctx.reserve,
    hypeUsd: ctx.hypeUsd,
    balance: ctx.balance,
    balanceAfterMin,
  };
}

// ---------------------------------------------------------------------------
// USDC -> HYPE (reverse of Step 1; migration step b). Exact USDC in, on the HYPE/USDC 0.3% pool.
//   currency0 = native HYPE, currency1 = USDC  =>  USDC in is zeroForOne = false.
//   UniversalRouter.execute([V4_SWAP], [abi.encode(actions, params)], deadline), NO value:
//     SWAP_EXACT_IN_SINGLE(USDC -> HYPE, amountIn, minOut), SETTLE_ALL(USDC, amountIn), TAKE_ALL(native, minOut).
//   SETTLE_ALL pays from msgSender() via Permit2.transferFrom(user -> PoolManager) (the router's
//   Permit2Payments), so USDC needs ERC20.approve(Permit2, amount) + Permit2.approve(USDC, UniversalRouter,
//   amount, now+30min). TAKE_ALL calls poolManager.take(native, msgSender(), amount): HYPE goes straight to
//   the signer. The router's V4TooLittleReceived check runs INSIDE the swap action, before SETTLE_ALL, so the
//   revert-trick quote needs no USDC balance or allowance.
// ---------------------------------------------------------------------------
export function buildSwapUsdcToHype({ amountIn, minAmountOut, recipient, deadline, info }) {
  const p = assertSwapPool('USDC');
  if (!(amountIn > 0n)) throw new Error('Swap amount must be > 0');
  if (amountIn > MAX_UINT128 || minAmountOut > MAX_UINT128) throw new Error('amount exceeds uint128');
  if (!(minAmountOut > 0n)) throw new Error('Minimum received must be > 0');
  const actions = [ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL];
  const params = [
    encodeExactInputSingle({ poolKey: p.key, zeroForOne: false, amountIn, amountOutMinimum: minAmountOut }),
    encodeCurrencyAmount(TOKEN0.address, amountIn),
    encodeCurrencyAmount(HYPE.address, minAmountOut),
  ];
  const commands = toHex(Uint8Array.from([UR_COMMANDS.V4_SWAP]));
  const inputs = [encodeUnlockData(actions, params)];
  const lines = [
    `you pay: ${fmtT(TOKEN0, amountIn)} (pulled through Permit2; no transaction value)`,
    info?.quote !== undefined ? `expected: ${fmtH(info.quote)} (exact simulation of this call)` : null,
    `minimum received: ${fmtH(minAmountOut)}${info?.slippageBps !== undefined ? ` (slippage ${(info.slippageBps / 100).toFixed(2)}%)` : ''}`,
    info?.priceImpactPct !== undefined ? `price impact vs pool mid price: ${info.priceImpactPct.toFixed(3)}% (plus ${(p.key.fee / 10000).toFixed(2)}% pool fee)` : `pool fee: ${(p.key.fee / 10000).toFixed(2)}%`,
    `pool: HYPE/USDC fee ${p.key.fee / 10000}% spacing ${p.key.tickSpacing}, no hooks, id ${p.id}`,
    info?.gasLimit ? `gas: limit ${info.gasLimit} (eth_estimateGas + ${info.gasMarginPct}%), max cost ${fmtH(info.gasCost)}` : null,
    `HYPE to: ${recipient} (the signer) as native HYPE; your existing HYPE reserve is not touched (gas only)`,
    `deadline: ${new Date(Number(deadline) * 1000).toISOString()}`,
  ].filter(Boolean);
  return {
    kind: 'swap',
    address: UNIVERSAL_ROUTER,
    abi: UR_ABI,
    functionName: 'execute',
    args: [commands, inputs, deadline],
    actions,
    preview: {
      title: `Swap ${fmtT(TOKEN0, amountIn)} → HYPE`,
      contract: `Uniswap UniversalRouter 2.1.2 ${UNIVERSAL_ROUTER}`,
      fn: 'execute(commands, inputs, deadline) — V4_SWAP: SWAP_EXACT_IN_SINGLE (zeroForOne=false), SETTLE_ALL(USDC), TAKE_ALL(HYPE)',
      lines,
    },
  };
}

/** Exact USDC -> HYPE quote: eth_call of the same execute() with minOut = 2^128-1 (reverts inside the swap action). */
export async function quoteUsdcToHype(client, { amountIn, from = QUOTE_SENDER, blockNumber }) {
  const req = buildSwapUsdcToHype({ amountIn, minAmountOut: MAX_UINT128, recipient: from, deadline: 1n << 40n });
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
  try {
    await client.call({ account: from, to: req.address, data, blockNumber });
  } catch (e) {
    const rd = revertDataOf(e);
    if (!rd) throw new Error('Quote failed: ' + (e.shortMessage || e.message));
    let dec;
    try {
      dec = decodeErrorResult({ abi: UR_ABI, data: rd });
    } catch {
      throw new Error(`Quote failed: unknown revert ${rd.slice(0, 10)}`);
    }
    if (dec.errorName === 'V4TooLittleReceived' && dec.args[0] === MAX_UINT128) return dec.args[1];
    throw new Error(`Quote failed: ${dec.errorName}(${(dec.args || []).join(', ')})`);
  }
  throw new Error('Quote failed: the call did not revert as expected');
}
/** HYPE out for amountIn USDC at the pool mid price, before fee (exact bigint). */
export function midHypeForUsdc(sqrtPriceX96, amountIn) {
  return (amountIn << 192n) / (sqrtPriceX96 * sqrtPriceX96);
}
/** Gas units assumed per approval before an exact estimate exists. */
export const APPROVAL_GAS_BUFFER_UNITS = 120_000n;

/**
 * Everything for a USDC -> HYPE swap, in order: [USDC.approve(Permit2, amount)] [Permit2.approve(USDC, UR,
 * amount, now+30min)] then the swap. Approvals are skipped when the existing ones cover `amountIn`.
 * Quote = revert trick; minOut = quote - slippage. When no approval is missing the swap is gas-estimated
 * (+margin) and its fee caps pinned in req.tx (no value). When approvals are missing, call this again after
 * they land: that second call re-quotes on the fresh state and pins gas.
 * HYPE rule: the swap adds HYPE and spends only gas; refused if the wallet cannot pay the gas for the
 * approvals + swap. Returns { txs, req, quote, minOut, needsApprovals, ... }.
 */
export async function planUsdcSwap(client, { amountIn, account, slippageBps = 100, nowSec, deadlineSec = 600, permitTtlSec = 1800, gasMarginPct = 25 }) {
  const p = assertSwapPool('USDC');
  if (!account) throw new Error('Connect a wallet first');
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SWAP_SLIPPAGE_BPS) throw new Error(`Slippage must be 0.01%–${MAX_SWAP_SLIPPAGE_BPS / 100}%`);
  if (!(amountIn > 0n)) throw new Error('Swap amount must be > 0');
  const [ctx, usdcBal, allow] = await Promise.all([
    readSwapContext(client, account),
    client.readContract({ address: TOKEN0.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    readAllowances(client, account, TOKEN0.address, UNIVERSAL_ROUTER),
  ]);
  if (amountIn > usdcBal) throw new Error(`Refused: you have only ${fmtT(TOKEN0, usdcBal)}.`);
  const quote = await quoteUsdcToHype(client, { amountIn, from: account });
  if (quote === 0n) throw new Error('Quote is 0: amount too small');
  const minOut = withSlippageDown(quote, slippageBps);
  if (minOut === 0n) throw new Error('Amount too small: minimum received rounds to 0');
  const pool = ctx.pools.USDC;
  const midOut = midHypeForUsdc(pool.sqrtPriceX96, amountIn);
  const impact = priceImpactPct(midOut, pool.lpFee, quote);
  const needs = approvalNeeds(amountIn, allow.erc20Allowance, allow.p2, nowSec);
  const txs = [];
  if (needs.erc20) txs.push({ kind: 'erc20-approve', ...buildErc20Approve(TOKEN0.address, amountIn) });
  if (needs.permit2) txs.push({ kind: 'permit2-approve', ...buildPermit2Approve(TOKEN0.address, amountIn, nowSec + permitTtlSec, UNIVERSAL_ROUTER) });
  const deadline = deadlineFromNow(deadlineSec, nowSec);
  const needsApprovals = txs.length > 0;
  let gasLimit = null;
  let gasCost = (BigInt(txs.length) * APPROVAL_GAS_BUFFER_UNITS + SWAP_GAS_BUFFER_UNITS) * ctx.fees.maxFeePerGas;
  let est = null;
  if (!needsApprovals) {
    const base = buildSwapUsdcToHype({ amountIn, minAmountOut: minOut, recipient: account, deadline });
    est = await client.estimateContractGas({ address: base.address, abi: base.abi, functionName: base.functionName, args: base.args, account });
    gasLimit = (est * BigInt(100 + gasMarginPct)) / 100n;
    gasCost = gasLimit * ctx.fees.maxFeePerGas;
  }
  if (ctx.balance < gasCost) throw new Error(`Refused: not enough HYPE for gas (need ≤ ${fmtH(gasCost)}, have ${fmtH(ctx.balance)}).`);
  const info = { quote, slippageBps, priceImpactPct: impact, gasLimit, gasMarginPct, gasCost };
  const req = buildSwapUsdcToHype({ amountIn, minAmountOut: minOut, recipient: account, deadline, info });
  if (gasLimit) req.tx = { gas: gasLimit, maxFeePerGas: ctx.fees.maxFeePerGas, maxPriorityFeePerGas: ctx.fees.maxPriorityFeePerGas };
  txs.push(req);
  return {
    txs, req, amountIn, quote, minOut, midOut, priceImpactPct: impact, feePct: pool.lpFee / 10000, needsApprovals,
    gasEstimate: est, gasLimit, gasCost, reserve: ctx.reserve, hypeUsd: ctx.hypeUsd, usdcPerHypeE6: ctx.usdcPerHypeE6, balance: ctx.balance,
  };
}
/** Native HYPE received by `to` from a swap = HYPE balance delta + gas paid (the receipt has no native Transfer log). */
export function hypeReceivedFromSwap({ balanceBefore, balanceAfter, receipt }) {
  return balanceAfter - balanceBefore + receipt.gasUsed * receipt.effectiveGasPrice;
}

// ---------------------------------------------------------------------------
// Values in USD for either LP pool. USDC = $1; HYPE priced from the HYPE/USDC pool (usdcPerHypeE6).
// ---------------------------------------------------------------------------
/** USD per 1 unit of the pool's quote token (USDC: 1, HYPE: hypeUsd). */
export const usdPerQuote = (pool, hypeUsd) => (lpPool(pool).id === 'USDC' ? 1 : hypeUsd);
/** USD per KNTQ implied by a pool price. */
export function usdPerKntqInPool(pool, sqrtPriceX96, hypeUsd) {
  return sqrtPriceToQuotePerKntq(sqrtPriceX96, pool) * usdPerQuote(pool, hypeUsd);
}
/** USD value of (amount0 quote token, amount1 KNTQ) at a pool's sqrtPrice. */
export function poolUsdValue(pool, amount0, amount1, sqrtPriceX96, hypeUsd) {
  const P = lpPool(pool);
  const uq = usdPerQuote(P.id, hypeUsd);
  return Number(formatUnits(amount0, P.token0.decimals)) * uq + Number(formatUnits(amount1, TOKEN1.decimals)) * usdPerKntqInPool(P.id, sqrtPriceX96, hypeUsd);
}
/** Value share of token0 (USDC or HYPE) for a new position in [tickLower, tickUpper) (0..1). */
export function lpToken0ValueFraction(state, tickLower, tickUpper, pool = 'USDC') {
  const P = lpPool(pool);
  if (P.id === 'USDC') return lpUsdcValueFraction(state, tickLower, tickUpper);
  if (state.tick < tickLower) return 1;
  if (state.tick >= tickUpper) return 0;
  const p = planMint(state, tickLower, tickUpper, { amount0: 10n ** 18n, anchor: 'amount0' }, 0, P.id);
  const v0 = Number(formatUnits(p.amount0, 18));
  const v1 = Number(formatUnits(p.amount1, 18)) * sqrtPriceToQuotePerKntq(state.sqrtPriceX96, P.id);
  return v0 + v1 > 0 ? v0 / (v0 + v1) : 0.5;
}

// ---------------------------------------------------------------------------
// Move a KNTQ/USDC position into KNTQ/HYPE 0.8% (three separate signed txs, each recomputed from chain):
//   (a) Remove 100% + burn (buildDecrease)  (b) USDC -> HYPE (planUsdcSwap)  (c) mint in the HYPE pool
//   (planMintFromBalances with HYPE = only what the swap brought, never the reserve, + all KNTQ).
// ---------------------------------------------------------------------------
/**
 * HYPE that step (c) may put into the new position:
 *   min(balance - reserve - mint gas buffer, hypeFromSwap if known), never negative.
 * hypeFromSwap = HYPE received in step (b) (recorded by the page); null when unknown (e.g. resumed elsewhere).
 */
export function migrationHypeForMint(ctx, hypeFromSwap = null) {
  const avail = maxHypeForLp(ctx);
  if (hypeFromSwap === null || hypeFromSwap === undefined) return avail;
  return hypeFromSwap < avail ? hypeFromSwap : avail;
}

/**
 * Read-only estimate of the whole migration from the CURRENT chain state (shown before and between steps):
 * what (a) returns, what (b) yields (exact revert-trick quote), the (c) mint plan with leftovers, values before
 * and after, and the cost (swap fee + price impact + gas + the tool fee on step (a)'s earned fees). KNTQ is priced in the TARGET pool for both the before
 * and after values, so the cost is the real economic cost; the price gap between the two pools is reported apart.
 *   pos: readPosition() result of the USDC position (or null once removed), usdcToSwap / kntqAvail override the
 *   amounts once (a) is done. range: { preset, custom } for the HYPE pool.
 */
export async function estimateMigration(client, { account, pos, usdcToSwap, kntqAvail, hypeFromSwap = null, preset = 'full', custom = {}, slippageBps = 50 }) {
  const ctx = await readSwapContext(client, account);
  const [usdcState, hypeState] = [await readPoolState(client, undefined, TARGET_POOL_ID), ctx.pools.KNTQ];
  const fees = ctx.fees.maxFeePerGas;
  let removeOut = null;
  let toolFee = null;
  let usdcIn = usdcToSwap ?? 0n;
  let kntq = kntqAvail ?? 0n;
  if (pos && pos.liquidity > 0n) {
    const d = planDecrease(usdcState, pos, pos.liquidity, slippageBps);
    // step (a) pays out the principal + 90% of the earned fees; the tool fee (10% of the fees) goes to FEE_RECIPIENT
    toolFee = toolFeeSplit(pos.fees);
    removeOut = { amount0: d.expected.amount0 + toolFee.user0, amount1: d.expected.amount1 + toolFee.user1, min0: d.amount0Min, min1: d.amount1Min };
    usdcIn = (usdcToSwap ?? 0n) + removeOut.amount0;
    kntq = (kntqAvail ?? 0n) + removeOut.amount1;
  }
  let quote = 0n;
  let midOut = 0n;
  if (usdcIn > 0n) {
    quote = await quoteUsdcToHype(client, { amountIn: usdcIn, from: account || QUOTE_SENDER });
    midOut = midHypeForUsdc(ctx.pools.USDC.sqrtPriceX96, usdcIn);
  }
  // gas still to pay: remove (if not done) + up to 2 approvals + swap (if not done) + 2 approvals + mint
  const gasUnits = (removeOut ? 500_000n : 0n) + (usdcIn > 0n ? 2n * APPROVAL_GAS_BUFFER_UNITS + SWAP_GAS_BUFFER_UNITS : 0n) + 2n * APPROVAL_GAS_BUFFER_UNITS + LP_MINT_GAS_BUFFER_UNITS;
  const gasHype = gasUnits * fees;
  // HYPE for the mint: the swap's output (or the recorded one), limited by the reserve rule after the gas still to pay
  const balanceAfterSwap = (ctx.balance ?? 0n) + (usdcIn > 0n ? quote : 0n) - gasHype + LP_MINT_GAS_BUFFER_UNITS * fees;
  const fromSwap = usdcIn > 0n ? quote : hypeFromSwap;
  const hypeAvail = migrationHypeForMint({ ...ctx, balance: balanceAfterSwap }, fromSwap);
  const range = rangeForPreset(preset, hypeState.tick, { ...custom, usdPerQuote: ctx.hypeUsd }, 'HYPE');
  const plan = planMintFromBalances(hypeState, range.tickLower, range.tickUpper, { avail0: hypeAvail, avail1: kntq }, slippageBps, 'HYPE');
  const hypeUsd = ctx.hypeUsd;
  const kUsdTarget = usdPerKntqInPool('HYPE', hypeState.sqrtPriceX96, hypeUsd);
  const kUsdSource = usdPerKntqInPool('USDC', usdcState.sqrtPriceX96, hypeUsd);
  const hUsd = (x) => Number(formatUnits(x, 18)) * hypeUsd;
  const kUsd = (x, px) => Number(formatUnits(x, 18)) * px;
  const uUsd = (x) => Number(formatUnits(x, 6));
  // Before: what is being moved (USDC + KNTQ, or after step b: the swap's HYPE + KNTQ).
  const movedHype = usdcIn > 0n ? 0n : hypeAvail;
  // The tool fee of step (a) is part of the value moved (it is 10% of fees the position earned) and part of the cost.
  const toolFeeUsd = toolFee ? uUsd(toolFee.fee0) + kUsd(toolFee.fee1, kUsdTarget) : 0;
  const before = uUsd(usdcIn) + hUsd(movedHype) + kUsd(kntq, kUsdTarget) + toolFeeUsd;
  const beforeAtSource = uUsd(usdcIn) + hUsd(movedHype) + kUsd(kntq, kUsdSource) + (toolFee ? uUsd(toolFee.fee0) + kUsd(toolFee.fee1, kUsdSource) : 0);
  const positionUsd = hUsd(plan.amount0) + kUsd(plan.amount1, kUsdTarget);
  const leftoverUsd = hUsd(plan.leftover0) + kUsd(plan.leftover1, kUsdTarget);
  // HYPE from the swap that cannot go in (it tops the wallet back up to the reserve and pays the gas) stays yours
  const extraHype = usdcIn > 0n && quote > hypeAvail ? quote - hypeAvail : 0n;
  const swapCostUsd = usdcIn > 0n ? uUsd(usdcIn) - hUsd(quote) : 0;
  const gasUsd = hUsd(gasHype);
  const after = positionUsd + leftoverUsd + hUsd(extraHype) - gasUsd;
  return {
    ctx, usdcState, hypeState, range, removeOut, toolFee, toolFeeUsd, usdcIn, kntq, quote, midOut, hypeAvail, plan, extraHype,
    hypeUsd, kntqUsdTarget: kUsdTarget, kntqUsdSource: kUsdSource, priceGapPct: (kUsdTarget / kUsdSource - 1) * 100,
    swapFeeImpactPct: usdcIn > 0n ? (1 - Number((quote * 10n ** 12n) / (midOut || 1n)) / 1e12) * 100 : 0,
    before, beforeAtSource, positionUsd, leftoverUsd, after, swapCostUsd, gasHype, gasUsd,
    costUsd: before - after, costPct: before > 0 ? ((before - after) / before) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Migration resume: recover what a step did from the chain (receipt of a saved tx hash, or the logs).
// ---------------------------------------------------------------------------
/** v4-core IPoolManager Swap event (amount0/amount1 = the swapper's BalanceDelta: negative = paid in). */
export const SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
export const SWAP_TOPIC = keccak256(toHex('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
export const addressTopic = (a) => encodeAbiParameters([{ type: 'address' }], [getAddress(a)]);
const ZERO_TOPIC = encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000000']);

/**
 * Native HYPE paid out by a USDC -> HYPE swap made through the UniversalRouter, read from the PoolManager's Swap event
 * in its receipt (pool HYPE/USDC 0.3%, sender = router, USDC in / HYPE out). null when the receipt has no such swap.
 * Hookless pool and TAKE_ALL of the whole delta: the HYPE the signer received == amount0.
 */
export function hypeOutFromSwapReceipt(receipt, poolId = SWAP_POOLS.USDC.id) {
  let out = null;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== ADDR.POOL_MANAGER || log.topics[0] !== SWAP_TOPIC) continue;
    if (log.topics[1].toLowerCase() !== poolId.toLowerCase()) continue;
    const ev = decodeEventLog({ abi: [SWAP_EVENT], data: log.data, topics: log.topics });
    if (getAddress(ev.args.sender) !== UNIVERSAL_ROUTER) continue;
    // v4-core emits the swapper's BalanceDelta: USDC in => amount1 < 0, HYPE out => amount0 > 0
    const a0 = ev.args.amount0, a1 = ev.args.amount1;
    if (!(a1 < 0n && a0 > 0n)) continue;
    out = (out ?? 0n) + a0;
  }
  return out;
}

/**
 * eth_getLogs over [fromBlock, toBlock] in chunks (shrinks on RPC range errors). reverse = newest chunk first.
 * Stops after the first chunk with a match when `first` is set. Returns raw RPC logs (hex fields), oldest first.
 */
export async function findLogs(client, { address, topics, fromBlock = POSM_DEPLOY_BLOCK, toBlock, chunk = 200000n, reverse = false, first = false, onProgress }) {
  const latest = toBlock ?? (await client.getBlockNumber());
  const lo = BigInt(fromBlock);
  const out = [];
  let step = chunk;
  let cur = reverse ? latest : lo;
  while (reverse ? cur >= lo : cur <= latest) {
    const a = reverse ? (cur - step + 1n < lo ? lo : cur - step + 1n) : cur;
    const b = reverse ? cur : (cur + step - 1n > latest ? latest : cur + step - 1n);
    let logs;
    try {
      logs = await client.request({ method: 'eth_getLogs', params: [{ address, fromBlock: toHex(a), toBlock: toHex(b), topics }] });
    } catch (e) {
      if (step <= 1000n) throw e;
      step /= 4n;
      continue;
    }
    onProgress?.(a, b, latest);
    const sorted = [...logs].sort((x, y) => (hexToBigInt(x.blockNumber) === hexToBigInt(y.blockNumber) ? Number(hexToBigInt(x.logIndex) - hexToBigInt(y.logIndex)) : hexToBigInt(x.blockNumber) < hexToBigInt(y.blockNumber) ? -1 : 1));
    if (reverse) out.unshift(...sorted); else out.push(...sorted);
    if (first && out.length) break;
    cur = reverse ? a - 1n : b + 1n;
  }
  return out;
}

/** Tx hash that burned PositionManager NFT `tokenId` of `owner` (Transfer(owner, 0x0, id)), newest first; null if none. */
export async function findBurnTx(client, owner, tokenId, { fromBlock = POSM_DEPLOY_BLOCK, onProgress } = {}) {
  const logs = await findLogs(client, {
    address: ADDR.POSITION_MANAGER, topics: [TRANSFER_TOPIC, addressTopic(owner), ZERO_TOPIC, toHex(BigInt(tokenId), { size: 32 })],
    fromBlock, reverse: true, first: true, onProgress,
  });
  return logs.length ? logs[logs.length - 1].transactionHash : null;
}

/**
 * First USDC -> HYPE swap of `owner` through the UniversalRouter at or after `fromBlock` (USDC Transfer(owner ->
 * PoolManager) whose receipt has the router's Swap in the HYPE/USDC pool). { receipt, hypeOut } or null.
 */
export async function findUsdcSwapTx(client, owner, { fromBlock, toBlock }) {
  const logs = await findLogs(client, { address: ADDR.USDC, topics: [TRANSFER_TOPIC, addressTopic(owner), addressTopic(ADDR.POOL_MANAGER)], fromBlock, toBlock });
  const seen = new Set();
  for (const l of logs) {
    if (seen.has(l.transactionHash)) continue;
    seen.add(l.transactionHash);
    const receipt = await client.getTransactionReceipt({ hash: l.transactionHash });
    if (receipt.status !== 'success' || !receipt.to || getAddress(receipt.to) !== UNIVERSAL_ROUTER || getAddress(receipt.from) !== getAddress(owner)) continue;
    const hypeOut = hypeOutFromSwapReceipt(receipt);
    if (hypeOut !== null) return { receipt, hypeOut };
  }
  return null;
}

/** First PositionManager NFT minted to `owner` (Transfer(0x0, owner, id)) at or after `fromBlock` in LP pool `pool`. */
export async function findMintInPool(client, owner, { fromBlock, toBlock, pool = 'HYPE' }) {
  assertLpPool(pool);
  const P = lpPool(pool);
  const logs = await findLogs(client, { address: ADDR.POSITION_MANAGER, topics: [TRANSFER_TOPIC, ZERO_TOPIC, addressTopic(owner)], fromBlock, toBlock });
  for (const l of logs) {
    const tokenId = hexToBigInt(l.topics[3]);
    const [key] = await client.readContract({ address: ADDR.POSITION_MANAGER, abi: POSM_ABI, functionName: 'getPoolAndPositionInfo', args: [tokenId] });
    if (lpPoolOfKey(key) === P.id) {
      return { tokenId, hash: l.transactionHash, blockNumber: hexToBigInt(l.blockNumber) };
    }
  }
  return null;
}

/** Sum of ERC20 Transfer(*, to) of `token` in a receipt. */
export function parseTokenReceived(receipt, token, to) {
  let sum = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token) || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    if (getAddress('0x' + log.topics[2].slice(26)) === getAddress(to)) sum += hexToBigInt(log.data);
  }
  return sum;
}

/**
 * Value share of USDC in a new LP position for [tickLower, tickUpper) at the LP pool price (0..1).
 * Out-of-range ranges need one token only: below -> 1 (USDC only), above -> 0 (KNTQ only).
 */
export function lpUsdcValueFraction(lpState, tickLower, tickUpper) {
  if (lpState.tick < tickLower) return 1;
  if (lpState.tick >= tickUpper) return 0;
  const p = planMint(lpState, tickLower, tickUpper, { amount0: 1000_000000n, anchor: 'amount0' }, 0);
  const v0 = Number(formatUnits(p.amount0, TOKEN0.decimals));
  const v = usdValue(p.amount0, p.amount1, lpState.sqrtPriceX96);
  return v > 0 ? v0 / v : 0.5;
}
/** Split spendable HYPE into the two swaps: usdcFraction of it to USDC, the rest to KNTQ. */
export function splitHypeForLp(spendable, usdcFraction = 0.5) {
  if (spendable <= 0n) return { toUsdc: 0n, toKntq: 0n };
  const f = BigInt(Math.round(Math.min(1, Math.max(0, usdcFraction)) * 1e6));
  const toUsdc = (spendable * f) / 1_000_000n;
  return { toUsdc, toKntq: spendable - toUsdc };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
export function fmtAmount(x, decimals, maxFrac = 6) {
  const s = formatUnits(x, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return (i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : ''));
}
export const fmtUsdc = (x, d = 4) => fmtAmount(x, TOKEN0.decimals, d);
export const fmtKntq = (x, d = 4) => fmtAmount(x, TOKEN1.decimals, d);
/** USD value of (amount0 USDC, amount1 KNTQ) at given sqrtPrice (USDC = $1). */
export function usdValue(amount0, amount1, sqrtPriceX96) {
  const usdPerKntq = 1 / sqrtPriceToKntqPerUsdc(sqrtPriceX96);
  return Number(formatUnits(amount0, TOKEN0.decimals)) + Number(formatUnits(amount1, TOKEN1.decimals)) * usdPerKntq;
}
export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a) => `${EXPLORER}/address/${a}`;
export { parseUnits, formatUnits, getAddress };
