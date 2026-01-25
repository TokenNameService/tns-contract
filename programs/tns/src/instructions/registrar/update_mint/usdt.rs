use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{Config, Token, MintUpdated, TnsError, USDT_MINT};
use super::super::helpers::{
    validate_not_paused, validate_symbol_can_update, validate_mint_different,
    validate_platform_fee_bps, transfer_token_fees_with_platform, PlatformTokenFeeAccounts,
    usd_micro_to_token_amount, update_symbol_mint,
};

#[derive(Accounts)]
pub struct UpdateMintUsdt<'info> {
    /// Shared Accounts

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Token::SEED_PREFIX, token_account.symbol.as_bytes()],
        bump = token_account.bump,
        has_one = owner @ TnsError::Unauthorized,
    )]
    pub token_account: Account<'info, Token>,

    pub system_program: Program<'info, System>,

    // USDT payment accounts

    pub token_program: Interface<'info, TokenInterface>,

    #[account(address = USDT_MINT @ TnsError::InvalidMint)]
    pub usdt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = owner,
    )]
    pub owner_usdt_account: InterfaceAccount<'info, TokenAccount>,

    /// Fee collector's USDT token account (ATA must be created by admin beforehand)
    #[account(
        mut,
        token::mint = usdt_mint,
    )]
    pub fee_collector_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Platform fee recipient token account. Validated in handler if provided.
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,

    /// The new mint to update the symbol to (validated as a real mint)
    pub new_mint: InterfaceAccount<'info, Mint>,
}

pub fn handler(ctx: Context<UpdateMintUsdt>, platform_fee_bps: u16) -> Result<()> {
    let new_mint = ctx.accounts.new_mint.key();
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate
    validate_not_paused(config)?;
    validate_symbol_can_update(&ctx.accounts.token_account, clock.unix_timestamp)?;
    validate_mint_different(&ctx.accounts.token_account.mint, &new_mint)?;
    validate_platform_fee_bps(platform_fee_bps)?;

    // Calculate fee in USD (no Pyth needed - USDT = $1)
    let yearly_price_usd_micro = config.get_current_yearly_price_usd(clock.unix_timestamp);
    let fee_usd_micro = yearly_price_usd_micro * config.update_fee_bps as u64 / 10000;
    let fee_usdt = usd_micro_to_token_amount(fee_usd_micro);

    let token_account_key = ctx.accounts.token_account.key();
    let old_mint = ctx.accounts.token_account.mint;
    let symbol_str = ctx.accounts.token_account.symbol.clone();
    let owner_key = ctx.accounts.owner.key();

    // Transfer USDT fee with optional platform fee split
    let platform_fee_paid = transfer_token_fees_with_platform(
        &PlatformTokenFeeAccounts {
            payer: &ctx.accounts.owner,
            payer_token_account: &ctx.accounts.owner_usdt_account,
            vault: &ctx.accounts.fee_collector_ata,
            platform_token_account: ctx.accounts.platform_fee_account.as_ref(),
            mint: &ctx.accounts.usdt_mint,
            token_program: &ctx.accounts.token_program,
        },
        fee_usdt,
        platform_fee_bps,
    )?;

    // Update mint
    update_symbol_mint(
        &mut ctx.accounts.token_account,
        new_mint,
    );

    emit!(MintUpdated {
        token_account: token_account_key,
        symbol: symbol_str,
        old_mint,
        new_mint,
        owner: owner_key,
        fee_paid: fee_usdt,
        platform_fee: platform_fee_paid,
        updated_at: clock.unix_timestamp,
    });

    Ok(())
}
