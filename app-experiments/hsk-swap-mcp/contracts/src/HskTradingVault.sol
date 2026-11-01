// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWHSK is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IPoolFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// SwapRouter02 (IV3SwapRouter) as HSKswap deploys it: no deadline in the struct.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// A trading wallet for one owner (an agent's own address). It holds tokens and can only:
/// - swap on HSKswap, between tokens the owner allowed, within each token's per-trade and daily limits, at no
///   worse than the owner's slippage limit against the pool's current price, with the output always kept here
/// - pay out to the owner
/// HSK sent to it is wrapped into WHSK, so everything it holds is an ERC-20. Ownership never changes.
contract HskTradingVault {
    /// Nobody can loosen the slippage limit past this.
    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 1000;
    uint256 private constant Q96 = 2 ** 96;

    address public immutable owner;
    ISwapRouter02 public immutable router;
    IWHSK public immutable whsk;
    IPoolFactory public immutable poolFactory;

    struct TokenLimit {
        bool allowed;
        uint128 maxPerTrade; // most of this token one swap may sell
        uint128 dailyLimit; // most of this token sold per UTC day
    }

    mapping(address => TokenLimit) public limits;
    mapping(address => uint256) public soldOnDay; // amount sold on day `dayOf[token]`
    mapping(address => uint256) public dayOf;
    address[] private listed;
    mapping(address => bool) private isListed;
    uint16 public maxSlippageBps = 100;
    bool public paused;

    event Deposited(address indexed from, uint256 amount);
    event TokenLimitSet(address indexed token, bool allowed, uint128 maxPerTrade, uint128 dailyLimit);
    event MaxSlippageSet(uint16 bps);
    event PausedSet(bool paused);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint24 fee, uint256 amountIn, uint256 amountOut);
    event Withdrawn(address indexed token, uint256 amount);

    error NotOwner();
    error IsPaused();
    error SameToken();
    error ZeroAmount();
    error TokenNotAllowed(address token);
    error OverTradeLimit(uint256 maxPerTrade);
    error OverDailyLimit(uint256 remainingToday);
    error NoPool();
    error MinOutBelowFloor(uint256 floor);
    error SlippageOverCap();
    error CallFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, ISwapRouter02 router_, IWHSK whsk_, IPoolFactory poolFactory_) {
        owner = owner_;
        router = router_;
        whsk = whsk_;
        poolFactory = poolFactory_;
    }

    receive() external payable {
        // WHSK pays out here when withdraw unwraps; anything else is a deposit, kept as WHSK.
        if (msg.sender == address(whsk)) return;
        whsk.deposit{value: msg.value}();
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ limits

    /// Allow `token` (with its limits, in its base units) or disallow it (allowed = false).
    function setTokenLimit(address token, bool allowed, uint128 maxPerTrade, uint128 dailyLimit) public onlyOwner {
        limits[token] = TokenLimit(allowed, maxPerTrade, dailyLimit);
        if (!isListed[token]) {
            isListed[token] = true;
            listed.push(token);
        }
        emit TokenLimitSet(token, allowed, maxPerTrade, dailyLimit);
    }

    function setMaxSlippageBps(uint16 bps) public onlyOwner {
        if (bps > MAX_SLIPPAGE_CAP_BPS) revert SlippageOverCap();
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    function setPaused(bool paused_) public onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// Several limit changes in one transaction. Each runs as the owner's own call, so each is checked the same.
    function multicall(bytes[] calldata calls) external onlyOwner {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory reason) = address(this).delegatecall(calls[i]);
            if (!ok) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
    }

    // ------------------------------------------------------------------ views

    function tokens() external view returns (address[] memory) {
        return listed;
    }

    function remainingToday(address token) public view returns (uint256) {
        uint256 sold = dayOf[token] == block.timestamp / 1 days ? soldOnDay[token] : 0;
        uint256 limit = limits[token].dailyLimit;
        return sold >= limit ? 0 : limit - sold;
    }

    /// The least a swap must ask for: the pool's current price, less its fee and the slippage limit.
    function minOutFloor(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        address pool = poolFactory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool();
        (uint160 sqrtPriceX96,,,,,,) = IPool(pool).slot0();
        uint256 spot = tokenIn < tokenOut
            ? Math.mulDiv(Math.mulDiv(amountIn, sqrtPriceX96, Q96), sqrtPriceX96, Q96)
            : Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
        uint256 afterFee = spot * (1e6 - fee) / 1e6;
        return afterFee * (10_000 - maxSlippageBps) / 10_000;
    }

    // ------------------------------------------------------------------ actions

    /// Sell exactly `amountIn` of `tokenIn` for at least `minOut` of `tokenOut` through one HSKswap pool.
    function swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut)
        external
        onlyOwner
        returns (uint256 amountOut)
    {
        if (paused) revert IsPaused();
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();
        TokenLimit memory limit = limits[tokenIn];
        if (!limit.allowed) revert TokenNotAllowed(tokenIn);
        if (!limits[tokenOut].allowed) revert TokenNotAllowed(tokenOut);
        if (amountIn > limit.maxPerTrade) revert OverTradeLimit(limit.maxPerTrade);
        uint256 remaining = remainingToday(tokenIn);
        if (amountIn > remaining) revert OverDailyLimit(remaining);

        uint256 today = block.timestamp / 1 days;
        soldOnDay[tokenIn] = (dayOf[tokenIn] == today ? soldOnDay[tokenIn] : 0) + amountIn;
        dayOf[tokenIn] = today;

        uint256 floor = minOutFloor(tokenIn, tokenOut, fee, amountIn);
        if (minOut < floor) revert MinOutBelowFloor(floor);

        _call(tokenIn, abi.encodeCall(IERC20.approve, (address(router), amountIn)));
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, address(this), amountIn, minOut, 0)
        );
        emit Swapped(tokenIn, tokenOut, fee, amountIn, amountOut);
    }

    /// Pay out to the owner, and only the owner. `token` = address(0) unwraps WHSK and sends native HSK.
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            whsk.withdraw(amount);
            (bool ok,) = owner.call{value: amount}("");
            if (!ok) revert CallFailed();
        } else {
            _call(token, abi.encodeCall(IERC20.transfer, (owner, amount)));
        }
        emit Withdrawn(token, amount);
    }

    /// A token call that must succeed, for tokens that return a bool and those that return nothing.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert CallFailed();
    }
}
