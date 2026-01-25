use anchor_lang::prelude::*;

#[error_code]
pub enum TnsError {
    #[msg("Symbol must be 1-10 characters")]
    InvalidSymbolLength,

    #[msg("Symbol must contain only alphanumeric characters")]
    InvalidSymbolCharacters,

    #[msg("Unauthorized: you are not the owner of this symbol")]
    Unauthorized,

    #[msg("Protocol is paused")]
    Paused,

    #[msg("New mint cannot be the same as current mint")]
    SameMint,

    #[msg("Cannot transfer ownership to same owner")]
    SameOwner,

    #[msg("Registration years must be between 1 and 10")]
    InvalidYears,

    #[msg("Symbol has expired and is past the grace period")]
    SymbolExpired,

    #[msg("Symbol is still active or in grace period, cannot expire yet")]
    NotYetExpired,

    #[msg("Renewal would exceed maximum 10 year registration limit")]
    RenewalExceedsMaxYears,

    #[msg("Symbol is expired, must renew before updating")]
    CannotUpdateExpiredSymbol,

    #[msg("Insufficient payment for registration")]
    InsufficientPayment,

    #[msg("Pyth price feed is stale")]
    StalePriceFeed,

    #[msg("Invalid Pyth price feed")]
    InvalidPriceFeed,

    #[msg("Price feed mismatch")]
    PriceFeedMismatch,

    #[msg("Invalid mint - must be owned by SPL token program")]
    InvalidMint,

    #[msg("Symbol is reserved for future use")]
    SymbolReserved,

    #[msg("Mint does not match whitelisted token")]
    WhitelistMintMismatch,

    #[msg("Only the mint authority can register this whitelisted symbol")]
    NotMintAuthority,

    #[msg("Only admin can register non-whitelisted symbols during Phase 1")]
    AdminOnlyRegistration,

    #[msg("Invalid phase transition - phase can only increase from 1 to 2 to 3")]
    InvalidPhase,

    #[msg("SOL cost exceeds maximum specified")]
    SlippageExceeded,

    #[msg("Symbol has not been expired long enough to cancel (requires 1 year after grace period)")]
    NotYetCancelable,

    #[msg("Symbol is not expired - cannot claim an active symbol")]
    SymbolNotExpired,

    #[msg("Platform fee exceeds maximum allowed (10%)")]
    PlatformFeeExceedsMax,
}
