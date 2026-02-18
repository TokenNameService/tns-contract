/**
 * Fetch and merge verified tokens from multiple sources
 *
 * Priority order (highest to lowest):
 * 1. Jupiter Cache API (live) - Most up-to-date, curated list
 * 2. Jupiter validated-tokens.csv (archived April 2025)
 * 3. Raydium mint list (live API)
 * 4. Orca token list (GitHub)
 * 5. Solana Token List (frozen July 2022) - Least reliable
 *
 * Collision Resolution:
 * - Collisions detected when same symbol maps to different mints
 * - Market data from DexScreener determines winner (highest volume)
 * - If no market data: higher-priority source wins
 * - Internal Jupiter collisions with no data: excluded (first-to-register wins)
 *
 * Output files:
 * - verified-tokens.json: Final token list for seeding
 * - collision-audit.json: Complete audit trail of all decisions
 * - pending-collisions.json: Excluded symbols (first-to-register wins)
 * - tradfi-collisions.json: Crypto symbols that match TradFi tickers
 * - validation-failures.json: Tokens failing contract validation
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data", "verified");

type TokenSource = "jupiter-cache" | "jupiter-csv" | "raydium" | "orca" | "solana";

interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoURI?: string;
  source: TokenSource;
}

interface CollisionCandidate {
  mint: string;
  name: string;
  source: TokenSource;
  marketCap?: number;
  price?: number;
  volume24h?: number;
}

interface PendingCollision {
  symbol: string;
  suggestedWinner: string;
  suggestedReason: string;
  candidates: CollisionCandidate[];
  needsReview: boolean;
}

interface CollisionAuditEntry {
  symbol: string;
  resolution: "market-cap" | "source-priority" | "excluded";
  reason: string;
  winner?: {
    mint: string;
    name: string;
    source: TokenSource;
    volume24h?: number;
    price?: number;
  };
  losers: Array<{
    mint: string;
    name: string;
    source: TokenSource;
    volume24h?: number;
    price?: number;
  }>;
}

// ============ Source Loaders ============

async function fetchJupiterCacheTokens(): Promise<TokenInfo[]> {
  console.log("Fetching Jupiter Cache API (live)...");

  const response = await fetch("https://cache.jup.ag/tokens");
  if (!response.ok) {
    console.error(`  Failed to fetch Jupiter Cache: ${response.status}`);
    return [];
  }

  const data = await response.json();
  const tokens: TokenInfo[] = [];

  for (const token of data) {
    const symbol = (token.symbol || "").trim();
    const tags = token.tags || [];

    // Skip tokens tagged as "unknown" (uncurated)
    if (tags.includes("unknown")) continue;

    // Only include mainnet tokens (chainId 101)
    if (symbol && token.address && token.chainId === 101) {
      tokens.push({
        name: token.name || "",
        symbol,
        address: token.address,
        decimals: token.decimals || 0,
        logoURI: token.logoURI || undefined,
        source: "jupiter-cache",
      });
    }
  }

  console.log(`  Fetched ${tokens.length} tokens (excluding unknown)\n`);
  return tokens;
}

function loadJupiterCsvTokens(): TokenInfo[] {
  const csvPath = join(DATA_DIR, "jupiter-validated-tokens.csv");
  console.log("Loading Jupiter CSV (archived April 2025)...");

  if (!existsSync(csvPath)) {
    console.error(`  File not found: ${csvPath}`);
    return [];
  }

  const csvContent = readFileSync(csvPath, "utf-8");
  const lines = csvContent.trim().split("\n");
  const tokens: TokenInfo[] = [];

  // Skip header: Name,Symbol,Mint,Decimals,LogoURI,Community Validated
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length >= 4) {
      const [name, symbol, mint, decimals, logoURI] = parts;
      tokens.push({
        name: name.trim(),
        symbol: symbol.trim(),
        address: mint.trim(),
        decimals: parseInt(decimals.trim(), 10),
        logoURI: logoURI?.trim() || undefined,
        source: "jupiter-csv",
      });
    }
  }

  console.log(`  Loaded ${tokens.length} tokens\n`);
  return tokens;
}

async function fetchRaydiumTokens(): Promise<TokenInfo[]> {
  console.log("Fetching Raydium mint list (live API)...");

  const response = await fetch("https://api-v3.raydium.io/mint/list");
  if (!response.ok) {
    console.error(`  Failed to fetch Raydium: ${response.status}`);
    return [];
  }

  const data = await response.json();
  const mintList = data?.data?.mintList || [];
  const tokens: TokenInfo[] = [];

  for (const token of mintList) {
    const symbol = (token.symbol || "").trim();
    if (symbol && token.address) {
      tokens.push({
        name: token.name || "",
        symbol,
        address: token.address,
        decimals: token.decimals || 0,
        logoURI: token.logoURI || undefined,
        source: "raydium",
      });
    }
  }

  console.log(`  Fetched ${tokens.length} tokens\n`);
  return tokens;
}

async function fetchOrcaTokens(): Promise<TokenInfo[]> {
  console.log("Fetching Orca token list (GitHub)...");

  const url = "https://raw.githubusercontent.com/orca-so/token-list/main/src/tokens/solana.tokenlist.json";
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`  Failed to fetch Orca: ${response.status}`);
    return [];
  }

  const data = await response.json();
  const tokenList = data?.tokens || [];
  const tokens: TokenInfo[] = [];

  for (const token of tokenList) {
    const symbol = (token.symbol || "").trim();
    if (symbol && token.address) {
      tokens.push({
        name: token.name || "",
        symbol,
        address: token.address,
        decimals: token.decimals || 0,
        logoURI: token.logoURI || undefined,
        source: "orca",
      });
    }
  }

  console.log(`  Fetched ${tokens.length} tokens\n`);
  return tokens;
}

function loadSolanaTokens(): TokenInfo[] {
  const jsonPath = join(DATA_DIR, "solana-tokenlist.json");
  console.log("Loading Solana Token List (frozen July 2022)...");

  if (!existsSync(jsonPath)) {
    console.error(`  File not found: ${jsonPath}`);
    return [];
  }

  const jsonContent = readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(jsonContent);
  const tokens: TokenInfo[] = [];

  for (const token of data.tokens) {
    if (token.chainId === 101) {
      tokens.push({
        name: token.name || "",
        symbol: token.symbol || "",
        address: token.address,
        decimals: token.decimals,
        logoURI: token.logoURI || undefined,
        source: "solana",
      });
    }
  }

  console.log(`  Loaded ${tokens.length} mainnet tokens\n`);
  return tokens;
}

// ============ Market Cap Fetching ============

async function fetchMarketData(mints: string[]): Promise<Map<string, { price: number; volume24h?: number }>> {
  const result = new Map<string, { price: number; volume24h?: number }>();

  if (mints.length === 0) return result;

  // Use DexScreener API - one request per token, but reliable
  // Only fetch first 200 to avoid rate limits (collisions are highest priority)
  const mintsToFetch = mints.slice(0, 200);
  let fetched = 0;

  for (const mint of mintsToFetch) {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (!response.ok) continue;

      const data = await response.json();
      const pairs = data.pairs || [];

      // Find Solana pairs and get the one with highest volume
      const solanaPairs = pairs.filter((p: any) => p.chainId === "solana");
      if (solanaPairs.length > 0) {
        // Sort by 24h volume descending
        solanaPairs.sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
        const bestPair = solanaPairs[0];

        result.set(mint, {
          price: parseFloat(bestPair.priceUsd || "0"),
          volume24h: bestPair.volume?.h24 || 0,
        });
        fetched++;
      }
    } catch (e) {
      // Continue on error
    }

    // Rate limit - DexScreener allows ~300 req/min
    await new Promise(r => setTimeout(r, 250));

    // Progress indicator
    if (fetched % 20 === 0 && fetched > 0) {
      process.stdout.write(`\r  Fetched ${fetched}/${mintsToFetch.length}...`);
    }
  }

  console.log(""); // New line after progress
  return result;
}

// ============ Collision Detection & Resolution ============

interface ProcessResult {
  finalTokens: Map<string, TokenInfo>;
  pendingCollisions: PendingCollision[];
  collisionAudit: CollisionAuditEntry[];
  stats: {
    bySource: Map<TokenSource, { total: number; added: number; skipped: number }>;
    totalCollisions: number;
    resolvedByMarketCap: number;
    resolvedBySourcePriority: number;
    excluded: number;
  };
}

async function processTokens(
  allSources: { name: TokenSource; tokens: TokenInfo[] }[]
): Promise<ProcessResult> {
  const finalTokens = new Map<string, TokenInfo>();
  const mintToSymbol = new Map<string, string>();
  const symbolCandidates = new Map<string, CollisionCandidate[]>();

  const stats = {
    bySource: new Map<TokenSource, { total: number; added: number; skipped: number }>(),
    totalCollisions: 0,
    resolvedByMarketCap: 0,
    resolvedBySourcePriority: 0,
    excluded: 0,
  };

  const collisionAudit: CollisionAuditEntry[] = [];

  // Initialize stats for each source
  for (const { name } of allSources) {
    stats.bySource.set(name, { total: 0, added: 0, skipped: 0 });
  }

  // First pass: collect all unique candidates for each symbol
  // Dedupe by mint within each symbol's candidate list
  const seenMints = new Set<string>();

  for (const { name, tokens } of allSources) {
    const sourceStats = stats.bySource.get(name)!;
    sourceStats.total = tokens.length;

    for (const token of tokens) {
      if (!token.symbol) continue;

      // Skip if this exact mint is already seen globally (same token, different source)
      if (seenMints.has(token.address)) {
        sourceStats.skipped++;
        continue;
      }

      seenMints.add(token.address);

      if (!symbolCandidates.has(token.symbol)) {
        symbolCandidates.set(token.symbol, []);
      }

      symbolCandidates.get(token.symbol)!.push({
        mint: token.address,
        name: token.name,
        source: name,
      });
    }
  }

  // Identify symbols with collisions (multiple mints)
  const collisionSymbols = [...symbolCandidates.entries()]
    .filter(([_, candidates]) => candidates.length > 1)
    .map(([symbol]) => symbol);

  stats.totalCollisions = collisionSymbols.length;

  // Categorize collisions by priority
  const highPriorityCollisions: string[] = []; // Involves Jupiter sources
  const lowPriorityCollisions: string[] = [];  // Only lower-tier sources

  for (const symbol of collisionSymbols) {
    const candidates = symbolCandidates.get(symbol)!;
    const hasJupiter = candidates.some(c =>
      c.source === "jupiter-cache" || c.source === "jupiter-csv"
    );
    if (hasJupiter) {
      highPriorityCollisions.push(symbol);
    } else {
      lowPriorityCollisions.push(symbol);
    }
  }

  console.log(`Found ${collisionSymbols.length} symbols with multiple mint candidates`);
  console.log(`  - High priority (Jupiter): ${highPriorityCollisions.length}`);
  console.log(`  - Low priority (other): ${lowPriorityCollisions.length}\n`);

  // Only fetch market data for high-priority collisions
  if (highPriorityCollisions.length > 0) {
    console.log("Fetching market data for high-priority collisions...");
    const highPriorityMints = highPriorityCollisions.flatMap(s =>
      symbolCandidates.get(s)!.map(c => c.mint)
    );
    const marketData = await fetchMarketData(highPriorityMints);

    // Attach market data to candidates
    for (const symbol of highPriorityCollisions) {
      for (const candidate of symbolCandidates.get(symbol)!) {
        const data = marketData.get(candidate.mint);
        if (data) {
          candidate.price = data.price;
          candidate.volume24h = data.volume24h;
          candidate.marketCap = data.price; // Use price as proxy
        }
      }
    }
    console.log(`  Retrieved data for ${marketData.size} tokens\n`);
  }

  // Resolve each symbol
  const pendingCollisions: PendingCollision[] = [];

  for (const [symbol, candidates] of symbolCandidates) {
    let winner: CollisionCandidate;
    let resolution: "market-cap" | "source-priority" | "excluded";
    let resolutionReason: string;

    if (candidates.length === 1) {
      // No collision
      winner = candidates[0];
      resolution = "source-priority";
      resolutionReason = "No collision";
    } else {
      // Collision - resolve by market data or source priority
      const byMarketCap = selectByMarketCap(candidates);
        const candidatesWithData = candidates.filter(c => c.volume24h !== undefined || c.marketCap !== undefined);
        const candidatesWithoutData = candidates.filter(c => c.volume24h === undefined && c.marketCap === undefined);
        const hasJupiter = candidates.some(c =>
          c.source === "jupiter-cache" || c.source === "jupiter-csv"
        );

        // Determine if we have a clear winner
        const winnerHasData = byMarketCap.volume24h !== undefined || byMarketCap.marketCap !== undefined;
        const clearWinner =
          // Case 1: One has data, others don't
          (candidatesWithData.length > 0 && candidatesWithoutData.length > 0 && winnerHasData) ||
          // Case 2: Multiple have data, we pick highest
          (candidatesWithData.length > 1 && winnerHasData);

        if (clearWinner) {
          winner = byMarketCap;
          resolution = "market-cap";
          resolutionReason = candidatesWithData.length > 1
            ? `Highest volume ($${byMarketCap.volume24h?.toLocaleString() || "0"})`
            : `Only token with market data (volume: $${byMarketCap.volume24h?.toLocaleString() || "0"})`;
          stats.resolvedByMarketCap++;

          // Add to audit
          collisionAudit.push({
            symbol,
            resolution: "market-cap",
            reason: resolutionReason,
            winner: {
              mint: winner.mint,
              name: winner.name,
              source: winner.source,
              volume24h: winner.volume24h,
              price: winner.price,
            },
            losers: candidates.filter(c => c.mint !== winner.mint).map(c => ({
              mint: c.mint,
              name: c.name,
              source: c.source,
              volume24h: c.volume24h,
              price: c.price,
            })),
          });
        } else if (candidatesWithData.length === 0) {
          // No market data at all - this is truly ambiguous
          // For internal Jupiter collisions, exclude from seeding entirely
          // For Jupiter vs other sources, Jupiter still wins by priority
          const allJupiter = candidates.every(c =>
            c.source === "jupiter-cache" || c.source === "jupiter-csv"
          );

          if (allJupiter && hasJupiter) {
            // Internal Jupiter collision with no data - exclude from seeding
            stats.excluded++;

            // Add to audit
            collisionAudit.push({
              symbol,
              resolution: "excluded",
              reason: "Internal Jupiter collision with no market data - first to register wins",
              losers: candidates.map(c => ({
                mint: c.mint,
                name: c.name,
                source: c.source,
              })),
            });

            // Add to pending for documentation
            pendingCollisions.push({
              symbol,
              suggestedWinner: "",
              suggestedReason: "No market data - exclude from seeding (first-to-register wins)",
              candidates: candidates,
              needsReview: false,
            });

            continue;  // Skip adding to finalTokens
          } else {
            // Jupiter vs lower-tier with no data - Jupiter wins by priority
            winner = candidates[0];
            resolution = "source-priority";
            resolutionReason = `${winner.source} beats lower-tier sources (no market data available)`;
            stats.resolvedBySourcePriority++;

            // Add to audit
            collisionAudit.push({
              symbol,
              resolution: "source-priority",
              reason: resolutionReason,
              winner: {
                mint: winner.mint,
                name: winner.name,
                source: winner.source,
              },
              losers: candidates.filter(c => c.mint !== winner.mint).map(c => ({
                mint: c.mint,
                name: c.name,
                source: c.source,
              })),
            });
          }
        } else {
          // Edge case: only one candidate has data but it's zero/falsy
          winner = candidates[0];
          resolution = "source-priority";
          resolutionReason = `${winner.source} priority (market data inconclusive)`;
          stats.resolvedBySourcePriority++;

          // Add to audit
          collisionAudit.push({
            symbol,
            resolution: "source-priority",
            reason: resolutionReason,
            winner: {
              mint: winner.mint,
              name: winner.name,
              source: winner.source,
              volume24h: winner.volume24h,
              price: winner.price,
            },
            losers: candidates.filter(c => c.mint !== winner.mint).map(c => ({
              mint: c.mint,
              name: c.name,
              source: c.source,
              volume24h: c.volume24h,
              price: c.price,
            })),
          });
        }
    }

    // Find the full token info from original sources
    let tokenInfo: TokenInfo | undefined;
    for (const { tokens } of allSources) {
      tokenInfo = tokens.find(t => t.address === winner.mint);
      if (tokenInfo) break;
    }

    if (tokenInfo) {
      finalTokens.set(symbol, tokenInfo);
      mintToSymbol.set(tokenInfo.address, symbol);

      // Update source stats
      const sourceStats = stats.bySource.get(tokenInfo.source)!;
      sourceStats.added++;
    }
  }

  return { finalTokens, pendingCollisions, collisionAudit, stats };
}

function selectByMarketCap(candidates: CollisionCandidate[]): CollisionCandidate {
  // Prefer volume24h as it's more reliable for identifying active tokens
  const withVolume = candidates.filter(c => c.volume24h !== undefined && c.volume24h > 0);
  if (withVolume.length > 0) {
    return withVolume.reduce((a, b) => (a.volume24h! > b.volume24h! ? a : b));
  }

  // Fall back to price/marketCap
  const withMarketCap = candidates.filter(c => c.marketCap !== undefined && c.marketCap > 0);
  if (withMarketCap.length > 0) {
    return withMarketCap.reduce((a, b) => (a.marketCap! > b.marketCap! ? a : b));
  }

  return candidates[0];
}

// ============ Output Writers ============

function writeVerifiedTokens(tokens: Map<string, TokenInfo>, stats: ProcessResult["stats"]) {
  // Include source info for each token
  const tokenMap: Record<string, { mint: string; source: string }> = {};
  for (const [symbol, token] of tokens) {
    tokenMap[symbol] = { mint: token.address, source: token.source };
  }

  const sources = [
    { name: "Jupiter Cache API", url: "https://cache.jup.ag/tokens", priority: 1 },
    { name: "Jupiter CSV", url: "https://github.com/jup-ag/token-list", priority: 2 },
    { name: "Raydium", url: "https://api-v3.raydium.io/mint/list", priority: 3 },
    { name: "Orca", url: "https://github.com/orca-so/token-list", priority: 4 },
    { name: "Solana Token List", url: "https://github.com/solana-labs/token-list", priority: 5 },
  ].map(s => {
    const key = s.name.toLowerCase().includes("cache") ? "jupiter-cache" :
                s.name.toLowerCase().includes("csv") ? "jupiter-csv" :
                s.name.toLowerCase() as TokenSource;
    const sourceStats = stats.bySource.get(key);
    return { ...s, added: sourceStats?.added || 0 };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    description: "Verified tokens merged from multiple sources with collision resolution",
    count: tokens.size,
    collisionStats: {
      total: stats.totalCollisions,
      resolvedByMarketCap: stats.resolvedByMarketCap,
      resolvedBySourcePriority: stats.resolvedBySourcePriority,
      excluded: stats.excluded,
    },
    sources,
    tokens: tokenMap,
  };

  const outputPath = join(DATA_DIR, "verified-tokens.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${tokens.size} verified tokens to ${outputPath}`);
}

function writePendingCollisions(pending: PendingCollision[]) {
  if (pending.length === 0) {
    console.log("No pending collisions to write.");
    return;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    description: "Symbols excluded from seeding due to ambiguous ownership",
    instructions: [
      "These symbols have multiple Jupiter-verified tokens with no market data",
      "They are excluded from genesis seeding - first to register wins",
    ],
    count: pending.length,
    collisions: pending.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };

  const outputPath = join(DATA_DIR, "pending-collisions.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${pending.length} excluded symbols to ${outputPath}`);
}

function writeCollisionAudit(audit: CollisionAuditEntry[], stats: ProcessResult["stats"]) {
  const byResolution = {
    "market-cap": audit.filter(a => a.resolution === "market-cap"),
    "source-priority": audit.filter(a => a.resolution === "source-priority"),
    "excluded": audit.filter(a => a.resolution === "excluded"),
  };

  const output = {
    generatedAt: new Date().toISOString(),
    description: "Complete audit trail of all collision resolutions",
    summary: {
      totalCollisions: audit.length,
      resolvedByMarketCap: byResolution["market-cap"].length,
      resolvedBySourcePriority: byResolution["source-priority"].length,
      excluded: byResolution["excluded"].length,
    },
    resolutions: {
      marketCap: {
        description: "Winner determined by highest trading volume or market data",
        count: byResolution["market-cap"].length,
        entries: byResolution["market-cap"].sort((a, b) => a.symbol.localeCompare(b.symbol)),
      },
      sourcePriority: {
        description: "Winner determined by source priority (Jupiter > Raydium > Orca > Solana)",
        count: byResolution["source-priority"].length,
        entries: byResolution["source-priority"].sort((a, b) => a.symbol.localeCompare(b.symbol)),
      },
      excluded: {
        description: "No winner - symbol excluded from seeding (first to register wins)",
        count: byResolution["excluded"].length,
        entries: byResolution["excluded"].sort((a, b) => a.symbol.localeCompare(b.symbol)),
      },
    },
  };

  const outputPath = join(DATA_DIR, "collision-audit.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote collision audit (${audit.length} resolutions) to ${outputPath}`);
}

// ============ Main ============

async function main() {
  console.log("=".repeat(60));
  console.log("Verified Token Fetcher with Collision Resolution");
  console.log("=".repeat(60));
  console.log("");

  // Fetch all sources in priority order (newest/live sources first, oldest last)
  const allSources: { name: TokenSource; tokens: TokenInfo[] }[] = [
    { name: "jupiter-cache", tokens: await fetchJupiterCacheTokens() },
    { name: "jupiter-csv", tokens: loadJupiterCsvTokens() },
    { name: "raydium", tokens: await fetchRaydiumTokens() },
    { name: "orca", tokens: await fetchOrcaTokens() },
    { name: "solana", tokens: loadSolanaTokens() },
  ];

  // Process with collision resolution
  const { finalTokens, pendingCollisions, collisionAudit, stats } = await processTokens(allSources);

  // Output results
  console.log("=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));
  console.log("");

  console.log("Tokens added by source:");
  for (const [source, s] of stats.bySource) {
    console.log(`  ${source.padEnd(15)} ${s.added.toString().padStart(5)} added (${s.total} total, ${s.skipped} skipped)`);
  }
  console.log("");

  console.log("Collision resolution:");
  console.log(`  Total collisions:        ${stats.totalCollisions}`);
  console.log(`  Resolved by market cap:  ${stats.resolvedByMarketCap}`);
  console.log(`  Resolved by source:      ${stats.resolvedBySourcePriority}`);
  console.log(`  Excluded (ambiguous):    ${stats.excluded}`);
  console.log("");

  // Write outputs
  writeVerifiedTokens(finalTokens, stats);
  writeCollisionAudit(collisionAudit, stats);
  writePendingCollisions(pendingCollisions);

  // Load TradFi reserved symbols for collision analysis
  const reservedDir = join(__dirname, "data", "reserved");
  const reservedSymbols = new Set<string>();
  const reservedFiles = ["dow.json", "sp500.json", "sp400.json", "sp600.json", "nasdaq100.json", "fmp-stocks.json", "fmp-etfs.json"];

  for (const file of reservedFiles) {
    const filePath = join(reservedDir, file);
    if (existsSync(filePath)) {
      try {
        const data = JSON.parse(readFileSync(filePath, "utf-8"));
        for (const item of data.symbols || []) {
          reservedSymbols.add((item.symbol || "").toString().toUpperCase());
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  // Find TradFi collisions and validation failures
  const tradfiCollisions: Array<{ symbol: string; mint: string; source: string }> = [];
  const validationFailures: Array<{ symbol: string; mint: string; source: string; reason: string }> = [];

  for (const [symbol, token] of finalTokens) {
    if (reservedSymbols.has(symbol.toUpperCase())) {
      tradfiCollisions.push({ symbol, mint: token.address, source: token.source });
    }
    if (symbol.length > 10) {
      validationFailures.push({ symbol, mint: token.address, source: token.source, reason: "Symbol too long (>10 chars)" });
    }
  }

  if (tradfiCollisions.length > 0) {
    const output = {
      generatedAt: new Date().toISOString(),
      description: "Verified crypto tokens that collide with TradFi symbols",
      count: tradfiCollisions.length,
      collisions: tradfiCollisions.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    };
    const outputPath = join(DATA_DIR, "tradfi-collisions.json");
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`Wrote ${tradfiCollisions.length} TradFi collisions to tradfi-collisions.json`);
  }

  if (validationFailures.length > 0) {
    const output = {
      generatedAt: new Date().toISOString(),
      description: "Verified tokens that fail contract validation rules",
      count: validationFailures.length,
      failures: validationFailures.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    };
    const outputPath = join(DATA_DIR, "validation-failures.json");
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`Wrote ${validationFailures.length} validation failures to validation-failures.json`);
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("Done!");
  console.log("=".repeat(60));

  if (pendingCollisions.length > 0) {
    console.log("");
    console.log(`ℹ️  ${pendingCollisions.length} symbols excluded from seeding (ambiguous ownership).`);
    console.log(`   See: scripts/data/verified/pending-collisions.json`);
    console.log(`   These symbols will be first-to-register wins.`);
  }

  console.log("");
  console.log(`📊 Full audit trail: scripts/data/verified/collision-audit.json`);
}

main().catch(console.error);
