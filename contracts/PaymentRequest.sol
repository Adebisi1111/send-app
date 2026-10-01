// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UsernameRegistry} from "./UsernameRegistry.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PaymentRequest
/// @notice Someone asks for USDC by username, stating what it is for. The
///         payer funds the request up front, so the recipient can release it
///         with a single click — no further approval needed, and no chasing.
///
/// @dev Flow:
///   1. Recipient calls `request{value: amount}(username, purpose, expiry)`,
///      paying USDC in. The money is held by this contract, keyed to the request.
///   2. Payer calls `release(id)` to send the funds to the recipient's address.
///      Anyone may call `release` once `autoRelease` is set, which is what makes
///      the "one click" work from a link or a QR code.
///   3. Payer calls `cancel(id)` to take the money back before release.
///
/// The requester's USDC is escrowed in this contract, not in the username
/// registry, so a compromised name cannot drain a balance.
contract PaymentRequest {
    /// @notice Lifecycle of a request.
    enum Status {
        None,
        Pending,
        Released,
        Cancelled,
        Refunded
    }

    /// @notice USDC has 6 decimals on Arc.
    uint256 public constant USDC_DECIMALS = 6;

    /// @notice Everything needed to show and settle a request.
    struct Request {
        address requester;   // who asked for the money
        address recipient;   // username owner, resolved at request time
        string username;     // normalised, for display
        string purpose;      // what the money is for
        uint256 amount;      // 6dp USDC
        uint64 expiresAt;    // unix seconds
        Status status;
        bool autoRelease;    // allow anyone to trigger the send
    }

    /// @notice USDC token, passed in at construction.
    IERC20 public immutable usdc;

    /// @notice Username -> address lookup, shared with the frontend.
    UsernameRegistry public immutable registry;

    uint256 private _nextId = 1;

    /// @notice request id => request
    mapping(uint256 => Request) private _requests;

    /// @notice recipient address => ids they can release
    mapping(address => uint256[]) private _inbox;
    /// @notice requester address => ids they can cancel
    mapping(address => uint256[]) private _outbox;
    /// @notice request id => index in _inbox
    mapping(uint256 => uint256) private _inboxIndex;
    /// @notice request id => index in _outbox
    mapping(uint256 => uint256) private _outboxIndex;

    /// @notice Emitted when a request is funded and awaiting release.
    event RequestCreated(
        uint256 indexed id,
        address indexed requester,
        address indexed recipient,
        string username,
        string purpose,
        uint256 amount,
        uint64 expiresAt,
        bool autoRelease
    );
    /// @notice Emitted when funds are sent to the recipient.
    event Released(uint256 indexed id, address indexed to, uint256 amount);
    /// @notice Emitted when the requester takes the money back.
    event Cancelled(uint256 indexed id, address indexed to, uint256 amount);
    /// @notice Emitted when an expired pending request is refunded.
    event Refunded(uint256 indexed id, address indexed to, uint256 amount);

    error RequestNotFound(uint256 id);
    error InvalidStatus(uint256 id, Status current);
    error NotRequester(uint256 id, address caller);
    error ZeroAddress();
    error ZeroAmount();
    error PurposeTooLong();
    error ExpiryTooLong();
    error UnknownUsername(string username);
    error ExpiryPassed(uint256 id);
    error TransferFailed();

    constructor(address usdcToken, address registry_) {
        if (usdcToken == address(0) || registry_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
        registry = UsernameRegistry(registry_);
    }

    /// @notice Create a request for a specific amount. The caller must have
    ///         approved this contract and the USDC is pulled in explicitly.
    function requestFor(
        string calldata username,
        string calldata purpose,
        uint256 amount,
        uint256 expiry,
        bool autoRelease
    ) external returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (bytes(purpose).length == 0 || bytes(purpose).length > 140) revert PurposeTooLong();
        if (expiry <= block.timestamp || expiry > block.timestamp + 30 days) {
            revert ExpiryTooLong();
        }

        address recipient = registry.resolve(username);
        if (recipient == address(0)) revert UnknownUsername(username);

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        id = _nextId++;
        _requests[id] = Request({
            requester: msg.sender,
            recipient: recipient,
            username: registry.normalise(username),
            purpose: purpose,
            amount: amount,
            expiresAt: uint64(expiry),
            status: Status.Pending,
            autoRelease: autoRelease
        });

        _push(_inbox, _inboxIndex, recipient, id);
        _push(_outbox, _outboxIndex, msg.sender, id);

        emit RequestCreated(
            id, msg.sender, recipient, _requests[id].username, purpose,
            amount, uint64(expiry), autoRelease
        );
    }

    /// @notice Send the escrowed USDC to the recipient. One click.
    /// @dev Callable by the recipient always, and by anyone when autoRelease is
    ///      set — that is what lets a link or QR code trigger the payout.
    function release(uint256 id) external {
        if (id == 0 || id >= _nextId) revert RequestNotFound(id);
        Request storage r = _requests[id];
        if (r.status != Status.Pending) revert InvalidStatus(id, r.status);
        if (!r.autoRelease && msg.sender != r.recipient) revert NotRequester(id, msg.sender);
        if (block.timestamp >= r.expiresAt) revert ExpiryPassed(id);

        r.status = Status.Released;
        if (!usdc.transfer(r.recipient, r.amount)) revert TransferFailed();

        emit Released(id, r.recipient, r.amount);
    }

    /// @notice Take the money back. Only the requester, only while pending.
    function cancel(uint256 id) external {
        if (id == 0 || id >= _nextId) revert RequestNotFound(id);
        Request storage r = _requests[id];
        if (r.status != Status.Pending) revert InvalidStatus(id, r.status);
        if (msg.sender != r.requester) revert NotRequester(id, msg.sender);

        r.status = Status.Cancelled;
        if (!usdc.transfer(msg.sender, r.amount)) revert TransferFailed();

        emit Cancelled(id, msg.sender, r.amount);
    }

    /// @notice Refund a request that was never released and has expired, so
    ///         escrowed funds cannot sit here forever.
    function refundExpired(uint256 id) external {
        if (id == 0 || id >= _nextId) revert RequestNotFound(id);
        Request storage r = _requests[id];
        if (r.status != Status.Pending) revert InvalidStatus(id, r.status);
        if (block.timestamp < r.expiresAt) revert ExpiryPassed(id);

        r.status = Status.Refunded;
        if (!usdc.transfer(r.requester, r.amount)) revert TransferFailed();

        emit Refunded(id, r.requester, r.amount);
    }

    /// @notice Full record for a request.
    function getRequest(uint256 id) external view returns (Request memory) {
        if (id == 0 || id >= _nextId) revert RequestNotFound(id);
        return _requests[id];
    }

    /// @notice Request ids where this address is the recipient.
    function inbox(address account) external view returns (uint256[] memory) {
        return _inbox[account];
    }

    /// @notice Request ids where this address is the requester.
    function outbox(address account) external view returns (uint256[] memory) {
        return _outbox[account];
    }

    /// @notice USDC currently held across all pending requests.
    function outstanding() external view returns (uint256) {
        return _totalOutstanding();
    }

    function _totalOutstanding() private view returns (uint256 total) {
        for (uint256 i = 1; i < _nextId; i++) {
            if (_requests[i].status == Status.Pending) total += _requests[i].amount;
        }
    }

    function _push(
        mapping(address => uint256[]) storage list,
        mapping(uint256 => uint256) storage index,
        address account,
        uint256 id
    ) private {
        list[account].push(id);
        index[id] = list[account].length - 1;
    }
}
