import express from 'express';
import Steel from 'steel-sdk';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const STEEL_API_KEY = process.env.STEEL_API_KEY;

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/scrape-airpremia', async (req, res) => {
  const {
    origin = 'EWR',
    destination = 'NRT',
    departure_date,
    return_date = null,
    passengers = 1
  } = req.body;

  if (!departure_date) {
    return res.status(400).json({ error: 'departure_date is required (YYYY-MM-DD)' });
  }

  const client = new Steel({ steelAPIKey: STEEL_API_KEY });
  let session;

  try {
    session = await client.sessions.create({ solveCaptcha: true });
    console.log(`Session created: ${session.id}`);

    const browser = await chromium.connectOverCDP(session.websocketUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    await page.goto('https://www.airpremia.com/en/booking/flight-search', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Trip type
    if (return_date) {
      await page.click('[data-trip="RT"], input[value="RT"], label:has-text("Round")').catch(() => {});
    } else {
      await page.click('[data-trip="OW"], input[value="OW"], label:has-text("One")').catch(() => {});
    }
    await page.waitForTimeout(500);

    // Origin
    const originInput = page.locator('input[placeholder*="Origin"], input[id*="from"], input[name*="origin"]').first();
    await originInput.fill(origin);
    await page.waitForTimeout(800);
    await page.locator('[class*="suggestion"] li, [class*="autocomplete"] li, [class*="dropdown"] li').first().click().catch(() => {});
    await page.waitForTimeout(400);

    // Destination
    const destInput = page.locator('input[placeholder*="Destination"], input[id*="to"], input[name*="destination"]').first();
    await destInput.fill(destination);
    await page.waitForTimeout(800);
    await page.locator('[class*="suggestion"] li, [class*="autocomplete"] li, [class*="dropdown"] li').first().click().catch(() => {});
    await page.waitForTimeout(400);

    // Departure date
    const dateInput = page.locator('input[placeholder*="Depart"], input[id*="depart"], input[type="date"]').first();
    await dateInput.fill(departure_date);
    await page.waitForTimeout(400);

    // Return date
    if (return_date) {
      const returnInput = page.locator('input[placeholder*="Return"], input[id*="return"]').first();
      await returnInput.fill(return_date);
      await page.waitForTimeout(400);
    }

    // Passengers
    for (let i = 1; i < passengers; i++) {
      await page.click('[aria-label*="Adult"] button[class*="plus"], [class*="passenger"] [class*="increment"]').catch(() => {});
      await page.waitForTimeout(200);
    }

    // Submit
    await page.click('button[type="submit"], [class*="search-btn"], [class*="searchBtn"]');
    await page.waitForTimeout(8000);

    // Extract results
    const results = await page.evaluate(() => {
      const cards = document.querySelectorAll(
        '[class*="flight-card"], [class*="result-item"], [class*="itinerary-card"]'
      );
      const data = [];
      cards.forEach(card => {
        const priceText = card.querySelector('[class*="price"], [class*="fare"]')?.innerText;
        const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;
        if (!price) return;
        data.push({
          price,
          currency: priceText?.includes('$') ? 'USD' : 'KRW',
          departs: card.querySelector('[class*="depart-time"], [class*="departure-time"]')?.innerText?.trim(),
          arrives: card.querySelector('[class*="arrive-time"], [class*="arrival-time"]')?.innerText?.trim(),
          duration: card.querySelector('[class*="duration"]')?.innerText?.trim(),
          stops: card.querySelector('[class*="stop"]')?.innerText?.trim() || 'Direct',
          cabin: card.querySelector('[class*="cabin"], [class*="class-name"]')?.innerText?.trim() || 'Economy'
        });
      });
      return data.sort((a, b) => a.price - b.price);
    });

    const bookingUrl = page.url();
    await browser.close();

    return res.json({
      airline: 'Air Premia',
      route: `${origin} → ${destination}`,
      departure_date,
      return_date,
      passengers,
      booking_url: bookingUrl || 'https://www.airpremia.com',
      results,
      cheapest: results[0] || null
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (session) {
      await client.sessions.release(session.id).catch(() => {});
      console.log(`Session released: ${session.id}`);
    }
  }
});

app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
