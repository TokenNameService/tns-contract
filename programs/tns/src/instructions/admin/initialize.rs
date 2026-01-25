use anchor_lang::prelude::*;
use crate::{
    Config, ProtocolInitialized,
    BASE_PRICE_USD_MICRO, ANNUAL_INCREASE_BPS, UPDATE_FEE_BPS, KEEPER_REWARD_LAMPORTS,
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Payer for account initialization (can be same as admin).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Admin authority who will control the protocol.
    /// Must sign to prove consent to being the admin.
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [Config::SEED_PREFIX],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,

    /// CHECK: Pyth SOL/USD price feed
    pub sol_usd_pyth_feed: AccountInfo<'info>,

    /// CHECK: Fee collector account - receives all protocol fees
    /// SOL fees go directly here, SPL token fees go to ATAs owned by this account
    pub fee_collector: AccountInfo<'info>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let clock = Clock::get()?;

    // Initialize config (also holds keeper reward lamports directly)
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.fee_collector = ctx.accounts.fee_collector.key();
    config.base_price_usd_micro = BASE_PRICE_USD_MICRO;
    config.annual_increase_bps = ANNUAL_INCREASE_BPS;
    config.update_fee_bps = UPDATE_FEE_BPS;
    config.sol_usd_pyth_feed = ctx.accounts.sol_usd_pyth_feed.key();
    config.tns_usd_pyth_feed = None; // No oracle initially, TNS pegged at $1
    config.keeper_reward_lamports = KEEPER_REWARD_LAMPORTS;
    config.launch_timestamp = clock.unix_timestamp;
    config.paused = true;
    config.phase = 1; // Start in Phase 1 (Genesis)
    config.bump = ctx.bumps.config;

    emit!(ProtocolInitialized {
        config: ctx.accounts.config.key(),
        admin: ctx.accounts.admin.key(),
        fee_collector: ctx.accounts.fee_collector.key(),
        sol_usd_pyth_feed: ctx.accounts.sol_usd_pyth_feed.key(),
        base_price_usd_micro: BASE_PRICE_USD_MICRO,
        initialized_at: clock.unix_timestamp,
    });

    Ok(())
}
