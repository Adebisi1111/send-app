// Live lifecycle against Arc testnet: createJob -> fund -> submit -> complete
// Run WITHOUT --broadcast first to simulate. Then with --broadcast to execute.
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {JobEscrow} from "../JobEscrow.sol";

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract JobLifecycle is Script {
    address constant ESCROW = 0x4E557f34FFA44ce32d804737ad2c7Cb30849a445;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    // Distinct provider so we can prove the escrow actually paid out.
    address constant PROVIDER = 0x000000000000000000000000000000000000dEaD;
    uint256 constant BUDGET = 5_000_000; // 5 USDC, 6 decimals

    function run() external {
        uint256 pk = vm.envUint("ARC_PK");
        address client = vm.addr(pk);
        uint256 expiresAt = block.timestamp + 3600;

        console.log("client   :", client);
        console.log("client USDC before:", IERC20Min(USDC).balanceOf(client));
        console.log("escrow USDC before:", IERC20Min(USDC).balanceOf(ESCROW));
        console.log("provider USDC before:", IERC20Min(USDC).balanceOf(PROVIDER));

        vm.startBroadcast(pk);
        JobEscrow escrow = JobEscrow(ESCROW);

        // 1. create
        uint256 jobId = escrow.createJob(
            PROVIDER, BUDGET, expiresAt, "Arc escrow lifecycle proof"
        );
        console.log("created jobId:", jobId);

        // 2. approve + fund
        IERC20Min(USDC).approve(ESCROW, BUDGET);
        escrow.fund(jobId);
        console.log("funded jobId:", jobId);

        // 3. provider submits
        vm.stopBroadcast();
        vm.startBroadcast();
        vm.prank(PROVIDER);
        escrow.submit(jobId, keccak256("arc-escrow-deliverable-v1"));
        console.log("submitted jobId:", jobId);
        vm.stopBroadcast();

        // 4. client completes -> releases to provider
        vm.startBroadcast(pk);
        escrow.complete(jobId);
        vm.stopBroadcast();
        console.log("completed jobId:", jobId);
    }
}
