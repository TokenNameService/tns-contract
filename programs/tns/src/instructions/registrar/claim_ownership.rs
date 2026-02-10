use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use mpl_token_metadata::accounts::Metadata;
use crate::{Config, Token, OwnershipClaimed, TnsError};
use super::helpers::validate_not_paused;

/// Claim ownership of a TNS record by proving token authority.
///
/// This allows the rightful owner of a token to claim the TNS record
/// even if someone else registered it first. Three paths to claim:
///
/// 1. **Mint authority**: If you control the mint authority, you control the token
/// 2. **Metadata update authority**: If you control metadata, you control the brand
/// 3. **Majority holder (>50%)**: If you hold majority supply, you have economic control
///
/// This creates a clear ownership hierarchy:
/// - Token authority = ultimate control (can always reclaim)
/// - TNS owner = delegated control (can be claimed by authority)
///
/// Note: If you transfer TNS ownership to someone, they should verify you've
/// also transferred or burned your token authorities, otherwise you can reclaim.
#[derive(Accounts)]
pub struct ClaimOwnership<'info> {
    /// The claimant - must be mint authority, update authority, or majority holder
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Token::SEED_PREFIX, token_account.symbol.as_bytes()],
        bump = token_account.bump,
    )]
    pub token_account: Account<'info, Token>,

    /// The token mint that this symbol is registered to
    #[account(
        constraint = token_mint.key() == token_account.mint @ TnsError::InvalidMint
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account - validated in handler
    pub token_metadata: AccountInfo<'info>,

    /// The claimant's token account for the mint (for majority holder check)
    /// Optional - only needed if claiming via majority holder path
    #[account(
        token::mint = token_mint,
        token::authority = claimant,
    )]
    pub claimant_token_account: Option<InterfaceAccount<'info, TokenAccount>>,
}

pub fn handler(ctx: Context<ClaimOwnership>) -> Result<()> {
    let clock = Clock::get()?;
    let claimant = ctx.accounts.claimant.key();
    let token_mint = &ctx.accounts.token_mint;
    let token_metadata_info = &ctx.accounts.token_metadata;

    // Validate not paused
    validate_not_paused(&ctx.accounts.config)?;

    // Can't claim if already owner
    require!(
        ctx.accounts.token_account.owner != claimant,
        TnsError::AlreadyOwner
    );

    // Verify metadata account is the correct PDA for this mint
    let (expected_metadata_key, _) = Metadata::find_pda(&token_mint.key());
    require!(
        token_metadata_info.key() == expected_metadata_key,
        TnsError::InvalidMetadata
    );

    // Deserialize metadata to get update authority
    let metadata = Metadata::safe_deserialize(&token_metadata_info.data.borrow())
        .map_err(|_| TnsError::InvalidMetadata)?;

    // Check path 1: Mint authority
    let is_mint_authority = token_mint.mint_authority
        .map(|auth| auth == claimant)
        .unwrap_or(false);

    // Check path 2: Metadata update authority
    let is_update_authority = metadata.update_authority == claimant;

    // Check path 3: Majority holder (>50% of supply)
    let is_majority_holder = if let Some(claimant_token_account) = &ctx.accounts.claimant_token_account {
        let total_supply = token_mint.supply;
        if total_supply > 0 {
            let claimant_balance = claimant_token_account.amount;
            // Must hold MORE than 50%
            claimant_balance > total_supply / 2
        } else {
            false
        }
    } else {
        false
    };

    // Must satisfy at least one path
    require!(
        is_mint_authority || is_update_authority || is_majority_holder,
        TnsError::NotTokenAuthority
    );

    // Determine claim type for event
    let claim_type = if is_mint_authority {
        "mint_authority"
    } else if is_update_authority {
        "update_authority"
    } else {
        "majority_holder"
    };

    // Capture old owner before mutation
    let old_owner = ctx.accounts.token_account.owner;

    // Transfer ownership to claimant
    ctx.accounts.token_account.owner = claimant;

    emit!(OwnershipClaimed {
        token_account: ctx.accounts.token_account.key(),
        symbol: ctx.accounts.token_account.symbol.clone(),
        old_owner,
        new_owner: claimant,
        claim_type: claim_type.to_string(),
        claimed_at: clock.unix_timestamp,
    });

    Ok(())
}
