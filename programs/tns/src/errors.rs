use anchor_lang::prelude::*;

#[error_code]
pub enum TnsError {
    #[msg("Symbol must be 1-10 characters")]
    InvalidSymbolLength,

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

    #[msg("Symbol is expired")]
    SymbolExpired,

    #[msg("Symbol is still active or in grace period, cannot expire yet")]
    NotYetExpired,

    #[msg("Expiration would exceed maximum 10 years from now")]
    ExceedsMaxYears,

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

    #[msg("Only admin can register during Phase 1")]
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

    #[msg("Invalid pool reserve account")]
    InvalidPoolReserve,

    #[msg("Pool reserves are empty or zero")]
    EmptyPoolReserves,

    #[msg("Math overflow in price calculation")]
    MathOverflow,

    #[msg("Invalid metadata account")]
    InvalidMetadata,

    #[msg("Metadata symbol does not match registered symbol")]
    MetadataSymbolMismatch,

    #[msg("Token metadata must be immutable")]
    MetadataMustBeImmutable,

    #[msg("Not token authority: must be mint authority, update authority, or hold >50% of supply")]
    NotTokenAuthority,

    #[msg("Already the owner of this symbol")]
    AlreadyOwner,

    #[msg("No metadata drift detected - symbol still matches")]
    NoDriftDetected,
}
