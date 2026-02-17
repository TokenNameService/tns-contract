/**
 * Fetch all reserved TradFi symbols - SEPARATE FILES for transparency
 *
 * This script fetches each source independently and saves to separate JSON files.
 * The Rust code generator will handle deduplication via comments.
 *
 * Sources:
 *   - Wikipedia: Dow, S&P 500, S&P 400, S&P 600, NASDAQ 100
 *   - FMP: All actively traded US securities + international
 *
 * Usage:
 *   pnpm fetch:reserved:indexes     # Wikipedia only (no API key)
 *   pnpm fetch:reserved             # All sources (requires .env with FMP_API_KEY)
 *   pnpm fetch:reserved:all         # Include ETFs
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getDow,
  getSAndP500,
  getSAndP400,
  getSAndP600,
  getNasdaq100,
} from "./scrapers";
import {
  fetchFmpActiveList,
  fetchFmpEtfList,
  fetchFmpAllAssets,
} from "./fetchFmpActiveList";
import { WikiAsset } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizeSymbol(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function isValidSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (normalized.length < 1 || normalized.length > 10) return false;
  if (!/^[A-Z0-9]+$/.test(normalized)) return false;
  return true;
}

interface IndexOutput {
  name: string;
  source: string;
  sourceType: "wikipedia" | "fmp";
  fetchedAt: string;
  count: number;
  symbols: Array<{
    symbol: string;
    name: string;
    sector?: string;
    industry?: string;
    exchange?: string;
  }>;
}

async function fetchAndSaveIndex(
  name: string,
  source: string,
  fetcher: () => Promise<WikiAsset[]>,
  dataDir: string
): Promise<number> {
  console.log(`  Fetching ${name}...`);

  try {
    const assets = await fetcher();
    const validAssets = assets
      .filter((a) => isValidSymbol(a.symbol))
      .map((a) => ({
        symbol: normalizeSymbol(a.symbol),
        name: a.name,
        sector: a.sector || undefined,
        industry: a.industry || undefined,
      }));

    const output: IndexOutput = {
      name,
      source,
      sourceType: "wikipedia",
      fetchedAt: new Date().toISOString(),
      count: validAssets.length,
      symbols: validAssets,
    };

    const filePath = join(dataDir, `${name}.json`);
    writeFileSync(filePath, JSON.stringify(output, null, 2));
    console.log(`    ✓ ${validAssets.length} symbols → ${name}.json`);

    return validAssets.length;
  } catch (err: any) {
    console.error(`    ✗ Failed: ${err.message}`);
    return 0;
  }
}

async function main() {
  const indexesOnly = process.argv.includes("--indexes-only");
  const includeEtfs = process.argv.includes("--include-etfs");
  const fmpApiKey = process.env.FMP_API_KEY;

  if (!indexesOnly && !fmpApiKey) {
    console.error(
      "Error: FMP_API_KEY environment variable required (or use --indexes-only)"
    );
    process.exit(1);
  }

  const dataDir = join(__dirname, "..", "data", "reserved");
  mkdirSync(dataDir, { recursive: true });

  console.log("\n=== Fetching Index Constituents from Wikipedia ===\n");

  // Fetch each index separately and save to individual files
  const dowCount = await fetchAndSaveIndex(
    "dow",
    "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average",
    getDow,
    dataDir
  );

  const sp500Count = await fetchAndSaveIndex(
    "sp500",
    "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
    getSAndP500,
    dataDir
  );

  const sp400Count = await fetchAndSaveIndex(
    "sp400",
    "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies",
    getSAndP400,
    dataDir
  );

  const sp600Count = await fetchAndSaveIndex(
    "sp600",
    "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies",
    getSAndP600,
    dataDir
  );

  const nasdaq100Count = await fetchAndSaveIndex(
    "nasdaq100",
    "https://en.wikipedia.org/wiki/Nasdaq-100",
    getNasdaq100,
    dataDir
  );

  // FMP data
  let fmpStocksCount = 0;
  let fmpEtfsCount = 0;

  if (!indexesOnly && fmpApiKey) {
    console.log("\n=== Fetching All Securities from FMP ===\n");

    // Fetch all stocks (US + international)
    console.log("  Fetching all actively traded securities...");
    try {
      const allAssets = await fetchFmpAllAssets(fmpApiKey);

      const validAssets = allAssets
        .filter((a) => isValidSymbol(a.symbol))
        .map((a) => ({
          symbol: normalizeSymbol(a.symbol),
          name: a.name,
          exchange: a.exchangeShortName || a.exchange || undefined,
          type: a.type || undefined,
        }));

      const output = {
        name: "fmp-stocks",
        source: "https://financialmodelingprep.com/api/v3/stock/list",
        sourceType: "fmp" as const,
        fetchedAt: new Date().toISOString(),
        count: validAssets.length,
        symbols: validAssets,
      };

      const filePath = join(dataDir, "fmp-stocks.json");
      writeFileSync(filePath, JSON.stringify(output, null, 2));
      console.log(`    ✓ ${validAssets.length} symbols → fmp-stocks.json`);
      fmpStocksCount = validAssets.length;
    } catch (err: any) {
      console.error(`    ✗ Failed: ${err.message}`);
    }

    // Fetch ETFs if requested
    if (includeEtfs) {
      console.log("  Fetching ETFs...");
      try {
        const etfs = await fetchFmpEtfList(fmpApiKey);

        const validEtfs = etfs
          .filter((a) => isValidSymbol(a.symbol))
          .map((a) => ({
            symbol: normalizeSymbol(a.symbol),
            name: a.name,
            exchange: a.exchangeShortName || a.exchange || undefined,
          }));

        const output = {
          name: "fmp-etfs",
          source: "https://financialmodelingprep.com/api/v3/etf/list",
          sourceType: "fmp" as const,
          fetchedAt: new Date().toISOString(),
          count: validEtfs.length,
          symbols: validEtfs,
        };

        const filePath = join(dataDir, "fmp-etfs.json");
        writeFileSync(filePath, JSON.stringify(output, null, 2));
        console.log(`    ✓ ${validEtfs.length} symbols → fmp-etfs.json`);
        fmpEtfsCount = validEtfs.length;
      } catch (err: any) {
        console.error(`    ✗ Failed: ${err.message}`);
      }
    }
  }

  // Summary
  console.log("\n=== Summary ===\n");
  console.log("  Wikipedia indexes:");
  console.log(`    Dow Jones:    ${dowCount} symbols`);
  console.log(`    S&P 500:      ${sp500Count} symbols`);
  console.log(`    S&P 400:      ${sp400Count} symbols`);
  console.log(`    S&P 600:      ${sp600Count} symbols`);
  console.log(`    NASDAQ 100:   ${nasdaq100Count} symbols`);
  if (!indexesOnly) {
    console.log("\n  FMP (global markets):");
    console.log(`    Stocks:       ${fmpStocksCount} symbols`);
    if (includeEtfs) {
      console.log(`    ETFs:         ${fmpEtfsCount} symbols`);
    }
  }
  console.log(`\n  Data saved to: ${dataDir}/`);
  console.log(
    "\n  Next step: Run 'npm run generate:reserved' to generate Rust code"
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
