// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";
import {PaymentRequest} from "../PaymentRequest.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract PaymentRequestTest is Test {
    UsernameRegistry registry;
    PaymentRequest requests;
    MockERC20 usdc;

    address adaeze = makeAddr("adaeze");
    address chidi = makeAddr("chidi");
    address bolu = makeAddr("bolu");
    address mallory = makeAddr("mallory");

    uint256 constant TEN = 10e6; // 10 USDC

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        registry = new UsernameRegistry();
        requests = new PaymentRequest(address(usdc), address(registry));

        vm.startPrank(adaeze);
        registry.register("adaeze");
        usdc.mint(address(adaeze), 1000e6);
        vm.stopPrank();

        vm.startPrank(chidi);
        registry.register("chidi");
        usdc.mint(address(chidi), 1000e6);
        vm.stopPrank();
    }

    function _expiry() internal view returns (uint256) {
        return block.timestamp + 7 days;
    }

    // ---------------------------------------------------------------- registry

    function test_RegisterAndResolve() public {
        assertEq(registry.resolve("adaeze"), adaeze);
        assertEq(keccak256(bytes(registry.usernameOf(adaeze))), keccak256("adaeze"));
    }

    function test_ResolveIsCaseInsensitive() public {
        assertEq(registry.resolve("ADAEZE"), adaeze);
        assertEq(registry.resolve("AdAeZe"), adaeze);
    }

    function test_CannotClaimTakenUsername() public {
        vm.prank(chidi);
        vm.expectRevert(abi.encodeWithSelector(UsernameRegistry.UsernameTaken.selector, "adaeze"));
        registry.register("adaeze");
    }

    function test_RejectsShortAndLongNames() public {
        vm.startPrank(bolu);
        vm.expectRevert(abi.encodeWithSelector(UsernameRegistry.InvalidUsername.selector, "ab"));
        registry.register("ab");

        bytes memory long36 = new bytes(36);
        for (uint256 i; i < 36; i++) long36[i] = "a";
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.InvalidUsername.selector, string(long36))
        );
        registry.register(string(long36));
        vm.stopPrank();
    }

    function test_RejectsDotsAndDashes() public {
        vm.startPrank(bolu);
        vm.expectRevert(abi.encodeWithSelector(UsernameRegistry.InvalidUsername.selector, "a.b"));
        registry.register("a.b");
        vm.expectRevert(abi.encodeWithSelector(UsernameRegistry.InvalidUsername.selector, "a-b"));
        registry.register("a-b");
        vm.stopPrank();
    }

    function test_OneNamePerAddress() public {
        vm.prank(chidi);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.AddressAlreadyHasUsername.selector, chidi, "chidi")
        );
        registry.register("second");
    }

    function test_TransferUsername() public {
        vm.prank(chidi);
        registry.transferUsername(bolu);
        assertEq(registry.resolve("chidi"), bolu);
        assertEq(bytes(registry.usernameOf(chidi)).length, 0);
    }

    // ---------------------------------------------------------------- request

    function test_RequestEscrowsUsdc() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), true);
        vm.stopPrank();

        PaymentRequest.Request memory r = requests.getRequest(id);
        assertEq(r.amount, TEN);
        assertEq(r.requester, chidi);
        assertEq(r.recipient, adaeze);
        assertEq(uint8(r.status), uint8(PaymentRequest.Status.Pending));
        assertEq(usdc.balanceOf(address(requests)), TEN);
    }

    function test_OneClickReleaseSendsFunds() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), true);
        vm.stopPrank();

        uint256 before = usdc.balanceOf(adaeze);

        // anyone can trigger when autoRelease is set — that is the "one click"
        vm.prank(mallory);
        requests.release(id);

        assertEq(usdc.balanceOf(adaeze), before + TEN);
        assertEq(uint8(requests.getRequest(id).status), uint8(PaymentRequest.Status.Released));
        assertEq(usdc.balanceOf(address(requests)), 0);
    }

    function test_ManualModeOnlyRecipientCanRelease() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), false);
        vm.stopPrank();

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, mallory));
        requests.release(id);

        vm.prank(adaeze);
        requests.release(id);
        assertEq(uint8(requests.getRequest(id).status), uint8(PaymentRequest.Status.Released));
    }

    function test_RequestCanBeCancelled() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), true);

        uint256 before = usdc.balanceOf(chidi);
        requests.cancel(id);
        assertEq(usdc.balanceOf(chidi), before + TEN);
        assertEq(uint8(requests.getRequest(id).status), uint8(PaymentRequest.Status.Cancelled));
        vm.stopPrank();
    }

    function test_ThirdPartyCannotCancel() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), true);
        vm.stopPrank();

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.NotRequester.selector, id, mallory));
        requests.cancel(id);
    }

    function test_CannotReleaseTwice() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), true);
        vm.stopPrank();

        requests.release(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentRequest.InvalidStatus.selector, id, PaymentRequest.Status.Released
            )
        );
        requests.release(id);
    }

    function test_CannotReleaseUnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.RequestNotFound.selector, 99));
        requests.release(99);
    }

    function test_ExpiredRequestCannotBeReleased() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, block.timestamp + 1 hours, true);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.ExpiryPassed.selector, id));
        requests.release(id);
    }

    function test_ExpiredRequestCanBeRefunded() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, block.timestamp + 1 hours, true);
        vm.stopPrank();

        vm.warp(block.timestamp + 2 hours);
        requests.refundExpired(id);
        assertEq(uint8(requests.getRequest(id).status), uint8(PaymentRequest.Status.Refunded));
        assertEq(usdc.balanceOf(address(requests)), 0);
    }

    function test_RejectsUnknownUsername() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.UnknownUsername.selector, "nobody"));
        requests.requestFor("nobody", "x", TEN, _expiry(), true);
        vm.stopPrank();
    }

    function test_RejectsZeroAmount() public {
        vm.prank(chidi);
        vm.expectRevert(PaymentRequest.ZeroAmount.selector);
        requests.requestFor("adaeze", "x", 0, _expiry(), true);
    }

    function test_RejectsEmptyPurpose() public {
        vm.prank(chidi);
        vm.expectRevert(PaymentRequest.PurposeTooLong.selector);
        requests.requestFor("adaeze", "", TEN, _expiry(), true);
    }

    function test_RejectsOverlongPurpose() public {
        bytes memory long141 = new bytes(141);
        for (uint256 i; i < 141; i++) long141[i] = "x";
        vm.prank(chidi);
        vm.expectRevert(PaymentRequest.PurposeTooLong.selector);
        requests.requestFor("adaeze", string(long141), TEN, _expiry(), true);
    }

    function test_RejectsExpiryTooFarOut() public {
        vm.prank(chidi);
        vm.expectRevert(PaymentRequest.ExpiryTooLong.selector);
        requests.requestFor("adaeze", "x", TEN, block.timestamp + 31 days, true);
    }

    /// @dev Funds held for a pending request must never be spendable by anyone
    ///      else, and must be accounted for.
    function test_OutstandingTracksPendingOnly() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN * 2);
        uint256 a = requests.requestFor("adaeze", "a", TEN, _expiry(), true);
        uint256 b = requests.requestFor("adaeze", "b", TEN, _expiry(), true);
        vm.stopPrank();

        assertEq(requests.outstanding(), TEN * 2);

        requests.release(a);
        assertEq(requests.outstanding(), TEN);

        vm.prank(chidi);
        requests.cancel(b);
        assertEq(requests.outstanding(), 0);
        assertEq(usdc.balanceOf(address(requests)), 0);
    }

    function test_InboxAndOutboxTrackRequests() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN * 2);
        uint256 a = requests.requestFor("adaeze", "a", TEN, _expiry(), true);
        uint256 b = requests.requestFor("adaeze", "b", TEN, _expiry(), true);
        vm.stopPrank();

        uint256[] memory in_ = requests.inbox(adaeze);
        assertEq(in_.length, 2);
        assertEq(in_[0], a);
        assertEq(in_[1], b);

        uint256[] memory out_ = requests.outbox(chidi);
        assertEq(out_.length, 2);
    }

    /// @dev A released request must not be releasable again even if the
    ///      recipient address is later reused.
    function test_UsernameTransferDoesNotStealEscrow() public {
        vm.startPrank(chidi);
        usdc.approve(address(requests), TEN);
        uint256 id = requests.requestFor("adaeze", "groceries", TEN, _expiry(), true);
        vm.stopPrank();

        // adaeze hands the name to bolu
        vm.prank(adaeze);
        registry.transferUsername(bolu);

        // the escrow still belongs to the recorded recipient, not the new name
        uint256 adaezeBefore = usdc.balanceOf(adaeze);
        uint256 boluBefore = usdc.balanceOf(bolu);
        requests.release(id);
        assertEq(usdc.balanceOf(adaeze), adaezeBefore + TEN);
        assertEq(usdc.balanceOf(bolu), boluBefore);
    }
}
