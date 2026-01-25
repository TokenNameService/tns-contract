use anchor_lang::prelude::*;
use crate::{Config, ConfigUpdated, TnsError};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ TnsError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    /// New admin must sign to prove consent to receiving admin rights
    pub new_admin: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    new_fee_collector: Option<Pubkey>,
    paused: Option<bool>,
    new_phase: Option<u8>,
    tns_usd_pyth_feed: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Update admin to the new_admin signer
    config.admin = ctx.accounts.new_admin.key();

    if let Some(fee_collector) = new_fee_collector {
        config.fee_collector = fee_collector;
    }

    if let Some(p) = paused {
        config.paused = p;
    }

    if let Some(phase) = new_phase {
        // Phase can only go forward (1 -> 2 -> 3), never backward
        require!(phase > config.phase && phase <= 3, TnsError::InvalidPhase);
        config.phase = phase;
    }

    if let Some(feed) = tns_usd_pyth_feed {
        config.tns_usd_pyth_feed = Some(feed);
    }

    emit!(ConfigUpdated {
        admin: config.admin,
        fee_collector: config.fee_collector,
        base_price_usd_micro: config.base_price_usd_micro,
        annual_increase_bps: config.annual_increase_bps,
        keeper_reward_lamports: config.keeper_reward_lamports,
        tns_usd_pyth_feed: config.tns_usd_pyth_feed,
        paused: config.paused,
        phase: config.phase,
    });

    Ok(())
}
