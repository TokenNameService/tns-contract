use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use crate::{Config, Token, SymbolRegistered, TnsError};
use super::super::helpers::{
    validate_not_paused, validate_years, validate_symbol_format,
    validate_and_calculate_expiration, validate_registration_access,
    calculate_fees_sol, transfer_sol_fees_with_platform, initialize_token_account,
    validate_slippage, validate_platform_fee_bps, SymbolInitData,
};

#[derive(Accounts)]
#[instruction(symbol: String, years: u8)]
pub struct RegisterSymbolSol<'info> {
    /// Shared Accounts

    #[account(mut)]
    pub payer: Signer<'info>,

    /// Config also holds keeper reward lamports
    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        space = 8 + Token::INIT_SPACE,
        seeds = [Token::SEED_PREFIX, symbol.to_uppercase().as_bytes()],
        bump
    )]
    pub token_account: Account<'info, Token>,

    /// The token mint being registered - validated as real SPL/Token-2022 mint
    pub token_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,

    // Solana Payment Accounts

    /// CHECK: Fee collector receives registration fee
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

    /// CHECK: Optional platform fee recipient (e.g., launchpad, referrer)
    /// If provided with non-zero platform_fee_bps, receives a portion of the fee
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,
}

pub fn handler(
    ctx: Context<RegisterSymbolSol>,
    symbol: String,
    years: u8,
    max_sol_cost: u64,
    platform_fee_bps: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let mint = ctx.accounts.token_mint.key();

    // Validate
    validate_not_paused(config)?;
    validate_years(years)?;
    validate_platform_fee_bps(platform_fee_bps)?;
    let normalized_symbol = validate_symbol_format(&symbol)?;

    validate_registration_access(
        config,
        &normalized_symbol,
        &mint,
        &ctx.accounts.payer.key(),
        &ctx.accounts.token_mint,
    )?;

    let expires_at = validate_and_calculate_expiration(
        clock.unix_timestamp,
        years,
        clock.unix_timestamp,
    )?;

    // Calculate fees
    let fees = calculate_fees_sol(
        config,
        clock.unix_timestamp,
        years,
        &ctx.accounts.sol_usd_price_feed,
    )?;

    // Validate slippage (fee + keeper reward)
    let total_cost = fees.fee_lamports + fees.keeper_reward_lamports;
    validate_slippage(total_cost, max_sol_cost)?;

    // Transfer fees with optional platform fee split
    let platform_fee_paid = transfer_sol_fees_with_platform(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.fee_collector,
        ctx.accounts.platform_fee_account.as_ref(),
        &ctx.accounts.system_program.to_account_info(),
        fees.fee_lamports,
        platform_fee_bps,
    )?;

    // Transfer keeper reward to Config PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.config.to_account_info(),
            },
        ),
        fees.keeper_reward_lamports,
    )?;

    // Initialize symbol
    let token_account_key = ctx.accounts.token_account.key();
    let payer_key = ctx.accounts.payer.key();
    let bump = ctx.bumps.token_account;

    initialize_token_account(
        &mut ctx.accounts.token_account,
        SymbolInitData {
            symbol: normalized_symbol.clone(),
            mint,
            owner: payer_key,
            current_time: clock.unix_timestamp,
            expires_at,
            bump,
        },
    );

    emit!(SymbolRegistered {
        token_account: token_account_key,
        symbol: normalized_symbol,
        mint,
        owner: payer_key,
        years,
        fee_paid: total_cost,
        platform_fee: platform_fee_paid,
        registered_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
