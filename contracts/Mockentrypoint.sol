// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Minimal EntryPoint mock used in tests only.
///      - tracks deposits
///      - forwards arbitrary calls to a wallet so tests can simulate EntryPoint calls
contract MockEntryPoint {

    mapping(address => uint256) public deposits;

    function depositTo(address account) external payable {
        deposits[account] += msg.value;
    }

    /// @notice Forwards a raw call to `wallet` as if coming from EntryPoint
    function callWallet(address wallet, bytes calldata data)
        external
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = wallet.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        return ret;
    }
}