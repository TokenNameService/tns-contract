use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use crate::{Config, Token, SymbolClaimed, TnsError};
use super::super::helpers::{
    validate_not_paused, validate_symbol_claimable, validate_mint_metadata,
    validate_and_calculate_expiration, validate_slippage, validate_platform_fee_bps,
    calculate_fees_sol, transfer_sol_fees_with_platform,
    update_symbol_on_claim, SymbolClaimData,
};

/// Claim an expired symbol with SOL payment
/// Anyone can claim a symbol that is past its grace period
/// No keeper reward - the original registration already funded the keeper pool
#[derive(Accounts)]
pub struct ClaimExpiredSymbolSol<'info> {
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

    /// The new mint to register the symbol to (validated as a real mint)
    pub new_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for new_mint - validated in handler
    pub new_mint_metadata: AccountInfo<'info>,

    /// Optional platform fee account (for launchpad referrals)
    /// CHECK: Validated by transfer if present
    #[account(mut)]
    pub platform_fee_account: Option<AccountInfo<'info>>,
}

pub fn handler(
    ctx: Context<ClaimExpiredSymbolSol>,
    years: u8,
    max_sol_cost: u64,
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

    // Calculate fees (we only use fee_lamports, not keeper_reward)
    let fees = calculate_fees_sol(
        config,
        clock.unix_timestamp,
        years,
        &ctx.accounts.sol_usd_price_feed,
    )?;

    // Validate slippage (no keeper reward for claims)
    validate_slippage(fees.fee_lamports, max_sol_cost)?;

    // Capture previous values before mutation
    let previous_owner = ctx.accounts.token_account.owner;
    let previous_mint = ctx.accounts.token_account.mint;

    // Transfer fees with platform split (no keeper reward - original registration funded keeper pool)
    let platform_fee_paid = transfer_sol_fees_with_platform(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.fee_collector,
        ctx.accounts.platform_fee_account.as_ref(),
        &ctx.accounts.system_program.to_account_info(),
        fees.fee_lamports,
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
        fee_paid: fees.fee_lamports,
        platform_fee: platform_fee_paid,
        claimed_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
