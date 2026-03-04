import express from 'express';
import Steel from 'steel-sdk';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const STEEL_API_KEY = process.env.STEEL_API_KEY;

// ─── Helpers ────────────────────────────────────────────────────────────────

function steelClient() {
  return new Steel({ steelAPIKey: STEEL_API_KEY });
}

async function withSession(fn) {
  const client = steelClient();
  const session = await client.sessions.create({ solveCaptcha: true });
  const browser = await chromium.connectOverCDP(session.websocketUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  try {
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
    await client.sessions.release(session.id).catch(() => {});
  }
}

// ─── Google Flights scraper ──────────────────────────────────────────────────

async function scrapeGoogleFlights({ origin, destination, departure_date, return_date, passengers }) {
  return withSession(async (page) => {
    const trip = return_date ? 'r' : 'o'; // r = round trip, o = one way
    const url = `https://www.google.com/travel/flights/search?tfs=&hl=en&q=flights+from+${origin}+to+${destination}+on+${departure_date}${return_date ? '+returning+' + return_date : ''}&curr=USD`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);

    // If no results loaded via query string, try filling the form
    const hasResults = await page.$('[class*="flight-result"], [jsname="IWWDBc"], [data-ved] [class*="YMlIz"]').catch(() => null);
    if (!hasResults) {
      await page.goto('https://www.google.com/travel/flights', { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2000);

      // One-way toggle
      if (!return_date) {
        await page.click('[data-value="2"]').catch(() => {});
        await page.waitForTimeout(300);
      }

      // Origin
      await page.click('input[placeholder="Where from?"]').catch(() => {});
      await page.keyboard.type(origin, { delay: 80 });
      await page.waitForTimeout(800);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);

      // Destination
      await page.click('input[placeholder="Where to?"]').catch(() => {});
      await page.keyboard.type(destination, { delay: 80 });
      await page.waitForTimeout(800);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);

      // Date — click the date field and type
      await page.click('[data-placeholder="Departure"]').catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.type(departure_date);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      if (return_date) {
        await page.keyboard.type(return_date);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(300);

      await page.click('[aria-label="Search"]').catch(() => {});
      await page.waitForTimeout(6000);
    }

    const results = await page.evaluate(() => {
      const items = [];
      // Google Flights result cards
      const cards = document.querySelectorAll('[jsname="IWWDBc"] li, [class*="flight-result"] li, ul[role="list"] li');
      cards.forEach(card => {
        const priceEl = card.querySelector('[data-gs], [aria-label*="$"], [class*="YMlIz"]');
        const priceText = priceEl?.innerText || priceEl?.getAttribute('aria-label') || '';
        const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
        if (!price || price < 50) return;

        const airline = card.querySelector('[class*="sSHqwe"], [class*="Xsgmwe"]')?.innerText?.trim();
        const duration = card.querySelector('[class*="AdWm1c"], [aria-label*="hr"]')?.innerText?.trim();
        const stops = card.querySelector('[class*="EfT7Ae"], [class*="ogfYpf"]')?.innerText?.trim() || 'Direct';
        const departs = card.querySelector('[class*="wtdjmc"]')?.innerText?.trim();
        const arrives = card.querySelector('[class*="XWcVob"]')?.innerText?.trim();

        items.push({ airline, price, currency: 'USD', duration, stops, departs, arrives });
      });
      return items;
    });

    return {
      source: 'Google Flights',
      booking_url: page.url(),
      results: results.filter(r => r.price).sort((a, b) => a.price - b.price)
    };
  });
}

// ─── Kiwi.com scraper ───────────────────────────────────────────────────────

async function scrapeKiwi({ origin, destination, departure_date, return_date, passengers }) {
  return withSession(async (page) => {
    // Kiwi URL format: /search/results/{from}/{to}/{depart}/{return or "no-return"}
    const datePart = departure_date; // YYYY-MM-DD
    const returnPart = return_date || 'no-return';
    const url = `https://www.kiwi.com/us/search/results/${origin}/${destination}/${datePart}/${returnPart}?adults=${passengers}&currency=USD&sortBy=price`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000); // Kiwi is React, needs time

    // Dismiss cookie banner if present
    await page.click('[data-test="CookiesPopup-Accept"], button:has-text("Accept")').catch(() => {});
    await page.waitForTimeout(1000);

    const results = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('[data-test="resultCard"], [class*="ResultCard"]');
      cards.forEach(card => {
        const priceText = card.querySelector('[data-test="flight-price"], [class*="price"]')?.innerText;
        const price = parseFloat(priceText?.replace(/[^0-9.]/g, '') || '0');
        if (!price) return;

        const airline = card.querySelector('[class*="airline-name"], [class*="CarrierLogo"] img')?.getAttribute('alt')
          || card.querySelector('[class*="carrier"]')?.innerText?.trim();
        const duration = card.querySelector('[data-test="journey-duration"], [class*="duration"]')?.innerText?.trim();
        const stops = card.querySelector('[data-test="stops"], [class*="stops"]')?.innerText?.trim() || 'Direct';
        const departs = card.querySelector('[class*="departure"] time, [class*="RoutePoint"]:first-child [class*="time"]')?.innerText?.trim();
        const arrives = card.querySelector('[class*="arrival"] time, [class*="RoutePoint"]:last-child [class*="time"]')?.innerText?.trim();

        items.push({ airline, price, currency: 'USD', duration, stops, departs, arrives });
      });
      return items;
    });

    return {
      source: 'Kiwi.com',
      booking_url: page.url(),
      results: results.filter(r => r.price).sort((a, b) => a.price - b.price)
    };
  });
}

// ─── Fly.com scraper ─────────────────────────────────────────────────────────

async function scrapeFly({ origin, destination, departure_date, return_date, passengers }) {
  return withSession(async (page) => {
    const url = `https://www.fly.com/search?origin=${origin}&destination=${destination}&departDate=${departure_date}${return_date ? '&returnDate=' + return_date : ''}&adults=${passengers}&tripType=${return_date ? 'roundtrip' : 'oneway'}&currency=USD`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

    await page.click('button:has-text("Accept"), [class*="cookie"] button').catch(() => {});
    await page.waitForTimeout(500);

    const results = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('[class*="flight-card"], [class*="result"], [class*="deal"]');
      cards.forEach(card => {
        const priceText = card.querySelector('[class*="price"], [class*="amount"]')?.innerText;
        const price = parseFloat(priceText?.replace(/[^0-9.]/g, '') || '0');
        if (!price) return;

        const airline = card.querySelector('[class*="airline"], [class*="carrier"]')?.innerText?.trim();
        const duration = card.querySelector('[class*="duration"]')?.innerText?.trim();
        const stops = card.querySelector('[class*="stop"]')?.innerText?.trim() || 'Direct';
        const departs = card.querySelector('[class*="depart"]')?.innerText?.trim();
        const arrives = card.querySelector('[class*="arriv"]')?.innerText?.trim();

        items.push({ airline, price, currency: 'USD', duration, stops, departs, arrives });
      });
      return items;
    });

    return {
      source: 'Fly.com',
      booking_url: page.url(),
      results: results.filter(r => r.price).sort((a, b) => a.price - b.price)
    };
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/scrape-flights', async (req, res) => {
  const {
    origin,
    destination,
    departure_date,
    return_date = null,
    passengers = 1,
    sources = ['google', 'kiwi', 'fly'] // caller can limit which sites to hit
  } = req.body;

  if (!origin || !destination || !departure_date) {
    return res.status(400).json({ error: 'origin, destination, and departure_date are required' });
  }

  const params = { origin, destination, departure_date, return_date, passengers };
  const scrapers = [];

  if (sources.includes('google')) scrapers.push(scrapeGoogleFlights(params).catch(e => ({ source: 'Google Flights', error: e.message, results: [] })));
  if (sources.includes('kiwi'))  scrapers.push(scrapeKiwi(params).catch(e => ({ source: 'Kiwi.com', error: e.message, results: [] })));
  if (sources.includes('fly'))   scrapers.push(scrapeFly(params).catch(e => ({ source: 'Fly.com', error: e.message, results: [] })));

  console.log(`Scraping ${scrapers.length} sources for ${origin}→${destination} on ${departure_date}`);

  const sourceResults = await Promise.all(scrapers);

  // Flatten + tag with source + sort by price
  const allResults = sourceResults.flatMap(s =>
    (s.results || []).map(r => ({ ...r, source: s.source, booking_url: s.booking_url }))
  ).sort((a, b) => a.price - b.price);

  return res.json({
    route: `${origin} → ${destination}`,
    departure_date,
    return_date,
    passengers,
    sources: sourceResults.map(s => ({ name: s.source, count: s.results?.length || 0, error: s.error || null })),
    cheapest: allResults[0] || null,
    all_results: allResults
  });
});

app.listen(PORT, () => console.log(`Flight scraper running on port ${PORT}`));
