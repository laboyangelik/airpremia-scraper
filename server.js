import express from 'express';
import Steel from 'steel-sdk';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const STEEL_API_KEY = process.env.STEEL_API_KEY;

// ─── Session helper ──────────────────────────────────────────────────────────

async function withSession(fn) {
  const client = new Steel({ steelAPIKey: STEEL_API_KEY });
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

// ─── Core scraper: Google Flights ───────────────────────────────────────────

async function scrapeGoogleFlights({ origin, destination, depart_date, return_date, adults = 1, sort_by = 'price' }) {
  return withSession(async (page) => {
    // Build Google Flights URL directly
    const tripType = return_date ? '1' : '2'; // 1=roundtrip, 2=oneway
    const pax = `${adults}.0.0.0`; // adults.children.infants_on_lap.infants_in_seat
    let url = `https://www.google.com/travel/flights?hl=en&curr=USD`;

    await page.goto('https://www.google.com/travel/flights?hl=en&curr=USD', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    await page.waitForTimeout(2000);

    // Dismiss any popups
    await page.click('button:has-text("Accept all"), button:has-text("Reject all"), [aria-label="Close"]').catch(() => {});
    await page.waitForTimeout(500);

    // Set one-way if needed
    if (!return_date) {
      await page.click('[data-value="2"], [aria-label*="one way"], [aria-label*="One way"]').catch(() => {});
      await page.waitForTimeout(400);
    }

    // Origin
    await page.click('input[placeholder="Where from?"], [aria-label="Where from?"]').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.type(origin, { delay: 60 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Destination
    await page.click('input[placeholder="Where to?"], [aria-label="Where to?"]').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.type(destination, { delay: 60 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // Departure date
    await page.click('[data-placeholder="Departure"], [aria-label*="Departure"]').catch(() => {});
    await page.waitForTimeout(400);
    // Type date in MM/DD/YYYY format
    const [year, month, day] = depart_date.split('-');
    await page.keyboard.type(`${month}/${day}/${year}`, { delay: 60 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    if (return_date) {
      const [ry, rm, rd] = return_date.split('-');
      await page.keyboard.type(`${rm}/${rd}/${ry}`, { delay: 60 });
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(300);

    // Done with date picker
    await page.click('[aria-label="Done. Search for"], button:has-text("Done")').catch(() => {});
    await page.waitForTimeout(500);

    // Search
    await page.click('[aria-label="Search"], button:has-text("Search")').catch(() => {});
    await page.waitForTimeout(6000);

    // Wait for results
    await page.waitForSelector('[jsname="IWWDBc"] li, [role="list"] li', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Extract flights
    const flights = await page.evaluate((sortBy) => {
      const items = [];
      const cards = document.querySelectorAll('[jsname="IWWDBc"] li, ul[role="listitem"] > li');

      cards.forEach(card => {
        // Price
        const priceEl = card.querySelector('[aria-label*="$"], [data-gs]');
        const priceAttr = priceEl?.getAttribute('aria-label') || priceEl?.innerText || '';
        const price = parseFloat(priceAttr.replace(/[^0-9.]/g, ''));
        if (!price || price < 50) return;

        // Airline
        const airline = card.querySelector('[class*="sSHqwe"], [class*="Xsgmwe"], [class*="h1fkLb"]')?.innerText?.trim()
          || card.querySelector('img[alt]')?.getAttribute('alt') || 'Unknown';

        // Duration
        const duration = card.querySelector('[class*="AdWm1c"], [aria-label*=" hr"]')?.innerText?.trim()
          || card.querySelector('[class*="gvkrdb"]')?.innerText?.trim();

        // Stops
        const stopsEl = card.querySelector('[class*="EfT7Ae"], [class*="ogfYpf"], [class*="VG3hNb"]');
        const stops = stopsEl?.innerText?.trim() || 'Nonstop';

        // Times
        const times = card.querySelectorAll('[class*="wtdjmc"], [class*="Ak5kof"]');
        const departs = times[0]?.innerText?.trim();
        const arrives = times[1]?.innerText?.trim();

        items.push({ price, airline, duration, stops, departs, arrives });
      });

      if (sortBy === 'fastest') {
        return items.sort((a, b) => {
          const toMins = d => {
            if (!d) return 9999;
            const h = parseInt(d.match(/(\d+)\s*hr/)?.[1] || 0);
            const m = parseInt(d.match(/(\d+)\s*min/)?.[1] || 0);
            return h * 60 + m;
          };
          return toMins(a.duration) - toMins(b.duration);
        });
      }
      return items.sort((a, b) => a.price - b.price);
    }, sort_by);

    const bookingUrl = page.url();
    return { flights, bookingUrl };
  });
}

// ─── Also scrape Kiwi as fallback/supplement ─────────────────────────────────

async function scrapeKiwi({ origin, destination, depart_date, return_date, adults = 1 }) {
  return withSession(async (page) => {
    const returnPart = return_date || 'no-return';
    const url = `https://www.kiwi.com/us/search/results/${origin}/${destination}/${depart_date}/${returnPart}?adults=${adults}&currency=USD&sortBy=price`;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.click('[data-test="CookiesPopup-Accept"], button:has-text("Accept")').catch(() => {});
    await page.waitForTimeout(1000);

    const flights = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('[data-test="resultCard"]').forEach(card => {
        const priceText = card.querySelector('[data-test="flight-price"]')?.innerText;
        const price = parseFloat(priceText?.replace(/[^0-9.]/g, '') || '0');
        if (!price) return;
        items.push({
          price,
          airline: card.querySelector('[class*="CarrierLogo"] img')?.getAttribute('alt') || 'Unknown',
          duration: card.querySelector('[data-test="journey-duration"]')?.innerText?.trim(),
          stops: card.querySelector('[data-test="stops"]')?.innerText?.trim() || 'Direct',
          departs: card.querySelector('[class*="RoutePoint"]:first-child [class*="time"]')?.innerText?.trim(),
          arrives: card.querySelector('[class*="RoutePoint"]:last-child [class*="time"]')?.innerText?.trim()
        });
      });
      return items.sort((a, b) => a.price - b.price);
    });

    return { flights, bookingUrl: page.url() };
  });
}

// ─── /search — drop-in replacement for existing flight_api ───────────────────
// Same params as the old API: origin, destination, depart_date, return_date, adults, sort_by
// Same response shape: { depart_date, return_date, flights: [...] }

app.get('/search', async (req, res) => {
  const { origin, destination, depart_date, return_date, adults = 1, sort_by = 'price_high' } = req.query;

  if (!origin || !destination || !depart_date) {
    return res.status(400).json({ error: 'origin, destination, depart_date required' });
  }

  const params = { origin, destination, depart_date, return_date, adults: parseInt(adults), sort_by };
  console.log(`/search ${origin}→${destination} ${depart_date} sort=${sort_by}`);

  try {
    // Run Google Flights + Kiwi in parallel
    const [google, kiwi] = await Promise.allSettled([
      scrapeGoogleFlights(params),
      scrapeKiwi(params)
    ]);

    const googleFlights = google.status === 'fulfilled' ? google.value.flights : [];
    const kiwiFlights  = kiwi.status  === 'fulfilled' ? kiwi.value.flights  : [];
    const bookingUrl   = google.status === 'fulfilled' ? google.value.bookingUrl : kiwi.value?.bookingUrl;

    // Merge + dedupe by price+airline, sort
    const merged = [...googleFlights, ...kiwiFlights]
      .filter(f => f.price > 0)
      .sort((a, b) => sort_by === 'fastest'
        ? durationToMins(a.duration) - durationToMins(b.duration)
        : a.price - b.price
      );

    // Return in same shape the existing Retool workflows expect
    return res.json({
      depart_date,
      return_date: return_date || null,
      flights: merged.map(f => ({ ...f, booking_url: bookingUrl }))
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message, flights: [] });
  }
});

// ─── /search-flexible — replaces the looping workflow ────────────────────────
// Scans Google Flights price calendar for cheapest dates across a window
// Returns array of { depart_date, return_date, flights: [...] } — same shape as loopDates

app.post('/search-flexible', async (req, res) => {
  const { origin, destination, start_month, trip_length_days = 7, adults = 1 } = req.body;

  if (!origin || !destination || !start_month) {
    return res.status(400).json({ error: 'origin, destination, start_month required' });
  }

  console.log(`/search-flexible ${origin}→${destination} from ${start_month} trip=${trip_length_days}d`);

  try {
    const results = await withSession(async (page) => {
      // Navigate to Google Flights and use the date grid / price calendar
      await page.goto('https://www.google.com/travel/flights?hl=en&curr=USD', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      await page.waitForTimeout(2000);

      await page.click('button:has-text("Accept all")').catch(() => {});
      await page.waitForTimeout(400);

      // Set roundtrip
      await page.click('[data-value="1"], [aria-label*="Round trip"]').catch(() => {});
      await page.waitForTimeout(400);

      // Origin
      await page.click('input[placeholder="Where from?"]').catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(origin, { delay: 60 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);

      // Destination
      await page.click('input[placeholder="Where to?"]').catch(() => {});
      await page.keyboard.type(destination, { delay: 60 });
      await page.waitForTimeout(1000);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      // Click "Flexible dates" or use date picker with month start
      const [sy, sm] = start_month.split('-');
      const startDate = new Date(`${sy}-${sm}-01`);
      const [m, d, y] = [String(startDate.getMonth() + 1).padStart(2,'0'), '01', sy];

      await page.click('[data-placeholder="Departure"]').catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.type(`${m}/${d}/${y}`, { delay: 60 });
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');

      // Return = depart + trip_length_days
      const returnDate = new Date(startDate);
      returnDate.setDate(returnDate.getDate() + parseInt(trip_length_days));
      const [rm, rd, ry] = [
        String(returnDate.getMonth() + 1).padStart(2,'0'),
        String(returnDate.getDate()).padStart(2,'0'),
        String(returnDate.getFullYear())
      ];
      await page.keyboard.type(`${rm}/${rd}/${ry}`, { delay: 60 });
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);

      await page.click('button:has-text("Done")').catch(() => {});
      await page.waitForTimeout(500);
      await page.click('[aria-label="Search"], button:has-text("Search")').catch(() => {});
      await page.waitForTimeout(5000);

      // Try to open the price grid / calendar view
      await page.click('button:has-text("Price graph"), [aria-label*="price graph"], button:has-text("Date grid")').catch(() => {});
      await page.waitForTimeout(3000);

      // Extract calendar prices
      const calendarData = await page.evaluate(() => {
        const cells = document.querySelectorAll('[data-calendarprices], [class*="calendar"] [class*="price"], [class*="PriceCalendar"] td');
        const dates = [];
        cells.forEach(cell => {
          const dateAttr = cell.getAttribute('data-date') || cell.getAttribute('aria-label') || '';
          const priceText = cell.querySelector('[class*="price"]')?.innerText || cell.innerText;
          const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
          if (dateAttr && price > 50) {
            dates.push({ date: dateAttr, price });
          }
        });
        return dates.sort((a, b) => a.price - b.price).slice(0, 10);
      });

      // Fallback: if calendar didn't work, just grab current results
      if (!calendarData.length) {
        const flights = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll('[jsname="IWWDBc"] li').forEach(card => {
            const priceAttr = card.querySelector('[aria-label*="$"]')?.getAttribute('aria-label') || '';
            const price = parseFloat(priceAttr.replace(/[^0-9.]/g, ''));
            if (!price) return;
            items.push({
              price,
              airline: card.querySelector('[class*="sSHqwe"]')?.innerText?.trim() || 'Unknown',
              duration: card.querySelector('[class*="AdWm1c"]')?.innerText?.trim(),
              stops: card.querySelector('[class*="EfT7Ae"]')?.innerText?.trim() || 'Nonstop'
            });
          });
          return items.sort((a, b) => a.price - b.price);
        });

        const bookingUrl = page.url();
        return [{
          depart_date: `${sy}-${sm}-01`,
          return_date: `${ry}-${rm}-${rd}`,
          flights: flights.map(f => ({ ...f, booking_url: bookingUrl }))
        }];
      }

      // Return calendar results in expected shape
      const bookingUrl = page.url();
      return calendarData.map(item => ({
        depart_date: item.date,
        return_date: (() => {
          const d = new Date(item.date);
          d.setDate(d.getDate() + parseInt(trip_length_days));
          return d.toISOString().split('T')[0];
        })(),
        flights: [{ price: item.price, airline: 'See booking link', duration: null, stops: null, booking_url: bookingUrl }]
      }));
    });

    return res.json({ formatResult: results });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message, formatResult: [] });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function durationToMins(d) {
  if (!d) return 9999;
  const h = parseInt(d.match(/(\d+)\s*hr/)?.[1] || 0);
  const m = parseInt(d.match(/(\d+)\s*min/)?.[1] || 0);
  return h * 60 + m;
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Flight scraper running on port ${PORT}`));
