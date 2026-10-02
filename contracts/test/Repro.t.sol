// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaymentRequest, IERC20} from "../PaymentRequest.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract ReproTest is Test {
    MockERC20 usdc;
    UsernameRegistry reg;
    PaymentRequest req;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    uint256 constant PAID = 2; // Status.Paid

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        reg = new UsernameRegistry();
        req = new PaymentRequest(IERC20(address(usdc)), reg);

        vm.startPrank(alice);
        reg.register("alice");
        usdc.mint(alice, 1000e6);
        vm.stopPrank();

        vm.startPrank(bob);
        reg.register("bob");
        usdc.mint(bob, 1000e6);
        vm.stopPrank();

        vm.startPrank(carol);
        reg.register("carol");
        usdc.mint(carol, 1000e6);
        vm.stopPrank();
    }

    // FINDING 1: requester can settle their own request, moving zero value.
    function test_selfPayByRequesterIsFree() public {
        vm.prank(alice);
        uint256 id = req.ask("bob", "lunch", 100e6, block.timestamp + 1 days);

        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        usdc.approve(address(req), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.CannotPayOwnRequest.selector, id)
        );
        req.pay(id, 100e6); // alice can no longer pay her own request

        assertEq(aliceBefore, usdc.balanceOf(alice), "balance untouched");
        assertEq(uint256(req.statusOf(id)), 1, "still Open");
        assertTrue(!req.responded(id, bob), "bob still owes an answer");
        assertTrue(req.canRespond(id, bob), "bob can still pay or decline");
    }// FINDING 2: transferUsername clobbers recipient's existing name, orphaning it.
    function test_transferOrphansRecipientName() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.AddressAlreadyHasUsername.selector, carol, "carol")
        );
        reg.transferUsername(carol);

        assertEq(reg.resolve("bob"), bob, "bob keeps his name");
        assertEq(reg.resolve("carol"), carol, "carol keeps hers");
        assertEq(reg.usernameOf(carol), "carol", "no orphan");
    }// Control: does a stranger's 1-wei gift lock the named payer out of declining?
    function test_strangerMicroGiftBlocksDecline() public {
        vm.prank(alice);
        uint256 id = req.ask("bob", "lunch", 100e6, block.timestamp + 1 days);

        vm.prank(carol);
        usdc.approve(address(req), 1);
        vm.prank(carol);
        req.pay(id, 1); // 1 wei

        assertTrue(req.canRespond(id, bob), "canRespond says bob may respond");
        vm.prank(bob);
        vm.expectRevert();
        req.decline(id);
    }
}