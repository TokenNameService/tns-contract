use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{
    Config, Token, MintUpdated, TnsError, TNS_MINT, TNS_DISCOUNT_BPS,
    PUMP_POOL_TNS_RESERVE, PUMP_POOL_SOL_RESERVE, calculate_tns_for_usd,
};
use super::super::helpers::{
    validate_not_paused, validate_symbol_not_expired, validate_mint_different, validate_mint_metadata,
    validate_platform_fee_bps, transfer_token_fees_with_platform, PlatformTokenFeeAccounts,
    update_symbol_mint,
};

#[derive(Accounts)]
pub struct UpdateMintTns<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [Token::SEED_PREFIX, token_account.symbol.as_bytes()],
        bump = token_account.bump,
        has_one = owner @ TnsError::UnauthorizedOwner,
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
        token::authority = owner,
    )]
    pub owner_tns_account: InterfaceAccount<'info, TokenAccount>,

    /// Fee collector's TNS token account (ATA must be created by admin beforehand)
    #[account(
        mut,
        token::mint = tns_mint,
    )]
    pub fee_collector_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Platform fee recipient token account. Validated in handler if provided.
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,

    /// The new mint to update the symbol to (validated as a real mint)
    pub new_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for new_mint - validated in handler
    pub new_mint_metadata: AccountInfo<'info>,

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

pub fn handler(ctx: Context<UpdateMintTns>, platform_fee_bps: u16) -> Result<()> {
    let new_mint = ctx.accounts.new_mint.key();
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate
    validate_not_paused(config)?;
    
    validate_symbol_not_expired(&ctx.accounts.token_account, clock.unix_timestamp)?;
    
    validate_mint_different(&ctx.accounts.token_account.mint, &new_mint)?;

    // Validate metadata matches - owner unchanged (already verified as signer)
    validate_mint_metadata(
        &ctx.accounts.new_mint_metadata,
        &new_mint,
        &ctx.accounts.token_account.symbol,
    )?;

    validate_platform_fee_bps(platform_fee_bps)?;

    // Calculate fee in USD
    let yearly_price_usd_micro = config.get_current_yearly_price_usd(clock.unix_timestamp);
    let fee_usd_micro = yearly_price_usd_micro * config.update_fee_bps as u64 / 10000;

    // Convert to TNS tokens at market price from DEX pool
    let tns_amount = calculate_tns_for_usd(
        fee_usd_micro,
        &ctx.accounts.pool_tns_reserve,
        &ctx.accounts.pool_sol_reserve,
        &ctx.accounts.sol_usd_price_feed,
        clock.unix_timestamp,
    )?;

    // Apply 25% discount for TNS payments
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_fee = tns_amount - discount;

    // Capture old mint before mutation
    let old_mint = ctx.accounts.token_account.mint;

    // Transfer TNS tokens with optional platform fee split
    let platform_fee_paid = transfer_token_fees_with_platform(
        &PlatformTokenFeeAccounts {
            payer: &ctx.accounts.owner,
            payer_token_account: &ctx.accounts.owner_tns_account,
            vault: &ctx.accounts.fee_collector_ata,
            platform_token_account: ctx.accounts.platform_fee_account.as_ref(),
            mint: &ctx.accounts.tns_mint,
            token_program: &ctx.accounts.token_program,
        },
        tns_fee,
        platform_fee_bps,
    )?;

    // Update mint
    update_symbol_mint(
        &mut ctx.accounts.token_account,
        new_mint,
    );

    emit!(MintUpdated {
        token_account: ctx.accounts.token_account.key(),
        symbol: ctx.accounts.token_account.symbol.clone(),
        old_mint,
        new_mint,
        owner: ctx.accounts.owner.key(),
        fee_paid: tns_fee, // Log TNS amount (after discount)
        platform_fee: platform_fee_paid,
        updated_at: clock.unix_timestamp,
    });

    Ok(())
}
