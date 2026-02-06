use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{Config, Token, SymbolRegistered, TnsError, USDT_MINT};
use super::super::helpers::{
    validate_not_paused, validate_symbol_format,
    validate_and_calculate_expiration, validate_registration_access, validate_mint_metadata,
    initialize_token_account, validate_platform_fee_bps,
    transfer_token_fees_with_platform, PlatformTokenFeeAccounts,
    SymbolInitData,
};

#[derive(Accounts)]
#[instruction(symbol: String, years: u8)]
pub struct RegisterSymbolUsdt<'info> {
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
        seeds = [Token::SEED_PREFIX, symbol.as_bytes()],
        bump
    )]
    pub token_account: Account<'info, Token>,

    /// The token mint being registered - validated as real SPL/Token-2022 mint
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for token_mint - validated in handler
    pub token_metadata: AccountInfo<'info>,

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

    /// CHECK: Platform fee recipient token account. Validated in handler if provided.
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,
}

pub fn handler(
    ctx: Context<RegisterSymbolUsdt>,
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

    // Calculate fee in USD (no Pyth needed - USDT = $1)
    let fee_usd_micro = config.calculate_registration_price_usd(clock.unix_timestamp, years);

    // Convert to USDT tokens (1:1 with USD micro)
    let usdt_amount = fee_usd_micro;

    // Transfer USDT with optional platform fee split
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
        fee_paid: usdt_amount,
        platform_fee: platform_fee_paid,
        registered_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
