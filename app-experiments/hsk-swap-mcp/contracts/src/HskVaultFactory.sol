// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HskTradingVault, IPoolFactory, ISwapRouter02, IWHSK} from "./HskTradingVault.sol";

/// One trading vault per owner, at an address fixed by the owner (CREATE2, salt = owner).
contract HskVaultFactory {
    ISwapRouter02 public immutable router;
    IWHSK public immutable whsk;
    IPoolFactory public immutable poolFactory;

    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault);

    error VaultExists(address vault);

    constructor(ISwapRouter02 router_, IWHSK whsk_, IPoolFactory poolFactory_) {
        router = router_;
        whsk = whsk_;
        poolFactory = poolFactory_;
    }

    /// The caller's vault, owned by the caller for good.
    function createVault() external returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists(vaultOf[msg.sender]);
        vault = address(
            new HskTradingVault{salt: bytes32(uint256(uint160(msg.sender)))}(msg.sender, router, whsk, poolFactory)
        );
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }
}
