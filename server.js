import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';

app.use(express.json({ limit: '2mb' }));

// In-memory cache for live crypto market data
const cache = {
  markets: null,
  marketsAt: 0,
  trending: null,
  trendingAt: 0,
  news: null,
  newsAt: 0,
  charts: new Map(),
  searches: new Map()
};

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CRYPTOCOMPARE_NEWS = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN';

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CryptoScoreAI/2.0 (High-Performance Market Monitor)',
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 1. Live Markets Proxy with 60-second caching
app.get('/api/markets', async (req, res) => {
  const now = Date.now();
  const topN = parseInt(req.query.topN || '100', 10);
  const ids = req.query.ids ? String(req.query.ids).trim() : '';

  // If specific IDs are queried, fetch or return
  if (ids) {
    try {
      const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h,7d`;
      const data = await fetchWithTimeout(url);
      return res.json(data);
    } catch (err) {
      // Return filtered cached markets if available
      if (cache.markets) {
        const idList = ids.split(',').map(s => s.trim().toLowerCase());
        const filtered = cache.markets.filter(c => idList.includes(c.id.toLowerCase()));
        return res.json(filtered);
      }
      return res.status(503).json({ error: 'Market data temporarily unavailable' });
    }
  }

  // If cached data is fresh (< 60s), serve immediately
  if (cache.markets && (now - cache.marketsAt < 60000)) {
    return res.json(cache.markets.slice(0, topN));
  }

  // Fetch fresh markets in background or inline
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h,7d&sparkline=true`;
    const fresh = await fetchWithTimeout(url);
    if (Array.isArray(fresh) && fresh.length > 0) {
      cache.markets = fresh;
      cache.marketsAt = now;
      return res.json(fresh.slice(0, topN));
    }
  } catch (err) {
    console.warn('Upstream CoinGecko markets warning:', err.message);
  }

  // If fresh fetch had an issue but cache exists, return cache
  if (cache.markets) {
    return res.json(cache.markets.slice(0, topN));
  }

  return res.status(503).json({ error: 'Market data initializing' });
});

// 2. Trending Proxy
app.get('/api/trending', async (req, res) => {
  const now = Date.now();
  if (cache.trending && (now - cache.trendingAt < 300000)) {
    return res.json(cache.trending);
  }

  try {
    const url = `${COINGECKO_BASE}/search/trending`;
    const fresh = await fetchWithTimeout(url);
    if (fresh && fresh.coins) {
      cache.trending = fresh;
      cache.trendingAt = now;
      return res.json(fresh);
    }
  } catch (err) {
    console.warn('Upstream trending warning:', err.message);
  }

  if (cache.trending) return res.json(cache.trending);
  return res.json({ coins: [] });
});

// 3. News Proxy
app.get('/api/news', async (req, res) => {
  const now = Date.now();
  if (cache.news && (now - cache.newsAt < 600000)) {
    return res.json(cache.news);
  }

  try {
    const fresh = await fetchWithTimeout(CRYPTOCOMPARE_NEWS);
    if (fresh && fresh.Data) {
      cache.news = fresh;
      cache.newsAt = now;
      return res.json(fresh);
    }
  } catch (err) {
    console.warn('Upstream news warning:', err.message);
  }

  if (cache.news) return res.json(cache.news);
  return res.json({ Data: [] });
});

// 4. Historical Chart Proxy
app.get('/api/chart/:id', async (req, res) => {
  const id = req.params.id;
  const days = req.query.days || '180';
  const cacheKey = `${id}-${days}`;
  const cached = cache.charts.get(cacheKey);

  if (cached && (Date.now() - cached.at < 600000)) {
    return res.json(cached.data);
  }

  try {
    const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const fresh = await fetchWithTimeout(url);
    if (fresh && fresh.prices) {
      cache.charts.set(cacheKey, { at: Date.now(), data: fresh });
      return res.json(fresh);
    }
  } catch (err) {
    console.warn(`Upstream chart warning for ${id}:`, err.message);
  }

  if (cached) return res.json(cached.data);
  return res.status(404).json({ error: 'Chart data not found' });
});

// 5. Search Proxy
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ coins: [] });

  const cached = cache.searches.get(q);
  if (cached && (Date.now() - cached.at < 300000)) {
    return res.json(cached.data);
  }

  try {
    const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(q)}`;
    const fresh = await fetchWithTimeout(url);
    if (fresh && fresh.coins) {
      cache.searches.set(q, { at: Date.now(), data: fresh });
      return res.json(fresh);
    }
  } catch (err) {
    console.warn('Upstream search warning:', err.message);
  }

  if (cached) return res.json(cached.data);
  return res.json({ coins: [] });
});

// 6. AI assistant endpoint using Gemini API
app.post('/api/ai', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(200).json({
      text: "The AI assistant is operating with heuristic market models. For personalized live Gemini analysis, set GEMINI_API_KEY in the deployment environment."
    });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return res.json({ text: response.text || '' });
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(500).json({
      error: err.message || 'Error communicating with Gemini AI service'
    });
  }
});

// Icon endpoints for PWA
app.get(['/icon-192.png', '/icon-512.png'], (req, res) => {
  res.sendFile(path.join(__dirname, 'icon.svg'));
});

// Serve static assets (manifest.json, sw.js, three-scene.js, etc.)
app.use(express.static(__dirname, {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Fallback to index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Warm cache immediately on startup so users never wait
(async () => {
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h,7d&sparkline=true`;
    const fresh = await fetchWithTimeout(url, {}, 5000);
    if (Array.isArray(fresh) && fresh.length > 0) {
      cache.markets = fresh;
      cache.marketsAt = Date.now();
      console.log(`Pre-warmed market cache with ${fresh.length} live crypto assets`);
    }
  } catch (e) {
    console.log('Background cache warm deferred to first user request');
  }
})();

app.listen(port, host, () => {
  console.log(`Crypto Score AI server listening on http://${host}:${port}`);
});
