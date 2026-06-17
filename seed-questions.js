/**
 * seed-questions.js — one-time seeding of the `questions` reference table.
 *
 * It reads the BANKS object straight out of index.html (so there's a single
 * source of truth), assigns each question a deterministic ID, and upserts.
 *
 * Run it from Cloud Shell or locally with the Cloud SQL Auth Proxy running.
 *
 * Env vars needed (see .env.example):
 *   DB_HOST  (e.g. 127.0.0.1 when using the Auth Proxy, or the socket path)
 *   DB_PORT  (e.g. 5432; omit if using a socket)
 *   DB_USER, DB_PASSWORD, DB_NAME
 *
 * Example with the Auth Proxy:
 *   ./cloud-sql-proxy invictus-venture:asia-southeast1:invictus-venture &
 *   DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=ssb_app DB_PASSWORD=... DB_NAME=ssb \
 *     node seed-questions.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// --- pull the BANKS literal out of index.html -----------------------------
function loadBanks() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const endMarker = 'SSB Capital Readiness Test — engine';
  const end = html.indexOf(endMarker);
  if (end === -1) throw new Error('Could not locate engine section in index.html');
  // C3 / C4 helpers are defined just above the BANKS block — include them,
  // and cut at the last bank-closing "];" before the engine section so no
  // trailing comment breaks parsing.
  const c3 = html.indexOf('const C3=');
  const region = html.slice(c3, end);
  const lastClose = region.lastIndexOf('];');
  const snippet = region.slice(0, lastClose + 2);
  // eslint-disable-next-line no-new-func
  const fn = new Function(snippet + '; return BANKS;');
  return fn();
}

async function main() {
  const BANKS = loadBanks();
  const rows = [];
  for (const [industry, bank] of Object.entries(BANKS)) {
    // assign deterministic id = industry_dDIM_INDEX, index within that dimension
    const perDimCount = {};
    bank.forEach((q) => {
      const d = q.d;
      perDimCount[d] = (perDimCount[d] || 0);
      const id = `${industry}_d${d}_${perDimCount[d]}`;
      perDimCount[d] += 1;
      rows.push({ id, industry, dimension: d, zh: q.zh, en: q.en });
    });
  }

  const connConfig = process.env.DB_HOST && process.env.DB_HOST.startsWith('/')
    ? { host: process.env.DB_HOST }                                   // unix socket
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432) };

  const pool = new Pool({
    ...connConfig,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 2,
  });

  let n = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO questions (id, industry, dimension, question_zh, question_en)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE
         SET question_zh = EXCLUDED.question_zh,
             question_en = EXCLUDED.question_en`,
      [r.id, r.industry, r.dimension, r.zh, r.en]
    );
    n += 1;
  }
  await pool.end();
  console.log(`Seeded ${n} questions.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
