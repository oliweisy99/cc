/**
 * Course Concierge - AI-Powered Weekly Data Report Automation
 *
 * HOW THE AI ANALYSIS WORKS:
 * ─────────────────────────────────────────────────────────────
 * 1. We read the Google Sheet and extract headers + last 3 data rows.
 * 2. We send that raw data to Claude with a structured prompt asking it
 *    to identify: column names, data types, sources (GA vs SamCart vs
 *    calculated), formatting patterns, and to produce a "fetch plan".
 * 3. Claude returns a JSON schema. We cache this to analysis-cache.json
 *    so we don't pay for a re-analysis on every run.
 * 4. We execute the fetch plan — calling GA Data API and SamCart REST API.
 * 5. We send the raw API responses back to Claude and ask it to format
 *    a single row array matching the exact sheet structure.
 * 6. We append that row to the sheet and do a self-validation read-back.
 *
 * The key insight: Claude never sees hardcoded column names. It infers
 * everything from the sheet data you show it.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE helper ────────────────────────────────────────────────────────────────
// We use Server-Sent Events so the browser receives live status updates
// without polling. Each status message is one SSE "data:" line.
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Clients config ─────────────────────────────────────────────────────────────
// Each client can override the global .env values with their own credentials.
// To add a new client: duplicate an entry and fill in its own Sheet ID / GA property.
const CLIENTS = [
  {
    id: 'client1',
    name: 'Client 1',
    sheetId: process.env.GOOGLE_SHEET_ID,
    sheetTab: process.env.SHEET_TAB_NAME || 'Weekly Reports',
    gaPropertyId: process.env.GA_PROPERTY_ID,
    samcartApiKey: process.env.SAMCART_API_KEY,
  },
  {
    id: 'client2',
    name: 'Client 2',
    // Override these with Client 2's values when you have them:
    sheetId: process.env.CLIENT2_GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_ID,
    sheetTab: process.env.CLIENT2_SHEET_TAB_NAME || 'Weekly Reports',
    gaPropertyId: process.env.CLIENT2_GA_PROPERTY_ID || process.env.GA_PROPERTY_ID,
    samcartApiKey: process.env.CLIENT2_SAMCART_API_KEY || process.env.SAMCART_API_KEY,
  },
];

// ─── Analysis cache ─────────────────────────────────────────────────────────────
// After Claude analyses a sheet the result is persisted here. Keyed by
// `${clientId}:${sheetTab}` so each client/tab pair gets its own cache.
const CACHE_FILE = path.join(__dirname, 'analysis-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ─── Google auth ────────────────────────────────────────────────────────────────
function getGoogleAuth() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set in .env');
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });
  return auth;
}

// ─── Step 1: Read Google Sheet ───────────────────────────────────────────────────
async function readSheet(client) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read the full sheet — all values
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: client.sheetId,
    range: client.sheetTab,
  });

  const rows = response.data.values || [];
  if (rows.length === 0) throw new Error('Google Sheet appears to be empty.');

  const headers = rows[0];
  // Take up to the last 5 data rows (skipping the header) for Claude's sample
  const dataRows = rows.slice(1);
  const sampleRows = dataRows.slice(-Math.min(5, dataRows.length));

  return { headers, sampleRows, allRows: rows, totalDataRows: dataRows.length };
}

// ─── Step 2: Claude – Analyse sheet structure ────────────────────────────────────
/**
 * Sends the sheet headers + sample rows to Claude and asks for a full
 * structural analysis. Claude returns a JSON object we call the "schema".
 *
 * PROMPT DESIGN: We explicitly ask for a fetch_plan so Claude tells us
 * which GA metrics and SamCart fields to pull. This is the core "autonomous"
 * part — the app never hardcodes what to fetch.
 */
async function analyseSheetWithClaude(headers, sampleRows, anthropic) {
  const headersStr = JSON.stringify(headers);
  const sampleStr = JSON.stringify(sampleRows);

  const prompt = `You are a data engineer analyzing a Google Sheet used for weekly business reports.

SHEET HEADERS (row 1):
${headersStr}

SAMPLE DATA ROWS (last few rows):
${sampleStr}

Analyze this sheet and return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:

{
  "columns": [
    {
      "name": "exact header text",
      "index": 0,
      "data_type": "date|integer|float|currency|percentage|text|calculated",
      "format": "describe the format pattern you see, e.g. YYYY-MM-DD, $#,##0.00, #%",
      "source": "google_analytics|samcart|calculated|manual",
      "metric": "the specific API metric/field name if applicable, e.g. sessions, totalUsers, bounceRate",
      "notes": "any important observations about this column"
    }
  ],
  "fetch_plan": {
    "google_analytics": {
      "metrics": ["list of GA4 metric names needed, e.g. sessions, totalUsers, bounceRate"],
      "dimensions": ["list of GA4 dimension names if needed, e.g. sessionDefaultChannelGroup"],
      "date_range": "last_7_days"
    },
    "samcart": {
      "endpoints": ["orders"],
      "fields": ["list of fields needed from SamCart, e.g. amount, status, created_at"],
      "aggregations": ["list of aggregations, e.g. sum:amount, count:orders, avg:amount"]
    }
  },
  "date_column_index": 0,
  "date_is_week_start": true,
  "reporting_notes": "any important observations about how this sheet is structured"
}

Be thorough. Every column must have an entry. Infer the source from the column name and data patterns.
If you cannot determine the source, use "manual". For calculated fields (like week-over-week %), use "calculated".`;

  console.log('\n[Claude] Sending sheet analysis prompt...');
  console.log('[Claude] Headers:', headersStr);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = message.content[0].text;
  console.log('[Claude] Sheet analysis response:', rawText);

  // Strip any accidental markdown code fences Claude might add
  const jsonText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON for sheet analysis: ${e.message}\nRaw: ${rawText}`);
  }
}

// ─── Step 3a: Fetch Google Analytics data ────────────────────────────────────────
/**
 * Uses the GA4 Data API (BetaAnalyticsDataClient) to fetch metrics for
 * the last 7 days. The metrics/dimensions to fetch come from Claude's
 * fetch_plan, so this function is fully dynamic.
 */
async function fetchGoogleAnalytics(gaPropertyId, fetchPlan) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');

  const analyticsClient = new BetaAnalyticsDataClient({
    keyFilename: credPath,
  });

  const gaConfig = fetchPlan.google_analytics;
  if (!gaConfig || !gaConfig.metrics || gaConfig.metrics.length === 0) {
    console.log('[GA] No GA metrics in fetch plan, skipping.');
    return null;
  }

  // Build metric/dimension objects for the GA4 API
  const metrics = gaConfig.metrics.map((m) => ({ name: m }));
  const dimensions = (gaConfig.dimensions || []).map((d) => ({ name: d }));

  console.log('[GA] Fetching metrics:', gaConfig.metrics);
  console.log('[GA] Fetching dimensions:', gaConfig.dimensions || []);

  const [response] = await analyticsClient.runReport({
    property: `properties/${gaPropertyId}`,
    dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    metrics,
    dimensions: dimensions.length > 0 ? dimensions : undefined,
  });

  // Also fetch previous 7 days for WoW calculations
  const [prevResponse] = await analyticsClient.runReport({
    property: `properties/${gaPropertyId}`,
    dateRanges: [{ startDate: '14daysAgo', endDate: '8daysAgo' }],
    metrics,
    dimensions: dimensions.length > 0 ? dimensions : undefined,
  });

  return {
    current: response,
    previous: prevResponse,
    metricNames: gaConfig.metrics,
    dimensionNames: gaConfig.dimensions || [],
  };
}

// ─── Step 3b: Fetch SamCart data ─────────────────────────────────────────────────
/**
 * Calls SamCart REST API for orders in the last 7 days.
 * The fields and aggregations to compute come from Claude's fetch_plan.
 */
async function fetchSamCart(samcartApiKey, fetchPlan) {
  const samConfig = fetchPlan.samcart;
  if (!samConfig || !samConfig.endpoints || samConfig.endpoints.length === 0) {
    console.log('[SamCart] No SamCart fields in fetch plan, skipping.');
    return null;
  }

  if (!samcartApiKey) {
    console.log('[SamCart] No API key set, returning mock data.');
    return { mock: true, message: 'No SAMCART_API_KEY set — using mock data.' };
  }

  // Build date range for the last 7 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  const formatDate = (d) => d.toISOString().split('T')[0];

  console.log('[SamCart] Fetching orders from', formatDate(startDate), 'to', formatDate(endDate));

  try {
    // SamCart API: GET /api/v1/orders with date filter
    // Docs: https://developer.samcart.com
    const response = await axios.get('https://api.samcart.com/v1/orders', {
      headers: {
        'SC-Api-Key': samcartApiKey,
        'Content-Type': 'application/json',
      },
      params: {
        created_at_min: formatDate(startDate),
        created_at_max: formatDate(endDate),
        limit: 250,
      },
    });

    const orders = response.data.data || response.data || [];
    console.log('[SamCart] Fetched', orders.length, 'orders');

    // Compute aggregations Claude asked for
    const aggregations = {};
    const completedOrders = orders.filter((o) =>
      ['completed', 'paid', 'captured'].includes((o.status || '').toLowerCase())
    );

    (samConfig.aggregations || []).forEach((agg) => {
      const [func, field] = agg.split(':');
      if (func === 'sum' && field === 'amount') {
        aggregations.totalRevenue = completedOrders.reduce(
          (sum, o) => sum + parseFloat(o.total_amount || o.amount || 0),
          0
        );
      }
      if (func === 'count' && field === 'orders') {
        aggregations.orderCount = completedOrders.length;
      }
      if (func === 'avg' && field === 'amount') {
        aggregations.avgOrderValue =
          completedOrders.length > 0 ? aggregations.totalRevenue / completedOrders.length : 0;
      }
    });

    return { orders: completedOrders, aggregations, raw: orders };
  } catch (err) {
    if (err.response) {
      throw new Error(`SamCart API error ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// ─── Step 4: Claude – Format data into a sheet row ──────────────────────────────
/**
 * Sends the raw API data + schema back to Claude and asks it to produce
 * a single JSON array — one element per column — matching the sheet exactly.
 *
 * PROMPT DESIGN: We show Claude its own prior analysis (the schema) so it
 * knows exactly what format each cell needs to be in.
 */
async function formatDataWithClaude(schema, gaData, samcartData, anthropic) {
  // Serialize the GA response into a readable format for Claude
  let gaText = 'No Google Analytics data fetched.';
  if (gaData && gaData.current) {
    const rows = gaData.current.rows || [];
    const metricHeaders = (gaData.current.metricHeaders || []).map((h) => h.name);
    const dimHeaders = (gaData.current.dimensionHeaders || []).map((h) => h.name);

    const currentRows = rows.map((row) => {
      const obj = {};
      (row.dimensionValues || []).forEach((v, i) => { obj[dimHeaders[i]] = v.value; });
      (row.metricValues || []).forEach((v, i) => { obj[metricHeaders[i]] = v.value; });
      return obj;
    });

    const prevRows = (gaData.previous?.rows || []).map((row) => {
      const obj = {};
      (row.dimensionValues || []).forEach((v, i) => { obj[dimHeaders[i]] = v.value; });
      (row.metricValues || []).forEach((v, i) => { obj[metricHeaders[i]] = v.value; });
      return obj;
    });

    gaText = `Current period (last 7 days): ${JSON.stringify(currentRows)}\nPrevious period (prior 7 days): ${JSON.stringify(prevRows)}`;
  }

  const samText = samcartData
    ? JSON.stringify({
        aggregations: samcartData.aggregations,
        orderCount: samcartData.orders?.length,
        sampleOrders: samcartData.orders?.slice(0, 3),
        isMock: samcartData.mock,
      })
    : 'No SamCart data fetched.';

  // Determine what Monday this week's report date should be
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7)); // roll back to Monday
  const reportDate = monday.toISOString().split('T')[0];

  const prompt = `You are populating a new row in a Google Sheet for a weekly business report.

SHEET SCHEMA (from your earlier analysis):
${JSON.stringify(schema, null, 2)}

GOOGLE ANALYTICS DATA:
${gaText}

SAMCART DATA:
${samText}

TODAY'S DATE: ${new Date().toISOString().split('T')[0]}
REPORT WEEK START (Monday): ${reportDate}

Produce ONLY a valid JSON array (no markdown, no explanation) representing the new row to append.
The array must have exactly ${schema.columns.length} elements, one per column, in column index order.

Rules:
- Use the exact date format shown in the schema for date columns
- Round integers to whole numbers
- Round currency to 2 decimal places
- Round percentages to 1 decimal place
- For text/list columns, match the exact formatting pattern from the sample rows
- For calculated fields (e.g., week-over-week %), compute them from the provided data
- If data is unavailable for a column, use null or an empty string — never invent numbers
- Output only the array, e.g.: ["2024-02-19", 1234, 987, 45.2, "google/organic", 5432.10, 12, 452.68]`;

  console.log('\n[Claude] Sending data formatting prompt...');
  console.log('[Claude] GA data summary:', gaText.substring(0, 500));
  console.log('[Claude] SamCart data summary:', samText.substring(0, 300));

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = message.content[0].text;
  console.log('[Claude] Formatted row response:', rawText);

  const jsonText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const row = JSON.parse(jsonText);
    if (!Array.isArray(row)) throw new Error('Expected a JSON array');
    return row;
  } catch (e) {
    throw new Error(`Claude returned invalid row array: ${e.message}\nRaw: ${rawText}`);
  }
}

// ─── Step 5: Write row to Google Sheet ──────────────────────────────────────────
async function appendRowToSheet(client, row) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: client.sheetId,
    range: client.sheetTab,
    valueInputOption: 'USER_ENTERED', // lets Sheets parse dates/numbers naturally
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] },
  });

  console.log('[Sheets] Append response:', response.data.updates);
  return response.data.updates;
}

// ─── Step 6: Self-validation read-back ──────────────────────────────────────────
async function readLastRow(client) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: client.sheetId,
    range: client.sheetTab,
  });

  const rows = response.data.values || [];
  return rows[rows.length - 1] || [];
}

// ─── MAIN WORKFLOW ──────────────────────────────────────────────────────────────
/**
 * Orchestrates the full 6-step pipeline, streaming status events to the browser.
 */
async function runReport(clientId, res) {
  const client = CLIENTS.find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);

  // Check required env
  if (!client.sheetId) throw new Error('GOOGLE_SHEET_ID not configured for this client.');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const cache = loadCache();
  const cacheKey = `${client.id}:${client.sheetTab}`;

  // ── Step 1: Read Sheet ─────────────────────────────────────────────────────
  sseWrite(res, 'status', { step: 1, message: 'Reading existing Google Sheet...' });
  const { headers, sampleRows, allRows, totalDataRows } = await readSheet(client);
  sseWrite(res, 'status', {
    step: 1,
    message: `Sheet read: ${headers.length} columns, ${totalDataRows} existing data rows.`,
  });
  sseWrite(res, 'sheet_data', { headers, sampleRows });

  // ── Step 2: Analyse with Claude (or use cache) ─────────────────────────────
  let schema;
  let usedCache = false;

  if (cache[cacheKey]) {
    usedCache = true;
    schema = cache[cacheKey].schema;
    sseWrite(res, 'status', {
      step: 2,
      message: `Using cached analysis from ${cache[cacheKey].cachedAt}. Re-analysis skipped.`,
      cached: true,
      cachedAt: cache[cacheKey].cachedAt,
    });
  } else {
    sseWrite(res, 'status', { step: 2, message: 'Sending sheet to Claude for structural analysis...' });
    schema = await analyseSheetWithClaude(headers, sampleRows, anthropic);

    // Persist to cache
    cache[cacheKey] = { schema, cachedAt: new Date().toISOString() };
    saveCache(cache);
    sseWrite(res, 'status', { step: 2, message: `Claude analysed ${schema.columns.length} columns.` });
  }

  sseWrite(res, 'schema', { schema, usedCache });

  // Broadcast which columns come from where
  const gaCols = schema.columns.filter((c) => c.source === 'google_analytics').map((c) => c.name);
  const scCols = schema.columns.filter((c) => c.source === 'samcart').map((c) => c.name);
  const calcCols = schema.columns.filter((c) => c.source === 'calculated').map((c) => c.name);

  sseWrite(res, 'status', {
    step: 2,
    message: `AI determined: ${gaCols.length} GA columns, ${scCols.length} SamCart columns, ${calcCols.length} calculated.`,
    details: { gaCols, scCols, calcCols },
  });

  // ── Step 3: Fetch data ─────────────────────────────────────────────────────
  let gaData = null;
  let samcartData = null;

  // 3a: Google Analytics
  if (schema.fetch_plan.google_analytics?.metrics?.length > 0) {
    if (!client.gaPropertyId) {
      sseWrite(res, 'status', {
        step: 3,
        message: 'GA_PROPERTY_ID not set — skipping Google Analytics fetch.',
        warning: true,
      });
    } else {
      sseWrite(res, 'status', {
        step: 3,
        message: `Fetching Google Analytics: ${schema.fetch_plan.google_analytics.metrics.join(', ')}...`,
      });
      gaData = await fetchGoogleAnalytics(client.gaPropertyId, schema.fetch_plan);
      const rowCount = gaData?.current?.rows?.length || 0;
      sseWrite(res, 'status', { step: 3, message: `Google Analytics: received ${rowCount} row(s).` });
      sseWrite(res, 'ga_data', { summary: `${rowCount} rows fetched` });
    }
  } else {
    sseWrite(res, 'status', { step: 3, message: 'No GA metrics in fetch plan. Skipping GA.' });
  }

  // 3b: SamCart
  if (schema.fetch_plan.samcart?.endpoints?.length > 0) {
    sseWrite(res, 'status', {
      step: 3,
      message: `Fetching SamCart: ${schema.fetch_plan.samcart.aggregations?.join(', ') || 'orders'}...`,
    });
    samcartData = await fetchSamCart(client.samcartApiKey, schema.fetch_plan);
    const orderCount = samcartData?.aggregations?.orderCount ?? samcartData?.orders?.length ?? 0;
    sseWrite(res, 'status', {
      step: 3,
      message: samcartData?.mock
        ? 'SamCart: no API key set, using mock data.'
        : `SamCart: ${orderCount} orders fetched.`,
      warning: !!samcartData?.mock,
    });
    sseWrite(res, 'samcart_data', { summary: samcartData?.aggregations || 'mock' });
  } else {
    sseWrite(res, 'status', { step: 3, message: 'No SamCart fields in fetch plan. Skipping SamCart.' });
  }

  // ── Step 4: Format with Claude ─────────────────────────────────────────────
  sseWrite(res, 'status', { step: 4, message: 'Asking Claude to format data to match sheet structure...' });
  const newRow = await formatDataWithClaude(schema, gaData, samcartData, anthropic);
  sseWrite(res, 'status', {
    step: 4,
    message: `Claude formatted ${newRow.length}-cell row.`,
  });
  sseWrite(res, 'formatted_row', { row: newRow, columnNames: schema.columns.map((c) => c.name) });

  // ── Step 5: Write to Sheet ─────────────────────────────────────────────────
  sseWrite(res, 'status', { step: 5, message: 'Writing new row to Google Sheets...' });
  const updateResult = await appendRowToSheet(client, newRow);
  sseWrite(res, 'status', { step: 5, message: 'Row appended successfully.' });
  sseWrite(res, 'write_result', { updateResult });

  // ── Step 6: Self-validation ────────────────────────────────────────────────
  sseWrite(res, 'status', { step: 6, message: 'Self-validating: reading back written row...' });
  const writtenRow = await readLastRow(client);
  const discrepancies = [];

  newRow.forEach((val, i) => {
    const written = writtenRow[i];
    const intended = String(val ?? '');
    if (written !== intended) {
      discrepancies.push({
        column: schema.columns[i]?.name || `Column ${i}`,
        intended,
        written,
      });
    }
  });

  if (discrepancies.length === 0) {
    sseWrite(res, 'status', { step: 6, message: 'Self-validation passed. All cells match.' });
  } else {
    sseWrite(res, 'status', {
      step: 6,
      message: `Self-validation: ${discrepancies.length} minor discrepancy(ies) detected (may be formatting only).`,
      warning: true,
    });
  }

  sseWrite(res, 'validation', { writtenRow, intendedRow: newRow, discrepancies });
  sseWrite(res, 'complete', {
    message: 'Report complete!',
    clientName: client.name,
    rowWritten: newRow,
    discrepancies,
  });
}

// ─── API Routes ─────────────────────────────────────────────────────────────────

// GET /api/clients — returns client list with cache info
app.get('/api/clients', (req, res) => {
  const cache = loadCache();
  const clients = CLIENTS.map((c) => {
    const cacheKey = `${c.id}:${c.sheetTab}`;
    const cached = cache[cacheKey];
    return {
      id: c.id,
      name: c.name,
      sheetId: c.sheetId,
      sheetTab: c.sheetTab,
      hasCachedAnalysis: !!cached,
      cachedAt: cached?.cachedAt || null,
    };
  });
  res.json(clients);
});

// POST /api/run-report — SSE stream of the full pipeline
app.get('/api/run-report/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const forceReanalyze = req.query.reanalyze === 'true';

  // Set up Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // If forced re-analysis, clear the cache entry first
  if (forceReanalyze) {
    const cache = loadCache();
    const client = CLIENTS.find((c) => c.id === clientId);
    if (client) {
      const cacheKey = `${client.id}:${client.sheetTab}`;
      delete cache[cacheKey];
      saveCache(cache);
      sseWrite(res, 'status', { step: 0, message: 'Cache cleared. Will re-analyse sheet.' });
    }
  }

  try {
    await runReport(clientId, res);
  } catch (err) {
    console.error('[Error]', err);
    sseWrite(res, 'error', { message: err.message, stack: err.stack });
  } finally {
    res.end();
  }
});

// POST /api/override-schema — manually supply a schema (Manual Override mode)
app.post('/api/override-schema/:clientId', (req, res) => {
  const { clientId } = req.params;
  const client = CLIENTS.find((c) => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { schema } = req.body;
  if (!schema) return res.status(400).json({ error: 'schema required in body' });

  const cache = loadCache();
  const cacheKey = `${client.id}:${client.sheetTab}`;
  cache[cacheKey] = { schema, cachedAt: new Date().toISOString(), manual: true };
  saveCache(cache);

  res.json({ ok: true, message: 'Schema saved. Next run will use this override.' });
});

// GET /api/cache — returns full cache for debugging
app.get('/api/cache', (req, res) => {
  res.json(loadCache());
});

// DELETE /api/cache/:clientId — clears cache for one client
app.delete('/api/cache/:clientId', (req, res) => {
  const { clientId } = req.params;
  const client = CLIENTS.find((c) => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const cache = loadCache();
  const cacheKey = `${client.id}:${client.sheetTab}`;
  delete cache[cacheKey];
  saveCache(cache);
  res.json({ ok: true });
});

// ─── Start server ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Course Concierge running at http://localhost:${PORT}`);
  console.log('   Press Ctrl+C to stop\n');
});
