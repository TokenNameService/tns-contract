use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{Config, Token, SymbolRenewed, TnsError, TNS_MINT, TNS_DISCOUNT_BPS};
use super::super::helpers::{
    validate_not_paused, validate_years, validate_symbol_not_expired,
    validate_and_calculate_expiration, validate_platform_fee_bps,
    transfer_token_fees_with_platform, PlatformTokenFeeAccounts, usd_micro_to_token_amount,
    update_symbol_on_renewal,
};

#[derive(Accounts)]
pub struct RenewSymbolTns<'info> {
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

    // TNS Payment Accounts

    pub token_program: Interface<'info, TokenInterface>,

    #[account(address = TNS_MINT @ TnsError::InvalidMint)]
    pub tns_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = tns_mint,
        token::authority = payer,
    )]
    pub payer_tns_account: InterfaceAccount<'info, TokenAccount>,

    /// Fee collector's TNS token account (ATA must be created by admin beforehand)
    #[account(
        mut,
        token::mint = tns_mint,
    )]
    pub fee_collector_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Platform fee recipient token account. Validated in handler if provided.
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<RenewSymbolTns>, years: u8, platform_fee_bps: u16) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate
    validate_not_paused(config)?;
    validate_years(years)?;
    validate_platform_fee_bps(platform_fee_bps)?;
    validate_symbol_not_expired(&ctx.accounts.token_account, clock.unix_timestamp)?;

    // Calculate new expiration - extend from current expires_at
    let old_expires_at = ctx.accounts.token_account.expires_at;
    let new_expires_at = validate_and_calculate_expiration(
        old_expires_at,
        years,
        clock.unix_timestamp,
    )?;

    // Calculate fee in USD (TNS uses $1 peg or oracle)
    // No keeper reward for renewals
    let fee_usd_micro = config.calculate_registration_price_usd(clock.unix_timestamp, years);

    // Calculate TNS amount based on oracle or $1 peg
    let tns_amount = if config.has_tns_oracle() {
        // For now, use $1 peg (oracle integration can be added later)
        usd_micro_to_token_amount(fee_usd_micro)
    } else {
        // Pre-oracle: 1 TNS = $1
        usd_micro_to_token_amount(fee_usd_micro)
    };

    // Apply 25% discount for TNS payments
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_treasury_amount = tns_amount - discount;

    let token_account_key = ctx.accounts.token_account.key();
    let symbol_str = ctx.accounts.token_account.symbol.clone();
    let owner_key = ctx.accounts.token_account.owner;
    let payer_key = ctx.accounts.payer.key();

    // Transfer TNS tokens (with 25% discount) with optional platform fee split
    let platform_fee_paid = transfer_token_fees_with_platform(
        &PlatformTokenFeeAccounts {
            payer: &ctx.accounts.payer,
            payer_token_account: &ctx.accounts.payer_tns_account,
            vault: &ctx.accounts.fee_collector_ata,
            platform_token_account: ctx.accounts.platform_fee_account.as_ref(),
            mint: &ctx.accounts.tns_mint,
            token_program: &ctx.accounts.token_program,
        },
        tns_treasury_amount,
        platform_fee_bps,
    )?;

    // Update symbol
    update_symbol_on_renewal(
        &mut ctx.accounts.token_account,
        new_expires_at,
    );

    emit!(SymbolRenewed {
        token_account: token_account_key,
        symbol: symbol_str,
        renewed_by: payer_key,
        owner: owner_key,
        years,
        fee_paid: tns_treasury_amount,
        platform_fee: platform_fee_paid,
        old_expires_at,
        new_expires_at,
        renewed_at: clock.unix_timestamp,
    });

    Ok(())
}
