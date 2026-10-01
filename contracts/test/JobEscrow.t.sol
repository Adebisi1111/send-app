// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {JobEscrow} from "../JobEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract JobEscrowTest is Test {
    // ─── Actors ────────────────────────────────────────────────────────────────
    address internal client   = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal stranger = makeAddr("stranger");

    // ─── Constants ─────────────────────────────────────────────────────────────
    uint256 internal constant BUDGET        = 500e6;   // 500 USDC (6 dec)
    uint256 internal constant CLIENT_FUNDS  = 1_000e6; // seed balance for client
    string  internal constant DESC          = "Build a landing page";
    bytes32 internal constant DELIVERABLE   = keccak256("ipfs://QmDeliverable");

    // ─── State ─────────────────────────────────────────────────────────────────
    MockERC20  internal usdc;
    JobEscrow  internal escrow;

    // ─── Helpers ───────────────────────────────────────────────────────────────

    /// @dev Returns block.timestamp + 1 day — a valid future expiry.
    function _futureExpiry() internal view returns (uint256) {
        return block.timestamp + 1 days;
    }

    /// @dev Creates a job as `client` and returns its jobId.
    function _createJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(provider, BUDGET, _futureExpiry(), DESC);
    }

    /// @dev Creates and funds a job as `client`. Returns jobId.
    function _createAndFundJob() internal returns (uint256 jobId) {
        jobId = _createJob();
        vm.prank(client);
        escrow.fund(jobId);
    }

    /// @dev Creates, funds and submits a job. Returns jobId.
    function _createFundAndSubmitJob() internal returns (uint256 jobId) {
        jobId = _createAndFundJob();
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);
    }

    // ─── setUp ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // Deploy mock USDC and the escrow contract.
        usdc   = new MockERC20("Mock USDC", "mUSDC", 6);
        escrow = new JobEscrow(address(usdc));

        // Seed the client with USDC and approve the escrow to pull funds.
        usdc.mint(client, CLIENT_FUNDS);
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  1. Deployment / Initialization
    // ══════════════════════════════════════════════════════════════════════════

    function test_Constructor_SetsUsdcAddress() public {
        assertEq(address(escrow.usdc()), address(usdc));
    }

    function test_Constructor_RevertsOnZeroAddress() public {
        vm.expectRevert(JobEscrow.JobEscrow__ZeroAddress.selector);
        new JobEscrow(address(0));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  2. createJob — happy path & reverts
    // ══════════════════════════════════════════════════════════════════════════

    function test_CreateJob_HappyPath() public {
        uint256 expiry = _futureExpiry();
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, BUDGET, expiry, DESC);

        assertEq(jobId, 1, "first job id should be 1");

        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.id,          jobId);
        assertEq(job.client,      client);
        assertEq(job.provider,    provider);
        assertEq(job.budget,      BUDGET);
        assertEq(job.expiresAt,   expiry);
        assertEq(job.description, DESC);
        assertEq(uint8(job.status), uint8(JobEscrow.JobStatus.Open));
        assertEq(job.deliverableHash, bytes32(0));
    }

    function test_CreateJob_EmitsJobCreated() public {
        uint256 expiry = _futureExpiry();
        // All three indexed topics + data must match.
        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobEscrow.JobCreated(1, client, provider, BUDGET, expiry);
        vm.prank(client);
        escrow.createJob(provider, BUDGET, expiry, DESC);
    }

    function test_CreateJob_TracksClientAndProviderJobs() public {
        uint256 jobId = _createJob();

        uint256[] memory clientJobs   = escrow.getClientJobs(client);
        uint256[] memory providerJobs = escrow.getProviderJobs(provider);

        assertEq(clientJobs.length,   1);
        assertEq(clientJobs[0],       jobId);
        assertEq(providerJobs.length, 1);
        assertEq(providerJobs[0],     jobId);
    }

    function test_CreateJob_RevertsZeroBudget() public {
        vm.prank(client);
        vm.expectRevert(JobEscrow.JobEscrow__InvalidBudget.selector);
        escrow.createJob(provider, 0, _futureExpiry(), DESC);
    }

    function test_CreateJob_RevertsPastExpiry() public {
        // expiresAt == block.timestamp should revert (strictly <=).
        vm.prank(client);
        vm.expectRevert(JobEscrow.JobEscrow__InvalidExpiry.selector);
        escrow.createJob(provider, BUDGET, block.timestamp, DESC);
    }

    function test_CreateJob_RevertsZeroAddressProvider() public {
        vm.prank(client);
        vm.expectRevert(JobEscrow.JobEscrow__ZeroAddress.selector);
        escrow.createJob(address(0), BUDGET, _futureExpiry(), DESC);
    }

    function test_CreateJob_IncrementingIds() public {
        vm.startPrank(client);
        uint256 id1 = escrow.createJob(provider, BUDGET, _futureExpiry(), "job 1");
        uint256 id2 = escrow.createJob(provider, BUDGET, _futureExpiry(), "job 2");
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  3. fund — happy path & reverts
    // ══════════════════════════════════════════════════════════════════════════

    function test_Fund_HappyPath() public {
        uint256 jobId = _createJob();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 escrowBefore = usdc.balanceOf(address(escrow));

        vm.prank(client);
        escrow.fund(jobId);

        assertEq(usdc.balanceOf(client),         clientBefore - BUDGET, "client balance decreased");
        assertEq(usdc.balanceOf(address(escrow)), escrowBefore + BUDGET, "escrow balance increased");

        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(uint8(job.status), uint8(JobEscrow.JobStatus.Funded));
    }

    function test_Fund_EmitsJobFunded() public {
        uint256 jobId = _createJob();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobEscrow.JobFunded(jobId, client, BUDGET);
        vm.prank(client);
        escrow.fund(jobId);
    }

    function test_Fund_RevertsDoubleFund() public {
        // Test case 4: calling fund() twice reverts.
        uint256 jobId = _createJob();
        vm.prank(client);
        escrow.fund(jobId);

        // Second fund should revert: status is now Funded, not Open.
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.JobEscrow__InvalidStatus.selector,
                jobId,
                JobEscrow.JobStatus.Funded,
                JobEscrow.JobStatus.Open
            )
        );
        escrow.fund(jobId);
    }

    function test_Fund_RevertsAfterExpiry() public {
        // Test case 7: fund() reverts when block.timestamp >= expiresAt.
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, BUDGET, expiry, DESC);

        // Warp past the expiry.
        vm.warp(expiry);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__JobExpired.selector, jobId)
        );
        escrow.fund(jobId);
    }

    function test_Fund_RevertsIfNonClient() public {
        uint256 jobId = _createJob();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__NotClient.selector, jobId)
        );
        escrow.fund(jobId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  4. submit — happy path & reverts
    // ══════════════════════════════════════════════════════════════════════════

    function test_Submit_HappyPath() public {
        uint256 jobId = _createAndFundJob();

        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);

        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(uint8(job.status),    uint8(JobEscrow.JobStatus.Submitted));
        assertEq(job.deliverableHash,  DELIVERABLE);
    }

    function test_Submit_EmitsJobSubmitted() public {
        uint256 jobId = _createAndFundJob();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobEscrow.JobSubmitted(jobId, provider, DELIVERABLE);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);
    }

    function test_Submit_RevertsIfNonProvider() public {
        // Test case 5.
        uint256 jobId = _createAndFundJob();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__NotProvider.selector, jobId)
        );
        escrow.submit(jobId, DELIVERABLE);
    }

    function test_Submit_RevertsIfNotFunded() public {
        // Cannot submit an Open job (not yet funded).
        uint256 jobId = _createJob();

        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.JobEscrow__InvalidStatus.selector,
                jobId,
                JobEscrow.JobStatus.Open,
                JobEscrow.JobStatus.Funded
            )
        );
        escrow.submit(jobId, DELIVERABLE);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  5. complete — happy path & reverts
    // ══════════════════════════════════════════════════════════════════════════

    function test_Complete_HappyPath() public {
        // Test case 1: createJob -> fund -> submit -> complete.
        uint256 jobId = _createFundAndSubmitJob();

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 escrowBefore   = usdc.balanceOf(address(escrow));

        vm.prank(client);
        escrow.complete(jobId);

        assertEq(usdc.balanceOf(provider),        providerBefore + BUDGET, "provider received BUDGET");
        assertEq(usdc.balanceOf(address(escrow)),  escrowBefore - BUDGET,  "escrow released BUDGET");

        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(uint8(job.status), uint8(JobEscrow.JobStatus.Completed));
    }

    function test_Complete_EmitsJobCompleted() public {
        // Test case 12 (JobCompleted event).
        uint256 jobId = _createFundAndSubmitJob();

        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobEscrow.JobCompleted(jobId, client, provider, BUDGET);
        vm.prank(client);
        escrow.complete(jobId);
    }

    function test_Complete_RevertsIfNonClient() public {
        // Test case 6.
        uint256 jobId = _createFundAndSubmitJob();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__NotClient.selector, jobId)
        );
        escrow.complete(jobId);
    }

    function test_Complete_RevertsIfNotSubmitted() public {
        // Cannot complete a job that is still Funded (not yet submitted).
        uint256 jobId = _createAndFundJob();

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.JobEscrow__InvalidStatus.selector,
                jobId,
                JobEscrow.JobStatus.Funded,
                JobEscrow.JobStatus.Submitted
            )
        );
        escrow.complete(jobId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  6. cancel — happy path (Open & Funded) & reverts
    // ══════════════════════════════════════════════════════════════════════════

    function test_Cancel_OpenState_NoUsdcMovement() public {
        // Test case 3: cancel in Open state — no USDC transferred.
        uint256 jobId = _createJob();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 escrowBefore = usdc.balanceOf(address(escrow));

        vm.prank(client);
        escrow.cancel(jobId);

        assertEq(usdc.balanceOf(client),          clientBefore, "no USDC movement for client");
        assertEq(usdc.balanceOf(address(escrow)),  escrowBefore, "no USDC movement for escrow");

        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(uint8(job.status), uint8(JobEscrow.JobStatus.Cancelled));
    }

    function test_Cancel_OpenState_EmitsJobCancelled() public {
        uint256 jobId = _createJob();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobEscrow.JobCancelled(jobId, client, 0);
        vm.prank(client);
        escrow.cancel(jobId);
    }

    function test_Cancel_FundedState_RefundsClient() public {
        // Test case 2: cancel after funding — USDC returned to client.
        uint256 jobId = _createAndFundJob();

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 escrowBefore = usdc.balanceOf(address(escrow));

        vm.prank(client);
        escrow.cancel(jobId);

        assertEq(usdc.balanceOf(client),          clientBefore + BUDGET, "client refunded BUDGET");
        assertEq(usdc.balanceOf(address(escrow)),  escrowBefore - BUDGET, "escrow released BUDGET");

        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(uint8(job.status), uint8(JobEscrow.JobStatus.Cancelled));
    }

    function test_Cancel_FundedState_EmitsJobCancelled() public {
        uint256 jobId = _createAndFundJob();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobEscrow.JobCancelled(jobId, client, BUDGET);
        vm.prank(client);
        escrow.cancel(jobId);
    }

    function test_Cancel_RevertsAfterSubmit() public {
        // Test case 11: cannot cancel once Submitted.
        uint256 jobId = _createFundAndSubmitJob();

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.JobEscrow__InvalidStatus.selector,
                jobId,
                JobEscrow.JobStatus.Submitted,
                JobEscrow.JobStatus.Open
            )
        );
        escrow.cancel(jobId);
    }

    function test_Cancel_RevertsIfNonClient() public {
        uint256 jobId = _createJob();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__NotClient.selector, jobId)
        );
        escrow.cancel(jobId);
    }

    function test_Cancel_RevertsAfterCompleted() public {
        uint256 jobId = _createFundAndSubmitJob();
        vm.prank(client);
        escrow.complete(jobId);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.JobEscrow__InvalidStatus.selector,
                jobId,
                JobEscrow.JobStatus.Completed,
                JobEscrow.JobStatus.Open
            )
        );
        escrow.cancel(jobId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  7. getJob — not-found revert
    // ══════════════════════════════════════════════════════════════════════════

    function test_GetJob_RevertsOnMissingId() public {
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__JobNotFound.selector, 999)
        );
        escrow.getJob(999);
    }

    function test_GetJob_RevertsOnIdZero() public {
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__JobNotFound.selector, 0)
        );
        escrow.getJob(0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  8. timeoutRefund — recovery path for stuck Submitted jobs
    // ══════════════════════════════════════════════════════════════════════════

    function test_TimeoutRefund_HappyPath() public {
        // Create a job with a short expiry, fund, submit, warp past expiry, then timeout-refund.
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, BUDGET, expiry, DESC);
        vm.prank(client);
        escrow.fund(jobId);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);

        // Warp past expiry.
        vm.warp(expiry + 1);

        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(client);
        escrow.timeoutRefund(jobId);

        assertEq(usdc.balanceOf(client), clientBefore + BUDGET, "client refunded on timeout");
        assertEq(uint8(escrow.getJob(jobId).status), uint8(JobEscrow.JobStatus.Cancelled));
    }

    function test_TimeoutRefund_EmitsJobTimedOut() public {
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, BUDGET, expiry, DESC);
        vm.prank(client);
        escrow.fund(jobId);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);
        vm.warp(expiry + 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobEscrow.JobTimedOut(jobId, client, BUDGET);
        vm.prank(client);
        escrow.timeoutRefund(jobId);
    }

    function test_TimeoutRefund_RevertsBeforeExpiry() public {
        uint256 jobId = _createFundAndSubmitJob();

        // expiresAt is _futureExpiry() = now + 1 day; do NOT warp.
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__NotExpiredYet.selector, jobId)
        );
        escrow.timeoutRefund(jobId);
    }

    function test_TimeoutRefund_RevertsIfNonClient() public {
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, BUDGET, expiry, DESC);
        vm.prank(client);
        escrow.fund(jobId);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);
        vm.warp(expiry + 1);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.JobEscrow__NotClient.selector, jobId)
        );
        escrow.timeoutRefund(jobId);
    }

    function test_TimeoutRefund_RevertsIfNotSubmitted() public {
        // Can only timeout-refund a Submitted job; Funded should revert.
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, BUDGET, expiry, DESC);
        vm.prank(client);
        escrow.fund(jobId);
        vm.warp(expiry + 1);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.JobEscrow__InvalidStatus.selector,
                jobId,
                JobEscrow.JobStatus.Funded,
                JobEscrow.JobStatus.Submitted
            )
        );
        escrow.timeoutRefund(jobId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  9. Fuzz tests
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Fuzzes budget values to ensure any valid non-zero budget is accepted.
    function testFuzz_CreateJob_AnyValidBudget(uint128 rawBudget) public {
        uint256 budget = bound(uint256(rawBudget), 1, type(uint128).max);
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, budget, _futureExpiry(), DESC);
        JobEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.budget, budget);
    }

    /// @dev Fuzzes expiry: anything <= block.timestamp must revert.
    function testFuzz_CreateJob_PastOrPresentExpiryReverts(uint256 expiry) public {
        expiry = bound(expiry, 0, block.timestamp);
        vm.prank(client);
        vm.expectRevert(JobEscrow.JobEscrow__InvalidExpiry.selector);
        escrow.createJob(provider, BUDGET, expiry, DESC);
    }

    /// @dev Full happy-path flow for any valid fuzzed budget (funds the client accordingly).
    function testFuzz_FullHappyPath(uint64 rawBudget) public {
        uint256 budget = bound(uint256(rawBudget), 1, type(uint64).max);

        // Give client exactly the fuzzed budget.
        usdc.mint(client, budget);
        vm.prank(client);
        usdc.approve(address(escrow), budget);

        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, budget, _futureExpiry(), DESC);
        vm.prank(client);
        escrow.fund(jobId);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE);

        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.complete(jobId);

        assertEq(usdc.balanceOf(provider), providerBefore + budget, "provider received budget");
    }
}
