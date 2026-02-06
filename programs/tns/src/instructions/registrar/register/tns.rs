use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{
    Config, Token, SymbolRegistered, TnsError, TNS_MINT, TNS_DISCOUNT_BPS,
    PUMP_POOL_TNS_RESERVE, PUMP_POOL_SOL_RESERVE, calculate_tns_for_usd,
};
use super::super::helpers::{
    validate_not_paused, validate_symbol_format,
    validate_and_calculate_expiration, validate_registration_access, validate_mint_metadata,
    initialize_token_account, validate_platform_fee_bps,
    transfer_token_fees_with_platform, PlatformTokenFeeAccounts,
    SymbolInitData,
};

#[derive(Accounts)]
#[instruction(symbol: String, years: u8)]
pub struct RegisterSymbolTns<'info> {
    /// Shared Accounts

    #[account(mut)]
    pub payer: Signer<'info>,

    /// Config also holds keeper reward lamports
    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Token::INIT_SPACE,
        seeds = [Token::SEED_PREFIX, symbol.as_bytes()],
        bump
    )]
    pub token_account: Box<Account<'info, Token>>,

    /// The token mint being registered - validated as real SPL/Token-2022 mint
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for token_mint - validated in handler
    pub token_metadata: AccountInfo<'info>,

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

    /// CHECK: Pyth SOL/USD price feed - validated in get_sol_price_micro
    pub sol_usd_price_feed: AccountInfo<'info>,

    /// CHECK: Pool's TNS reserve token account - validated against constant
    #[account(address = PUMP_POOL_TNS_RESERVE @ TnsError::InvalidPoolReserve)]
    pub pool_tns_reserve: AccountInfo<'info>,

    /// CHECK: Pool's SOL reserve token account - validated against constant
    #[account(address = PUMP_POOL_SOL_RESERVE @ TnsError::InvalidPoolReserve)]
    pub pool_sol_reserve: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<RegisterSymbolTns>,
    symbol: String,
    years: u8,
    platform_fee_bps: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let mint = ctx.accounts.token_mint.key();

    // Validate
    validate_not_paused(config)?;

    let normalized_symbol = validate_symbol_format(&symbol)?;

    let expires_at = validate_and_calculate_expiration(
        clock.unix_timestamp,
        years,
        clock.unix_timestamp,
    )?;

    validate_registration_access(
        config,
        &normalized_symbol,
        &mint,
        &ctx.accounts.payer.key(),
        &ctx.accounts.token_mint,
    )?;

    validate_mint_metadata(
        &ctx.accounts.token_metadata,
        &mint,
        &normalized_symbol,
    )?;

    validate_platform_fee_bps(platform_fee_bps)?;

    // Calculate fee in USD
    let fee_usd_micro = config.calculate_registration_price_usd(clock.unix_timestamp, years);

    // Convert to TNS tokens at market price from DEX pool
    let tns_amount = calculate_tns_for_usd(
        fee_usd_micro,
        &ctx.accounts.pool_tns_reserve,
        &ctx.accounts.pool_sol_reserve,
        &ctx.accounts.sol_usd_price_feed,
        clock.unix_timestamp,
    )?;

    // Apply 25% discount
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_discounted = tns_amount - discount;

    // Transfer TNS tokens with optional platform fee split
    let platform_fee_paid = transfer_token_fees_with_platform(
        &PlatformTokenFeeAccounts {
            payer: &ctx.accounts.payer,
            payer_token_account: &ctx.accounts.payer_tns_account,
            vault: &ctx.accounts.fee_collector_ata,
            platform_token_account: ctx.accounts.platform_fee_account.as_ref(),
            mint: &ctx.accounts.tns_mint,
            token_program: &ctx.accounts.token_program,
        },
        tns_discounted,
        platform_fee_bps,
    )?;

    let keeper_reward_lamports = config.get_keeper_reward_lamports();

    // Transfer keeper reward in SOL to Config PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.config.to_account_info(),
            },
        ),
        keeper_reward_lamports,
    )?;

    // Initialize symbol
    initialize_token_account(
        &mut ctx.accounts.token_account,
        SymbolInitData {
            symbol: normalized_symbol.clone(),
            mint,
            owner: ctx.accounts.payer.key(),
            current_time: clock.unix_timestamp,
            expires_at,
            bump: ctx.bumps.token_account,
        },
    );

    emit!(SymbolRegistered {
        token_account: ctx.accounts.token_account.key(),
        symbol: normalized_symbol,
        mint,
        owner: ctx.accounts.payer.key(),
        years,
        fee_paid: tns_discounted,
        platform_fee: platform_fee_paid,
        registered_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
