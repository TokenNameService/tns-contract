use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{Config, Token, SymbolClaimed, TnsError, USDT_MINT};
use super::super::helpers::{
    validate_not_paused, validate_years, validate_symbol_claimable,
    validate_and_calculate_expiration, validate_platform_fee_bps,
    transfer_token_fees_with_platform, PlatformTokenFeeAccounts, usd_micro_to_token_amount,
    update_symbol_on_claim, SymbolClaimData,
};

/// Claim an expired symbol with USDT payment
/// No keeper reward - the original registration already funded the keeper pool
#[derive(Accounts)]
pub struct ClaimExpiredSymbolUsdt<'info> {
    /// Shared Accounts

    #[account(mut)]
    pub payer: Signer<'info>,

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

    pub system_program: Program<'info, System>,

    // USDT Payment Accounts

    pub token_program: Interface<'info, TokenInterface>,

    #[account(address = USDT_MINT @ TnsError::InvalidMint)]
    pub usdt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = payer,
    )]
    pub payer_usdt_account: InterfaceAccount<'info, TokenAccount>,

    /// Fee collector's USDT token account (ATA must be created by admin beforehand)
    #[account(
        mut,
        token::mint = usdt_mint,
    )]
    pub fee_collector_ata: InterfaceAccount<'info, TokenAccount>,

    /// The new mint to register the symbol to (validated as a real mint)
    pub new_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Platform fee recipient token account. Validated in handler if provided.
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,
}

pub fn handler(
    ctx: Context<ClaimExpiredSymbolUsdt>,
    years: u8,
    platform_fee_bps: u16,
) -> Result<()> {
    let new_mint = ctx.accounts.new_mint.key();
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate
    validate_not_paused(config)?;
    validate_years(years)?;
    validate_platform_fee_bps(platform_fee_bps)?;
    validate_symbol_claimable(&ctx.accounts.token_account, clock.unix_timestamp)?;

    // Calculate new expiration from now
    let expires_at = validate_and_calculate_expiration(
        clock.unix_timestamp,
        years,
        clock.unix_timestamp,
    )?;

    // Calculate fee in USD (no Pyth needed - USDT = $1)
    let fee_usd_micro = config.calculate_registration_price_usd(clock.unix_timestamp, years);

    // Convert to USDT token amount
    let usdt_amount = usd_micro_to_token_amount(fee_usd_micro);

    // Capture previous values for event
    let token_account_key = ctx.accounts.token_account.key();
    let symbol_str = ctx.accounts.token_account.symbol.clone();
    let previous_owner = ctx.accounts.token_account.owner;
    let previous_mint = ctx.accounts.token_account.mint;
    let new_owner = ctx.accounts.payer.key();

    // Transfer USDT with platform split (no keeper reward - original registration funded keeper pool)
    let platform_fee_paid = transfer_token_fees_with_platform(
        &PlatformTokenFeeAccounts {
            payer: &ctx.accounts.payer,
            payer_token_account: &ctx.accounts.payer_usdt_account,
            vault: &ctx.accounts.fee_collector_ata,
            platform_token_account: ctx.accounts.platform_fee_account.as_ref(),
            mint: &ctx.accounts.usdt_mint,
            token_program: &ctx.accounts.token_program,
        },
        usdt_amount,
        platform_fee_bps,
    )?;

    // Update symbol with new owner and mint
    update_symbol_on_claim(
        &mut ctx.accounts.token_account,
        SymbolClaimData {
            new_mint,
            new_owner,
            expires_at,
        },
    );

    emit!(SymbolClaimed {
        token_account: token_account_key,
        symbol: symbol_str,
        previous_owner,
        previous_mint,
        new_owner,
        new_mint,
        years,
        fee_paid: usdt_amount,
        platform_fee: platform_fee_paid,
        claimed_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
