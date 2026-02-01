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

    // Capture all values before close
    let token_account_key = ctx.accounts.token_account.key();
    let symbol = ctx.accounts.token_account.symbol.clone();
    let previous_owner = ctx.accounts.token_account.owner;
    let previous_mint = ctx.accounts.token_account.mint;
    let admin_key = ctx.accounts.admin.key();

    emit!(SymbolClosedByAdmin {
        token_account: token_account_key,
        symbol,
        previous_owner,
        previous_mint,
        admin: admin_key,
        closed_at: clock.unix_timestamp,
    });

    Ok(())
}
