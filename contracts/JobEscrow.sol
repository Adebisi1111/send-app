// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract JobEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Cancelled
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        uint256 budget;
        uint256 expiresAt;
        string description;
        JobStatus status;
        bytes32 deliverableHash;
    }

    error JobEscrow__ZeroAddress();
    error JobEscrow__InvalidBudget();
    error JobEscrow__InvalidExpiry();
    error JobEscrow__JobNotFound(uint256 jobId);
    error JobEscrow__InvalidStatus(uint256 jobId, JobStatus current, JobStatus required);
    error JobEscrow__NotClient(uint256 jobId);
    error JobEscrow__NotProvider(uint256 jobId);
    error JobEscrow__JobExpired(uint256 jobId);
    error JobEscrow__NotExpiredYet(uint256 jobId);

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        uint256 budget,
        uint256 expiresAt
    );
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 budget);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverableHash);
    event JobCompleted(uint256 indexed jobId, address indexed client, address indexed provider, uint256 budget);
    event JobCancelled(uint256 indexed jobId, address indexed client, uint256 refund);
    event JobTimedOut(uint256 indexed jobId, address indexed client, uint256 refund);

    IERC20 public immutable usdc;
    uint256 private _nextJobId = 1;

    mapping(uint256 => Job) private _jobs;
    mapping(address => uint256[]) private _clientJobs;
    mapping(address => uint256[]) private _providerJobs;

    /// @notice Initializes the escrow with the ERC-20 token used for settlement.
    /// @param usdcToken Address of the USDC token contract.
    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert JobEscrow__ZeroAddress();
        usdc = IERC20(usdcToken);
    }

    /// @notice Creates a new job escrow request.
    /// @param provider Address of the service provider assigned to the job.
    /// @param budget Job budget denominated in 6-decimal USDC units.
    /// @param expiresAt Unix timestamp after which funding is no longer allowed.
    /// @param description Human-readable description of the job.
    /// @return jobId Newly created job identifier.
    function createJob(
        address provider,
        uint256 budget,
        uint256 expiresAt,
        string calldata description
    ) external returns (uint256 jobId) {
        if (provider == address(0)) revert JobEscrow__ZeroAddress();
        if (budget == 0) revert JobEscrow__InvalidBudget();
        if (expiresAt <= block.timestamp) revert JobEscrow__InvalidExpiry();

        jobId = _nextJobId;
        _nextJobId = jobId + 1;

        _jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            budget: budget,
            expiresAt: expiresAt,
            description: description,
            status: JobStatus.Open,
            deliverableHash: bytes32(0)
        });

        _clientJobs[msg.sender].push(jobId);
        _providerJobs[provider].push(jobId);

        emit JobCreated(jobId, msg.sender, provider, budget, expiresAt);
    }

    /// @notice Funds a job escrow by transferring the budget from the client.
    /// @param jobId Identifier of the job to fund.
    function fund(uint256 jobId) external nonReentrant {
        _requireJobExists(jobId);
        Job storage job = _jobs[jobId];

        if (msg.sender != job.client) revert JobEscrow__NotClient(jobId);
        if (job.status != JobStatus.Open) revert JobEscrow__InvalidStatus(jobId, job.status, JobStatus.Open);
        if (block.timestamp >= job.expiresAt) revert JobEscrow__JobExpired(jobId);

        job.status = JobStatus.Funded;

        usdc.safeTransferFrom(msg.sender, address(this), job.budget);

        emit JobFunded(jobId, msg.sender, job.budget);
    }

    /// @notice Submits a deliverable for a funded job.
    /// @param jobId Identifier of the job being submitted.
    /// @param deliverableHash Content hash of the submitted deliverable.
    function submit(uint256 jobId, bytes32 deliverableHash) external {
        _requireJobExists(jobId);
        Job storage job = _jobs[jobId];

        if (msg.sender != job.provider) revert JobEscrow__NotProvider(jobId);
        if (job.status != JobStatus.Funded) revert JobEscrow__InvalidStatus(jobId, job.status, JobStatus.Funded);

        job.deliverableHash = deliverableHash;
        job.status = JobStatus.Submitted;

        emit JobSubmitted(jobId, msg.sender, deliverableHash);
    }

    /// @notice Completes a submitted job and releases escrowed funds to the provider.
    /// @param jobId Identifier of the job to complete.
    function complete(uint256 jobId) external nonReentrant {
        _requireJobExists(jobId);
        Job storage job = _jobs[jobId];

        if (msg.sender != job.client) revert JobEscrow__NotClient(jobId);
        if (job.status != JobStatus.Submitted) {
            revert JobEscrow__InvalidStatus(jobId, job.status, JobStatus.Submitted);
        }

        address provider = job.provider;
        uint256 budget = job.budget;
        job.status = JobStatus.Completed;

        usdc.safeTransfer(provider, budget);

        emit JobCompleted(jobId, msg.sender, provider, budget);
    }

    /// @notice Cancels an open or funded job.
    /// @param jobId Identifier of the job to cancel.
    function cancel(uint256 jobId) external nonReentrant {
        _requireJobExists(jobId);
        Job storage job = _jobs[jobId];

        if (msg.sender != job.client) revert JobEscrow__NotClient(jobId);
        if (job.status != JobStatus.Open && job.status != JobStatus.Funded) {
            revert JobEscrow__InvalidStatus(jobId, job.status, JobStatus.Open);
        }

        uint256 refund = 0;
        if (job.status == JobStatus.Funded) {
            refund = job.budget;
        }

        address client = job.client;
        job.status = JobStatus.Cancelled;

        if (refund != 0) {
            usdc.safeTransfer(client, refund);
        }

        emit JobCancelled(jobId, msg.sender, refund);
    }

    /// @notice Allows the client to reclaim escrowed funds from a Submitted job after it has expired.
    /// @dev Recovery path against a permanently-stuck escrow when the provider cannot receive USDC
    ///      (e.g. blocklisted). Only callable after `expiresAt` has passed.
    /// @param jobId Identifier of the job to time out.
    function timeoutRefund(uint256 jobId) external nonReentrant {
        _requireJobExists(jobId);
        Job storage job = _jobs[jobId];

        if (msg.sender != job.client) revert JobEscrow__NotClient(jobId);
        if (job.status != JobStatus.Submitted) {
            revert JobEscrow__InvalidStatus(jobId, job.status, JobStatus.Submitted);
        }
        if (block.timestamp < job.expiresAt) revert JobEscrow__NotExpiredYet(jobId);

        uint256 refund = job.budget;
        address client = job.client;
        job.status = JobStatus.Cancelled;

        usdc.safeTransfer(client, refund);

        emit JobTimedOut(jobId, client, refund);
    }

    /// @notice Returns a job by its identifier.
    /// @param jobId Identifier of the job.
    /// @return Job data.
    function getJob(uint256 jobId) external view returns (Job memory) {
        _requireJobExists(jobId);
        return _jobs[jobId];
    }

    /// @notice Returns all job IDs created by a client.
    /// @param client Address of the client.
    /// @return Array of job IDs.
    function getClientJobs(address client) external view returns (uint256[] memory) {
        return _clientJobs[client];
    }

    /// @notice Returns all job IDs assigned to a provider.
    /// @param provider Address of the provider.
    /// @return Array of job IDs.
    function getProviderJobs(address provider) external view returns (uint256[] memory) {
        return _providerJobs[provider];
    }

    function _requireJobExists(uint256 jobId) internal view {
        if (jobId == 0 || jobId >= _nextJobId) revert JobEscrow__JobNotFound(jobId);
    }
}
