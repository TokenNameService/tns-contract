use anchor_lang::prelude::*;
use crate::Token;

/// Data needed to initialize a new symbol account
pub struct SymbolInitData {
    pub symbol: String,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub current_time: i64,
    pub expires_at: i64,
    pub bump: u8,
}

/// Initialize a new symbol account
pub fn initialize_token_account(token_account: &mut Token, data: SymbolInitData) {
    token_account.symbol = data.symbol;
    token_account.mint = data.mint;
    token_account.owner = data.owner;
    token_account.registered_at = data.current_time;
    token_account.expires_at = data.expires_at;
    token_account.bump = data.bump;
    token_account._reserved = [0u8; 64];
}

/// Update symbol expiration on renewal
pub fn update_symbol_on_renewal(
    token_account: &mut Token,
    new_expires_at: i64,
) {
    token_account.expires_at = new_expires_at;
}

/// Update symbol mint
pub fn update_symbol_mint(
    token_account: &mut Token,
    new_mint: Pubkey,
) {
    token_account.mint = new_mint;
}

/// Update symbol owner
pub fn update_symbol_owner(token_account: &mut Token, new_owner: Pubkey) {
    token_account.owner = new_owner;
}

/// Data needed to claim an expired symbol
pub struct SymbolClaimData {
    pub new_mint: Pubkey,
    pub new_owner: Pubkey,
    pub expires_at: i64,
}

/// Update symbol when claimed by new owner
/// Resets mint, owner, and expiration but preserves symbol string, registered_at, and bump
pub fn update_symbol_on_claim(token_account: &mut Token, data: SymbolClaimData) {
    token_account.mint = data.new_mint;
    token_account.owner = data.new_owner;
    token_account.expires_at = data.expires_at;
    // registered_at, symbol, bump, and _reserved are preserved
}
