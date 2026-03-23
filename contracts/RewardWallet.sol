// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { UserOperation, IEntryPoint } from "./interfaces/IEntryPoint.sol";
import { ECDSA }                       from "./libraries/ECDSA.sol";
import { RewardToken }                 from "./RewardToken.sol";

// ══════════════════════════════════════════════════════════════════════════════
//
//  RewardWallet — ERC-4337 smart account
//
//  Covers three patterns:
//
//  ① Session keys      — temporary signer with limited permissions
//  ② ERC-4337          — validateUserOp + executeUserOp via EntryPoint
//  ③ Idempotency keys  — each session key can be used EXACTLY ONCE
//
// ══════════════════════════════════════════════════════════════════════════════

contract RewardWallet {
    using ECDSA for bytes32;

    // ── storage ───────────────────────────────────────────────────────────────

    address public immutable ENTRY_POINT;
    address public immutable owner;
    address public immutable rewardToken; // the only contract a session key is allowed to call

    uint256 private constant SIG_OK     = 0;
    uint256 private constant SIG_FAILED = 1;

    // ── ① Session key ─────────────────────────────────────────────────────────

    struct SessionKey {
        address signer;      // who signs the UserOp
        uint256 validUntil;  // expiry timestamp
        bool    active;
        // ③ Idempotency: the key can only be consumed once
        bool    used;
    }

    // keyId => SessionKey
    // keyId = keccak256(signer, validUntil, salt) — deterministic
    mapping(bytes32 => SessionKey) public sessionKeys;

    // ── events ────────────────────────────────────────────────────────────────

    event SessionKeyAdded(bytes32 indexed keyId, address signer);
    event SessionKeyUsed(bytes32 indexed keyId);   // ③ key has been burned
    event SessionKeyRevoked(bytes32 indexed keyId);
    event Claimed(address indexed wallet);

    // ── errors ────────────────────────────────────────────────────────────────

    error OnlyEntryPoint();
    error OnlyOwner();
    error KeyNotActive();
    error KeyExpired();
    error KeyAlreadyUsed();   // ③ idempotency: repeated call is forbidden
    error WrongTarget();      // ④ only rewardToken is allowed
    error WrongSelector();    // ④ only mintReward() is allowed

    // ── constructor ───────────────────────────────────────────────────────────

    constructor(address _entryPoint, address _owner, address _rewardToken) {
        ENTRY_POINT  = _entryPoint;
        owner        = _owner;
        rewardToken  = _rewardToken;
    }

    receive() external payable {}

    modifier onlyEntryPoint() {
        if (msg.sender != ENTRY_POINT) revert OnlyEntryPoint();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── ① add session key ─────────────────────────────────────────────────────

    /// @notice Owner adds a new session key
    /// @dev    Same parameters always produce the same keyId (deterministic)
    function addSessionKey(
        address signer,
        uint256 validUntil,
        bytes32 salt
    ) external onlyOwner returns (bytes32 keyId) {
        require(signer     != address(0),     "zero signer");
        require(validUntil >  block.timestamp, "already expired");

        keyId = keccak256(abi.encode(signer, validUntil, salt));

        require(!sessionKeys[keyId].active, "key exists");

        sessionKeys[keyId] = SessionKey({
            signer:     signer,
            validUntil: validUntil,
            active:     true,
            used:       false  // ③ not yet consumed
        });

        emit SessionKeyAdded(keyId, signer);
    }

    /// @notice Owner revokes an existing session key
    function revokeSessionKey(bytes32 keyId) external onlyOwner {
        sessionKeys[keyId].active = false;
        emit SessionKeyRevoked(keyId);
    }

    // ── ② ERC-4337: validateUserOp ────────────────────────────────────────────
    //
    //  Signature format:
    //    mode 0 (owner):        abi.encode(uint8(0), bytes sig)
    //    mode 1 (session key):  abi.encode(uint8(1), bytes32 keyId, bytes sig)
    //
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32                userOpHash,
        uint256                /* missingFunds */
    ) external onlyEntryPoint returns (uint256) {

        (uint8 mode) = abi.decode(userOp.signature[:32], (uint8));

        // ── owner: standard signature ─────────────────────────────────────────
        if (mode == 0) {
            (, bytes memory sig) = abi.decode(userOp.signature, (uint8, bytes));
            address recovered = userOpHash.toEthSignedMessageHash().recover(sig);
            return recovered == owner ? SIG_OK : SIG_FAILED;
        }

        // ── session key ───────────────────────────────────────────────────────
        if (mode == 1) {
            (, bytes32 keyId, bytes memory sig) =
                abi.decode(userOp.signature, (uint8, bytes32, bytes));

            SessionKey storage sk = sessionKeys[keyId];

            // key validity checks
            if (!sk.active)                      return SIG_FAILED; // not active
            if (block.timestamp > sk.validUntil) return SIG_FAILED; // expired
            if (sk.used)                         return SIG_FAILED; // ③ already consumed

            // ④ session key may ONLY call rewardToken.mintReward()
            //    callData = abi.encodeCall(RewardWallet.claim, ())
            //    inside claim() → rewardToken.mintReward(address(this))
            //    we verify the UserOp is targeting exactly claim()
            bytes4 sel = bytes4(userOp.callData[:4]);
            if (sel != RewardWallet.claim.selector) return SIG_FAILED;

            // verify signature
            address recovered = userOpHash.toEthSignedMessageHash().recover(sig);
            return recovered == sk.signer ? SIG_OK : SIG_FAILED;
        }

        return SIG_FAILED;
    }

    // ── ② ERC-4337: executeUserOp ─────────────────────────────────────────────
    //
    //  Called by EntryPoint after successful validation.
    //  callData = abi.encodeCall(RewardWallet.claim, (keyId))
    //
    function executeUserOp(bytes32 keyId) external onlyEntryPoint {
        _claim(keyId);
    }

    // ── claim — core logic ────────────────────────────────────────────────────

    /// @notice Entry point for claiming a reward via session key
    function claim(bytes32 keyId) external {
        require(
            msg.sender == ENTRY_POINT || msg.sender == owner,
            "not authorized"
        );
        _claim(keyId);
    }

    function _claim(bytes32 keyId) internal {
        SessionKey storage sk = sessionKeys[keyId];

        if (!sk.active)                      revert KeyNotActive();
        if (block.timestamp > sk.validUntil) revert KeyExpired();
        if (sk.used)                         revert KeyAlreadyUsed(); // ③

        // ③ Idempotency: mark the key as permanently consumed
        sk.used = true;
        emit SessionKeyUsed(keyId);

        // ④ hardcoded target — rewardToken is not a parameter
        RewardToken(rewardToken).mintReward(address(this));

        emit Claimed(address(this));
    }

    // ── owner can execute arbitrary calls without ERC-4337 ───────────────────

    /// @notice Allows the owner to make arbitrary calls directly
    function ownerExecute(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyOwner {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    /// @notice Deposits ETH into the EntryPoint on behalf of this wallet
    function deposit() external payable {
        IEntryPoint(ENTRY_POINT).depositTo{value: msg.value}(address(this));
    }
}
