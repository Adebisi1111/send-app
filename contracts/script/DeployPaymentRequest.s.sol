// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PaymentRequest, IERC20} from "../PaymentRequest.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";

/// @notice Deploys the ask-then-pay request contract against the existing
///         username registry, which is already live on Arc mainnet.
contract DeployPaymentRequest is Script {
    function run() external {
        uint256 pk = vm.envUint("ARC_DEPLOYER_KEY");
        address registry = vm.envAddress("USERNAME_REGISTRY");
        address usdc = 0x3600000000000000000000000000000000000000;

        vm.startBroadcast(pk);
        PaymentRequest req = new PaymentRequest(IERC20(usdc), UsernameRegistry(registry));
        vm.stopBroadcast();

        console.log("PaymentRequest:", address(req));
        console.log("UsernameRegistry:", registry);
        console.log("USDC:", usdc);
    }
}