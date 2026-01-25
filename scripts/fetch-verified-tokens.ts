/**
 * Fetch and merge verified tokens from multiple sources
 *
 * Sources:
 * 1. Jupiter validated-tokens.csv (archived April 2025)
 *    - ~780 curated/validated tokens
 *    - https://github.com/jup-ag/token-list
 *
 * 2. Solana Token List (frozen July 2022)
 *    - ~13,600 tokens (less curated)
 *    - https://github.com/solana-labs/token-list
 *
 * Output: Merged deduplicated list with Jupiter tokens taking priority
 * (since they're more recently validated)
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoURI?: string;
  source: "jupiter" | "solana";
}

/**
 * Parse Jupiter validated-tokens.csv (archived April 2025)
 */
function loadJupiterTokens(): TokenInfo[] {
  const csvPath = join(__dirname, "data", "jupiter-validated-tokens.csv");
  console.log("Loading Jupiter validated tokens (archived April 2025)...");

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
        symbol: symbol.trim().toUpperCase(),
        address: mint.trim(),
        decimals: parseInt(decimals.trim(), 10),
        logoURI: logoURI?.trim() || undefined,
        source: "jupiter",
      });
    }
  }

  console.log(`  Loaded ${tokens.length} tokens from Jupiter\n`);
  return tokens;
}

/**
 * Parse Solana token list JSON (frozen July 2022)
 */
function loadSolanaTokens(): TokenInfo[] {
  const jsonPath = join(__dirname, "data", "solana-tokenlist.json");
  console.log("Loading Solana token list (frozen July 2022)...");

  const jsonContent = readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(jsonContent);
  const tokens: TokenInfo[] = [];

  for (const token of data.tokens) {
    // Only include mainnet tokens (chainId 101)
    if (token.chainId === 101) {
      tokens.push({
        name: token.name || "",
        symbol: (token.symbol || "").toUpperCase(),
        address: token.address,
        decimals: token.decimals,
        logoURI: token.logoURI || undefined,
        source: "solana",
      });
    }
  }

  console.log(`  Loaded ${tokens.length} mainnet tokens from Solana list\n`);
  return tokens;
}

async function main() {
  // Load both sources
  const jupiterTokens = loadJupiterTokens();
  const solanaTokens = loadSolanaTokens();

  // Merge with Jupiter taking priority (more recently curated)
  const tokensBySymbol = new Map<string, TokenInfo>();
  const tokensByAddress = new Map<string, TokenInfo>();

  // Add Jupiter tokens first (higher priority)
  for (const token of jupiterTokens) {
    if (token.symbol && !tokensBySymbol.has(token.symbol)) {
      tokensBySymbol.set(token.symbol, token);
      tokensByAddress.set(token.address, token);
    }
  }

  // Add Solana tokens that aren't already present
  let solanaAdded = 0;
  for (const token of solanaTokens) {
    // Skip if we already have this symbol or address
    if (
      !token.symbol ||
      tokensBySymbol.has(token.symbol) ||
      tokensByAddress.has(token.address)
    ) {
      continue;
    }
    tokensBySymbol.set(token.symbol, token);
    tokensByAddress.set(token.address, token);
    solanaAdded++;
  }

  console.log(`Merged results:`);
  console.log(`  From Jupiter: ${jupiterTokens.length} tokens`);
  console.log(`  From Solana (new): ${solanaAdded} tokens`);
  console.log(`  Total unique: ${tokensBySymbol.size} tokens\n`);

  // Build output
  const tokenMap: Record<string, string> = {};
  for (const [symbol, token] of tokensBySymbol) {
    tokenMap[symbol] = token.address;
  }

  const output = {
    sources: [
      {
        name: "Jupiter validated-tokens.csv",
        url: "https://github.com/jup-ag/token-list",
        status: "archived April 2025",
        count: jupiterTokens.length,
      },
      {
        name: "Solana Token List",
        url: "https://github.com/solana-labs/token-list",
        status: "frozen July 2022",
        count: solanaAdded,
      },
    ],
    generatedAt: new Date().toISOString(),
    count: tokensBySymbol.size,
    tokens: tokenMap,
  };

  // Write merged JSON
  const outputPath = join(__dirname, "data", "verified-tokens.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.count} verified tokens to ${outputPath}`);

  // Write simple list for reference
  const listPath = join(__dirname, "data", "verified-tokens-list.txt");
  const list = Array.from(tokensBySymbol.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([symbol, token]) => `${symbol}: ${token.address}`)
    .join("\n");
  writeFileSync(listPath, list);
  console.log(`Wrote token list to ${listPath}`);
}

main();
