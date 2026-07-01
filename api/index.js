const fetch = require("node-fetch");
const cheerio = require("cheerio");

const BASE_URL = "https://www.moviesublk.com";
const FEED_URL = `${BASE_URL}/feeds/posts/default`;

const HTML_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
};

// Fetch JSON from the Blogger feed API
async function getFeed(params) {
  const qs = new URLSearchParams({ alt: "json", "max-results": "20", ...params });
  const res = await fetch(`${FEED_URL}?${qs}`, { headers: HTML_HEADERS });
  if (!res.ok) throw new Error(`Feed error: ${res.status}`);
  return res.json();
}

// Fetch HTML of a specific post page (needed for details/gdrive)
async function getHTML(url) {
  const res = await fetch(url, { headers: HTML_HEADERS });
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  return res.text();
}

// Convert a Blogger feed entry to a MovieItem
function entryToItem(entry) {
  const title = entry.title.$t || "";
  const link = (entry.link.find((l) => l.rel === "alternate") || {}).href || "";
  // Upgrade thumbnail from s72-c to s320 for better quality
  const rawThumb = (entry.media$thumbnail || {}).url || "";
  const image = rawThumb.replace(/\/s\d+-c\//, "/s320/");
  const type = (entry.category || []).map((c) => c.term).join(", ") || null;
  return { title, link, image, type };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { action, query, url } = req.query;

    if (!action)
      return res.status(400).json({
        status: false,
        message: "action missing. Use: search | list | details | gdrive",
      });

    // ── SEARCH ───────────────────────────────────────────────────────────────
    if (action === "search") {
      if (!query)
        return res.status(400).json({ status: false, message: "query param missing" });

      const data = await getFeed({ q: query });
      const entries = data.feed.entry || [];
      const results = entries.map(entryToItem).filter((r) => r.title && r.link);
      return res.json({ status: true, count: results.length, results });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      let feedUrl = FEED_URL;
      // If query looks like a label (e.g. "movie", "kdrama"), filter by label
      if (query) {
        feedUrl = `${FEED_URL}/-/${encodeURIComponent(query)}`;
      }
      const qs = new URLSearchParams({ alt: "json", "max-results": "20" });
      const feedRes = await fetch(`${feedUrl}?${qs}`, { headers: HTML_HEADERS });
      if (!feedRes.ok) throw new Error(`Feed error: ${feedRes.status}`);
      const data = await feedRes.json();
      const entries = data.feed.entry || [];
      const results = entries.map(entryToItem).filter((r) => r.title && r.link);
      return res.json({ status: true, count: results.length, results });
    }

    // ── DETAILS ──────────────────────────────────────────────────────────────
    if (action === "details") {
      if (!url)
        return res.status(400).json({ status: false, message: "url param missing" });

      const html = await getHTML(url);
      const $ = cheerio.load(html);

      const title = $("h1.post-title, h2.post-title, h1.entry-title, h2.entry-title, h1")
        .first()
        .text()
        .trim();

      // Best image: first large image in the post body
      let image = "";
      $(".post-body img, .entry-content img").each((i, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || "";
        if (src && !image) image = src;
      });

      // Episodes: elements with id starting with "ep-"
      const episodes = [];
      $('[id^="ep-"]').each((i, el) => {
        const epId = $(el).attr("id") || "";
        if (epId) episodes.push({ ep: epId, anchor: `${url.split("#")[0]}#${epId}` });
      });

      const gdriveLinks = extractGdriveLinks($, html);

      return res.json({
        status: true,
        title,
        image,
        url,
        has_episodes: episodes.length > 0,
        episodes: episodes.length > 0 ? episodes : null,
        gdrive_links: gdriveLinks.length > 0 ? gdriveLinks : null,
      });
    }

    // ── GDRIVE ───────────────────────────────────────────────────────────────
    if (action === "gdrive") {
      if (!url)
        return res.status(400).json({ status: false, message: "url param missing" });

      const html = await getHTML(url);
      const $ = cheerio.load(html);
      const gdriveLinks = extractGdriveLinks($, html);

      if (gdriveLinks.length === 0)
        return res.json({ status: false, message: "No Google Drive links found", url });

      return res.json({ status: true, count: gdriveLinks.length, gdrive_links: gdriveLinks });
    }

    return res.status(400).json({ status: false, message: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ status: false, error: err.message });
  }
};

function extractGdriveLinks($, rawHtml) {
  const found = [];
  const seen = new Set();

  $('a[href*="drive.google.com"], a[href*="drive.usercontent.google.com"]').each((i, el) => {
    const href = $(el).attr("href") || "";
    const label = $(el).text().trim() || "Google Drive";
    if (href && !seen.has(href)) {
      seen.add(href);
      found.push({ label, original: href, direct: toDirect(href) });
    }
  });

  // Also scan raw HTML for drive URLs embedded in scripts / data attributes
  const matches = rawHtml.match(/https:\/\/drive\.google\.com\/[^\s"'<>\\]+/g) || [];
  for (const m of matches) {
    const clean = m
      .replace(/\\u003d/g, "=")
      .replace(/\\u0026/g, "&")
      .split("&amp;")[0];
    if (!seen.has(clean)) {
      seen.add(clean);
      found.push({ label: "Google Drive", original: clean, direct: toDirect(clean) });
    }
  }

  return found;
}

function toDirect(url) {
  if (url.includes("drive.usercontent.google.com")) return url;
  const idMatch =
    url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) ||
    url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idMatch)
    return `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&authuser=0`;
  return url;
}
