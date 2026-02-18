# TNS Partnership Strategy

## Overview

TNS (Token Name Service) creates a unique opportunity to become the **naming layer for Solana**. Two potential partners could accelerate this vision:

| Partner | What They Do | Synergy |
|---------|--------------|---------|
| **SNS** (Solana Name Service) | `.sol` domains for wallets/identities | TNS + SNS = complete naming infrastructure |
| **D3** | Traditional DNS domains (`.com`, `.xyz`) on-chain | Bridge between Web2 and Web3 identity |

---

## SNS Partnership

### What SNS Does
- Registers `.sol` domains (e.g., `alice.sol`)
- Resolves domains → wallet addresses
- Stores arbitrary data in domain records
- Has reverse lookup (wallet → domains)

### What TNS Does
- Registers token symbols (e.g., `$BONK`)
- Resolves symbols → mint addresses
- Verifies token authenticity on-chain

### Partnership Value Proposition

**"The complete naming layer for Solana"**

| Resolution Type | Service | Example |
|-----------------|---------|---------|
| Identity → Wallet | SNS | `alice.sol` → `7xKp...` |
| Symbol → Token | TNS | `$BONK` → `DezX...` |

Together, any name on Solana can be resolved through a unified interface.

---

### Partnership Ideas (No Code Changes Required)

#### 1. Unified Name Resolution SDK
A single SDK/API that routes resolution requests to the appropriate service:

```typescript
import { resolve } from '@solana/naming';

// Routes to SNS
const wallet = await resolve('alice.sol');

// Routes to TNS
const mint = await resolve('$BONK');

// Combined lookup
const tokenInfo = await resolve('$BONK', { includeSnsProfile: true });
// Returns: { mint, owner, ownerDomains: ['bonkteam.sol'] }
```

**Effort**: Off-chain only, SDK development
**Value**: Developer convenience, unified ecosystem story

#### 2. Co-Marketing Campaign
- Joint announcement: "Solana's Complete Naming Infrastructure"
- Shared documentation site
- Cross-promotion on socials
- Joint hackathon/grant program for projects integrating both

**Effort**: Marketing coordination only
**Value**: Credibility, visibility, shared community

#### 3. Bundle Deals
- Launch a token? Get `$SYMBOL` (TNS) + `symbol.sol` (SNS) together
- Discount for registering both
- Single checkout flow

**Effort**: Frontend/product integration
**Value**: User convenience, cross-selling

#### 4. Profile Integration
- SNS profiles display "Verified Token Creator" badge for wallets that own TNS symbols
- TNS explorer shows linked `.sol` domains for token owners

**Effort**: Frontend integration, API calls
**Value**: Trust signals, cross-ecosystem visibility

---

### Optional: On-Chain SNS Integration

**Note**: This is NOT required for the partnership. The reverse lookup approach works fine:
1. Look up TNS Token PDA for `$BONK` → get `owner` pubkey
2. Do SNS reverse lookup for that `owner` → get their `.sol` domains

However, if an **explicit on-chain link** is desired (for cases where owner has multiple domains, or token brand differs from owner identity), here's the implementation path:

#### When Explicit Links Matter

| Scenario | Problem with Reverse Lookup |
|----------|----------------------------|
| Owner has 5 `.sol` domains | Which one is "official" for this token? |
| Token brand ≠ owner identity | Creator is `alice.sol` but token should be `bonk.sol` |
| Owner sells/transfers the `.sol` | Link breaks silently |
| Owner wallet changes (multisig rotation) | Reverse lookup points to different domains |

#### Implementation (If Needed Later)

**1. Update Token Struct** (~5 min)

```rust
pub struct Token {
    #[max_len(10)]
    pub symbol: String,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub registered_at: i64,
    pub bump: u8,
    pub expires_at: i64,

    // NEW: Optional linked SNS domain account
    pub sns_domain: Option<Pubkey>,  // 33 bytes

    pub _reserved: [u8; 31],  // reduced from 64
}
```

**2. Add SNS Verification Helper** (~30 min)

```rust
// In helpers/validation.rs
pub fn verify_sns_ownership(
    sns_account: &AccountInfo,
    expected_owner: &Pubkey,
) -> Result<()> {
    // SNS NameRegistryState: parent_name (32) | owner (32) | class (32)
    // Owner is at offset 32
    let owner_bytes = &sns_account.data.borrow()[32..64];
    let sns_owner = Pubkey::try_from(owner_bytes)?;

    require!(sns_owner == *expected_owner, TnsError::SnsOwnershipMismatch);
    Ok(())
}
```

**3. Update Registration Instructions** (~1-2 hours)

```rust
/// Optional: SNS domain to link (verifies caller owns it)
#[account()]
pub sns_domain_account: Option<AccountInfo<'info>>,
```

Handler logic:
```rust
if let Some(sns_account) = ctx.accounts.sns_domain_account {
    verify_sns_ownership(&sns_account, &ctx.accounts.owner.key())?;
    token.sns_domain = Some(sns_account.key());
}
```

**4. Tests** (~1-2 hours)

**Total Effort**: 3-5 hours

**Decision Required**: Should the SNS link be immutable (set once) or updatable (like mint)?

| Option | Pros | Cons |
|--------|------|------|
| Immutable | Simpler, no update logic | Can't change if you sell the `.sol` |
| Updatable | Flexible | Need another instruction, fee decision |

#### Upgrade Path: No Migration Required

**You can launch now and add this later.** Here's why:

The Token struct has `_reserved: [u8; 64]` which is initialized to all zeros. When you later change the struct to include `sns_domain: Option<Pubkey>`, existing PDAs will **automatically deserialize correctly** with no migration needed.

**How Borsh serializes `Option<Pubkey>`:**
- Byte 0 = `0x00` → `None`
- Byte 0 = `0x01` + 32 bytes → `Some(Pubkey)`

Since `_reserved` is all zeros, the first byte is `0x00`, which deserializes as `None`. No migration script needed.

**What you need when adding this feature:**

| Task | Required? |
|------|-----------|
| Migration script to update old PDAs | **No** - zeros already = `None` |
| Program upgrade with new struct | Yes |
| New `link_sns_domain` instruction | Yes - for users to add links |

**New instruction for linking (add alongside the struct change):**

```rust
// instructions/registrar/link_sns_domain.rs
pub fn link_sns_domain(ctx: Context<LinkSnsDomain>) -> Result<()> {
    // Verify caller owns the TNS token
    require!(
        ctx.accounts.token.owner == ctx.accounts.owner.key(),
        TnsError::NotTokenOwner
    );

    // Verify caller owns the SNS domain
    verify_sns_ownership(
        &ctx.accounts.sns_domain_account,
        &ctx.accounts.owner.key()
    )?;

    // Update the token PDA
    ctx.accounts.token.sns_domain = Some(ctx.accounts.sns_domain_account.key());

    emit!(SnsDomainLinked {
        symbol: ctx.accounts.token.symbol.clone(),
        sns_domain: ctx.accounts.sns_domain_account.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct LinkSnsDomain<'info> {
    #[account(mut)]
    pub token: Account<'info, Token>,

    /// The SNS domain account to link
    /// CHECK: Validated in verify_sns_ownership
    pub sns_domain_account: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,
}
```

**Summary**: Launch now with confidence. The `_reserved` bytes are your insurance policy. When/if SNS integration happens, it's a clean program upgrade + one new instruction. Users with existing symbols can call `link_sns_domain` to add their `.sol` link.

---

## D3 Partnership

### What D3 Does
- Brings traditional DNS domains (`.com`, `.xyz`, etc.) on-chain
- Makes domain ownership verifiable via blockchain
- Enables domain trading/transfers on-chain

### Partnership Value Proposition

**"Complete brand identity for tokenized assets"**

| Identity Layer | Service | Example |
|----------------|---------|---------|
| Web Domain | D3 | `mytoken.xyz` |
| Token Symbol | TNS | `$MYTOKEN` |
| Wallet Identity | SNS | `mytoken.sol` |

---

### Partnership Ideas

#### 1. Brand Protection Bundle
- Register `mytoken.xyz` (D3) + `$MYTOKEN` (TNS) together
- One-stop brand identity for token launches
- "Prove you own both" verification

**Value**: Comprehensive brand protection, premium offering

#### 2. RWA/TradFi Bridge
TNS already reserves TradFi symbols for future RWA tokenization. D3 could provide:
- Official web presence verification alongside TNS symbol verification
- DNS TXT records pointing to TNS symbols
- Creates trust bridge between traditional finance and on-chain assets

**Value**: Institutional credibility, RWA market positioning

#### 3. DNS → TNS Linking
Traditional domain records could reference TNS symbols:
```
mycompany.com TXT "tns:$MYCO"
```

This creates verifiable proof that a Web2 entity "owns" a specific on-chain token symbol.

**Value**: Web2 ↔ Web3 identity bridge

#### 4. Acquisition/Merger Angles

| Direction | Rationale |
|-----------|-----------|
| **D3 acquires TNS** | Symbol registry becomes a product line in their "on-chain naming" suite |
| **TNS acquires D3** | Complete naming infrastructure (domains + symbols) |
| **Joint venture** | "Solana Naming Consortium" - unified governance, separate products |

**Value**: Strategic optionality, potential exit/growth path

#### 5. Shared Infrastructure
Both are naming registries with similar mechanics:
- Registration, renewal, expiration, grace periods
- Could share: admin tooling, renewal UX, keeper economics, oracle feeds

**Value**: Reduced development costs, operational synergies

---

## Recommendations

### Immediate Actions

1. **SNS**: Reach out with the "Unified SDK" pitch
   - No code changes needed
   - Pure co-marketing and developer tooling
   - Easy win, builds relationship

2. **D3**: Explore the RWA/brand bundle angle
   - TNS's reserved TradFi symbols are a unique asset
   - D3's DNS legitimacy + TNS symbol verification = compelling RWA story

### Longer Term

3. **Evaluate on-chain SNS integration** based on user demand
   - Monitor if "multiple domains per owner" becomes a real problem
   - Implementation is straightforward if needed (3-5 hours)

4. **D3 strategic discussions**
   - Assess their funding/acquisition interest
   - TNS's RWA focus could be attractive for their roadmap

---

## References

- [SNS Registry Structure](https://sns.guide/registry.html)
- [SNS Cookbook](https://solanacookbook.com/references/name-service.html)
- [SNS Guide](https://sns.guide/)
