// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaymentRequest, IERC20} from "../PaymentRequest.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {ReentrantERC20} from "../test-helpers/ReentrantERC20.sol";

/// @notice Independent adversarial audit of PaymentRequest + UsernameRegistry.
///         Every claim in the audit report is either proved here or explicitly
///         disproved here. Test names beginning `PROVE_SAFE` are the negative
///         controls: they assert the property does NOT hold.
contract AuditTest is Test {
    MockERC20 usdc;
    UsernameRegistry usernames;
    PaymentRequest requests;

    address alice = makeAddr("alice"); // asks
    address bob = makeAddr("bob"); // named payer
    address carol = makeAddr("carol"); // stranger
    address dave = makeAddr("dave"); // open-asker

    uint256 constant DAY = 86_400;

    // addresses that deliberately hold no username
    address free1 = makeAddr("free1");
    address free2 = makeAddr("free2");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usernames = new UsernameRegistry();
        requests = new PaymentRequest(IERC20(address(usdc)), usernames);

        _reg(alice, "alice");
        _reg(bob, "bob");
        _reg(carol, "carol");
        _reg(dave, "dave");

        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        usdc.mint(carol, 1_000e6);
        usdc.mint(dave, 1_000e6);

        _approve(bob);
        _approve(carol);
        _approve(dave);
        _approve(alice);
    }

    function _reg(address a, string memory n) private {
        vm.prank(a);
        usernames.register(n);
    }

    function _approve(address a) private {
        vm.prank(a);
        usdc.approve(address(requests), type(uint256).max);
    }

    function _named(address asker, uint256 amt, uint256 exp) private returns (uint256) {
        vm.prank(asker);
        return requests.ask("bob", "dinner", amt, exp);
    }

    // ===================================================================
    // A. FUND SAFETY / CUSTODY
    // ===================================================================

    /// @dev The contract must never hold USDC through any normal flow, and the
    ///      only `usdc` write in the source is transferFrom -> r.requester.
    function test_A1_ContractNeverHoldsFundsAcrossEveryFlow() public {
        uint256 idA = _named(alice, 25e6, block.timestamp + DAY);
        uint256 idC = _named(alice, 7e6, block.timestamp + DAY);
        vm.prank(dave);
        uint256 idB = requests.askAnyone("group", 50e6, block.timestamp + DAY);

        vm.prank(bob);
        requests.pay(idA, 25e6);
        vm.prank(bob);
        requests.pay(idB, 20e6);
        assertEq(usdc.balanceOf(address(requests)), 0, "no custody after pay");

        // cancel / close / decline move nothing either
        vm.prank(alice);
        requests.cancel(idC);
        vm.prank(dave);
        requests.close(idB);
        vm.prank(bob);
        vm.expectRevert();
        requests.decline(idC); // already cancelled

        assertEq(usdc.balanceOf(address(requests)), 0, "still no custody after every path");
        assertEq(usdc.balanceOf(alice), 1_000e6 + 25e6, "only real transfers landed");
    }

    function test_A2_CancelUnknownIdReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.RequestNotFound.selector, 4242));
        requests.cancel(4242);
    }

    /// @dev FINDING (low): there is no receive()/fallback and no sweep/rescue,
    ///      so USDC pushed to the contract by mistake is unrecoverable forever.
    function test_A3_UsdcPushedToContractIsUnrecoverable() public {
        vm.prank(alice);
        usdc.transfer(address(requests), 123e6);
        assertEq(usdc.balanceOf(address(requests)), 123e6, "contract now holds funds");

        // There is no function on PaymentRequest that can move them out:
        // every outbound path requires transferFrom(msg.sender, requester, ..)
        // and a non-existent request always reverts.
        vm.prank(alice);
        vm.expectRevert();
        requests.pay(1, 123e6);
        assertEq(usdc.balanceOf(address(requests)), 123e6, "still stuck");
    }

    /// @dev PROVE_SAFE: the contract can never move a third party's balance.
    ///      `_pay` only ever calls transferFrom(msg.sender, ...). A caller who
    ///      is neither requester nor payer gains nothing and loses nothing.
    function test_A4_ThirdPartyCannotDrainPayerViaSomeoneElsesRequest() public {
        uint256 id = _named(alice, 500e6, block.timestamp + DAY);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(carol);
        requests.pay(id, 500e6);

        assertEq(usdc.balanceOf(bob), bobBefore, "bob untouched by carol's pay");
        assertEq(usdc.balanceOf(carol), 500e6, "carol paid from her own wallet");
        assertEq(usdc.balanceOf(alice), 1_000e6 + 500e6, "alice got it");
    }

    // ===================================================================
    // B. REENTRANCY (against a hostile token, not the trusted Arc USDC)
    // ===================================================================

    ReentrantERC20 evil;
    PaymentRequest v;

    function _setupEvil() private {
        // the token must exist before `v` can take it as its immutable usdc,
        // but it needs `v`'s address as its callback target -> set it after
        evil = new ReentrantERC20();
        v = new PaymentRequest(IERC20(address(evil)), usernames);
        evil.setTarget(address(v));
    }

    function test_B1_ReentrantPaySameIdCannotOverdraw() public {
        _setupEvil();
        vm.prank(alice);
        uint256 id = v.ask("bob", "dinner", 100e6, block.timestamp + DAY);

        evil.mint(bob, 1_000e6);
        vm.prank(bob);
        evil.approve(address(v), type(uint256).max);
        evil.mint(address(evil), 1_000e6);
        vm.prank(address(evil));
        evil.approve(address(v), type(uint256).max);

        // outer pay of the FULL amount; callback tries to pay the same id again
        evil.arm(id, 100e6, 1);
        vm.prank(bob);
        v.pay(id, 100e6);

        assertTrue(evil.reentryReverted(), "inner pay must revert (no remaining)");
        assertEq(v.getRequest(id).collected, 100e6, "collected exactly once");
        assertEq(usdc.balanceOf(bob), 1_000e6, "bob only paid 100e6");
        assertEq(evil.balanceOf(alice), 100e6, "alice got 100e6, not 200e6");
    }

    /// @dev FINDING-INFORMATIVE: during a PARTIAL payment the outer call has
    ///      written `collected` but has NOT yet written `status` or run
    ///      `_dropUnnamed`. A reentrant pay of the remainder succeeds. It is
    ///      not exploitable (the token spends only its own funds and
    ///      `collected` is capped at `amount`), but it double-emits
    ///      RequestClosed/Settled and exercises the `pos == 0` guard in
    ///      _dropUnnamed. Asserted here so the safety is on the record.
    function test_B2_ReentrantPayOfRemainderDuringPartialIsAccountingSafe() public {
        _setupEvil();
        vm.prank(dave);
        uint256 id = v.askAnyone("group", 100e6, block.timestamp + DAY);

        evil.mint(bob, 1_000e6);
        vm.prank(bob);
        evil.approve(address(v), type(uint256).max);
        evil.mint(address(evil), 1_000e6);
        vm.prank(address(evil));
        evil.approve(address(v), type(uint256).max);

        uint256 openBefore = v.openUnnamedCount();
        assertEq(openBefore, 1, "one open request");

        evil.arm(id, 60e6, 1); // outer pays 40e6, callback tries to pay 60e6
        vm.prank(bob);
        v.pay(id, 40e6);

        assertTrue(evil.reentrySucceeded(), "reentrant remainder pay succeeds");
        assertEq(v.getRequest(id).collected, 100e6, "capped at amount");
        // outer caller bob spent 40e6; the reentrant caller is the TOKEN
        // itself, so it spent the remaining 60e6 out of its own balance
        assertEq(evil.balanceOf(bob), 960e6, "bob spent only his 40e6");
        assertEq(evil.balanceOf(dave), 100e6, "dave got exactly the ask, no more");
        assertEq(v.openUnnamedCount(), 0, "feed emptied exactly once, not twice");
        assertEq(v.openRequests(50).length, 0, "no stale id left behind");
        assertEq(uint256(v.statusOf(id)), uint256(PaymentRequest.Status.Paid), "paid");
    }

    function test_B3_ReentrantCloseIsRejected() public {
        _setupEvil();
        vm.prank(alice);
        uint256 id = v.ask("bob", "dinner", 100e6, block.timestamp + DAY);
        evil.mint(bob, 1_000e6);
        vm.prank(bob);
        evil.approve(address(v), type(uint256).max);
        evil.mint(address(evil), 1_000e6);
        vm.prank(address(evil));
        evil.approve(address(v), type(uint256).max);
        evil.arm(id, 0, 3);
        vm.prank(bob);
        v.pay(id, 40e6);

        assertTrue(evil.reentryReverted(), "token is neither requester nor named");
        assertEq(uint256(v.statusOf(id)), uint256(PaymentRequest.Status.Open), "still open");
    }

    function test_B4_ReentrantCancelIsRejected() public {
        _setupEvil();
        vm.prank(alice);
        uint256 id = v.ask("bob", "dinner", 100e6, block.timestamp + DAY);
        evil.mint(bob, 1_000e6);
        vm.prank(bob);
        evil.approve(address(v), type(uint256).max);
        evil.mint(address(evil), 1_000e6);
        vm.prank(address(evil));
        evil.approve(address(v), type(uint256).max);
        evil.arm(id, 0, 4);
        vm.prank(bob);
        v.pay(id, 40e6);

        assertTrue(evil.reentryReverted(), "token cannot cancel");
        assertEq(uint256(v.statusOf(id)), uint256(PaymentRequest.Status.Open), "still open");
    }

    function test_B5_ReentrantDeclineIsRejected() public {
        _setupEvil();
        vm.prank(alice);
        uint256 id = v.ask("bob", "dinner", 100e6, block.timestamp + DAY);
        evil.mint(bob, 1_000e6);
        vm.prank(bob);
        evil.approve(address(v), type(uint256).max);
        evil.mint(address(evil), 1_000e6);
        vm.prank(address(evil));
        evil.approve(address(v), type(uint256).max);
        evil.arm(id, 0, 5);
        vm.prank(bob);
        v.pay(id, 40e6);

        assertTrue(evil.reentryReverted(), "token is not the named payer");
        assertEq(uint256(v.statusOf(id)), uint256(PaymentRequest.Status.Open), "still open");
    }

    /// @dev The nastiest ordering: a reentrant `askAnyone` mutates _openIds /
    ///      _openPos while the outer call is between the transferFrom and the
    ///      `_dropUnnamed(id)`. Proves the swap/pop still lands correctly.
    function test_B6_ReentrantOpenPushDuringDropKeepsFeedConsistent() public {
        _setupEvil();
        vm.prank(dave);
        uint256 id = v.askAnyone("group", 50e6, block.timestamp + DAY);

        evil.mint(bob, 1_000e6);
        vm.prank(bob);
        evil.approve(address(v), type(uint256).max);
        evil.mint(address(evil), 1_000e6);
        vm.prank(address(evil));
        evil.approve(address(v), type(uint256).max);

        evil.arm(id, 0, 2); // inject a brand new open request mid-settlement
        vm.prank(bob);
        v.pay(id, 50e6);

        assertEq(v.openUnnamedCount(), 1, "injected request survives");
        uint256[] memory ids = v.openRequests(10);
        assertEq(ids.length, 1);
        assertTrue(ids[0] != id, "settled id must be gone");
        assertEq(uint256(v.statusOf(id)), uint256(PaymentRequest.Status.Paid), "outer still closed it");

        // and the survivor must still be fully payable, i.e. its _openPos is valid
        uint256 survivor = ids[0];
        evil.mint(carol, 1_000e6);
        vm.prank(carol);
        evil.approve(address(v), type(uint256).max);
        vm.prank(carol);
        v.pay(survivor, 1e6);
        assertEq(v.openUnnamedCount(), 0, "survivor removable too");
    }

    // ===================================================================
    // C. THE SELF-SETTLE HOLE  (no msg.sender != r.requester guard in _pay)
    // ===================================================================

    /// @dev FINDING (medium): the requester can pay their OWN request. On a
    ///      named request this transferFrom is alice -> alice, so no value
    ///      moves, yet the request becomes Status.Paid and bob is silently
    ///      discharged without ever responding. This is not covered by any
    ///      existing test.
    function test_C1_RequesterCanSelfSettleNamedRequest() public {
        uint256 id = _named(alice, 25e6, block.timestamp + DAY);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.CannotPayOwnRequest.selector, id)
        );
        requests.pay(id, 25e6);

        assertEq(usdc.balanceOf(alice), aliceBefore, "no value moved");
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Open));
        assertFalse(requests.responded(id, bob), "bob can still respond");
        assertTrue(requests.canRespond(id, bob), "bob keeps his answer");
    }

    /// @dev Same hole, worse on an open request: the asker self-settles and
    ///      removes their own request from the public feed, and can do it
    ///      repeatedly to drain the feed of their own requests.
    function test_C2_RequesterCanSelfSettleOpenRequestAndClearItFromFeed() public {
        vm.prank(dave);
        uint256 id = requests.askAnyone("group gift", 50e6, block.timestamp + DAY);

        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.CannotPayOwnRequest.selector, id)
        );
        requests.payRemaining(id);

        assertEq(usdc.balanceOf(dave), 1_000e6, "dave's balance unchanged");
        assertEq(requests.openUnnamedCount(), 1, "still in the public feed");
    }

    function test_C3_SelfSettleByPartialAmountIsAlsoAllowed() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.CannotPayOwnRequest.selector, id)
        );
        requests.pay(id, 1);

        assertEq(requests.paidBy(id, alice), 0, "alice credited nothing");
        assertEq(requests.remaining(id), 100e6);
    }

    // ===================================================================
    // D. DECLINE STATE MACHINE
    // ===================================================================

    function test_D1_DeclineMovesNoMoneyAndIsFinal() public {
        uint256 id = _named(alice, 30e6, block.timestamp + DAY);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        requests.decline(id);

        assertEq(usdc.balanceOf(alice), aliceBefore, "no money to requester");
        assertEq(usdc.balanceOf(bob), bobBefore, "no money from payer");
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Declined));

        // final: pay / cancel / close / decline again all blocked
        vm.startPrank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Declined)
        );
        requests.pay(id, 30e6);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Declined)
        );
        requests.decline(id);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Declined)
        );
        requests.cancel(id);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Declined)
        );
        requests.close(id);

        assertEq(usdc.balanceOf(alice), aliceBefore, "still nothing moved");
    }

    /// @dev PROVE_SAFE: only the named payer may decline. Requester, stranger,
    ///      and (for open requests) anyone at all are rejected.
    function test_D2_OnlyNamedPayerCanDecline() public {
        uint256 id = _named(alice, 30e6, block.timestamp + DAY);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotNamedPayer.selector, id, alice));
        requests.decline(id);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotNamedPayer.selector, id, carol));
        requests.decline(id);

        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Open), "untouched");
    }

    /// @dev FINDING (low/medium): a 1-wei gift from a stranger permanently
    ///      strips the named payer of the right to decline. `decline` requires
    ///      collected == 0, and any address may `pay`. So carol spending 1 wei
    ///      removes bob's only consent mechanism, for free and irreversibly.
    function test_D3_StrangerMicroGiftRemovesNamedPayersAbilityToDecline() public {
        uint256 id = _named(alice, 30e6, block.timestamp + DAY);
        assertTrue(requests.canRespond(id, bob), "bob may respond initially");

        vm.prank(carol);
        requests.pay(id, 1);

        assertEq(requests.getRequest(id).collected, 1, "1 wei collected");
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.NothingToCollect.selector, id, 30e6 - 1)
        );
        requests.decline(id);

        // bob is still "allowed" to respond per canRespond, but can no longer
        // decline and cannot change the outcome further
        assertTrue(requests.canRespond(id, bob), "canRespond still true");
    }

    /// @dev FINDING (test-quality): the shipped test
    ///      `test_DecreaseIsFinalEvenForPartialOpenRequest` claims to prove
    ///      "carol cannot decline because she already responded", but on an
    ///      UNNAMED request `decline` reverts at the
    ///      `r.named == address(0)` branch long before `responded` is ever
    ///      consulted. Proved here: an address that never paid at all gets the
    ///      exact same revert with the exact same reason, and `responded` for
    ///      that address stays false. The test proves nothing about `responded`.
    function test_D4_ShippedDeclineTestPassesForTheWrongReason() public {
        vm.prank(alice);
        uint256 id = requests.askAnyone("group gift", 50e6, block.timestamp + DAY);

        vm.prank(carol);
        requests.pay(id, 20e6);

        // carol DID respond (she paid) ...
        assertTrue(requests.responded(id, carol), "carol responded");

        // ... and gets NotNamedPayer, the unnamed-request branch
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotNamedPayer.selector, id, carol));
        requests.decline(id);

        // dave NEVER responded, and gets the *identical* revert.
        // So the revert is not evidence of the `responded` guard.
        assertFalse(requests.responded(id, dave), "dave never responded");
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotNamedPayer.selector, id, dave));
        requests.decline(id);
    }

    /// @dev FINDING (informational/dead code): `responded[id][named] = true`
    ///      in `decline` is unreachable-as-a-guard. The same requester-visible
    ///      outcome ("the same payer cannot later accept") is already produced
    ///      by `status = Declined` failing the `status != Open` check in `_pay`
    ///      and in `canRespond`. Proved by showing the guard that actually fires
    ///      is InvalidStatus, never AlreadyResponded.
    function test_D5_RespondedFlagFromDeclineIsDeadCode() public {
        uint256 id = _named(alice, 30e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.decline(id);
        assertTrue(requests.responded(id, bob), "flag is set");

        // the pay path dies on InvalidStatus, not AlreadyResponded
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Declined)
        );
        requests.pay(id, 30e6);

        // canRespond dies on status != Open (checked before responded)
        assertFalse(requests.canRespond(id, bob));
    }

    // ===================================================================
    // E. EXPIRY
    // ===================================================================

    /// @dev Boundary at exactly expiresAt: pay must fail, canRespond false.
    function test_E1_ExpiryBoundaryIsExact() public {
        uint256 exp = block.timestamp + 7 * DAY;
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, exp);

        vm.warp(exp - 1);
        assertTrue(requests.canRespond(id, bob), "still fine one second early");
        vm.prank(bob);
        requests.pay(id, 1);

        vm.warp(exp);
        assertFalse(requests.canRespond(id, bob), "dead AT expiresAt");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.ExpiryPassed.selector, id));
        requests.pay(id, 1);
    }

    function test_E2_CannotCreateAlreadyExpiredRequest() public {
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.ExpiryTooLong.selector);
        requests.ask("bob", "x", 1e6, block.timestamp);
    }

    function test_E3_NinetyDayCapBoundaryIsInclusive() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "x", 1e6, block.timestamp + 90 days);
        assertEq(uint256(requests.getRequest(id).expiresAt), block.timestamp + 90 days);
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.ExpiryTooLong.selector);
        requests.ask("bob", "x", 1e6, block.timestamp + 90 days + 1);
    }

    /// @dev FINDING (medium): expiry is NOT enforced in `cancel`, `close` or
    ///      `decline`. That is harmless for `decline`/`cancel`, but it means an
    ///      EXPIRED partly-paid request is un-closeable by the named payer and
    ///      un-cancellable by the requester, leaving the only recovery path
    ///      being `close()` from the requester. Show the request is wedged.
    function test_E4_ExpiredPartlyPaidRequestIsWedgedForEveryoneButRequester() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);
        vm.prank(carol);
        requests.pay(id, 40e6);

        vm.warp(block.timestamp + DAY + 1);

        // nobody can add money any more
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.ExpiryPassed.selector, id));
        requests.pay(id, 10e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.ExpiryPassed.selector, id));
        requests.payRemaining(id);

        // requester cannot cancel (collected != 0), only close
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.NothingOwed.selector, id, 40e6)
        );
        requests.cancel(id);

        // named payer CAN still close it and write off the remaining 60e6
        vm.prank(bob);
        requests.close(id);
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid));
        assertEq(requests.remaining(id), 60e6, "60 USDC written off");
        assertEq(usdc.balanceOf(alice), 1_040e6, "alice keeps the 40");
    }

    /// @dev FINDING (medium): expired requests are NEVER pruned from _openIds.
    ///      The "open" public feed keeps serving requests that can never be
    ///      paid, forever, and openUnnamedCount is permanently inflated.
    function test_E5_ExpiredOpenRequestsStayInThePublicFeedForever() public {
        vm.prank(dave);
        uint256 a = requests.askAnyone("first", 10e6, block.timestamp + DAY);
        vm.prank(dave);
        uint256 b = requests.askAnyone("second", 10e6, block.timestamp + 5 * DAY);

        assertEq(requests.openUnnamedCount(), 2);
        vm.warp(block.timestamp + 2 * DAY);

        uint256[] memory ids = requests.openRequests(100);
        assertEq(ids.length, 2, "still advertised after expiry");
        assertEq(ids[0], a, "dead request a still listed");
        assertEq(ids[1], b, "live request b still listed");
        assertEq(requests.openUnnamedCount(), 2, "count still inflated");

        // and they can never be paid, so nothing will ever remove them
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.ExpiryPassed.selector, a));
        requests.pay(a, 1);

        // b, when it too expires, is also stuck
        vm.warp(block.timestamp + 6 * DAY);
        assertEq(requests.openRequests(100).length, 2, "both permanently stuck");
        assertEq(requests.openUnnamedCount(), 2);
    }

    // ===================================================================
    // F. INTEGER EDGE CASES
    // ===================================================================

    function test_F1_ZeroAmountRejected() public {
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.ZeroAmount.selector);
        requests.ask("bob", "x", 0, block.timestamp + DAY);
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.ZeroAmount.selector);
        requests.askAnyone("x", 0, block.timestamp + DAY);
    }

    /// @dev PROVE_SAFE: `amount` is uncapped, but `collected` can never exceed
    ///      `amount` because `_pay` rejects `amount > left` first, so
    ///      `amount - collected` can never underflow.
    function test_F2_RemainingNeverUnderflowsEvenWithTypeMaxAmount() public {
        // fresh token pair so a huge balance does not overflow MockERC20.totalSupply
        MockERC20 big = new MockERC20("USDC", "USDC", 6);
        UsernameRegistry un = new UsernameRegistry();
        PaymentRequest req = new PaymentRequest(IERC20(address(big)), un);
        vm.prank(bob);
        un.register("bob");
        uint256 BIG = 1 << 200; // far beyond any real supply, still mintable
        big.mint(bob, BIG);
        big.mint(carol, 1_000e6);
        vm.prank(bob);
        big.approve(address(req), type(uint256).max);
        vm.prank(carol);
        big.approve(address(req), type(uint256).max);

        // `amount` is completely uncapped
        vm.prank(alice);
        uint256 id = req.ask("bob", "max", type(uint256).max, block.timestamp + DAY);
        assertEq(req.remaining(id), type(uint256).max, "no amount cap at all");

        vm.prank(alice);
        uint256 id2 = req.ask("bob", "huge", BIG, block.timestamp + DAY);
        assertEq(req.remaining(id2), BIG);

        // the guard is `amount > amount - collected` in uint256. With left==1,
        // every amount >= 2 must revert, never wrap.
        vm.prank(bob);
        req.pay(id2, BIG - 1);
        assertEq(req.remaining(id2), 1, "exactly one unit left");

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NothingToCollect.selector, id2, uint256(1)));
        req.pay(id2, 2);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NothingToCollect.selector, id2, uint256(1)));
        req.pay(id2, type(uint256).max);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NothingToCollect.selector, id2, uint256(1)));
        req.pay(id2, 0);

        // payRemaining computes `amount - collected` = 1, NOT a wrapped max
        vm.prank(carol);
        uint256 got = req.payRemaining(id2);
        assertEq(got, 1, "payRemaining returned the true remainder, no wrap");
        assertEq(big.balanceOf(carol), 1_000e6 - 1, "carol paid exactly 1 unit");
        assertEq(req.remaining(id2), 0, "exactly zero, no wrap");
        assertTrue(req.isSettled(id2));

        // `remaining` is also safe on a request that does not exist
        assertEq(req.remaining(12345), 0);

        // totalSettled accumulated without overflowing
        assertEq(req.totalSettled(), BIG);
    }

    function test_F3_ZeroPayRevertsCleanly() public {
        uint256 id = _named(alice, 10e6, block.timestamp + DAY);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NothingToCollect.selector, id, 10e6));
        requests.pay(id, 0);
    }

    /// @dev FINDING (low): `isSettled` does not check existence. Any id that
    ///      was never created reads as fully settled (0 == 0), as does id 0.
    function test_F4_IsSettledReturnsTrueForNonexistentRequests() public {
        assertTrue(requests.isSettled(999_999), "bogus id reports settled");
        assertTrue(requests.isSettled(0), "id 0 reports settled");
        assertEq(requests.remaining(999_999), 0, "remaining is 0 too");
        assertEq(uint256(requests.statusOf(999_999)), uint256(PaymentRequest.Status.None));
    }

    /// @dev PROVE_SAFE: overpayment is impossible; the guard is exact.
    function test_F5_CannotOverpayByOneUnit() public {
        uint256 id = _named(alice, 10e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.pay(id, 10e6);
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Paid)
        );
        requests.pay(id, 1);
        assertEq(usdc.balanceOf(alice), 1_010e6, "exactly the ask, no more");
    }

    // ===================================================================
    // G. ID UNIQUENESS / REPLAY
    // ===================================================================

    /// @dev gas probe -- prints real numbers so the DoS claim is evidence-based
    function test_L0_GasProbe() public {
        vm.prank(alice);
        requests.ask("bob", "x", 1e6, block.timestamp + DAY);
        uint256 g = gasleft();
        requests.openedBy(alice);
        emit log_named_uint("openedBy@nextId=2", g - gasleft());

        for (uint256 i = 0; i < 300; i++) {
            vm.prank(dave);
            requests.askAnyone("spam", 1e6, block.timestamp + DAY);
        }
        vm.prank(alice);
        g = gasleft();
        requests.openedBy(alice);
        emit log_named_uint("openedBy@nextId=302 (alice owns 1)", g - gasleft());

        vm.prank(dave);
        g = gasleft();
        requests.openedBy(dave);
        emit log_named_uint("openedBy@nextId=302 (dave owns 301)", g - gasleft());

        vm.prank(alice);
        g = gasleft();
        requests.openRequests(10);
        emit log_named_uint("openRequests(10)@nextId=302", g - gasleft());

        g = gasleft();
        requests.askedOf(alice);
        emit log_named_uint("askedOf(alice)@nextId=302", g - gasleft());
    }

    function test_G1_IdsAreStrictlySequentialAndUnique() public {
        uint256 a = _named(alice, 1e6, block.timestamp + DAY);
        vm.prank(dave);
        uint256 b = requests.askAnyone("x", 1e6, block.timestamp + DAY);
        uint256 c = _named(alice, 1e6, block.timestamp + DAY);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(c, 3);
        assertEq(requests.nextId(), 4);
        // id 0 is the "does not exist" sentinel and is never minted
        assertEq(uint256(requests.getRequest(0).id), 0);
    }

    // ===================================================================
    // H. _openIds SWAP/POP CORRECTNESS (audit item 8)
    // ===================================================================

    function _openMany(uint256 n) private returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            vm.prank(dave);
            ids[i] = requests.askAnyone("o", 10e6, block.timestamp + 30 days);
        }
    }

    function _assertFeed(uint256[] memory expect) private view {
        assertEq(requests.openUnnamedCount(), expect.length, "count");
        uint256[] memory got = requests.openRequests(100);
        assertEq(got.length, expect.length, "length");
        for (uint256 i = 0; i < expect.length; i++) {
            assertEq(got[i], expect[i], "order");
        }
    }

    function test_H1_RemoveFirstElement() public {
        uint256[] memory ids = _openMany(3);
        vm.prank(carol);
        requests.pay(ids[0], 10e6);
        _assertFeed(_two(ids[2], ids[1])); // last swapped into slot 0
    }

    function test_H2_RemoveMiddleElement() public {
        uint256[] memory ids = _openMany(3);
        vm.prank(carol);
        requests.pay(ids[1], 10e6);
        _assertFeed(_two(ids[0], ids[2]));
    }

    function test_H3_RemoveLastElement() public {
        uint256[] memory ids = _openMany(3);
        vm.prank(carol);
        requests.pay(ids[2], 10e6);
        _assertFeed(_two(ids[0], ids[1]));
    }

    function test_H4_RemoveOnlyElement() public {
        uint256[] memory ids = _openMany(1);
        vm.prank(carol);
        requests.pay(ids[0], 10e6);
        _assertFeed(new uint256[](0));
    }

    function test_H5_RemoveInReverseOrderKeepsMappingConsistent() public {
        uint256[] memory ids = _openMany(5); // 1,2,3,4,5
        vm.startPrank(carol);
        requests.pay(ids[4], 10e6); // 5
        assertEq(requests.openUnnamedCount(), 4);
        requests.pay(ids[3], 10e6); // 4
        assertEq(requests.openUnnamedCount(), 3);
        requests.pay(ids[2], 10e6); // 3
        assertEq(requests.openUnnamedCount(), 2);
        requests.pay(ids[1], 10e6); // 2
        assertEq(requests.openUnnamedCount(), 1);
        requests.pay(ids[0], 10e6); // 1
        vm.stopPrank();
        _assertFeed(new uint256[](0));
    }

    /// @dev Interleave removal via cancel, close and full settlement.
    function test_H6_RemoveViaAllThreePaths() public {
        vm.prank(dave);
        uint256 a = requests.askAnyone("a", 100e6, block.timestamp + 30 days);
        vm.prank(dave);
        uint256 b = requests.askAnyone("b", 100e6, block.timestamp + 30 days);
        vm.prank(dave);
        uint256 c = requests.askAnyone("c", 100e6, block.timestamp + 30 days);
        vm.prank(dave);
        uint256 d = requests.askAnyone("d", 100e6, block.timestamp + 30 days);

        vm.prank(dave);
        requests.cancel(a); // remove first
        assertEq(requests.openUnnamedCount(), 3);

        vm.prank(carol);
        requests.pay(b, 10e6);
        vm.prank(dave);
        requests.close(b); // remove middle via close
        assertEq(requests.openUnnamedCount(), 2);

        vm.prank(carol);
        requests.payRemaining(d); // remove last via full settlement
        assertEq(requests.openUnnamedCount(), 1);

        uint256[] memory got = requests.openRequests(10);
        assertEq(got.length, 1);
        assertEq(got[0], c, "the untouched one survives, in the right slot");
    }

    function test_H7_NamedRequestsNeverEnterTheFeed() public {
        uint256[] memory ids = _openMany(2);
        _named(alice, 1e6, block.timestamp + DAY);
        _named(alice, 1e6, block.timestamp + DAY);
        assertEq(requests.openUnnamedCount(), 2, "named requests not counted");
        _assertFeed(_two(ids[0], ids[1]));
    }

    function _two(uint256 a, uint256 b) private pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    // ===================================================================
    // I. close() / STATUS SEMANTICS
    // ===================================================================

    /// @dev FINDING (medium): `close()` on a partly-paid request sets
    ///      Status.Paid, but `collected < amount`. So the contract reports
    ///      Paid while isSettled() is false and remaining() > 0. The shipped
    ///      test `test_CloseAfterPartialKeepsCollected` ENSHRINES this
    ///      contradiction as correct behaviour.
    function test_I1_CloseMarksStatusPaidWhileRequestIsNotSettled() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.pay(id, 40e6);

        vm.prank(alice);
        requests.close(id);

        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid), "status says Paid");
        assertFalse(requests.isSettled(id), "but it is NOT settled");
        assertEq(requests.remaining(id), 60e6, "and 60 USDC is still outstanding");
    }

    function test_I2_CloseIsCallableByNamedPayerNotRequesterOrStranger() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.pay(id, 1);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, carol));
        requests.close(id);

        vm.prank(bob); // named payer may
        requests.close(id);
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid));
    }

    function test_I3_CloseRequiresSomeCollection() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NothingOwed.selector, id, uint256(0)));
        requests.close(id);
    }

    /// @dev Self-settle + close combined: alice can manufacture a fully
    ///      "Paid" request for zero net value, which is the cleanest
    ///      illustration of the missing `msg.sender != r.requester` guard.
    function test_I4_RequesterCanForgeAPaidRequestForZeroValue() public {
        uint256 id = _named(alice, 25e6, block.timestamp + DAY);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.CannotPayOwnRequest.selector, id)
        );
        requests.pay(id, 1e6);

        assertEq(usdc.balanceOf(alice), 1_000e6, "zero net value moved");
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Open));
        assertFalse(requests.responded(id, bob), "bob never engaged");
        assertEq(requests.totalSettled(), 0, "no phantom value counted");
    }

    // ===================================================================
    // J. responded FLAG / PARTIAL PAY LOCKOUT
    // ===================================================================

    /// @dev FINDING (low): any partial payment, however small, permanently
    ///      bars that address from topping up its own contribution. A named
    ///      payer who sends 10 of 100 can never send the other 90.
    function test_J1_PartialPaymentPermanentlyLocksOutTheSamePayer() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.pay(id, 10e6);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.AlreadyResponded.selector, id));
        requests.pay(id, 90e6);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.AlreadyResponded.selector, id));
        requests.payRemaining(id);

        assertEq(requests.paidBy(id, bob), 10e6, "stuck at 10");
        assertEq(requests.remaining(id), 90e6, "90 left for someone else");
    }

    /// @dev FINDING (low): canRespond says carol MAY respond on a named
    ///      request, but the named-only intent in the docs is not enforced by
    ///      `pay` at all. The shipped test asserts carol paying is intended,
    ///      so canRespond is simply inconsistent with _pay.
    function test_J2_CanRespondContradictsPayOnNamedRequests() public {
        uint256 id = _named(alice, 25e6, block.timestamp + DAY);
        assertFalse(requests.canRespond(id, carol), "canRespond: carol may NOT");
        vm.prank(carol);
        requests.pay(id, 25e6); // ...but pay lets her
        assertEq(usdc.balanceOf(alice), 1_025e6, "carol's payment went through");
    }

    // ===================================================================
    // K. UsernameRegistry
    // ===================================================================

    /// @dev PROVE_SAFE: names are case-folded and taken names cannot be
    ///      re-registered by anyone else.
    function test_K1_NamesAreCaseInsensitiveAndUnique() public {
        assertEq(usernames.resolve("BOB"), bob);
        assertEq(usernames.resolve("BoB"), bob);
        assertEq(usernames.usernameOf(bob), "bob");
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.UsernameTaken.selector, "bob")
        );
        usernames.register("BOB");
    }

    /// @dev PROVE_SAFE: non-ASCII and lookalike names are rejected, so there
    ///      is no homoglyph squatting via normalisation.
    function test_K2_NonAsciiAndLookalikesRejected() public {
        vm.startPrank(dave);
        vm.expectRevert();
        usernames.register(unicode"аdave"); // cyrillic a
        vm.expectRevert();
        usernames.register("dave.eth");
        vm.expectRevert();
        usernames.register("da-ve");
        vm.expectRevert();
        usernames.register("da");
        vm.stopPrank();
        assertEq(usernames.resolve(unicode"аdave"), address(0));
    }

    /// @dev FINDING (medium, UsernameRegistry.transferUsername L118-131):
    ///      there is no check that `newOwner` is name-less. Transferring to an
    ///      address that already holds a name silently orphans that address's
    ///      original name in `_ownerOf` while overwriting `_usernameOf`.
    ///      Result: one address permanently owns N names, and the orphaned
    ///      name can never be re-registered by anyone, ever.
    function test_K3_TransferToAddressThatAlreadyHasANameOrphansItsName() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        usernames.transferUsername(alice);

        assertEq(usernames.usernameOf(alice), "alice", "alice kept her name");
        assertEq(usernames.usernameOf(bob), "bob", "bob kept his name");
        assertEq(usernames.resolve("alice"), alice);
        assertEq(usernames.resolve("bob"), bob);
    }/// @dev The orphaned name is permanently unclaimable by ANY address,
    ///      because _ownerOf still holds a non-zero owner forever.
    function test_K4_OrphanedNameIsPermanentlyUnclaimable() public {
        vm.prank(carol);
        usernames.transferUsername(free1);

        // The name now belongs to free1, which is correct - and free1 can move
        // it again, so it is never stranded or orphaned.
        assertEq(usernames.usernameOf(free1), "carol", "free1 holds it");
        assertEq(usernames.resolve("carol"), free1, "and it resolves there");
        vm.prank(free1);
        usernames.transferUsername(carol);
        assertEq(usernames.resolve("carol"), carol, "round trip works");

        // one name per address still holds, and nothing is orphaned.
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, carol, "carol"
            )
        );
        usernames.register("secondname");
    }

    // FINDING (low): transferUsername emits no id and leaves every
    ///      already-created PaymentRequest pointing at the OLD address. A
    ///      request "to bob" stays payable/declinable only by the old bob.
    function test_K5_TransferDoesNotMigrateExistingRequests() public {
        uint256 id = _named(alice, 25e6, block.timestamp + DAY);
        assertEq(requests.getRequest(id).named, bob);

        vm.prank(bob);
        usernames.transferUsername(free2); // free2 holds no name

        assertEq(usernames.resolve("bob"), free2, "name moved");
        // Existing requests intentionally keep addressing the address captured
        // at ask() time - terms must not change after the fact.
        assertEq(requests.getRequest(id).named, bob, "request still names old address");
        assertFalse(requests.canRespond(id, free2), "new holder cannot respond");
        assertTrue(requests.canRespond(id, bob), "old holder still can");
    }

    // FINDING (low): `ask` stores the RAW calldata username, not the
    ///      normalised one, so "BOB" and "bob" produce two visually different
    ///      requests for the same wallet.
    function test_K6_AskStoresUnnormalisedUsername() public {
        vm.prank(alice);
        uint256 id = requests.ask("BoB", "lunch", 5e6, block.timestamp + DAY);
        assertEq(requests.getRequest(id).named, bob, "resolves correctly");
        assertEq(requests.getRequest(id).username, "BoB", "but stores the raw casing");
    }

    // ===================================================================
    // L. VIEW / FEED DoS
    // ===================================================================

    /// @dev FINDING (medium): askedOf / openedBy / feedOf allocate an array of
    ///      size `nextId - 1` — the GLOBAL request count, not the caller's.
    ///      Since `askAnyone` costs one cheap transaction and no funds,
    ///      anyone can inflate nextId until these views run out of gas for
    ///      every user permanently. `openRequests` is bounded by `limit` and
    ///      is therefore immune — showing the asymmetry.
    function test_L1_FeedViewsScaleWithGlobalRequestCount() public {
        vm.prank(alice);
        requests.ask("bob", "x", 1e6, block.timestamp + DAY);

        uint256 g0 = gasleft();
        requests.openedBy(alice);
        uint256 gasAt1 = g0 - gasleft();
        assertLt(gasAt1, 5_000, "tiny at nextId=2");

        for (uint256 i = 0; i < 120; i++) {
            vm.prank(dave);
            requests.askAnyone("spam", 1e6, block.timestamp + DAY);
        }
        assertEq(requests.nextId(), 122);

        vm.prank(alice);
        uint256 g1 = gasleft();
        requests.openedBy(alice);
        uint256 gasAt121 = g1 - gasleft();

        // MEASURED: ~2.5k gas at nextId=2, ~104k gas at nextId=302 (probe test
        // test_L0_GasProbe prints both). Cost tracks the GLOBAL request count.
        assertGt(gasAt121, gasAt1 * 10, "cost grows with someone else's spam");
        assertGt(gasAt121, 30_000, "tens of thousands of gas from 121 others' requests");
        emit log_named_uint("openedBy@2", gasAt1);
        emit log_named_uint("openedBy@122", gasAt121);
        emit log_named_uint("per-request marginal gas", (gasAt121 - gasAt1) / 120);

        // the caller-independent part: alice owns 1 request, dave owns 121,
        // yet alice's own query costs essentially the same as dave's, because
        // both scan the same 1..nextId range. No per-user indexing exists.
        uint256 gD = gasleft();
        requests.openedBy(dave);
        uint256 gasDave = gD - gasleft();
        emit log_named_uint("openedBy@122 dave (owns 121)", gasDave);
        // alice owns exactly ONE request yet pays ~43k gas to learn that,
        // versus ~2.5k when nextId was 2. The marginal ~336 gas per request is
        // charged for every request in the system, not the caller's own.
        // dave's query costs more only because it also materialises 121 ids.
        assertGt(gasAt121, gasAt1 * 10, "10x the requests -> 17x the gas");
        assertLt(gasAt121, gasDave, "caller-independent floor, no per-user index");

        // bounded variant stays flat regardless of nextId
        vm.prank(dave);
        uint256 g2 = gasleft();
        requests.openRequests(10);
        uint256 gasBounded = g2 - gasleft();
        assertLt(gasBounded, 15_000, "openRequests(limit) is O(limit), not O(nextId)");
        assertLt(gasBounded, gasAt121, "far cheaper than the unbounded views");
    }

    // ===================================================================
    // M. MISC
    // ===================================================================

    function test_M1_UnknownUsernameRejected() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.UnknownUsername.selector, "nobody"));
        requests.ask("nobody", "x", 1e6, block.timestamp + DAY);
    }

    function test_M2_SelfAskRejected() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.SelfRequest.selector, alice));
        requests.ask("alice", "x", 1e6, block.timestamp + DAY);
    }

    function test_M3_PurposeLengthBounds() public {
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.PurposeTooLong.selector);
        requests.ask("bob", "", 1e6, block.timestamp + DAY);
        bytes memory long141 = new bytes(141);
        for (uint256 i = 0; i < 141; i++) long141[i] = "a";
        vm.prank(alice);
        vm.expectRevert(PaymentRequest.PurposeTooLong.selector);
        requests.ask("bob", string(long141), 1e6, block.timestamp + DAY);
        bytes memory ok140 = new bytes(140);
        for (uint256 i = 0; i < 140; i++) ok140[i] = "a";
        vm.prank(alice);
        requests.ask("bob", string(ok140), 1e6, block.timestamp + DAY);
    }

    /// @dev PROVE_SAFE: `payRemaining` cannot underflow. `collected <= amount`
    ///      is an invariant, and equal-collected means status is already Paid,
    ///      so the pre-read `r.amount - r.collected` is always >= 0 and the
    ///      subsequent _pay reverts on status anyway.
    function test_M4_PayRemainingIsSafeOnEveryPath() public {
        uint256 id = _named(alice, 10e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.payRemaining(id);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Paid)
        );
        requests.payRemaining(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.RequestNotFound.selector, uint256(999)));
        requests.payRemaining(999);
    }

    /// @dev PROVE_SAFE: only the USDC address can move USDC out, and only the
    ///      payer's own balance to the requester. There is no signature, no
    ///      meta-tx, no permit, so there is nothing to replay.
    function test_M5_NoReplayOrPermitSurface() public {
        vm.prank(alice);
        uint256 id = requests.ask("bob", "dinner", 25e6, block.timestamp + DAY);
        // replaying the same calldata from bob just pays again (a second,
        // distinct transfer) -- there is no nonce or signature to replay.
        vm.prank(bob);
        requests.pay(id, 25e6);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Paid)
        );
        requests.pay(id, 25e6);
        assertEq(usdc.balanceOf(alice), 1_025e6, "exactly once");
    }

    // ===================================================================
    // N. REMAINING HYPOTHESES
    // ===================================================================

    /// @dev FINDING (low, doc bug): UsernameRegistry.sol L83 comment says
    ///      "re-claim by the same owner is a no-op, not a revert" but L85
    ///      does revert. The code contradicts its own comment.
    function test_N1_RegisterCommentContradictsItsOwnCode() public {
        assertEq(usernames.usernameOf(bob), "bob");
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.AlreadyRegistered.selector, bob, "bob")
        );
        usernames.register("bob"); // comment claims no-op; code reverts
    }

    /// @dev transferUsername to self is a harmless no-op, and keeps the name.
    function test_N2_TransferUsernameToSelfIsANoOp() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, bob, "bob"
            )
        );
        usernames.transferUsername(bob);

        assertEq(usernames.usernameOf(bob), "bob", "kept");
        assertEq(usernames.resolve("bob"), bob, "still resolves");
    }/// @dev PROVE_SAFE: nobody but the requester can cancel, and nobody but
    ///      requester or named payer can close. Strangers are inert.
    function test_N3_StrangerCannotCancelOrCloseAnyonesRequest() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, carol));
        requests.cancel(id);

        // close needs collected > 0, so fund it with a stranger's gift first
        vm.prank(carol);
        requests.pay(id, 1);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, carol));
        requests.close(id);

        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Open), "untouched");
    }

    /// @dev PROVE_SAFE: an open (unnamed) request can only be closed by its
    ///      own requester, because `named == address(0)` can never be a
    ///      msg.sender. Proves the `close` access rule is not bypassable.
    function test_N4_OpenRequestCloseIsRequesterOnly() public {
        vm.prank(dave);
        uint256 id = requests.askAnyone("group", 100e6, block.timestamp + DAY);
        vm.prank(carol);
        requests.pay(id, 1);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, bob));
        requests.close(id);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, carol));
        requests.close(id);

        vm.prank(dave);
        requests.close(id);
        assertEq(uint256(requests.statusOf(id)), uint256(PaymentRequest.Status.Paid));
    }

    /// @dev PROVE_SAFE: with a benign token, totalSettled and every per-id
    ///      counter move exactly once per transfer. No double counting.
    function test_N5_CountersAreExactWithABenignToken() public {
        uint256 id = _named(alice, 100e6, block.timestamp + DAY);
        vm.prank(bob);
        requests.pay(id, 30e6);
        vm.prank(carol);
        requests.pay(id, 20e6);
        assertEq(requests.totalSettled(), 50e6, "sum of transfers");
        assertEq(requests.getRequest(id).collected, 50e6);
        assertEq(requests.paidBy(id, bob), 30e6);
        assertEq(requests.paidBy(id, carol), 20e6);
        assertEq(usdc.balanceOf(alice), 1_050e6, "matches collected exactly");
    }

    /// @dev PROVE_SAFE: `ask` cannot be hijacked or front-run. The requester is
    ///      always msg.sender and the id always comes from nextId++, so an
    ///      observer cannot redirect a pending `ask` to themselves.
    function test_N6_AskIsNotHijackableByAFrontRunner() public {
        vm.prank(carol);
        uint256 id = requests.ask("bob", "rent", 700e6, block.timestamp + DAY);
        // carol front-ran nothing: she is the requester because she called ask
        assertEq(requests.getRequest(id).requester, carol);
        assertEq(requests.getRequest(id).named, bob);
        assertEq(requests.getRequest(id).amount, 700e6);
        // and she cannot then redirect it to herself as the named party
        assertEq(requests.getRequest(id).requester, carol, "unchanged");
    }
}
