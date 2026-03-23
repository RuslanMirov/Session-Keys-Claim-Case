// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

library ECDSA {
    /// @notice Recovers the signer address from a raw signature
    function recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(hash, v, r, s);
    }

    /// @notice Wraps a hash in the Ethereum signed message envelope
    function toEthSignedMessageHash(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }
}
