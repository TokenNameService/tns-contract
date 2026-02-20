use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use crate::{
    Config, Token, SymbolClaimed, TnsError, TNS_MINT, TNS_DISCOUNT_BPS,
    PUMP_POOL_TNS_RESERVE, PUMP_POOL_SOL_RESERVE, calculate_tns_for_usd,
};
use super::super::helpers::{
    validate_not_paused, validate_symbol_claimable, validate_mint_metadata,
    validate_and_calculate_expiration, validate_platform_fee_bps,
    transfer_token_fees_with_platform, PlatformTokenFeeAccounts,
    update_symbol_on_claim, SymbolClaimData,
};

/// Claim an expired symbol with TNS token payment (25% discount)
/// No keeper reward - the original registration already funded the keeper pool
#[derive(Accounts)]
pub struct ClaimExpiredSymbolTns<'info> {
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

    /// The new mint to register the symbol to (validated as a real mint)
    pub new_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for new_mint - validated in handler
    pub new_mint_metadata: AccountInfo<'info>,

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

pub fn handler(
    ctx: Context<ClaimExpiredSymbolTns>,
    years: u8,
    platform_fee_bps: u16,
) -> Result<()> {
    let new_mint = ctx.accounts.new_mint.key();
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate
    validate_not_paused(config)?;
    
    validate_symbol_claimable(&ctx.accounts.token_account, clock.unix_timestamp)?;

    let expires_at = validate_and_calculate_expiration(
        clock.unix_timestamp,
        years,
        clock.unix_timestamp,
    )?;

    validate_mint_metadata(
        &ctx.accounts.new_mint_metadata,
        &ctx.accounts.new_mint.to_account_info(),
        &ctx.accounts.token_account.symbol,
    )?;

    validate_platform_fee_bps(platform_fee_bps)?;

    // New owner is the payer, not the mint's update_authority
    let new_owner = ctx.accounts.payer.key();

    // Calculate fee in USD
    let fee_usd_micro = config.calculate_registration_price_usd(clock.unix_timestamp, years);

    // Convert to TNS tokens at market price from DEX pool
    let tns_amount = calculate_tns_for_usd(
        fee_usd_micro,
        &ctx.accounts.pool_tns_reserve,
        &ctx.accounts.pool_sol_reserve,
        &ctx.accounts.price_update,
    )?;

    // Apply 25% discount
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_discounted_amount = tns_amount - discount;

    // Capture previous values before mutation
    let previous_owner = ctx.accounts.token_account.owner;
    let previous_mint = ctx.accounts.token_account.mint;

    // Transfer TNS tokens with platform split (no keeper reward - original registration funded keeper pool)
    let platform_fee_paid = transfer_token_fees_with_platform(
        &PlatformTokenFeeAccounts {
            payer: &ctx.accounts.payer,
            payer_token_account: &ctx.accounts.payer_tns_account,
            vault: &ctx.accounts.fee_collector_ata,
            platform_token_account: ctx.accounts.platform_fee_account.as_ref(),
            mint: &ctx.accounts.tns_mint,
            token_program: &ctx.accounts.token_program,
        },
        tns_discounted_amount,
        platform_fee_bps,
    )?;

    // Update symbol with new owner (payer) and mint
    update_symbol_on_claim(
        &mut ctx.accounts.token_account,
        SymbolClaimData {
            new_mint,
            new_owner,
            expires_at,
        },
    );

    emit!(SymbolClaimed {
        token_account: ctx.accounts.token_account.key(),
        symbol: ctx.accounts.token_account.symbol.clone(),
        previous_owner,
        previous_mint,
        new_owner,
        new_mint,
        years,
        fee_paid: tns_discounted_amount,
        platform_fee: platform_fee_paid,
        claimed_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
