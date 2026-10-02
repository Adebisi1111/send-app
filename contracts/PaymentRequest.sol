// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UsernameRegistry} from "./UsernameRegistry.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PaymentRequest — ask for USDC by username, get paid on accept.
/// @notice A requester asks someone for USDC. Nothing is escrowed and no funds
///         are ever locked: the payer sends their own USDC when they accept.
///         A request is therefore free to leave and free to ignore, and there is
///         no custody risk and no balance that can be stranded.
/// @dev Two things this supports that per-to-per apps cannot:
///
///        1. Open requests. A request may name nobody, in which case anyone
///           holding the link can fulfil it. That turns "pay me back for
///           dinner" into an open, shareable claim.
///        2. Partial settlement. `pay` accepts any value up to the remaining
///           amount, so several people can chip into one request. It closes
///           only once the full amount has been collected.
contract PaymentRequest {
    enum Status {
        None,
        Open,
        Paid,
        Cancelled,
        Declined
    }

    struct Request {
        uint256 id;
        address requester; // who is owed
        address named; // who was asked; address(0) means open to anyone
        string username; // the name that was asked, or "" when open
        string purpose;
        uint256 amount; // total requested
        uint256 collected; // settled so far
        uint64 expiresAt;
        Status status;
    }

    error ZeroAmount();
    error PurposeTooLong();
    error ExpiryTooLong();
    error RequestNotFound(uint256 id);
    error InvalidStatus(uint256 id, Status status);
    error NotRequester(uint256 id, address caller);
    error SelfRequest(address caller);
    error ExpiryPassed(uint256 id);
    error UnknownUsername(string username);
    error NothingToCollect(uint256 id, uint256 remaining);
    error NothingOwed(uint256 id, uint256 collected);
    error TransferFailed();
    error NotNamedPayer(uint256 id, address caller);
    error AlreadyResponded(uint256 id);

    event RequestOpened(
        uint256 indexed id,
        address indexed requester,
        address indexed named,
        string username,
        string purpose,
        uint256 amount,
        uint64 expiresAt
    );
    /// @notice Emitted on every settlement, partial ones included.
    event Settled(
        uint256 indexed id, address indexed payer, uint256 amount, uint256 collected, uint256 total
    );
    event RequestClosed(uint256 indexed id, address indexed requester, Status status);
    /// @notice Emitted when the named payer turns a request down. No money moves.
    event RequestDeclined(uint256 indexed id, address indexed named);

    IERC20 public immutable usdc;
    UsernameRegistry public immutable usernames;

    uint256 public nextId = 1;
    uint256 public totalSettled;

    mapping(uint256 => Request) private _requests;
    /// @notice How much a given payer has put into a given request.
    mapping(uint256 => mapping(address => uint256)) public paidBy;
    /// @notice True once the named payer has accepted or declined. A decline is
    ///         final: the same payer cannot later accept.
    mapping(uint256 => mapping(address => bool)) public responded;

    /// 1-based position of each open unnamed request inside _openIds, so it can
    /// be removed in O(1) when it settles.
    mapping(uint256 => uint256) private _openPos;
    uint256[] private _openIds;
    uint256 public openUnnamedCount;

    constructor(IERC20 usdc_, UsernameRegistry usernames_) {
        usdc = usdc_;
        usernames = usernames_;
    }

    // ------------------------------------------------------------ asking

    /// @notice Ask a named person for USDC. They pay from their own wallet.
    function ask(string calldata username, string calldata purpose, uint256 amount, uint256 expiry)
        external
        returns (uint256 id)
    {
        address to = usernames.resolve(username);
        if (to == address(0)) revert UnknownUsername(username);
        if (to == msg.sender) revert SelfRequest(msg.sender);
        id = _open(msg.sender, to, username, purpose, amount, expiry);
    }

    /// @notice Leave a request open to anyone. No escrow, no counterparty.
    function askAnyone(string calldata purpose, uint256 amount, uint256 expiry)
        external
        returns (uint256 id)
    {
        id = _open(msg.sender, address(0), "", purpose, amount, expiry);
        _openIds.push(id);
        _openPos[id] = _openIds.length;
        openUnnamedCount = _openIds.length;
    }

    function _open(
        address requester,
        address named,
        string memory username,
        string memory purpose,
        uint256 amount,
        uint256 expiry
    ) private returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (bytes(purpose).length == 0 || bytes(purpose).length > 140) revert PurposeTooLong();
        if (expiry <= block.timestamp || expiry > block.timestamp + 90 days) {
            revert ExpiryTooLong();
        }

        id = nextId++;
        _requests[id] = Request({
            id: id,
            requester: requester,
            named: named,
            username: username,
            purpose: purpose,
            amount: amount,
            collected: 0,
            expiresAt: uint64(expiry),
            status: Status.Open
        });

        emit RequestOpened(id, requester, named, username, purpose, amount, uint64(expiry));
    }

    // ------------------------------------------------------------ paying

    /// @notice Pay a request in full or in part. Anyone may call this — that is
    ///         what makes an open request open, and it also lets several people
    ///         chip into the same request.
    function pay(uint256 id, uint256 amount) external {
        _pay(id, amount);
    }

    function _pay(uint256 id, uint256 amount) private {
        Request storage r = _requests[id];
        if (r.id == 0) revert RequestNotFound(id);
        if (r.status != Status.Open) revert InvalidStatus(id, r.status);
        if (block.timestamp >= r.expiresAt) revert ExpiryPassed(id);
        if (responded[id][msg.sender]) revert AlreadyResponded(id);

        uint256 left = r.amount - r.collected;
        if (amount == 0 || amount > left) revert NothingToCollect(id, left);

        r.collected += amount;
        paidBy[id][msg.sender] += amount;
        responded[id][msg.sender] = true;
        totalSettled += amount;

        if (!usdc.transferFrom(msg.sender, r.requester, amount)) revert TransferFailed();

        if (r.collected == r.amount) {
            r.status = Status.Paid;
            if (r.named == address(0)) _dropUnnamed(id);
            emit RequestClosed(id, r.requester, Status.Paid);
        }

        emit Settled(id, msg.sender, amount, r.collected, r.amount);
    }

    /// @notice Pay whatever is left on a request.
    function payRemaining(uint256 id) external returns (uint256 paid) {
        Request storage r = _requests[id];
        paid = r.amount - r.collected;
        _pay(id, paid);
    }

    /// @notice Turn a request down. Only the named payer may do this, and only
    ///         while nothing has been collected. A decline is final: it closes
    ///         the request, and `responded` stops the same payer from
    ///         reversing it later. No money moves, because nothing was held.
    function decline(uint256 id) external {
        Request storage r = _requests[id];
        if (r.id == 0) revert RequestNotFound(id);
        if (r.status != Status.Open) revert InvalidStatus(id, r.status);
        if (r.named == address(0)) revert NotNamedPayer(id, msg.sender);
        if (msg.sender != r.named) revert NotNamedPayer(id, msg.sender);
        if (r.collected > 0) revert NothingToCollect(id, r.amount - r.collected);

        responded[id][msg.sender] = true;
        r.status = Status.Declined;
        emit RequestDeclined(id, msg.sender);
    }

    // ------------------------------------------------------------ closing

    /// @notice Close a request nobody has paid. Only the asker, and only while
    ///         nothing has been collected.
    function cancel(uint256 id) external {
        Request storage r = _requests[id];
        if (r.id == 0) revert RequestNotFound(id);
        if (r.status != Status.Open) revert InvalidStatus(id, r.status);
        if (msg.sender != r.requester) revert NotRequester(id, msg.sender);
        if (r.collected != 0) revert NothingOwed(id, r.collected);

        r.status = Status.Cancelled;
        if (r.named == address(0)) _dropUnnamed(id);
        emit RequestClosed(id, r.requester, Status.Cancelled);
    }

    /// @notice Close a request that has been partly paid.
    function close(uint256 id) external {
        Request storage r = _requests[id];
        if (r.id == 0) revert RequestNotFound(id);
        if (r.status != Status.Open) revert InvalidStatus(id, r.status);
        if (msg.sender != r.requester && msg.sender != r.named) revert NotRequester(id, msg.sender);
        if (r.collected == 0) revert NothingOwed(id, 0);

        r.status = Status.Paid;
        if (r.named == address(0)) _dropUnnamed(id);
        emit RequestClosed(id, r.requester, Status.Paid);
    }

    function _dropUnnamed(uint256 id) private {
        uint256 pos = _openPos[id];
        if (pos == 0) return;
        uint256 last = _openIds[_openIds.length - 1];
        _openIds[pos - 1] = last;
        _openPos[last] = pos;
        _openIds.pop();
        delete _openPos[id];
        openUnnamedCount = _openIds.length;
    }

    // ------------------------------------------------------------ reading

    function getRequest(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    /// @notice How much is still needed to settle a request.
    function remaining(uint256 id) external view returns (uint256) {
        Request storage r = _requests[id];
        return r.amount - r.collected;
    }

    /// @notice Whether `account` may accept a request: it is still open, it has
    ///         not expired, and this account has not already responded to it.
    function canRespond(uint256 id, address account) external view returns (bool) {
        Request storage r = _requests[id];
        if (r.id == 0 || r.status != Status.Open) return false;
        if (block.timestamp >= r.expiresAt) return false;
        if (responded[id][account]) return false;
        if (r.named != address(0) && r.named != account) return false;
        return true;
    }

    /// @notice True once the request has been fully settled.
    function isSettled(uint256 id) external view returns (bool) {
        Request storage r = _requests[id];
        return r.collected == r.amount;
    }

    function statusOf(uint256 id) external view returns (Status) {
        return _requests[id].status;
    }

    /// @notice Requests addressed to a specific account.
    function askedOf(address account) external view returns (uint256[] memory ids) {
        uint256 total = nextId - 1;
        ids = new uint256[](total);
        uint256 n;
        for (uint256 i = 1; i <= total; i++) {
            if (_requests[i].named == account) ids[n++] = i;
        }
        assembly {
            mstore(ids, n)
        }
    }

    /// @notice Requests an account opened.
    function openedBy(address account) external view returns (uint256[] memory ids) {
        uint256 total = nextId - 1;
        ids = new uint256[](total);
        uint256 n;
        for (uint256 i = 1; i <= total; i++) {
            if (_requests[i].requester == account) ids[n++] = i;
        }
        assembly {
            mstore(ids, n)
        }
    }

    /// @notice Open requests that named nobody — the public feed.
    function openRequests(uint256 limit) external view returns (uint256[] memory ids) {
        uint256 cap = openUnnamedCount < limit ? openUnnamedCount : limit;
        ids = new uint256[](cap);
        for (uint256 i = 0; i < cap; i++) {
            ids[i] = _openIds[i];
        }
    }

    /// @notice Everything an account can act on, newest first: requests made to
    ///         it, requests it opened, and open requests anyone may fulfil.
    function feedOf(address account, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 total = nextId - 1;
        uint256 cap = total < limit ? total : limit;
        ids = new uint256[](cap);
        uint256 n;
        for (uint256 i = total; i > 0 && n < cap; i--) {
            Request storage r = _requests[i];
            if (r.requester == account || r.named == account || r.named == address(0)) {
                ids[n++] = i;
            }
        }
        assembly {
            mstore(ids, n)
        }
    }
}