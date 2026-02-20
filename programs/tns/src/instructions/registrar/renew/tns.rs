use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use crate::{
    Config, Token, SymbolRenewed, TnsError, TNS_MINT, TNS_DISCOUNT_BPS,
    PUMP_POOL_TNS_RESERVE, PUMP_POOL_SOL_RESERVE, calculate_tns_for_usd,
};
use super::super::helpers::{
    validate_not_paused, validate_symbol_not_expired,
    validate_and_calculate_expiration, validate_platform_fee_bps,
    transfer_token_fees_with_platform, PlatformTokenFeeAccounts,
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
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [Token::SEED_PREFIX, token_account.symbol.as_bytes()],
        bump = token_account.bump,
    )]
    pub token_account: Box<Account<'info, Token>>,

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

    // Pool pricing accounts for TNS market price

    /// Pyth pull oracle price update account (ownership verified by SDK)
    pub price_update: Account<'info, PriceUpdateV2>,

    /// CHECK: Pool's TNS reserve token account - validated against constant
    #[account(address = PUMP_POOL_TNS_RESERVE @ TnsError::InvalidPoolReserve)]
    pub pool_tns_reserve: AccountInfo<'info>,

    /// CHECK: Pool's SOL reserve token account - validated against constant
    #[account(address = PUMP_POOL_SOL_RESERVE @ TnsError::InvalidPoolReserve)]
    pub pool_sol_reserve: AccountInfo<'info>,
}

pub fn handler(ctx: Context<RenewSymbolTns>, years: u8, platform_fee_bps: u16) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate
    validate_not_paused(config)?;

    validate_symbol_not_expired(&ctx.accounts.token_account, clock.unix_timestamp)?;

    let old_expires_at = ctx.accounts.token_account.expires_at;

    let new_expires_at = validate_and_calculate_expiration(
        old_expires_at,
        years,
        clock.unix_timestamp,
    )?;

    validate_platform_fee_bps(platform_fee_bps)?;

    // Calculate fee in USD
    // No keeper reward for renewals
    let fee_usd_micro = config.calculate_registration_price_usd(clock.unix_timestamp, years);

    // Convert to TNS tokens at market price from DEX pool
    let tns_amount = calculate_tns_for_usd(
        fee_usd_micro,
        &ctx.accounts.pool_tns_reserve,
        &ctx.accounts.pool_sol_reserve,
        &ctx.accounts.price_update,
    )?;

    // Apply 25% discount for TNS payments
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_treasury_amount = tns_amount - discount;

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
        token_account: ctx.accounts.token_account.key(),
        symbol: ctx.accounts.token_account.symbol.clone(),
        renewed_by: ctx.accounts.payer.key(),
        owner: ctx.accounts.token_account.owner,
        years,
        fee_paid: tns_treasury_amount,
        platform_fee: platform_fee_paid,
        old_expires_at,
        new_expires_at,
        renewed_at: clock.unix_timestamp,
    });

    Ok(())
}
