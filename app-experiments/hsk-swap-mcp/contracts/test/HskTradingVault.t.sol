// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HskTradingVault, IERC20, IPoolFactory, ISwapRouter02, IWHSK} from "../src/HskTradingVault.sol";
import {HskVaultFactory} from "../src/HskVaultFactory.sol";

/// Runs against live HSKswap testnet pools: forge test --fork-url https://testnet.hsk.xyz
contract HskTradingVaultTest is Test {
    ISwapRouter02 constant ROUTER = ISwapRouter02(0xa6914E66690c6794244B5f66a09eAEbf66254237);
    IWHSK constant WHSK = IWHSK(0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6);
    IPoolFactory constant POOLS = IPoolFactory(0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0);
    address constant USDT = 0x98B6173A8B7DFc52ce8bc88f1184a918A1CCaa4F;
    address constant USDC = 0x93F960a8DAB5A541e93e6DdaCD54F49a1750DE81;

    HskVaultFactory factory;
    HskTradingVault vault;
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    function setUp() public {
        require(block.chainid == 133, "run with --fork-url https://testnet.hsk.xyz");
        factory = new HskVaultFactory(ROUTER, WHSK, POOLS);
        vm.prank(agent);
        vault = HskTradingVault(payable(factory.createVault()));
        vm.deal(agent, 10 ether);
        vm.prank(agent);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        require(ok);
        vm.startPrank(agent);
        vault.setTokenLimit(address(WHSK), true, 0.1 ether, 0.25 ether);
        vault.setTokenLimit(USDT, true, 100 ether, 1000 ether);
        vm.stopPrank();
    }

    function floor(uint256 amountIn) internal view returns (uint256) {
        return vault.minOutFloor(address(WHSK), USDT, 500, amountIn);
    }

    function test_factoryGivesEachOwnerOneVault() public {
        assertEq(factory.vaultOf(agent), address(vault));
        assertEq(vault.owner(), agent);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(HskVaultFactory.VaultExists.selector, address(vault)));
        factory.createVault();
    }

    function test_depositsAreWrapped() public view {
        assertEq(WHSK.balanceOf(address(vault)), 1 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_swapWithinLimitsKeepsOutputInTheVault() public {
        uint256 min = floor(0.01 ether);
        vm.prank(agent);
        uint256 out = vault.swap(address(WHSK), USDT, 500, 0.01 ether, min);
        assertGe(out, min);
        assertEq(IERC20(USDT).balanceOf(address(vault)), out);
        assertEq(IERC20(USDT).balanceOf(agent), 0);
        assertEq(WHSK.balanceOf(address(vault)), 0.99 ether);
        assertEq(vault.remainingToday(address(WHSK)), 0.24 ether);
    }

    function test_onlyTheOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(HskTradingVault.NotOwner.selector);
        vault.swap(address(WHSK), USDT, 500, 0.01 ether, 0);
        vm.expectRevert(HskTradingVault.NotOwner.selector);
        vault.withdraw(address(0), 1);
        vm.expectRevert(HskTradingVault.NotOwner.selector);
        vault.setTokenLimit(USDC, true, type(uint128).max, type(uint128).max);
        vm.expectRevert(HskTradingVault.NotOwner.selector);
        vault.setMaxSlippageBps(1000);
        vm.stopPrank();
    }

    function test_tokensMustBeAllowedBothWays() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(HskTradingVault.TokenNotAllowed.selector, USDC));
        vault.swap(address(WHSK), USDC, 3000, 0.01 ether, 1);
        vault.setTokenLimit(address(WHSK), false, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(HskTradingVault.TokenNotAllowed.selector, address(WHSK)));
        vault.swap(address(WHSK), USDT, 500, 0.01 ether, 1);
        vm.stopPrank();
    }

    function test_perTradeAndDailyLimits() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(HskTradingVault.OverTradeLimit.selector, 0.1 ether));
        vault.swap(address(WHSK), USDT, 500, 0.11 ether, 1);
        vault.swap(address(WHSK), USDT, 500, 0.1 ether, floor(0.1 ether));
        vault.swap(address(WHSK), USDT, 500, 0.1 ether, floor(0.1 ether));
        vm.expectRevert(abi.encodeWithSelector(HskTradingVault.OverDailyLimit.selector, 0.05 ether));
        vault.swap(address(WHSK), USDT, 500, 0.06 ether, 1);
        vm.stopPrank();
        // A new UTC day starts the allowance again.
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.remainingToday(address(WHSK)), 0.25 ether);
    }

    function test_minOutBelowTheSlippageFloorIsRefused() public {
        uint256 min = floor(0.01 ether);
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(HskTradingVault.MinOutBelowFloor.selector, min));
        vault.swap(address(WHSK), USDT, 500, 0.01 ether, 0);
        // Tightening to 0% means the price impact alone fails the router's own check.
        vault.setMaxSlippageBps(0);
        uint256 strict = floor(0.01 ether);
        assertGt(strict, min);
        vm.expectRevert(bytes("Too little received"));
        vault.swap(address(WHSK), USDT, 500, 0.01 ether, strict);
        vm.expectRevert(HskTradingVault.SlippageOverCap.selector);
        vault.setMaxSlippageBps(1001);
        vm.stopPrank();
    }

    function test_pausedStopsSwapsButNotWithdrawals() public {
        vm.startPrank(agent);
        vault.setPaused(true);
        vm.expectRevert(HskTradingVault.IsPaused.selector);
        vault.swap(address(WHSK), USDT, 500, 0.01 ether, 1);
        uint256 before = agent.balance;
        vault.withdraw(address(0), 0.4 ether);
        vm.stopPrank();
        assertEq(agent.balance, before + 0.4 ether);
        assertEq(WHSK.balanceOf(address(vault)), 0.6 ether);
    }

    function test_withdrawTokensGoOnlyToTheOwner() public {
        vm.startPrank(agent);
        uint256 out = vault.swap(address(WHSK), USDT, 500, 0.01 ether, floor(0.01 ether));
        vault.withdraw(USDT, out);
        vm.stopPrank();
        assertEq(IERC20(USDT).balanceOf(agent), out);
    }

    function test_multicallSetsSeveralLimitsAtOnce() public {
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(HskTradingVault.setTokenLimit, (USDC, true, 5e6, 50e6));
        calls[1] = abi.encodeCall(HskTradingVault.setMaxSlippageBps, (300));
        calls[2] = abi.encodeCall(HskTradingVault.setPaused, (true));
        vm.prank(agent);
        vault.multicall(calls);
        (bool allowed, uint128 perTrade, uint128 daily) = vault.limits(USDC);
        assertTrue(allowed);
        assertEq(perTrade, 5e6);
        assertEq(daily, 50e6);
        assertEq(vault.maxSlippageBps(), 300);
        assertTrue(vault.paused());
        assertEq(vault.tokens().length, 3);

        calls = new bytes[](1);
        calls[0] = abi.encodeCall(HskTradingVault.setMaxSlippageBps, (5000));
        vm.prank(agent);
        vm.expectRevert(HskTradingVault.SlippageOverCap.selector);
        vault.multicall(calls);
        vm.prank(stranger);
        vm.expectRevert(HskTradingVault.NotOwner.selector);
        vault.multicall(calls);
    }
}
