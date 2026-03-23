// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// ─────────────────────────────────────────────────────────────────────────────
//  Minimal ERC-4337 interfaces (no external dependencies)
// ─────────────────────────────────────────────────────────────────────────────

struct UserOperation {
    address sender;
    uint256 nonce;
    bytes   initCode;
    bytes   callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes   paymasterAndData;
    bytes   signature;
}

interface IEntryPoint {
    function depositTo(address account) external payable;
}
