use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use mpl_token_metadata::accounts::Metadata;
use crate::{
    Config, Token, TnsError,
    MAX_SYMBOL_LENGTH, MAX_REGISTRATION_YEARS, SECONDS_PER_YEAR,
    whitelist::{get_symbol_status, SymbolStatus},
};

/// Validate common requirements for registration and renewal
pub fn validate_not_paused(config: &Config) -> Result<()> {
    require!(!config.paused, TnsError::Paused);
    
    Ok(())
}

/// Validate symbol format: length and uppercase requirement
pub fn validate_symbol_format(symbol: &str) -> Result<String> {
    require!(
        !symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LENGTH,
        TnsError::InvalidSymbolLength
    );

    // Symbol must be uppercase (no lowercase letters allowed)
    require!(
        !symbol.chars().any(|c| c.is_lowercase()),
        TnsError::SymbolMustBeUppercase
    );

    Ok(symbol.to_string())
}

/// Validate years (1-10) and that expiration doesn't exceed 10 years from now
/// Works for both registration (base_time = now) and renewal (base_time = current expires_at)
/// Returns the calculated expiration timestamp
pub fn validate_and_calculate_expiration(
    base_time: i64,
    years: u8,
    current_time: i64,
) -> Result<i64> {
    require!(years >= 1, TnsError::InvalidYears);

    let expires_at = base_time + (years as i64 * SECONDS_PER_YEAR);
    let max_allowed = current_time + (MAX_REGISTRATION_YEARS as i64 * SECONDS_PER_YEAR);

    require!(expires_at <= max_allowed, TnsError::ExceedsMaxYears);

    Ok(expires_at)
}

/// Validate symbol is not fully expired (past grace period)
/// Used for renewal and update operations
pub fn validate_symbol_not_expired(token: &Token, current_time: i64) -> Result<()> {
    require!(!token.is_expired(current_time), TnsError::SymbolExpired);

    Ok(())
}

/// Validate new mint is different from current mint
pub fn validate_mint_different(current_mint: &Pubkey, new_mint: &Pubkey) -> Result<()> {
    require!(current_mint != new_mint, TnsError::SameMint);

    Ok(())
}

/// Validate SOL cost doesn't exceed max specified (slippage protection)
pub fn validate_slippage(actual_cost: u64, max_cost: u64) -> Result<()> {
    require!(actual_cost <= max_cost, TnsError::SlippageExceeded);
    
    Ok(())
}

/// Validate symbol is expired (past grace period) and can be claimed
pub fn validate_symbol_claimable(token: &Token, current_time: i64) -> Result<()> {
    require!(token.is_expired(current_time), TnsError::SymbolNotExpired);
    
    Ok(())
}

/// Validate symbol is cancelable (1 year past grace period)
pub fn validate_symbol_cancelable(token: &Token, current_time: i64) -> Result<()> {
    require!(token.is_cancelable(current_time), TnsError::NotYetCancelable);
    
    Ok(())
}

/// Validate platform fee BPS doesn't exceed maximum (10%)
pub fn validate_platform_fee_bps(platform_fee_bps: u16) -> Result<()> {
    require!(
        platform_fee_bps <= crate::MAX_PLATFORM_FEE_BPS,
        TnsError::PlatformFeeExceedsMax
    );
    
    Ok(())
}

/// Validate whitelist/phase access for registration
/// Returns Ok(()) if the payer is allowed to register this symbol
pub fn validate_registration_access(
  config: &Config,
  symbol: &str,
  mint: &Pubkey,
  payer: &Pubkey,
  token_mint: &Mint,
) -> Result<()> {
  let symbol_status = get_symbol_status(symbol);

  // Phase 1 (Genesis): Everything admin-controlled except verified tokens
  if config.phase == 1 {
      if let SymbolStatus::Verified(whitelisted_mint) = symbol_status {
          require!(*mint == whitelisted_mint, TnsError::WhitelistMintMismatch);
          
          let mint_authority = token_mint.mint_authority;
          
          require!(
              mint_authority.is_some() && mint_authority.unwrap() == *payer,
              TnsError::NotMintAuthority
          );
      } else if matches!(symbol_status, SymbolStatus::Reserved(_)) {
          // Reserved symbols require admin
          require!(*payer == config.admin, TnsError::SymbolReserved);
      } else {
          // NotListed requires admin in Phase 1
          require!(*payer == config.admin, TnsError::AdminOnlyRegistration);
      }
  
  // Phase 2 (Open): NotListed opens up, reserved stays protected
  } else if config.phase == 2 {
      if let SymbolStatus::Verified(whitelisted_mint) = symbol_status {
          require!(*mint == whitelisted_mint, TnsError::WhitelistMintMismatch);
          
          let mint_authority = token_mint.mint_authority;
          
          require!(
              mint_authority.is_some() && mint_authority.unwrap() == *payer,
              TnsError::NotMintAuthority
          );
      } else if matches!(symbol_status, SymbolStatus::Reserved(_)) {
          // Reserved symbols require admin
          require!(*payer == config.admin, TnsError::SymbolReserved);
      }
      // NotListed: no restrictions
  }
  // Phase 3+: No restrictions - anyone can register anything

  Ok(())
}

/// Validate mint's Metaplex metadata:
/// 1. Metadata account key matches the derived PDA for the mint
/// 2. Metadata symbol is uppercase
/// 3. Symbol matches the expected symbol exactly
/// 4. Metadata is immutable (is_mutable == false)
pub fn validate_mint_metadata(
    metadata_info: &AccountInfo,
    mint: &Pubkey,
    expected_symbol: &str,
) -> Result<()> {
    // Verify metadata account key matches the derived PDA
    let (expected_pda_key, _) = Metadata::find_pda(mint);

    require!(metadata_info.key() == expected_pda_key, TnsError::InvalidMetadata);

    // Deserialize metadata account
    let metadata = Metadata::safe_deserialize(&metadata_info.data.borrow())
        .map_err(|_| TnsError::InvalidMetadata)?;

    // Trim null bytes from Metaplex padding (pads to fixed 10-byte length)
    let metadata_symbol = metadata.symbol.trim_matches('\0');

    // Metadata symbol must be uppercase (no lowercase letters allowed)
    require!(
        !metadata_symbol.chars().any(|c| c.is_lowercase()),
        TnsError::MetadataSymbolMustBeUppercase
    );

    // Symbol must match exactly
    require!(
        metadata_symbol == expected_symbol,
        TnsError::MetadataSymbolMismatch
    );

    // Must be immutable
    require!(!metadata.is_mutable, TnsError::MetadataMustBeImmutable);

    Ok(())
}

