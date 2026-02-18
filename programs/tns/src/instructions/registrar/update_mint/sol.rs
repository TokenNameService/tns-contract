use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use crate::{Config, Token, MintUpdated, TnsError};
use super::super::helpers::{
    validate_not_paused, validate_symbol_not_expired, validate_mint_different, validate_mint_metadata,
    validate_slippage, validate_platform_fee_bps, calculate_update_fee,
    transfer_sol_fees_with_platform, update_symbol_mint,
};

#[derive(Accounts)]
pub struct UpdateMintSol<'info> {
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
        has_one = owner @ TnsError::UnauthorizedOwner,
    )]
    pub token_account: Account<'info, Token>,

    pub system_program: Program<'info, System>,

    // Solana Payment Accounts

    /// CHECK: Fee collector receives update fee
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

    /// CHECK: Optional platform fee recipient (launchpad/referrer)
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,

    /// The new mint to update the symbol to (validated as a real mint)
    pub new_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for new_mint - validated in handler
    pub new_mint_metadata: AccountInfo<'info>,
}

pub fn handler(ctx: Context<UpdateMintSol>, max_sol_cost: u64, platform_fee_bps: u16) -> Result<()> {
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
        &ctx.accounts.new_mint.to_account_info(),
        &ctx.accounts.token_account.symbol,
    )?;

    validate_platform_fee_bps(platform_fee_bps)?;

    // Calculate and transfer fee
    let fee = calculate_update_fee(
        config,
        clock.unix_timestamp,
        &ctx.accounts.sol_usd_price_feed,
    )?;

    // Validate slippage
    validate_slippage(fee.fee_lamports, max_sol_cost)?;

    // Capture old mint before mutation
    let old_mint = ctx.accounts.token_account.mint;

    // Transfer fees with optional platform fee split
    let platform_fee_paid = transfer_sol_fees_with_platform(
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.fee_collector,
        ctx.accounts.platform_fee_account.as_ref(),
        &ctx.accounts.system_program.to_account_info(),
        fee.fee_lamports,
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
        fee_paid: fee.fee_lamports,
        platform_fee: platform_fee_paid,
        updated_at: clock.unix_timestamp,
    });

    Ok(())
}
