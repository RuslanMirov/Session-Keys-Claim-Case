const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { time }        = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal mock EntryPoint — just tracks deposits and can forward calls.
 * Deployed inline so tests have no external dependency.
 */
const MOCK_ENTRY_POINT_ABI = [
  "function depositTo(address account) external payable",
  "function callWallet(address wallet, bytes calldata data) external returns (bytes memory)",
];

const MOCK_ENTRY_POINT_BYTECODE = `
pragma solidity ^0.8.23;
contract MockEntryPoint {
    mapping(address => uint256) public deposits;
    function depositTo(address account) external payable {
        deposits[account] += msg.value;
    }
    // Lets tests simulate EntryPoint calling validateUserOp / executeUserOp
    function callWallet(address wallet, bytes calldata data)
        external returns (bytes memory)
    {
        (bool ok, bytes memory ret) = wallet.call(data);
        require(ok, "wallet call failed");
        return ret;
    }
}
`;

/** Build a minimal UserOperation struct (all unused fields are zero/empty). */
function buildUserOp(sender, callData, signature) {
  return {
    sender,
    nonce:                  0n,
    initCode:               "0x",
    callData,
    callGasLimit:           200_000n,
    verificationGasLimit:   200_000n,
    preVerificationGas:     50_000n,
    maxFeePerGas:           1n,
    maxPriorityFeePerGas:   1n,
    paymasterAndData:       "0x",
    signature,
  };
}

/** Sign a userOpHash the way the wallet expects (mode=0 owner, mode=1 session key). */
async function signOwner(signer, userOpHash) {
  const sig = await signer.signMessage(ethers.getBytes(userOpHash));
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "bytes"],
    [0, sig]
  );
}

async function signSessionKey(signer, keyId, userOpHash) {
  const sig = await signer.signMessage(ethers.getBytes(userOpHash));
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "bytes32", "bytes"],
    [1, keyId, sig]
  );
}

/** Compute a deterministic keyId the same way the contract does. */
function computeKeyId(signer, validUntil, salt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes32"],
      [signer, validUntil, salt]
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Session Key Claim Protocol", function () {

  let entryPoint;   // MockEntryPoint
  let token;        // RewardToken
  let wallet;       // RewardWallet
  let owner;        // wallet owner (cold key)
  let sessionSigner;// hot session key signer
  let attacker;     // adversarial account
  let salt;

  beforeEach(async function () {
    [owner, sessionSigner, attacker] = await ethers.getSigners();
    salt = ethers.randomBytes(32);

    const EP = await ethers.getContractFactory("MockEntryPoint");
    entryPoint = await EP.deploy();

    const Token = await ethers.getContractFactory("RewardToken");
    token = await Token.deploy();

    const Wallet = await ethers.getContractFactory("RewardWallet");
    wallet = await Wallet.deploy(
      await entryPoint.getAddress(),
      owner.address,
      await token.getAddress()
    );

    // Register the wallet so it can call mintReward()
    await token.registerWallet(await wallet.getAddress());
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  1. Deployment
  // ───────────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {

    it("sets owner, entryPoint and rewardToken correctly", async function () {
      expect(await wallet.owner()).to.equal(owner.address);
      expect(await wallet.ENTRY_POINT()).to.equal(await entryPoint.getAddress());
      expect(await wallet.rewardToken()).to.equal(await token.getAddress());
    });

    it("registers wallet in RewardToken", async function () {
      expect(await token.registeredWallets(await wallet.getAddress())).to.be.true;
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  2. Session key management
  // ───────────────────────────────────────────────────────────────────────────

  describe("addSessionKey", function () {

    it("owner can add a session key and keyId is deterministic", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);

      await expect(
        wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt)
      )
        .to.emit(wallet, "SessionKeyAdded")
        .withArgs(keyId, sessionSigner.address);

      const sk = await wallet.sessionKeys(keyId);
      expect(sk.signer).to.equal(sessionSigner.address);
      expect(sk.active).to.be.true;
      expect(sk.used).to.be.false;
    });

    it("same params always produce the same keyId", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId1 = computeKeyId(sessionSigner.address, validUntil, salt);
      const tx = await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      const receipt = await tx.wait();
      // parse emitted keyId
      const event = receipt.logs.find(l => l.fragment?.name === "SessionKeyAdded");
      expect(event.args[0]).to.equal(keyId1);
    });

    it("reverts when called by non-owner", async function () {
      const validUntil = (await time.latest()) + 3600;
      await expect(
        wallet.connect(attacker).addSessionKey(sessionSigner.address, validUntil, salt)
      ).to.be.revertedWithCustomError(wallet, "OnlyOwner");
    });

    it("reverts for zero signer address", async function () {
      const validUntil = (await time.latest()) + 3600;
      await expect(
        wallet.connect(owner).addSessionKey(ethers.ZeroAddress, validUntil, salt)
      ).to.be.revertedWith("zero signer");
    });

    it("reverts when validUntil is in the past", async function () {
      const past = (await time.latest()) - 1;
      await expect(
        wallet.connect(owner).addSessionKey(sessionSigner.address, past, salt)
      ).to.be.revertedWith("already expired");
    });

    it("reverts when adding a duplicate key (same params)", async function () {
      const validUntil = (await time.latest()) + 3600;
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      await expect(
        wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt)
      ).to.be.revertedWith("key exists");
    });

  });

  describe("revokeSessionKey", function () {

    it("owner can revoke a session key", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      await expect(wallet.connect(owner).revokeSessionKey(keyId))
        .to.emit(wallet, "SessionKeyRevoked")
        .withArgs(keyId);

      const sk = await wallet.sessionKeys(keyId);
      expect(sk.active).to.be.false;
    });

    it("reverts when called by non-owner", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      await expect(
        wallet.connect(attacker).revokeSessionKey(keyId)
      ).to.be.revertedWithCustomError(wallet, "OnlyOwner");
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  3. claim() — core mechanic
  // ───────────────────────────────────────────────────────────────────────────

  describe("claim() via owner", function () {

    it("owner can claim with a valid session key", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      await expect(wallet.connect(owner).claim(keyId))
        .to.emit(wallet, "SessionKeyUsed").withArgs(keyId)
        .and.to.emit(wallet, "Claimed").withArgs(await wallet.getAddress())
        .and.to.emit(token, "Minted");

      // token balance updated
      const REWARD = await token.REWARD();
      expect(await token.balanceOf(await wallet.getAddress())).to.equal(REWARD);
    });

    it("marks key as used after claim — cannot claim twice", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).claim(keyId);

      await expect(
        wallet.connect(owner).claim(keyId)
      ).to.be.revertedWithCustomError(wallet, "KeyAlreadyUsed");
    });

    it("reverts when key is expired", async function () {
      const validUntil = (await time.latest()) + 60;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      await time.increase(120); // jump past expiry

      await expect(
        wallet.connect(owner).claim(keyId)
      ).to.be.revertedWithCustomError(wallet, "KeyExpired");
    });

    it("reverts when key is revoked", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).revokeSessionKey(keyId);

      await expect(
        wallet.connect(owner).claim(keyId)
      ).to.be.revertedWithCustomError(wallet, "KeyNotActive");
    });

    it("reverts when called by an attacker directly", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      await expect(
        wallet.connect(attacker).claim(keyId)
      ).to.be.revertedWith("not authorized");
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  4. validateUserOp — mode 0 (owner)
  // ───────────────────────────────────────────────────────────────────────────

  describe("validateUserOp — mode 0 (owner signature)", function () {

    it("returns SIG_OK for a valid owner signature", async function () {
      const callData  = wallet.interface.encodeFunctionData("claim", [ethers.ZeroHash]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("test-op-hash"));
      const signature  = await signOwner(owner, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(0n); // SIG_OK
    });

    it("returns SIG_FAILED when owner signature is wrong", async function () {
      const callData   = wallet.interface.encodeFunctionData("claim", [ethers.ZeroHash]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("test-op-hash"));
      const signature  = await signOwner(attacker, userOpHash); // wrong signer
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED
    });

    it("reverts when called by non-EntryPoint", async function () {
      const callData   = "0x";
      const userOpHash = ethers.ZeroHash;
      const userOp     = buildUserOp(await wallet.getAddress(), callData, "0x" + "00".repeat(32));

      await expect(
        wallet.connect(attacker).validateUserOp(userOp, userOpHash, 0)
      ).to.be.revertedWithCustomError(wallet, "OnlyEntryPoint");
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  5. validateUserOp — mode 1 (session key)
  // ───────────────────────────────────────────────────────────────────────────

  describe("validateUserOp — mode 1 (session key)", function () {

    let keyId, validUntil;

    beforeEach(async function () {
      validUntil = (await time.latest()) + 3600;
      keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
    });

    it("returns SIG_OK for valid session key signature targeting claim()", async function () {
      const callData   = wallet.interface.encodeFunctionData("claim", [keyId]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("session-op-hash"));
      const signature  = await signSessionKey(sessionSigner, keyId, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(0n); // SIG_OK
    });

    it("returns SIG_FAILED when session key targets wrong selector", async function () {
      // attacker tries to call ownerExecute() via a session key
      const callData = wallet.interface.encodeFunctionData("ownerExecute", [
        attacker.address, 0, "0x"
      ]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("evil-op-hash"));
      const signature  = await signSessionKey(sessionSigner, keyId, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED
    });

    it("returns SIG_FAILED for wrong session key signer", async function () {
      const callData   = wallet.interface.encodeFunctionData("claim", [keyId]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("session-op-hash"));
      const signature  = await signSessionKey(attacker, keyId, userOpHash); // wrong signer
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED
    });

    it("returns SIG_FAILED when key is already used", async function () {
      // burn the key first
      await wallet.connect(owner).claim(keyId);

      const callData   = wallet.interface.encodeFunctionData("claim", [keyId]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("session-op-hash-2"));
      const signature  = await signSessionKey(sessionSigner, keyId, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED
    });

    it("returns SIG_FAILED when key is expired", async function () {
      await time.increase(3700); // jump past validUntil

      const callData   = wallet.interface.encodeFunctionData("claim", [keyId]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("session-op-hash-3"));
      const signature  = await signSessionKey(sessionSigner, keyId, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED
    });

    it("returns SIG_FAILED when key is revoked", async function () {
      await wallet.connect(owner).revokeSessionKey(keyId);

      const callData   = wallet.interface.encodeFunctionData("claim", [keyId]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("session-op-hash-4"));
      const signature  = await signSessionKey(sessionSigner, keyId, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), callData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  6. executeUserOp
  // ───────────────────────────────────────────────────────────────────────────

  describe("executeUserOp", function () {

    it("EntryPoint can execute a valid claim via executeUserOp", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      const callData = wallet.interface.encodeFunctionData("executeUserOp", [keyId]);

      await expect(entryPoint.callWallet(await wallet.getAddress(), callData))
        .to.emit(wallet, "SessionKeyUsed").withArgs(keyId)
        .and.to.emit(wallet, "Claimed");

      const REWARD = await token.REWARD();
      expect(await token.balanceOf(await wallet.getAddress())).to.equal(REWARD);
    });

    it("reverts when called by non-EntryPoint", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      await expect(
        wallet.connect(attacker).executeUserOp(keyId)
      ).to.be.revertedWithCustomError(wallet, "OnlyEntryPoint");
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  7. ownerExecute
  // ───────────────────────────────────────────────────────────────────────────

  describe("ownerExecute", function () {

    it("owner can make arbitrary calls", async function () {
      // Fund the wallet first
      await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });

      const balBefore = await ethers.provider.getBalance(attacker.address);
      const callData  = wallet.interface.encodeFunctionData("ownerExecute", [
        attacker.address,
        ethers.parseEther("0.5"),
        "0x"
      ]);
      await wallet.connect(owner).ownerExecute(attacker.address, ethers.parseEther("0.5"), "0x");
      const balAfter = await ethers.provider.getBalance(attacker.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.5"));
    });

    it("reverts when called by non-owner", async function () {
      await expect(
        wallet.connect(attacker).ownerExecute(attacker.address, 0, "0x")
      ).to.be.revertedWithCustomError(wallet, "OnlyOwner");
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  8. RewardToken
  // ───────────────────────────────────────────────────────────────────────────

  describe("RewardToken", function () {

    it("only registered wallet can call mintReward", async function () {
      await expect(
        token.connect(attacker).mintReward(attacker.address)
      ).to.be.revertedWith("not registered");
    });

    it("wallet cannot mint to a different address", async function () {
      // Deploy a second wallet and try to mint to attacker
      const Wallet = await ethers.getContractFactory("RewardWallet");
      const wallet2 = await Wallet.deploy(
        await entryPoint.getAddress(),
        owner.address,
        await token.getAddress()
      );
      await token.registerWallet(await wallet2.getAddress());

      // wallet2 tries mintReward(attacker.address) — must fail
      const callData = token.interface.encodeFunctionData("mintReward", [attacker.address]);
      await expect(
        wallet2.connect(owner).ownerExecute(await token.getAddress(), 0, callData)
      ).to.be.revertedWith("can only mint to self");
    });

    it("only owner can register a wallet", async function () {
      await expect(
        token.connect(attacker).registerWallet(attacker.address)
      ).to.be.revertedWith("only owner");
    });

    it("totalSupply grows with each claim", async function () {
      const REWARD = await token.REWARD();
      expect(await token.totalSupply()).to.equal(0n);

      // First claim
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).claim(keyId);

      expect(await token.totalSupply()).to.equal(REWARD);
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  //  9. Adversarial / edge cases
  // ───────────────────────────────────────────────────────────────────────────

  describe("Adversarial scenarios", function () {

    it("stolen session key cannot be replayed after first use", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      // Legitimate first claim
      await wallet.connect(owner).claim(keyId);

      // Attacker obtains the keyId and tries to replay via owner path
      await expect(
        wallet.connect(owner).claim(keyId)
      ).to.be.revertedWithCustomError(wallet, "KeyAlreadyUsed");
    });

    it("attacker cannot use a valid key to call ownerExecute via validateUserOp", async function () {
      const validUntil = (await time.latest()) + 3600;
      const keyId = computeKeyId(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);

      // Crafted callData targeting ownerExecute instead of claim
      const evilCallData = wallet.interface.encodeFunctionData("ownerExecute", [
        attacker.address, ethers.parseEther("1"), "0x"
      ]);
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("evil"));
      const signature  = await signSessionKey(sessionSigner, keyId, userOpHash);
      const userOp     = buildUserOp(await wallet.getAddress(), evilCallData, signature);

      const validateData = wallet.interface.encodeFunctionData("validateUserOp", [
        userOp, userOpHash, 0
      ]);
      const result = await entryPoint.callWallet.staticCall(
        await wallet.getAddress(), validateData
      );
      const decoded = wallet.interface.decodeFunctionResult("validateUserOp", result);
      expect(decoded[0]).to.equal(1n); // SIG_FAILED — selector blocked
    });

    it("different salt produces independent keys (one burn doesn't affect the other)", async function () {
      const validUntil = (await time.latest()) + 3600;
      const salt2 = ethers.randomBytes(32);

      const keyId1 = computeKeyId(sessionSigner.address, validUntil, salt);
      const keyId2 = computeKeyId(sessionSigner.address, validUntil, salt2);

      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt2);

      // Burn key1
      await wallet.connect(owner).claim(keyId1);

      // key2 still works
      await expect(wallet.connect(owner).claim(keyId2))
        .to.emit(wallet, "SessionKeyUsed").withArgs(keyId2);
    });

    it("expired key cannot be re-activated by adding with same params", async function () {
      const validUntil = (await time.latest()) + 60;
      await wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt);
      await time.increase(120);

      // Same params → same keyId → "key exists" even though expired
      await expect(
        wallet.connect(owner).addSessionKey(sessionSigner.address, validUntil, salt)
      ).to.be.revertedWith("already expired");
    });

  });

});