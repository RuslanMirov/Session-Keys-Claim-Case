// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// ══════════════════════════════════════════════════════════════════════════════
//
//  RewardToken — mock ERC-20
//  mintReward() can only be called by a registered wallet
//
// ══════════════════════════════════════════════════════════════════════════════

contract RewardToken {

    string  public constant name     = "RewardToken";
    string  public constant symbol   = "RWD";
    uint8   public constant decimals = 18;
    uint256 public constant REWARD   = 100 ether;

    address public immutable owner;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool)    public registeredWallets;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Minted(address indexed wallet, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Owner registers a wallet after it has been deployed
    function registerWallet(address wallet) external {
        require(msg.sender == owner, "only owner");
        registeredWallets[wallet] = true;
    }

    /// @notice Called by the wallet itself: rewardToken.mintReward(address(this))
    function mintReward(address to) external {
        require(registeredWallets[msg.sender], "not registered");
        require(msg.sender == to,              "can only mint to self");

        totalSupply    += REWARD;
        balanceOf[to]  += REWARD;

        emit Transfer(address(0), to, REWARD);
        emit Minted(to, REWARD);
    }
}
