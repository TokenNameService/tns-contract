use anchor_lang::prelude::*;

/// Emitted when a new symbol is registered
#[event]
pub struct SymbolRegistered {
    /// The PDA address of the Symbol account
    pub token_account: Pubkey,
    /// The symbol string (e.g., "BONK")
    pub symbol: String,
    /// The mint this symbol is registered to
    pub mint: Pubkey,
    /// Who registered and owns the symbol
    pub owner: Pubkey,
    /// Number of years registered for
    pub years: u8,
    /// Registration fee paid (total cost to user)
    pub fee_paid: u64,
    /// Platform fee paid to referrer/launchpad (0 if none)
    pub platform_fee: u64,
    /// Unix timestamp of registration
    pub registered_at: i64,
    /// Unix timestamp when registration expires
    pub expires_at: i64,
}

/// Emitted when a symbol is renewed
#[event]
pub struct SymbolRenewed {
    /// The PDA address of the Symbol account
    pub token_account: Pubkey,
    /// The symbol string
    pub symbol: String,
    /// Who renewed (anyone can renew for anyone)
    pub renewed_by: Pubkey,
    /// The owner of the symbol
    pub owner: Pubkey,
    /// Number of years added
    pub years: u8,
    /// Renewal fee paid (total cost to user)
    pub fee_paid: u64,
    /// Platform fee paid to referrer (0 if none)
    pub platform_fee: u64,
    /// Previous expiration timestamp
    pub old_expires_at: i64,
    /// New expiration timestamp
    pub new_expires_at: i64,
    /// Unix timestamp of renewal
    pub renewed_at: i64,
}

/// Emitted when an expired symbol is claimed by a new owner
#[event]
pub struct SymbolClaimed {
    /// The PDA address of the Symbol account
    pub token_account: Pubkey,
    /// The symbol string
    pub symbol: String,
    /// Previous owner who lost the symbol
    pub previous_owner: Pubkey,
    /// Previous mint that was registered
    pub previous_mint: Pubkey,
    /// New owner who claimed the symbol
    pub new_owner: Pubkey,
    /// New mint registered to the symbol
    pub new_mint: Pubkey,
    /// Number of years registered for
    pub years: u8,
    /// Fee paid (total cost to user)
    pub fee_paid: u64,
    /// Platform fee paid to referrer (0 if none)
    pub platform_fee: u64,
    /// Unix timestamp
    pub claimed_at: i64,
    /// New expiration timestamp
    pub expires_at: i64,
}

/// Emitted when an abandoned symbol is canceled (account closed)
#[event]
pub struct SymbolCanceled {
    /// The PDA address of the Symbol account (now closed)
    pub token_account: Pubkey,
    /// The symbol string (now available for fresh registration)
    pub symbol: String,
    /// Previous owner who abandoned the symbol
    pub previous_owner: Pubkey,
    /// Previous mint that was registered
    pub previous_mint: Pubkey,
    /// Who called cancel (keeper who receives rent)
    pub canceled_by: Pubkey,
    /// Unix timestamp
    pub canceled_at: i64,
    /// Rent returned to keeper in lamports
    pub rent_returned: u64,
}

/// Emitted when a symbol's mint is updated (symbol transferred to new token)
#[event]
pub struct MintUpdated {
    /// The PDA address of the Symbol account
    pub token_account: Pubkey,
    /// The symbol string
    pub symbol: String,
    /// The previous mint
    pub old_mint: Pubkey,
    /// The new mint
    pub new_mint: Pubkey,
    /// Who authorized the update
    pub owner: Pubkey,
    /// Fee paid (total cost to user)
    pub fee_paid: u64,
    /// Platform fee paid to referrer (0 if none)
    pub platform_fee: u64,
    /// Unix timestamp
    pub updated_at: i64,
}

/// Emitted when symbol ownership is transferred
#[event]
pub struct OwnershipTransferred {
    /// The PDA address of the Symbol account
    pub token_account: Pubkey,
    /// The symbol string
    pub symbol: String,
    /// Previous owner
    pub old_owner: Pubkey,
    /// New owner
    pub new_owner: Pubkey,
    /// Unix timestamp
    pub transferred_at: i64,
}

/// Emitted when token authority claims ownership of a symbol
#[event]
pub struct OwnershipClaimed {
    /// The PDA address of the Symbol account
    pub token_account: Pubkey,
    /// The symbol string
    pub symbol: String,
    /// Previous owner (who lost ownership)
    pub old_owner: Pubkey,
    /// New owner (the claimant)
    pub new_owner: Pubkey,
    /// How ownership was claimed: "mint_authority", "update_authority", or "majority_holder"
    pub claim_type: String,
    /// Unix timestamp
    pub claimed_at: i64,
}

/// Emitted when config is updated
#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub fee_collector: Pubkey,
    pub base_price_usd_micro: u64,
    pub annual_increase_bps: u16,
    pub keeper_reward_lamports: u64,
    pub tns_usd_pyth_feed: Option<Pubkey>,
    pub paused: bool,
    pub phase: u8,
}

/// Emitted when the protocol is initialized
#[event]
pub struct ProtocolInitialized {
    /// The config PDA address
    pub config: Pubkey,
    /// The admin authority
    pub admin: Pubkey,
    /// The fee collector
    pub fee_collector: Pubkey,
    /// SOL/USD Pyth price feed
    pub sol_usd_pyth_feed: Pubkey,
    /// Base price in USD micro-cents
    pub base_price_usd_micro: u64,
    /// Unix timestamp of initialization
    pub initialized_at: i64,
}

/// Emitted when admin seeds a symbol for genesis bootstrap
#[event]
pub struct SymbolSeeded {
    /// The PDA address of the Token account
    pub token_account: Pubkey,
    /// The symbol string (e.g., "SOL")
    pub symbol: String,
    /// The mint this symbol is registered to
    pub mint: Pubkey,
    /// Owner (update authority)
    pub owner: Pubkey,
    /// Number of years registered for
    pub years: u8,
    /// Unix timestamp of seeding
    pub seeded_at: i64,
    /// Unix timestamp when registration expires
    pub expires_at: i64,
}

/// Emitted when admin force-updates a symbol
#[event]
pub struct SymbolUpdatedByAdmin {
    /// The PDA address of the Token account
    pub token_account: Pubkey,
    /// The symbol string
    pub symbol: String,
    /// Previous owner
    pub old_owner: Pubkey,
    /// New owner (may be same as old)
    pub new_owner: Pubkey,
    /// Previous mint
    pub old_mint: Pubkey,
    /// New mint (may be same as old)
    pub new_mint: Pubkey,
    /// Previous expiration timestamp
    pub old_expires_at: i64,
    /// New expiration timestamp (may be same as old)
    pub new_expires_at: i64,
    /// Admin who made the update
    pub admin: Pubkey,
    /// Unix timestamp of update
    pub updated_at: i64,
}

/// Emitted when admin force-closes a symbol
#[event]
pub struct SymbolClosedByAdmin {
    /// The PDA address of the Token account (now closed)
    pub token_account: Pubkey,
    /// The symbol string (now available for fresh registration)
    pub symbol: String,
    /// Previous owner
    pub previous_owner: Pubkey,
    /// Previous mint
    pub previous_mint: Pubkey,
    /// Admin who closed it
    pub admin: Pubkey,
    /// Unix timestamp
    pub closed_at: i64,
}

/// Emitted when symbol drift is detected and account is closed
#[event]
pub struct SymbolDriftDetected {
    /// The PDA address of the Token account (now closed)
    pub token_account: Pubkey,
    /// The registered symbol (what TNS had stored)
    pub symbol: String,
    /// The new metadata symbol (what the owner changed it to)
    pub new_metadata_symbol: String,
    /// The mint address
    pub mint: Pubkey,
    /// Previous owner who lost their registration
    pub previous_owner: Pubkey,
    /// Keeper who detected the drift and receives rent
    pub keeper: Pubkey,
    /// Unix timestamp when drift was detected
    pub detected_at: i64,
    /// Rent returned to keeper in lamports
    pub rent_returned: u64,
}
