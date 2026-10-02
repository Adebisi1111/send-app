// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PaymentRequest, IERC20} from "../PaymentRequest.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @notice Brings up the whole stack on a local fork of Arc: a mock USDC, a
///         username registry and the request contract, with accounts seeded so
///         the frontend can be driven against real behaviour.
contract DeployLocal is Script {
    function run() external {
        uint256 alicePk = vm.envUint("ALICE_PK");
        uint256 bobPk = vm.envUint("BOB_PK");
        uint256 carolPk = vm.envUint("CAROL_PK");

        address alice = vm.addr(alicePk);
        address bob = vm.addr(bobPk);
        address carol = vm.addr(carolPk);

        vm.startBroadcast(alicePk);
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        UsernameRegistry usernames = new UsernameRegistry();
        PaymentRequest requests = new PaymentRequest(IERC20(address(usdc)), usernames);

        usernames.register("alice");
        vm.stopBroadcast();

        vm.broadcast(bobPk);
        usernames.register("bob");
        vm.broadcast(carolPk);
        usernames.register("carol");

        vm.broadcast(alicePk);
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);
        usdc.mint(carol, 10_000e6);

        console.log("USDC:        ", address(usdc));
        console.log("Registry:    ", address(usernames));
        console.log("Requests:    ", address(requests));
        console.log("alice:       ", alice);
        console.log("bob:         ", bob);
        console.log("carol:       ", carol);
    }
}