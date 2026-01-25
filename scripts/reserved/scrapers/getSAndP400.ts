import { WikiAsset } from "../types";
import * as cheerio from "cheerio";
import axios from "axios";

export const getSAndP400 = async (): Promise<WikiAsset[]> => {
  const response = await axios.get(
    "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TNSScraper/1.0)",
      },
    }
  );
  const $ = cheerio.load(response.data);

  const table = $("#constituents").closest("table");

  const companies: WikiAsset[] = [];
  table.find("tbody tr").each((index, element) => {
    if (index === 0) return;

    const company = $(element)
      .find("td")
      .map((_i, el) => $(el).text().trim())
      .get();

    if (company.length >= 4) {
      companies.push({
        symbol: company[0],
        name: company[1],
        sector: company[2],
        industry: company[3],
      });
    }
  });

  return companies;
};
