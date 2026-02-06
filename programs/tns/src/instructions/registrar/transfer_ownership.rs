use anchor_lang::prelude::*;
use crate::{Config, Token, OwnershipTransferred, TnsError};
use super::helpers::validate_not_paused;

#[derive(Accounts)]
pub struct TransferOwnership<'info> {
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
}

pub fn handler(ctx: Context<TransferOwnership>, new_owner: Pubkey) -> Result<()> {
    let clock = Clock::get()?;

    // Validate not paused
    validate_not_paused(&ctx.accounts.config)?;

    // Ensure new owner is different
    require!(ctx.accounts.token_account.owner != new_owner, TnsError::SameOwner);

    // Capture old owner before mutation
    let old_owner = ctx.accounts.token_account.owner;

    // Transfer ownership
    ctx.accounts.token_account.owner = new_owner;

    emit!(OwnershipTransferred {
        token_account: ctx.accounts.token_account.key(),
        symbol: ctx.accounts.token_account.symbol.clone(),
        old_owner,
        new_owner,
        transferred_at: clock.unix_timestamp,
    });

    Ok(())
}
