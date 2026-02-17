use anchor_lang::prelude::*;
use crate::{Config, Token, SymbolRenewed, TnsError};
use super::super::helpers::{
    validate_not_paused, validate_symbol_not_expired,
    validate_and_calculate_expiration, validate_slippage, validate_platform_fee_bps,
    calculate_fees_sol, transfer_sol_fees_with_platform, update_symbol_on_renewal,
};

#[derive(Accounts)]
pub struct RenewSymbolSol<'info> {
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

    // Solana Payment Accounts

    /// CHECK: Fee collector receives renewal fee
    #[account(
        mut,
        address = config.fee_collector,
    )]
    pub fee_collector: AccountInfo<'info>,

    /// CHECK: Pyth SOL/USD price feed account
    #[account(
        constraint = sol_usd_price_feed.key() == config.sol_usd_pyth_feed @ TnsError::PriceFeedMismatch
    )]
    pub sol_usd_price_feed: AccountInfo<'info>,

    /// CHECK: Optional platform fee recipient
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,
}

pub fn handler(
    ctx: Context<RenewSymbolSol>,
    years: u8,
    max_sol_cost: u64,
    platform_fee_bps: u16,
) -> Result<()> {
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

    // Calculate fees (no keeper reward for renewals)
    let fees = calculate_fees_sol(
        config,
        clock.unix_timestamp,
        years,
        &ctx.accounts.sol_usd_price_feed,
    )?;

    // Validate slippage (fee only, no keeper reward for renewals)
    validate_slippage(fees.fee_lamports, max_sol_cost)?;

    // Transfer fee with optional platform fee split
    let platform_fee_paid = transfer_sol_fees_with_platform(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.fee_collector,
        ctx.accounts.platform_fee_account.as_ref(),
        &ctx.accounts.system_program.to_account_info(),
        fees.fee_lamports,
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
        fee_paid: fees.fee_lamports,
        platform_fee: platform_fee_paid,
        old_expires_at,
        new_expires_at,
        renewed_at: clock.unix_timestamp,
    });

    Ok(())
}
