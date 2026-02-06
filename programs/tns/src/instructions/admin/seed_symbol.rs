use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use crate::{Config, Token, TnsError, SymbolSeeded};
use crate::instructions::registrar::helpers::{
    validate_symbol_format, validate_and_calculate_expiration,
    validate_mint_metadata,
};

/// Admin-only instruction to seed the registry with verified tokens.
/// No fee, sets owner to mint authority, configurable expiration (1-10 years).
#[derive(Accounts)]
#[instruction(symbol: String, years: u8)]
pub struct SeedSymbol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ TnsError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + Token::INIT_SPACE,
        seeds = [Token::SEED_PREFIX, symbol.as_bytes()],
        bump
    )]
    pub token_account: Account<'info, Token>,

    /// The verified token mint - owner becomes the mint authority
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for token_mint - validated in handler
    pub token_metadata: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SeedSymbol>, symbol: String, years: u8) -> Result<()> {
    let clock = Clock::get()?;

    let normalized_symbol = validate_symbol_format(&symbol)?;

    let expires_at = validate_and_calculate_expiration(
        clock.unix_timestamp,
        years,
        clock.unix_timestamp,
    )?;

    validate_mint_metadata(
        &ctx.accounts.token_metadata,
        &ctx.accounts.token_mint.key(),
        &normalized_symbol,
    )?;

    // Get the mint authority - this becomes the symbol owner
    let owner = ctx.accounts.token_mint.mint_authority
        .ok_or(TnsError::InvalidMint)?;

    ctx.accounts.token_account.symbol = normalized_symbol.clone();
    ctx.accounts.token_account.mint = ctx.accounts.token_mint.key();
    ctx.accounts.token_account.owner = owner;
    ctx.accounts.token_account.registered_at = clock.unix_timestamp;
    ctx.accounts.token_account.expires_at = expires_at;
    ctx.accounts.token_account.bump = ctx.bumps.token_account;
    ctx.accounts.token_account._reserved = [0u8; 64];

    emit!(SymbolSeeded {
        token_account: ctx.accounts.token_account.key(),
        symbol: normalized_symbol,
        mint: ctx.accounts.token_mint.key(),
        owner,
        years,
        seeded_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
