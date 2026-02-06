use anchor_lang::prelude::*;
use crate::{Config, Token, TnsError, SymbolClosedByAdmin};

/// Admin-only instruction to force-close a symbol account.
/// Closes the account immediately, returning rent to admin.
/// The symbol becomes available for fresh registration.
#[derive(Accounts)]
pub struct AdminCloseSymbol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ TnsError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        close = admin,
    )]
    pub token_account: Account<'info, Token>,
}

pub fn handler(ctx: Context<AdminCloseSymbol>) -> Result<()> {
    let clock = Clock::get()?;

    emit!(SymbolClosedByAdmin {
        token_account: ctx.accounts.token_account.key(),
        symbol: ctx.accounts.token_account.symbol.clone(),
        previous_owner: ctx.accounts.token_account.owner,
        previous_mint: ctx.accounts.token_account.mint,
        admin: ctx.accounts.admin.key(),
        closed_at: clock.unix_timestamp,
    });

    Ok(())
}
