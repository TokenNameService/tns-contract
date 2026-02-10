use anchor_lang::prelude::*;
use crate::{GRACE_PERIOD_SECONDS, CANCEL_PERIOD_SECONDS};

/// The Token account - represents ownership of a unique token symbol
/// PDA seeds: ["token", symbol_bytes]
#[account]
#[derive(InitSpace)]
pub struct Token {
    /// The symbol/ticker (e.g., "BONK", "mSOL") - case-sensitive
    #[max_len(10)]
    pub symbol: String,

    /// The SPL token mint that this symbol resolves to
    pub mint: Pubkey,

    /// The owner who can update the mint or transfer ownership
    pub owner: Pubkey,

    /// Unix timestamp when first registered (for trust/provenance)
    pub registered_at: i64,

    /// PDA bump seed
    pub bump: u8,

    /// Unix timestamp when registration expires (might remove if the community decides on a no-expiration model)
    pub expires_at: i64,

    /// Reserved for future use
    pub _reserved: [u8; 64],
}

impl Token {
    pub const SEED_PREFIX: &'static [u8] = b"token";

    /// Check if token is expired (past expiration + grace period)
    pub fn is_expired(&self, current_time: i64) -> bool {
        current_time > self.expires_at + GRACE_PERIOD_SECONDS
    }

    /// Check if token is in grace period
    pub fn is_in_grace_period(&self, current_time: i64) -> bool {
        current_time > self.expires_at && current_time <= self.expires_at + GRACE_PERIOD_SECONDS
    }

    /// Check if token is active (not expired, not in grace)
    pub fn is_active(&self, current_time: i64) -> bool {
        current_time <= self.expires_at
    }

    /// Check if token can be canceled (1 year after grace period ends)
    pub fn is_cancelable(&self, current_time: i64) -> bool {
        current_time > self.expires_at + GRACE_PERIOD_SECONDS + CANCEL_PERIOD_SECONDS
    }
}
