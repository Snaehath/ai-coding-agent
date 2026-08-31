// Types
export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

// HTML entity decoder
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, ""); // Strip HTML tags
}

// Extract search results from DuckDuckGo HTML
function parseDuckDuckGoHtml(html: string, maxResults: number = 5): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks in DuckDuckGo HTML
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i];

    // Extract title and URL from result link
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    // Extract snippet
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (titleMatch) {
      let rawUrl = titleMatch[1];
      // DuckDuckGo redirects: //duckduckgo.com/l/?uddg=URL
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      }

      const title = decodeHtmlEntities(titleMatch[2]).trim();
      const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1]).trim() : "";

      if (title && rawUrl && !rawUrl.includes("duckduckgo.com/")) {
        results.push({
          title,
          url: rawUrl,
          snippet,
        });
      }
    }
  }

  return results;
}

// Fallback search using DuckDuckGo Instant Answer API
async function searchDuckDuckGoApi(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const results: SearchResult[] = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
      });
    }

    for (const topic of data.RelatedTopics ?? []) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.slice(0, 60),
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      }
      if (results.length >= 5) break;
    }

    return results;
  } catch {
    return [];
  }
}

// Perform web search with HTML and API fallback
export async function performWebSearch(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  if (!query || !query.trim()) return [];

  // Try DuckDuckGo HTML search first (rich snippets)
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      body: `q=${encodeURIComponent(query)}&b=`,
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const html = await res.text();
      const results = parseDuckDuckGoHtml(html, maxResults);
      if (results.length > 0) return results;
    }
  } catch {
    // Fallback to API if HTML endpoint is rate limited or times out
  }

  // Fallback to instant answer API
  return await searchDuckDuckGoApi(query);
}

// Format search results into clean markdown for LLM context
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No search results found for query: "${query}".`;
  }

  const formatted = results.map((r, i) =>
    `[${i + 1}] Title: ${r.title}\n    URL: ${r.url}\n    Snippet: ${r.snippet}`
  ).join("\n\n");

  return `Search Results for "${query}":\n\n${formatted}`;
}
