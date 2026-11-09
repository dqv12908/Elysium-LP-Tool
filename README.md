# Elysium LP Tool

**A self-hosted, open-source liquidity tool for Uniswap v4 on [Elysium](https://elysium.kinetiq.xyz), Kinetiq's Layer 2 for Hyperliquid.**

Swap HYPE into the tokens you need, open a concentrated-liquidity position, watch your fees in dollars, collect, withdraw,
or move a position between pools, all from one local page that talks only to the official Uniswap v4 contracts on
Elysium and to your own MetaMask.

> At the time of writing, the official Uniswap app does not list Elysium, and aggregator swaps on Elysium can fail
> before they are broadcast. This tool talks to the official Uniswap v4 contracts on Elysium directly.

---

## ⚠️ Fee disclosure: please read

**This tool charges a fee of 10% of the LP fees your position earns.** Nothing else.

| What | Charged? |
|---|---|
| LP fees your position earned, when you **collect** them | **10%** |
| LP fees still uncollected when you **remove liquidity** (partial or 100%), including step (a) of *Move position* | **10%** of the fee part only |
| Your deposited tokens (principal) | **Never** |
| Swaps (HYPE → USDC, HYPE → KNTQ, USDC → HYPE) | **Never** |
| Opening a position (approvals, mint) | **Never** |
| Gas | Paid by you to the network, as with any transaction. The tool gets none of it. |

**Example.** Your position earned 5.00 USDC and 20 KNTQ in fees. When you click *Collect fees*, the same transaction
sends **0.50 USDC + 2 KNTQ** to the fee recipient and **4.50 USDC + 18 KNTQ** to you. If you remove your liquidity, you get
100% of the deposited tokens back plus 90% of any uncollected fees.

**Fee recipient:** `0xd977de5063b91AbEAe53Bc19B56c08b0904b09c3`
([view on the Elysium explorer](https://elysium.kinetiq.xyz/explorer/address/0xd977de5063b91AbEAe53Bc19B56c08b0904b09c3))

How it is enforced and shown:

- **On the page.** A permanent notice sits at the top. Every position card shows your uncollected fees and the 90% you
  would receive. The confirmation dialog for *Collect*, *Remove* and *Move* lists the exact tool fee in each token and
  the recipient **before you sign**.
- **On-chain.** The fee is part of the same Uniswap v4 `modifyLiquidities` transaction you sign. First,
  `DECREASE_LIQUIDITY(liquidity = 0)` settles only the earned fees. Then `TAKE(currency, feeRecipient, amount)` pays
  10% of the *computed* earned fees in each token, and `TAKE_PAIR(currency0, currency1, you)` pays the remaining fees
  to you. Only after that, when you're removing, does a second `DECREASE_LIQUIDITY` (plus `BURN_POSITION` if you chose
  it) withdraw your principal, and a second `TAKE_PAIR` pays all of it to you.
  - **The fee can never come out of principal.** If the fees were already collected elsewhere, for example from another
    tab, the first `TAKE_PAIR` sees a negative balance and the whole transaction reverts.
  - **Timing.** The fee is computed from the pool's on-chain `feeGrowth` values immediately before you sign. If more fees
    accrue between that read and the block, you keep the difference.
  - **No zero-amount `TAKE`.** It is never encoded, because in v4 an amount of 0 means "take the entire balance".
- **In the code.** `TOOL_FEE_BPS` and `FEE_RECIPIENT` are constants in [`lib.mjs`](lib.mjs), and the fork tests assert the
  split to the wei (see [Tests](#tests)).

This is open source under the MIT license. You can read every line before using it, and you are free to fork it.

---

## Features

- **One-page LP workflow** for two KNTQ pools on Elysium's official Uniswap v4 deployment:
  - **KNTQ/USDC 2%**: tick spacing 200
  - **KNTQ/HYPE 0.8%**: native HYPE, tick spacing 120
- **Built-in swaps** through Uniswap's UniversalRouter, with no aggregator: HYPE → USDC, HYPE → KNTQ, USDC → HYPE.
  Quotes are an exact simulation of the swap you will sign.
- **A gas reserve you can't spend by accident.** The tool always keeps **$8 of HYPE** (plus a 3% cushion and the gas for
  every later step) in your wallet. MAX buttons, swaps and native-HYPE deposits all stop at that reserve.
- **Range presets** (Full, ±20%, ±50%, ±80%) or a custom USD price range. Ticks are snapped to the pool's spacing, and the
  second token amount is calculated with the exact v4 math.
- **Wallet value in USD.** Your KNTQ, HYPE and USDC are priced live from on-chain pools, which MetaMask can't do for
  Elysium tokens.
- **My positions** shows range, in/out of range, current amounts and **exact uncollected fees** for each NFT. It can
  collect, remove any %, burn, or scan the chain for your positions.
- **Move position:** a guided, resumable 3-step migration from KNTQ/USDC 2% → KNTQ/HYPE 0.8%:
  1. remove + burn;
  2. swap the returned USDC → HYPE;
  3. mint.

  If the page crashes or you close it mid-way, it resumes from on-chain state.
- **Safety checks before every write**:
  - pool ids recomputed from frozen pool keys, and contract wiring verified;
  - every transaction simulated with `eth_call`;
  - approvals for the exact amount by default (Permit2, 30-minute expiry);
  - only swaps and native-HYPE mints may carry a transaction value, and that value is checked.
- **Picks MetaMask even when other wallets are installed** (EIP-6963 discovery). Phantom and others often hijack
  `window.ethereum`; this tool doesn't fall for it.
- **No keys, no custody, no backend.** Everything runs in your browser and is signed by your wallet.

---

## Quick start

**You need:** [Node.js](https://nodejs.org) 22+, desktop Chrome (or any Chromium browser) with
[MetaMask](https://metamask.io), and some HYPE on Elysium. Bridge it in at <https://elysium.kinetiq.xyz/bridge>.

```bash
git clone https://github.com/dqv12908/Elysium-LP-Tool.git
cd Elysium-LP-Tool
node serve.mjs
```

Open **<http://localhost:5199>** in Chrome. The page needs no `npm install`: it loads viem from `esm.sh`, pinned to
2.38.0. The server binds to `127.0.0.1` only.

### Optional: use your own RPC

The page reads chain data through a small proxy in `serve.mjs`, which forwards to Elysium's public RPC by default. The
public RPC rate-limits, so if you have a private endpoint (Alchemy, dRPC, Chainstack…), pass it in an environment
variable. It stays on the server and never appears in page code:

```bash
UPSTREAM_RPC="https://your-private-elysium-endpoint" node serve.mjs
```

```powershell
# Windows PowerShell
$env:UPSTREAM_RPC = "https://your-private-elysium-endpoint"; node serve.mjs
```

The proxy only forwards read methods (`eth_call`, `eth_getLogs`, `eth_estimateGas`…). It refuses
`eth_sendRawTransaction` and anything else that writes. Your transactions go through MetaMask.

---

## Using it

### 0. Connect

1. Click **Connect MetaMask**.
2. Approve the connection. If MetaMask isn't on Elysium, the page asks it to switch, adding the network if needed:
   chain id `99901`, RPC `https://rpc.elysium.kinetiq.xyz`, symbol `HYPE`.
3. Check the three badges at the top are green:
   - **Pool ids verified**
   - **PositionManager verified**
   - **Swap router & HYPE pools verified**

   If any badge is red, every write button stays disabled.

### 1. Get tokens

Choose the pool in Step 2 first, so the split matches your range. Then:

- **Split for LP** fills the swap boxes from your *spendable* HYPE in the value ratio your range needs.
- **Swap HYPE → USDC / HYPE → KNTQ / USDC → HYPE**: each swap shows the exact quote, the minimum received at your slippage
  (default 1%, max 5%), the price impact and the pool fee before you sign.
- **Kept for gas** shows the reserve. It is never swapped and never deposited.

### 2. Add liquidity

1. Pick the pool and a range: Full / ±20% / ±50% / ±80% / Custom.
2. Type one amount, or click **max**. The other amount is calculated.
3. Click **Review & add liquidity** and sign the list:
   - `USDC.approve(Permit2, exact)`, KNTQ/USDC pool only
   - `Permit2.approve(USDC, PositionManager, exact, +30 min)`, KNTQ/USDC pool only
   - `KNTQ.approve(Permit2, exact)`
   - `Permit2.approve(KNTQ, PositionManager, exact, +30 min)`
   - `PositionManager.modifyLiquidities(MINT_POSITION, SETTLE_PAIR [, SWEEP])`. In the HYPE pool this carries your HYPE
     as `msg.value`, and `SWEEP` returns any HYPE that wasn't used.

   Approvals you already have are skipped.
4. **Write down your tokenId.** The position is an NFT, and MetaMask may not display it.

### 3. Manage

Under **My positions**, add your tokenId or click **Scan chain**.

- **Collect fees**: you receive 90% of the earned fees, and 10% goes to the fee recipient.
- **Remove X%** (tick *burn NFT* at 100%): you get your principal back in full, plus 90% of any uncollected fees.
- **Burn empty NFT**: cleans up a position with no liquidity left. No tokens move.
- **Move to KNTQ/HYPE 0.8%** (on KNTQ/USDC cards): the guided migration described above.

---

## Contracts

All on Elysium mainnet (chain id `99901`).

| Contract | Address |
|---|---|
| Uniswap v4 PoolManager | `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1` |
| Uniswap v4 PositionManager (UNI-V4-POSM) | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` |
| Uniswap UniversalRouter 2.1.2 | `0xA13f7611115752DEB2B13813BDDE16A5073e4b45` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC (6 dec) | `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` |
| KNTQ (18 dec) | `0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0` |
| Tool fee recipient | `0xd977de5063b91AbEAe53Bc19B56c08b0904b09c3` |

| Pool | Key | Pool id |
|---|---|---|
| KNTQ/USDC 2% | USDC / KNTQ, fee 20000, spacing 200, no hooks | `0xd5ed6cd3a66b0631b92a54e1e3abde3c1bcd2d34f7786a30651c7b1634dd1f43` |
| KNTQ/HYPE 0.8% | native HYPE / KNTQ, fee 8000, spacing 120, no hooks | `0xd210029ab684d92240876c54ec6d5a8b2b1998b71c2c907c1e55de02e13e3472` |
| HYPE/USDC 0.3% (swaps, HYPE price) | native HYPE / USDC, fee 3000, spacing 60, no hooks | `0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc` |

**How the router was chosen.** Elysium has two genuine Uniswap UniversalRouters bound to the official PoolManager.
This tool uses **2.1.2**. Uniswap's deployment record for chain 99901
([Uniswap/contracts PR #179](https://github.com/Uniswap/contracts/pull/179), open at the time of writing) lists it as the
default `UniversalRouter`. Its runtime bytecode is byte-identical to Uniswap's HyperEVM UniversalRouter 2.1.2, apart from
constructor immutables. The same deployer created the PoolManager, PositionManager, V4Quoter and both routers. The
fork tests check the page's quotes against Uniswap's on-chain V4Quoter (`0x379f556c5a748bd7cc9baf0f7a344094ac1814f5`) to
the unit.

---

## How it works

```
                    ┌──────────────────────── your browser ────────────────────────┐
  serve.mjs  ◄──────┤  index.html + app.js (UI)  ──►  lib.mjs (all math & encoding) │
  127.0.0.1:5199    │          │                                                    │
   │  /rpc (reads)  │          └──► MetaMask (EIP-6963) ──► signs every write       │
   ▼                └───────────────────────────────────────────────────────────────┘
  Elysium RPC  ◄── reads: pool slot0 / liquidity / feeGrowth via PoolManager.extsload, balances, logs
                    writes (signed by you): Permit2, PositionManager.modifyLiquidities, UniversalRouter.execute
```

- [`lib.mjs`](lib.mjs) has **no UI code**. It contains pool keys and id checks; exact bigint ports of `TickMath`,
  `SqrtPriceMath` and `LiquidityAmounts`; StateLibrary-layout storage reads; fee-growth math; the action encoders; every
  transaction builder with a human-readable preview; the swap quoting (revert trick, `V4TooLittleReceived`); the
  reserve and MAX math; and the fee split. The page and all tests import the same functions.
- [`app.js`](app.js) is the page. Before every write it re-reads the chain, simulates the transaction, shows the preview
  dialog and pins explicit gas fee caps (2 × the current base fee; you pay only the actual base fee). Elysium's base
  fee drifts between blocks, so a wallet that guesses a cap at the base fee gets rejected.
- [`serve.mjs`](serve.mjs) serves the page files and the read-only RPC proxy, and nothing else.

---

## Tests

The tests run the **exact builders the page uses** against an [anvil](https://book.getfoundry.sh/anvil/) fork of
Elysium mainnet. No private keys are used: anvil's dev accounts are unlocked, and test funds come from impersonating
real token holders on the fork.

```bash
npm install          # viem 2.38.0, needed only for the tests
npm run test:all     # runs every suite, one after the other
```

You need [Foundry](https://book.getfoundry.sh/getting-started/installation) (`anvil` on `PATH` or in `~/.foundry/bin`).
If the Elysium RPC can't be reached, a suite skips and exits 0.

| Suite | Port | What it proves |
|---|---|---|
| `test/fork.test.mjs` | 8566 | Mint full-range and ±50% positions, pull the exact amounts, collect fees equal to the lib's calculation, remove and burn |
| `test/swap.test.mjs` | 8566 | HYPE→USDC, HYPE→KNTQ and USDC→HYPE swaps: quote = received = Uniswap V4Quoter; the $8 reserve holds through the whole flow |
| `test/verify-encoding.test.mjs` | 8567 | Action bytes, param layouts, TickMath, storage slots and Permit2 selectors checked line by line against Uniswap source |
| `test/verify-funds.test.mjs` | 8568 | User-funds invariants: owner/recipient is always you, exact approvals, no value on LP txs, no key handling |
| `test/verify-swap.test.mjs` | 8569 | Independent swap-path verification: router, pool keys, reserve can't be bypassed, min-out never 0 |
| `test/migrate.test.mjs` | 8570 | Full KNTQ/USDC → KNTQ/HYPE migration on a fresh position: cost < 2%, reserve untouched |
| `test/verify-migrate.test.mjs` | 8571 | Runs the panel's own `app.js` code with page reloads and crash/resume scenarios |
| `test/fee.test.mjs` | 8572 | The tool fee, to the wei, in both pools (detailed below) |

`test/fee.test.mjs` checks, in both pools:
- **Collect:** the recipient gets exactly 10% of the computed fees, and you get the rest.
- **Fees that grow after the read:** the recipient still gets no more than 10% of the computed amount.
- **Partial and full remove:** 10% of the *fee* part only, with 100% of principal returned to you.
- **Zero fees:** no fee transfer at all.
- **Fees collected elsewhere first:** a remove built from a stale read reverts instead of touching principal.
- **Calldata:** every `TAKE` goes to the recipient, none has amount 0, and `TAKE_PAIR` always pays you.

Run the suites one after the other: several forks at once hit the public RPC's rate limit.

> Elysium is an Arbitrum-Orbit chain, and its block headers have no `excessBlobGas`. Without a workaround, anvil rejects
> calls on the forked block, so the tests mine one local block right after anvil starts.

---

## Risks

- **Impermanent loss.** When KNTQ's price moves against the other token, you end up holding more of the token that fell.
  In the KNTQ/HYPE pool both tokens are volatile against the dollar.
- **Ranges.** A narrow range earns more while the price is inside it and **nothing** once it leaves. At that point the
  position is 100% one token.
- **Thin pools.** The KNTQ/USDC pool has had only a few hundred dollars of liquidity. Small trades move its price a lot,
  and its volume comes in bursts.
- **Fees aren't guaranteed.** Past volume, especially in a chain's launch week, says little about future fees.
- **Smart-contract and chain risk.** Uniswap v4, Permit2, the tokens, Elysium and its bridge are third-party systems.
- **Software risk.** This tool is tested but unaudited. Review it, start small, and read every preview before you sign.

**This is software, not financial advice.** You are responsible for your own decisions and funds.

---

## License

[MIT](LICENSE). Use it, fork it, change it. The fee terms above apply to this distribution. If you run a modified
version, you're responsible for disclosing what it does.
