// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaymentRequest, IERC20} from "../PaymentRequest.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev The requester is owed; the payer sends their own USDC on accept.
///      Nothing is escrowed, so these tests check money moves straight from
///      payer to requester and that partial settlement adds up correctly.
contract PaymentRequestTest is Test {
    MockERC20 usdc;
    UsernameRegistry usernames;
    PaymentRequest requests;

    address alice = makeAddr("alice"); // asks
    address bob = makeAddr("bob"); // pays
    address carol = makeAddr("carol"); // chips in
    address dave = makeAddr("dave"); // asks, open request

    uint256 constant DAY = 86_400;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usernames = new UsernameRegistry();
        requests = new PaymentRequest(IERC20(address(usdc)), usernames);

        vm.startPrank(alice);
        usernames.register("alice");
        vm.stopPrank();
        vm.startPrank(bob);
        usernames.register("bob");
        vm.stopPrank();
        vm.startPrank(carol);
        usernames.register("carol");
        vm.stopPrank();
        vm.startPrank(dave);
        usernames.register("dave");
        vm.stopPrank();

        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        usdc.mint(carol, 1_000e6);
        usdc.mint(dave, 1_000e6);

        vm.prank(bob);
        usdc.approve(address(requests), type(uint256).max);
        vm.prank(carol);
        usdc.approve(address(requests), type(uint256).max);
    }

    // ------------------------------------------------------ asking

    function test_AskNamesTheRecipient() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);

        PaymentRequest.Request memory r = requests.getRequest(id);
        assertEq(r.requester, alice, "requester");
        assertEq(r.named, bob, "named");
        assertEq(r.amount, 25e6, "amount");
        assertEq(r.collected, 0, "nothing collected");
        assertEq(uint256(r.status), uint256(PaymentRequest.Status.Open), "open");
    }

    /// @dev No escrow: asking must not move a single token.
    function test_AskEscrowsNothing() public {
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 contractBefore = usdc.balanceOf(address(requests));

        vm.prank(alice);
        requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);

        assertEq(usdc.balanceOf(alice), aliceBefore, "asker keeps their money");
        assertEq(usdc.balanceOf(address(requests)), contractBefore, "contract holds nothing");
    }

    function test_CannotAskUnknownName() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.UnknownUsername.selector, "nobody"));
        requests.ask("nobody", "x", 1e6, block.timestamp + DAY);
    }

    function test_CannotAskYourself() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.SelfRequest.selector, alice));
        requests.ask("alice", "x", 1e6, block.timestamp + DAY);
    }

    function test_AskAnyoneHasNoNamedPayer() public {
        vm.prank(dave);
        uint256 id = requests.askAnyone("birthday gift", 50e6, block.timestamp + 7 * DAY);

        PaymentRequest.Request memory r = requests.getRequest(id);
        assertEq(r.named, address(0), "open to anyone");
        assertEq(requests.openUnnamedCount(), 1, "one open request");
    }

    // ------------------------------------------------------ paying

    function test_PayMovesMoneyFromPayerToRequester() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);

        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(bob);
        requests.pay(id, 25e6);

        assertEq(usdc.balanceOf(bob), bobBefore - 25e6, "payer paid");
        assertEq(usdc.balanceOf(alice), aliceBefore + 25e6, "asker received");
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid), "paid");
    }

    /// @dev The core of the Cash App model: anyone can settle a named request,
    ///      not just the person it was addressed to.
    function test_SomeoneElseCanPay() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);

        uint256 carolBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        requests.pay(id, 25e6);

        assertEq(usdc.balanceOf(carol), carolBefore - 25e6, "carol paid");
        assertEq(usdc.balanceOf(alice), 1_000e6 + 25e6, "alice got it");
    }

    // ------------------------------------------------------ partial

    function test_SeveralPeopleChipIn() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "gift", 100e6, block.timestamp + 7 * DAY);

        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(bob);
        requests.pay(id, 40e6);

        vm.prank(carol);
        requests.pay(id, 60e6);

        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6, "asker got the full amount");
        assertEq(requests.paidBy(id, bob), 40e6, "bob's contribution");
        assertEq(requests.paidBy(id, carol), 60e6, "carol's contribution");
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid), "fully paid");
    }

    function test_PartialKeepsRequestOpen() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "gift", 100e6, block.timestamp + 7 * DAY);

        vm.prank(bob);
        requests.pay(id, 25e6);

        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Open), "still open");
        assertEq(requests.remaining(id), 75e6, "still owed");
        assertTrue(!requests.isSettled(id), "not settled");
    }

    function test_CannotOverpay() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "gift", 10e6, block.timestamp + 7 * DAY);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.NothingToCollect.selector, id, 10e6)
        );
        requests.pay(id, 11e6);
    }

    function test_PayRemainingSettlesTheRest() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "gift", 100e6, block.timestamp + 7 * DAY);

        vm.prank(bob);
        requests.pay(id, 30e6);
        vm.prank(carol);
        requests.payRemaining(id);

        assertTrue(requests.isSettled(id), "settled");
    }

    /// @dev The group-gift flow: an open request funded by several strangers.
    function test_OpenFeedListsAPartlyPaidRequest() public {
        vm.prank(alice);
        uint256 id = requests.askAnyone("group gift", 100e6, block.timestamp + 14 days);

        // a stranger pays part of it: still open, so still listed
        vm.startPrank(bob);
        usdc.approve(address(requests), 40e6);
        requests.pay(id, 40e6);
        vm.stopPrank();

        uint256[] memory ids = requests.openRequests(100);
        assertEq(ids.length, 1, "partly paid request must stay listed");
        assertEq(ids[0], id, "listed under its own id");
        assertEq(requests.openUnnamedCount(), 1);
        assertEq(requests.remaining(id), 60e6);
    }

    function test_OpenFeedDropsSettledRequest() public {
        vm.prank(alice);
        uint256 a = requests.askAnyone("first", 10e6, block.timestamp + 14 days);
        vm.prank(alice);
        uint256 b = requests.askAnyone("second", 10e6, block.timestamp + 14 days);
        assertEq(requests.openRequests(100).length, 2);

        // settle the first one; the second must still be reachable
        vm.startPrank(bob);
        usdc.approve(address(requests), 10e6);
        requests.pay(a, 10e6);
        vm.stopPrank();

        uint256[] memory ids = requests.openRequests(100);
        assertEq(ids.length, 1, "settled request leaves the feed");
        assertEq(ids[0], b, "the other request is still listed");
        assertEq(requests.openUnnamedCount(), 1);

        // and emptying it entirely leaves an empty list, not stale ids
        vm.startPrank(carol);
        usdc.approve(address(requests), 10e6);
        requests.pay(b, 10e6);
        vm.stopPrank();
        assertEq(requests.openRequests(100).length, 0, "feed empties cleanly");
        assertEq(requests.openUnnamedCount(), 0);
    }

    function test_OpenFeedRemovesMiddleWithoutDisturbingOthers() public {
        vm.startPrank(alice);
        uint256 a = requests.askAnyone("a", 10e6, block.timestamp + 14 days);
        uint256 b = requests.askAnyone("b", 10e6, block.timestamp + 14 days);
        uint256 c = requests.askAnyone("c", 10e6, block.timestamp + 14 days);
        vm.stopPrank();

        // settle the middle one, so the swap-with-last path runs
        vm.startPrank(bob);
        usdc.approve(address(requests), 10e6);
        requests.pay(b, 10e6);
        vm.stopPrank();

        uint256[] memory ids = requests.openRequests(100);
        assertEq(ids.length, 2);
        assertTrue(ids[0] == a && ids[1] == c, "a and c survive, b is gone");
    }

    function test_OpenRequestAcceptsManyStrangers() public {
        vm.prank(dave);
        uint256 id = requests.askAnyone("group gift", 30e6, block.timestamp + 7 * DAY);

        vm.prank(bob);
        requests.pay(id, 10e6);
        vm.prank(carol);
        requests.pay(id, 20e6);

        assertEq(usdc.balanceOf(dave), 1_000e6 + 30e6, "dave got the full amount");
        assertEq(requests.openUnnamedCount(), 0, "left the public feed");
        assertTrue(requests.isSettled(id), "settled");
    }

    // ------------------------------------------------------ closing

    function test_CancelBeforeAnyPayment() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);

        vm.prank(alice);
        requests.cancel(id);

        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Cancelled), "cancelled");
    }

    function test_CannotCancelOncePaid() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);
        vm.prank(bob);
        requests.pay(id, 25e6);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Paid
            )
        );
        requests.cancel(id);
    }

    function test_OnlyAskerCancels() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 7 * DAY);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, bob));
        requests.cancel(id);
    }

    /// @dev A partly funded request can be closed by the asker, keeping what
    ///      was already collected.
    function test_CloseAfterPartialKeepsCollected() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "gift", 100e6, block.timestamp + 7 * DAY);
        vm.prank(bob);
        requests.pay(id, 40e6);

        vm.prank(alice);
        requests.close(id);

        assertEq(usdc.balanceOf(alice), 1_000e6 + 40e6, "alice keeps what she got");
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid), "closed");
    }

    // ------------------------------------------------------ expiry

    function test_ExpiredRequestCannotBePaid() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + 1);

        vm.warp(block.timestamp + 2);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.ExpiryPassed.selector, id));
        requests.pay(id, 25e6);
    }

    function test_ExpiryMustBeInTheFuture() public {
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.ExpiryTooLong.selector);
        requests.ask("bob", "dinner", 25e6, block.timestamp - 1);
    }

    function test_ExpiryCannotExceedNinetyDays() public {
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.ExpiryTooLong.selector);
        requests.ask("bob", "dinner", 25e6, block.timestamp + 91 * DAY);
    }

    // ------------------------------------------------------ feeds

    function test_FeedIncludesOpenRequestsForEveryone() public {
        vm.prank(dave);
        uint256 open = requests.askAnyone("gift", 10e6, block.timestamp + DAY);
        vm.prank(alice);
        uint256 named = requests.ask("bob", "dinner", 10e6, block.timestamp + DAY);

        uint256[] memory f = requests.feedOf(bob, 50);
        bool sawOpen = false;
        bool sawNamed = false;
        for (uint256 i = 0; i < f.length; i++) {
            if (f[i] == open) sawOpen = true;
            if (f[i] == named) sawNamed = true;
        }
        assertTrue(sawOpen, "open request in feed");
        assertTrue(sawNamed, "request addressed to bob in feed");
    }

    function test_AskedOfAndOpenedBy() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 10e6, block.timestamp + DAY);

        uint256[] memory asked = requests.askedOf(bob);
        assertEq(asked.length, 1, "bob was asked once");
        assertEq(asked[0], id, "correct id");

        uint256[] memory opened = requests.openedBy(alice);
        assertEq(opened.length, 1, "alice opened once");
    }

    // ------------------------------------------------------ totals

    function test_TotalSettledTracksEverything() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.pay(id, 25e6);

        assertEq(requests.totalSettled(), 25e6, "total settled");
    }
}