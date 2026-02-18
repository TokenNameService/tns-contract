use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, StateWithExtensions},
    state::Mint as Token2022Mint,
};
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use mpl_token_metadata::accounts::Metadata;
use crate::{
    Config, Token, TnsError,
    MAX_SYMBOL_LENGTH, MAX_REGISTRATION_YEARS, SECONDS_PER_YEAR,
    symbol_status::{get_symbol_status, SymbolStatus},
};

/// Validate common requirements for registration and renewal
pub fn validate_not_paused(config: &Config) -> Result<()> {
    require!(!config.paused, TnsError::Paused);
    
    Ok(())
}

/// Validate symbol format: length only (case-sensitive, preserves original case)
pub fn validate_symbol_format(symbol: &str) -> Result<String> {
    require!(
        !symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LENGTH,
        TnsError::InvalidSymbolLength
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

/// Validate phase access for registration
/// Returns Ok(()) if the payer is allowed to register this symbol
///
/// Phase logic:
/// - Phase 1 (Genesis): Admin only - verified tokens are seeded by admin scripts
/// - Phase 2 (Open): Anyone can register, except TradFi reserved symbols (admin only)
/// - Phase 3+: No restrictions - anyone can register anything (RWA tokenization)
pub fn validate_registration_access(
  config: &Config,
  symbol: &str,
  _mint: &Pubkey,
  payer: &Pubkey,
  _token_mint: &Mint,
) -> Result<()> {
  let symbol_status = get_symbol_status(symbol);

  // Phase 1 (Genesis): Admin-controlled
  // Verified tokens are seeded via admin scripts, not user registration
  if config.phase == 1 {
      require!(*payer == config.admin, TnsError::AdminOnlyRegistration);

  // Phase 2 (Open): Anyone can register, except reserved TradFi symbols
  } else if config.phase == 2 && matches!(symbol_status, SymbolStatus::ReservedTradfi) {
      require!(*payer == config.admin, TnsError::SymbolReserved);
  }
  // Phase 3+: No restrictions - anyone can register anything

  Ok(())
}

/// Token-2022 program ID
use anchor_spl::token_2022::ID as TOKEN_2022_PROGRAM_ID;

/// Try to extract symbol from Token-2022 metadata extension.
/// Returns Some(symbol) if successful, None if no metadata extension.
fn try_get_token2022_symbol(mint_info: &AccountInfo) -> Option<String> {
    let data = mint_info.data.borrow();

    // Try to parse as Token-2022 mint with extensions
    let mint_with_ext = StateWithExtensions::<Token2022Mint>::unpack(&data).ok()?;

    // Try to get the TokenMetadata extension
    let metadata = mint_with_ext.get_variable_len_extension::<TokenMetadata>().ok()?;

    Some(metadata.symbol.clone())
}

/// Parse and validate a mint's Metaplex metadata account.
/// Returns the deserialized Metadata if valid.
pub fn parse_metadata(
    metadata_info: &AccountInfo,
    mint: &Pubkey,
) -> Result<Metadata> {
    let (expected_pda_key, _) = Metadata::find_pda(mint);

    require!(metadata_info.key() == expected_pda_key, TnsError::InvalidMetadata);

    Metadata::safe_deserialize(&metadata_info.data.borrow())
        .map_err(|_| TnsError::InvalidMetadata.into())
}

/// Extract the symbol from a mint's metadata.
/// Supports both Metaplex metadata and Token-2022 metadata extensions.
///
/// SECURITY: Enforces correct metadata type based on mint program:
/// - Token-2022 mints MUST pass mint as metadata_info (embedded metadata)
/// - Classic SPL mints MUST pass Metaplex metadata PDA as metadata_info
///
/// Returns the symbol string if successful.
pub fn extract_metadata_symbol(
    metadata_info: &AccountInfo,
    mint_info: &AccountInfo,
) -> Result<String> {
    let is_token_2022 = mint_info.owner == &TOKEN_2022_PROGRAM_ID;

    if is_token_2022 {
        // Token-2022: metadata MUST be the mint itself (embedded metadata extension)
        require!(
            metadata_info.key() == mint_info.key(),
            TnsError::InvalidMetadata
        );

        let symbol = try_get_token2022_symbol(metadata_info)
            .ok_or(TnsError::InvalidMetadata)?;

        Ok(symbol)
    } else {
        // Classic SPL Token: metadata MUST be Metaplex metadata PDA
        require!(
            metadata_info.key() != mint_info.key(),
            TnsError::InvalidMetadata
        );

        let metadata = parse_metadata(metadata_info, &mint_info.key())?;
        let metadata_symbol = metadata.symbol.trim_matches('\0').to_string();

        Ok(metadata_symbol)
    }
}

/// Validate mint's metadata symbol matches expected symbol exactly (case-sensitive).
pub fn validate_mint_metadata(
    metadata_info: &AccountInfo,
    mint_info: &AccountInfo,
    expected_symbol: &str,
) -> Result<()> {
    let symbol = extract_metadata_symbol(metadata_info, mint_info)?;

    require!(
        symbol == expected_symbol,
        TnsError::MetadataSymbolMismatch
    );

    Ok(())
}

