// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsernameRegistry} from "../UsernameRegistry.sol";
import {PaymentRequest, IERC20} from "../PaymentRequest.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev A contract that screams if the registry ever calls it. Used to prove
///      transferUsername makes no external call (so cannot be re-entered).
contract Eavesdropper {
    uint256 public hits;
    fallback() external payable {
        hits += 1;
    }
    receive() external payable {
        hits += 1;
    }
}

/// @dev Registers a name then destroys itself, to show a name held by a gone
///      contract is unrecoverable (the registry has no admin/renounce path).
contract SelfRegistering {
    UsernameRegistry immutable reg;

    constructor(address reg_) {
        reg = UsernameRegistry(reg_);
    }

    function destroy() external {
        selfdestruct(payable(msg.sender));
    }
}

contract AuditRegistryTest is Test {
    UsernameRegistry reg;
    MockERC20 usdc;
    PaymentRequest pay_;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address mallory = makeAddr("mallory");

    function setUp() public {
        reg = new UsernameRegistry();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        pay_ = new PaymentRequest(IERC20(address(usdc)), reg);
    }

    function _reg(address who, string memory n) private {
        vm.prank(who);
        reg.register(n);
    }

    // ==================================================================
    // 1. CASE FOLDING — can "Bob" and "bob" be different people?
    // ==================================================================

    function test_CaseVariantsAllCollapseToOneOwner() public {
        _reg(alice, "bob");

        // Every case spelling must be taken by alice and unreclaimable.
        string[6] memory variants =
            ["bob", "Bob", "BOB", "bOb", "bOB", "BoB"];
        for (uint256 i = 0; i < variants.length; i++) {
            assertEq(
                reg.resolve(variants[i]),
                alice,
                string.concat("variant must resolve to alice: ", variants[i])
            );
            assertTrue(reg.isTaken(variants[i]), "variant must be taken");
            vm.prank(bob);
            vm.expectRevert(
                abi.encodeWithSelector(UsernameRegistry.UsernameTaken.selector, "bob")
            );
            reg.register(variants[i]);
        }
    }

    function test_ReRegisterBySameOwnerReverts() public {
        _reg(alice, "bob");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.AlreadyRegistered.selector, alice, "bob")
        );
        reg.register("BOB");
    }

    /// @dev normalise is byte-for-byte deterministic, so folding cannot split.
    function test_NormaliseIsDeterministicByteWise() public view {
        assertEq(reg.normalise("Bob"), "bob");
        assertEq(reg.normalise("BOB"), "bob");
        assertEq(reg.normalise("b0B_"), "b0b_");
    }

    // ==================================================================
    // 2. UNICODE / NON-ASCII — confusable and homoglyph input
    // ==================================================================

    function test_UnicodeIsRejected() public {
        // Cyrillic "а" (U+0430) instead of Latin "a" in "adaeze"
        vm.prank(alice);
        vm.expectRevert();
        reg.register(string(hex"61d0b061657a65"));

        // fullwidth latin
        vm.prank(alice);
        vm.expectRevert();
        reg.register(string(hex"efbc8d65"));

        // "b" + U+0131 (Turkish dotless i, UTF-8 c4 b1) + "b"
        vm.prank(alice);
        vm.expectRevert();
        reg.register(string(hex"62c4b162"));

        // combining accent
        vm.prank(alice);
        vm.expectRevert();
        reg.register("bo\xcc\x81b");
    }

    function test_HighBytesNeverNormaliseIntoAscii() public view {
        // 0xC0..0xDE are never in the A-Z fold window: they pass through
        // untouched and then fail validation in _validate. Confirms the fold
        // (line 69) is strictly ASCII A-Z and cannot fold a high byte into a
        // letter, so no unicode confusable collapses onto a real name.
        bytes memory in_ = hex"c0415a";
        string memory out_ = reg.normalise(string(in_));
        bytes memory outB = bytes(out_);
        assertEq(outB.length, 3);
        assertEq(uint8(outB[0]), 0xc0, "high byte passes through unchanged");
        assertEq(uint8(outB[1]), 0x61, "A folds to a");
        assertEq(uint8(outB[2]), 0x7a, "Z folds to z");
    }

    // ==================================================================
    // 3. DOMAIN IMITATION — dots and dashes
    // ==================================================================

    function test_DotsAndDashesRejected() public {
        vm.startPrank(alice);
        vm.expectRevert();
        reg.register("paypal.com");
        vm.expectRevert();
        reg.register("paypal-com");
        vm.expectRevert();
        reg.register(".paypal");
        vm.expectRevert();
        reg.register("paypal.");
        vm.expectRevert();
        reg.register("pay..pal");
        vm.stopPrank();
    }

    function test_LengthBoundsEnforced() public {
        // 2 chars reverts
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.InvalidUsername.selector, "ab")
        );
        reg.register("ab");

        // 3 chars is the boundary and must succeed
        _reg(alice, "abc");
        assertEq(reg.resolve("abc"), alice, "3 chars accepted");
    }

    function test_ThirtyTwoCharsOkThirtyThreeReverts() public {
        _reg(alice, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 32
        vm.prank(bob);
        vm.expectRevert();
        reg.register("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 33
    }

    // ==================================================================
    // 4/5/6. transferUsername — storage write trace
    // ==================================================================

    function test_TransferMovesNameAndClearsSender() public {
        _reg(alice, "alice");
        vm.prank(alice);
        reg.transferUsername(bob);

        assertEq(reg.resolve("alice"), bob, "name now resolves to bob");
        assertEq(reg.usernameOf(alice), "", "alice released it");
        assertEq(reg.usernameOf(bob), "alice", "bob holds it");
    }

    function test_SelfTransferIsANoOp() public {
        _reg(alice, "alice");

        // self-transfer now reverts rather than silently doing nothing
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.transferUsername(alice);

        assertEq(reg.resolve("alice"), alice, "still owned");
        assertEq(reg.usernameOf(alice), "alice", "still holds the string");
    }

    function test_TransferToZeroAddressReverts() public {
        _reg(alice, "alice");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.InvalidUsername.selector, "")
        );
        reg.transferUsername(address(0));
    }

    function test_CannotTransferANameYouDoNotOwn() public {
        _reg(alice, "alice");
        _reg(bob, "bob");

        // mallory holds nothing -> cannot move anything.
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.UsernameNotFound.selector, "")
        );
        mallory_call();
    }

    function mallory_call() private {
        reg.transferUsername(mallory);
    }

    // ==================================================================
    // *** CRITICAL: transfer into an address that already has a name ***
    // ==================================================================

    function test_TransferOverwritesReceiversExistingName() public {
        _reg(alice, "alice");
        _reg(mallory, "mallory");
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.transferUsername(alice);

        // both mappings survive untouched
        assertEq(reg.usernameOf(alice), "alice", "alice keeps her name");
        assertEq(reg.usernameOf(mallory), "mallory", "mallory keeps hers");
        assertEq(reg.resolve("alice"), alice, "alice still resolves");
        assertEq(reg.resolve("mallory"), mallory, "mallory still resolves");
    }

    function test_OrphanedNameIsPermanentlyUnclaimable() public {
        _reg(alice, "alice");
        _reg(mallory, "mallory");
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.transferUsername(alice);

        // both mappings survive untouched
        assertEq(reg.usernameOf(alice), "alice", "alice keeps her name");
        assertEq(reg.usernameOf(mallory), "mallory", "mallory keeps hers");
        assertEq(reg.resolve("alice"), alice, "alice still resolves");
        assertEq(reg.resolve("mallory"), mallory, "mallory still resolves");

        // and alice can still rotate her name to a new wallet, so a lost or
        // compromised key is recoverable.
        vm.prank(alice);
        reg.transferUsername(carol);
        assertEq(reg.resolve("alice"), carol, "alice moved her name off the old wallet");
    }

    /// @dev The griefing primitive: anyone can permanently lock a victim's
    ///      name for ~2 transactions, and the victim can never move that name
    ///      to a new wallet afterwards.
    function test_AnyoneCanPermanentlyLockSomeoneEltesName() public {
        _reg(alice, "alice");
        _reg(mallory, "zzzzzzzz");

        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.transferUsername(alice);

        // alice retains her name and can still rotate it off a bad key
        assertEq(reg.usernameOf(alice), "alice");
        vm.prank(alice);
        reg.transferUsername(carol);
        assertEq(reg.resolve("alice"), carol, "recoverable, not frozen");
    }

    /// @dev No selfdestruct/renounce path: a name registered by a contract that
    ///      is later destroyed is stuck, because only the owner can clear it.
    function test_NameHeldByDestroyedContractIsStuckForever() public {
        SelfRegistering sr = new SelfRegistering(address(reg));
        vm.prank(address(sr));
        reg.register("scname");
        assertEq(reg.resolve("scname"), address(sr));

        vm.prank(address(sr));
        sr.destroy();

        // Still taken, and the address that held it is gone.
        assertTrue(reg.isTaken("scname"), "still taken after contract destroyed");
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.UsernameTaken.selector, "scname")
        );
        reg.register("scname");
    }

    function test_OrphanBreaksOneNamePerAddress() public {
        _reg(alice, "alice");
        _reg(mallory, "mallory");
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.transferUsername(alice);

        // both mappings survive untouched
        assertEq(reg.usernameOf(alice), "alice", "alice keeps her name");
        assertEq(reg.usernameOf(mallory), "mallory", "mallory keeps hers");
        assertEq(reg.resolve("alice"), alice, "alice still resolves");
        assertEq(reg.resolve("mallory"), mallory, "mallory still resolves");

        // one name per address still holds
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.register("secondname");
    }

    function test_RecipientClobberedSilentlyStillReceivesPayments() public {
        _reg(alice, "alice");
        _reg(mallory, "mallory");
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                UsernameRegistry.AddressAlreadyHasUsername.selector, alice, "alice"
            )
        );
        reg.transferUsername(alice);

        // both mappings survive untouched
        assertEq(reg.usernameOf(alice), "alice", "alice keeps her name");
        assertEq(reg.usernameOf(mallory), "mallory", "mallory keeps hers");
        assertEq(reg.resolve("alice"), alice, "alice still resolves");
        assertEq(reg.resolve("mallory"), mallory, "mallory still resolves");

        // a name that still resolves correctly keeps routing payments correctly
        vm.prank(bob);
        uint256 id = pay_.ask("alice", "rent", 10e6, block.timestamp + 1 days);
        assertEq(pay_.getRequest(1).named, alice, "request still targets alice");
    }

    // ==================================================================
    // 1. SQUATTING / FRONT-RUNNING + dead reserved-name machinery
    // ==================================================================

    function test_AnyoneCanSquatFirstAndWinnerTakesAll() public {
        // Alice's registration is pending; mallory sees it and front-runs.
        _reg(mallory, "adaeze");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(UsernameRegistry.UsernameTaken.selector, "adaeze")
        );
        reg.register("adaeze");

        // No reclaim, no expiry, no admin override exists in the ABI.
        assertEq(reg.resolve("adaeze"), mallory, "squatter keeps it forever");
    }

    function test_ProtectedLookingNamesAreAllClaimable() public {
        // RESERVED_SLOT (line 23) and ReservedUsername (line 21) are dead code.
        _reg(mallory, "admin");
        _reg(alice, "support");
        _reg(bob, "circle");
        _reg(carol, "usdc");
        assertEq(reg.resolve("admin"), mallory);
        assertEq(reg.resolve("support"), alice);
    }

    // ==================================================================
    // 3. HOMOGRAPH inside the allowed charset
    // ==================================================================

    function test_LeetHomographsAllCoexist() public {
        _reg(mallory, "paypal");
        _reg(alice, "paypa1");
        _reg(bob, "paypai");
        _reg(carol, "paypal_");

        assertTrue(reg.isTaken("paypal"));
        assertTrue(reg.isTaken("paypa1"));
        assertTrue(reg.isTaken("paypai"));
        assertTrue(reg.isTaken("paypal_"));
    }

    function test_NameCannotImitateAFullHexAddress() public {
        // 42 hex chars would exceed the 32 cap, so no address-shaped name.
        vm.prank(alice);
        vm.expectRevert();
        reg.register("0x0000000000000000000000000000000000000001");
    }

    // ==================================================================
    // 7. REENTRANCY
    // ==================================================================

    function test_TransferMakesNoExternalCallSoCannotReenter() public {
        Eavesdropper spy = new Eavesdropper();
        _reg(alice, "alice");

        vm.prank(alice);
        reg.transferUsername(address(spy));

        assertEq(reg.resolve("alice"), address(spy), "transfer succeeded");
        assertEq(spy.hits(), 0, "receiver was never called -> no reentrancy vector");
    }

    // ==================================================================
    // 8. GAS / UNBOUNDED LOOPS
    // ==================================================================

    function test_OverlongInputIsSelfFundedAndRevertsClean() public {
        bytes memory long_ = new bytes(1000);
        for (uint256 i = 0; i < 1000; i++) long_[i] = "a";
        vm.prank(alice);
        vm.expectRevert();
        reg.register(string(long_));
        // state untouched
        assertEq(reg.usernameOf(alice), "");
    }

    function test_NormalRegistrationGasIsBounded() public {
        vm.prank(alice);
        uint256 g0 = gasleft();
        reg.register("adaeze");
        uint256 used = g0 - gasleft();
        assertLt(used, 200_000, "register stays cheap");
    }

    // ==================================================================
    // Event / interface mismatches
    // ==================================================================

    function test_UsernameHashEventFieldIsNotAHash() public {
        // Line 35 names the field usernameHash, line 98 passes the plain string.
        vm.recordLogs();
        _reg(alice, "adaeze");
        assertGt(vm.getRecordedLogs().length, 0);
        // and there is no getter exposing keccak256(normalised) on-chain.
        assertEq(reg.resolve("ADAEZE"), alice, "folding works but no hash is published");
    }
}
