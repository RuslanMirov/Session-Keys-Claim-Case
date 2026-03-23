# Session Key Claim Case

> *One key. One claim. No replays.*

---

## The Problem

DeFi protocols distribute rewards constantly — liquidity mining, airdrops, staking yields.
To claim them, users must sign a transaction with their **main private key**.

That means:
- Exposing your hot wallet every time you claim
- Bots or malicious dApps can fish for signatures
- One leaked key = entire wallet drained

**Users shouldn't need to touch their main key just to claim $12 in rewards.**

---

## The Solution

Session Key Claim Protocol lets a DeFi protocol issue a **single-use session key** to a user.

That key can do **exactly one thing**: call `claim()` on the user's smart wallet.
Once used, it is permanently burned. It cannot be replayed, reused, or redirected.

The user's main key never leaves cold storage.

```
Protocol Backend          Session Key (hot)         RewardWallet (user)
       │                        │                          │
       │── addSessionKey() ────▶│                          │
       │                        │── validateUserOp() ─────▶│
       │                        │── claim(keyId) ──────────▶│
       │                        │                          │── mintReward()
       │                        │                    key.used = true ✓
       │                        │                    (burned forever)
```

---

## How It Works

**Three guarantees, hardcoded into the contract:**

| Guarantee | Mechanism |
|---|---|
| Key expires | `validUntil` timestamp checked on every call |
| Key burns on use | `used = true` set before any external call |
| Key can only claim | `claim.selector` enforced in `validateUserOp` |

No amount of signature replay, front-running, or key theft can trigger a second claim.

---

## Contracts

```
contracts/
├── interfaces/
│   └── IEntryPoint.sol      UserOperation struct + EntryPoint interface
├── libraries/
│   └── ECDSA.sol            Signature recovery helpers
├── RewardToken.sol          Mock ERC-20 (mintable only by registered wallets)
└── RewardWallet.sol         ERC-4337 smart account with session key logic
```

### RewardWallet

The user's smart account. Owner is their cold wallet address.

- `addSessionKey(signer, validUntil, salt)` — owner issues a key to a hot signer
- `revokeSessionKey(keyId)` — owner kills a key early
- `validateUserOp(...)` — EntryPoint hook, validates owner or session key signatures
- `claim(keyId)` — burns the key and mints the reward
- `ownerExecute(...)` — owner escape hatch for arbitrary calls

### RewardToken

Mock ERC-20. Only wallets registered by the deployer can call `mintReward()`.
Drop-in replacement for any real DeFi reward distribution contract.

---

## Quickstart

```bash
npm install
npx hardhat compile
npx hardhat test
```

Deploy:

```js
const rewardToken  = await RewardToken.deploy();
const rewardWallet = await RewardWallet.deploy(
  ENTRY_POINT_ADDRESS,
  ownerAddress,
  rewardToken.address
);

await rewardToken.registerWallet(rewardWallet.address);
```

Issue a session key (backend):

```js
const keyId = await rewardWallet.addSessionKey(
  hotSignerAddress,
  Math.floor(Date.now() / 1000) + 3600, // valid for 1 hour
  ethers.randomBytes(32)                 // unique salt
);
```

---

## Security Properties

- **No replay** — `used` flag is permanent, checked before any state change
- **No redirection** — session key selector is locked to `claim()` only
- **No escalation** — session key cannot call `ownerExecute` or `addSessionKey`
- **Expiry enforced** — both in `validateUserOp` and inside `_claim`
- **Owner always safe** — cold wallet never participates in hot claim flow

---

## License

MIT
