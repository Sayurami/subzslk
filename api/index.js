const fetch = require("node-fetch");
const cheerio = require("cheerio");

const BASE_URL = "https://www.moviesublk.com";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
};

async function getHTML(url) {
  const res = await fetch(url, { headers });
  return await res.text();
}

// Extract image URL from a post element.
// The site uses document.write(postthumbnail("URL", ...)) inside <script> tags,
// or stores the full URL in <a content="URL"> before the post-image div.
function extractImage($, el) {
  // 1. Try <a content="..."> attribute (full resolution image)
  const contentAttr = $(el).find('a[content]').first().attr('content');
  if (contentAttr && contentAttr.startsWith('http')) return contentAttr;

  // 2. Try extracting from script postthumbnail("URL", ...) call
  const scriptText = $(el).find('script').text();
  const thumbMatch = scriptText.match(/postthumbnail\(\s*["']([^"']+)["']/);
  if (thumbMatch) {
    // Convert s72-c thumbnail to s320 for better quality
    return thumbMatch[1].replace('/s72-c/', '/s320/');
  }

  // 3. Try regular img tags (data-src or src)
  const img = $(el).find('img').first();
  return img.attr('data-src') || img.attr('src') || '';
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { action, query, url } = req.query;

    if (!action)
      return res.status(400).json({ status: false, message: "action missing. Use: search | list | details | gdrive" });

    // ── SEARCH ──────────────────────────────────────────────────────────────
    if (action === "search") {
      if (!query) return res.status(400).json({ status: false, message: "query param missing" });

      const html = await getHTML(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
      const $ = cheerio.load(html);
      const results = [];

      // Each post is wrapped in div.post-outer > article.post.hentry
      $('article.post.hentry').each((i, el) => {
        // Title and link come from h2.post-title a
        const titleEl = $(el).find('h2.post-title a, h2.entry-title a').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || $(el).find('a[href*="moviesublk.com"]').first().attr('href') || '';
        const image = extractImage($, el);
        const badge = $(el).find('.post-labels a, .label a').first().text().trim();

        if (title && link) results.push({ title, link, image, type: badge || null });
      });

      return res.json({ status: true, count: results.length, results });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      // The main page uses the Blogger feed; scrape the homepage or label page
      const listUrl = query
        ? `${BASE_URL}/search/label/${encodeURIComponent(query)}`
        : BASE_URL;

      const html = await getHTML(listUrl);
      const $ = cheerio.load(html);
      const results = [];

      $('article.post.hentry').each((i, el) => {
        const titleEl = $(el).find('h2.post-title a, h2.entry-title a').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || $(el).find('a[href*="moviesublk.com"]').first().attr('href') || '';
        const image = extractImage($, el);
        const badge = $(el).find('.post-labels a, .label a').first().text().trim();

        if (title && link) results.push({ title, link, image, type: badge || 'MOVIE' });
      });

      return res.json({ status: true, count: results.length, results });
    }

    // ── DETAILS ──────────────────────────────────────────────────────────────
    if (action === "details") {
      if (!url) return res.status(400).json({ status: false, message: "url param missing" });

      const html = await getHTML(url);
      const $ = cheerio.load(html);

      const title = $('h1.post-title, h2.post-title, h1.entry-title, h2.entry-title, h1').first().text().trim();

      // Main post image — first large image in post body
      let image = '';
      const firstPostImg = $('.post-body img, .entry-content img').first();
      image = firstPostImg.attr('src') || firstPostImg.attr('data-src') || '';

      // Episodes: anchors like id="ep-1", id="ep-2", etc.
      const episodes = [];
      $('a[id^="ep-"], [id^="ep-"]').each((i, el) => {
        const epId = $(el).attr('id') || '';
        if (epId) episodes.push({ ep: epId, anchor: `${url.split('#')[0]}#${epId}` });
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
      if (!url) return res.status(400).json({ status: false, message: "url param missing" });

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
    const href = $(el).attr('href') || '';
    const label = $(el).text().trim() || 'Google Drive';
    if (href && !seen.has(href)) {
      seen.add(href);
      found.push({ label, original: href, direct: toDirect(href) });
    }
  });

  // Also scan raw HTML for drive URLs (sometimes embedded in JS / data attrs)
  const matches = rawHtml.match(/https:\/\/drive\.google\.com\/[^\s"'<>\\]+/g) || [];
  for (const m of matches) {
    const clean = m
      .replace(/\\u003d/g, '=')
      .replace(/\\u0026/g, '&')
      .split('&amp;')[0];
    if (!seen.has(clean)) {
      seen.add(clean);
      found.push({ label: 'Google Drive', original: clean, direct: toDirect(clean) });
    }
  }

  return found;
}

function toDirect(url) {
  if (url.includes('drive.usercontent.google.com')) return url;
  const idMatch =
    url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) ||
    url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idMatch)
    return `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&authuser=0`;
  return url;
}
