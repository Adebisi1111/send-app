// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PaymentRequest, IERC20} from "../PaymentRequest.sol";

/// @dev Malicious / callback-capable token used ONLY to probe whether
///      PaymentRequest is safe if `usdc` were not the trusted Circle USDC.
///      It re-enters `pay`, `close`, `cancel`, `decline` and `askAnyone`
///      from inside transferFrom, i.e. exactly when PaymentRequest has
///      already written `collected` but has NOT yet written `status`,
///      `RequestClosed`, or performed `_dropUnnamed`.
contract ReentrantERC20 {
    string public name = "Reentrant USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target;
    /// id of the request the callback should try to re-enter
    uint256 public reentryId;
    uint256 public reentryAmount;
    /// when true, transferFrom performs the callback exactly once
    bool public armed;
    /// which probe to run: 0 = none, 1 = pay same id, 2 = askAnyone,
    /// 3 = close, 4 = cancel, 5 = decline
    uint8 public probe;

    bool public reentryReverted;
    bool public reentrySucceeded;
    uint256 public callbackCount;

    constructor() {}

    function setTarget(address t) external {
        target = t;
    }

    function arm(uint256 id, uint256 amount, uint8 probe_) external {
        reentryId = id;
        reentryAmount = amount;
        probe = probe_;
        armed = true;
        reentryReverted = false;
        reentrySucceeded = false;
        callbackCount = 0;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        if (armed && msg.sender == target) {
            armed = false;
            callbackCount++;
            if (probe == 1) {
                // try to pay the SAME request again from inside the callback
                try PaymentRequest(target).pay(reentryId, reentryAmount) {
                    reentrySucceeded = true;
                } catch {
                    reentryReverted = true;
                }
            } else if (probe == 2) {
                // mutate _openIds / _openPos / openUnnamedCount mid-settlement
                PaymentRequest(target).askAnyone("injected", 1e6, block.timestamp + 1 days);
            } else if (probe == 3) {
                try PaymentRequest(target).close(reentryId) {
                    reentrySucceeded = true;
                } catch {
                    reentryReverted = true;
                }
            } else if (probe == 4) {
                try PaymentRequest(target).cancel(reentryId) {
                    reentrySucceeded = true;
                } catch {
                    reentryReverted = true;
            } } else if (probe == 5) {
                try PaymentRequest(target).decline(reentryId) {
                    reentrySucceeded = true;
                } catch {
                    reentryReverted = true;
                }
            }
        }
        return true;
    }
}
