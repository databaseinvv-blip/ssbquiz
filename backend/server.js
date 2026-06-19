/**
 * Cloud Run service — SSB Capital Readiness Test backend.
 *
 * POST /submit  { submission, answers, pdfBase64 }
 *   1) CORS (allowlisted origins) + preflight
 *   2) validate + rate-limit
 *   3) insert submissions + answers (one transaction)
 *   4) upload PDF to GCS
 *   5) email the user via Resend
 *
 * Auth to GCP uses the Cloud Run service account's identity (ADC) — NO key file.
 * Cloud SQL is reached over the Unix socket mounted by --add-cloudsql-instances.
 */
const express = require('express');
const { Pool } = require('pg');
const { Storage } = require('@google-cloud/storage');
const { Resend } = require('resend');

const {
  INSTANCE_CONNECTION_NAME,   // invictus-venture:asia-southeast1:invictus-venture
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  GCS_BUCKET,
  RESEND_API_KEY,
  MAIL_FROM,
  MAIL_REPLY_TO,
  ALLOWED_ORIGINS,            // comma-separated; e.g. "https://ssb.vercel.app,https://test.yourdomain.com"
  PORT = 8080,
} = process.env;

// ---- CORS allowlist --------------------------------------------------------
const allowList = (ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return false;
  if (allowList.includes(origin)) return true;
  // allow any *.vercel.app preview/prod deploy by default
  try { if (new URL(origin).hostname.endsWith('.vercel.app')) return true; } catch {}
  return false;
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    return true;
  }
  return false;
}

// ---- GCP / DB / email singletons -------------------------------------------
// ADC: Storage() with no credentials picks up the Cloud Run SA automatically.
const storage = new Storage();
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Cloud SQL over Unix socket (mounted at /cloudsql/<conn-name>).
const pool = new Pool({
  host: `/cloudsql/${INSTANCE_CONNECTION_NAME}`,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  max: 5,
});

// ---- best-effort in-memory rate limit --------------------------------------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 60 * 1000, max = 20;
  const rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
  rec.count += 1; hits.set(ip, rec);
  return rec.count > max;
}

const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

const app = express();
app.use(express.json({ limit: '8mb' }));   // PDF base64 can be a few MB

app.get('/', (_req, res) => res.status(200).send('SSB backend OK'));

app.options('/submit', (req, res) => {
  applyCors(req, res);
  res.status(204).end();
});

app.post('/submit', async (req, res) => {
  const corsOk = applyCors(req, res);
  if (!corsOk) { res.status(403).json({ ok: false, error: 'Origin not allowed' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) { res.status(429).json({ ok: false, error: 'Too many requests' }); return; }

  const { submission: s = {}, answers = [], pdfBase64 = '' } = req.body || {};
  if (!isEmail(s.email)) { res.status(400).json({ ok: false, error: 'Valid email required' }); return; }
  if (!Array.isArray(answers)) { res.status(400).json({ ok: false, error: 'answers must be an array' }); return; }

  let submissionId, pdfUrl = null, pdfPath = null, emailStatus = 'skipped';

  // ---- DB write (transaction) ----------------------------------------------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO submissions
        (name,email,phone,projected_pat,industry,industry_label,pattern,
         estimated_pe,estimated_valuation,scalability,sustainability,brand_influence,
         s1_system,s2_replication,s3_moat,s4_finance,s5_voice,s6_brand_indep)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        s.name || null, s.email, s.phone || null, num(s.projectedPAT),
        s.industry || null, s.industryLabel || null, s.pattern || null,
        num(s.estimatedPE), num(s.estimatedValuation),
        num(s.Scalability), num(s.Sustainability), num(s.BrandInfluence),
        num(s.S1), num(s.S2), num(s.S3), num(s.S4), num(s.S5), num(s.S6),
      ]
    );
    submissionId = ins.rows[0].id;
    for (const a of answers) {
      await client.query(
        `INSERT INTO answers
          (submission_id,question_id,dimension,question_zh,chosen_zh,chosen_en,score)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [submissionId, a.questionId || null, num(a.dimension),
         a.questionZh || null, a.chosenZh || null, a.chosenEn || null, num(a.score)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('DB error:', e);
    res.status(500).json({ ok: false, error: 'Database write failed' });
    return;
  }
  client.release();

  // ---- GCS upload (non-fatal) ----------------------------------------------
  let pdfBuffer = null;
  if (pdfBase64) {
    try {
      pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const safeName = String(s.name || 'report').replace(/[^\w\u4e00-\u9fa5]+/g, '_');
      pdfPath = `reports/${new Date().toISOString().slice(0, 10)}/SSB_${safeName}_${submissionId}.pdf`;
      await storage.bucket(GCS_BUCKET).file(pdfPath)
        .save(pdfBuffer, { contentType: 'application/pdf', resumable: false });
      pdfUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${encodeURI(pdfPath)}`;
      await pool.query('UPDATE submissions SET pdf_url=$1, pdf_path=$2 WHERE id=$3',
        [pdfUrl, pdfPath, submissionId]);
    } catch (e) { console.error('GCS upload error:', e); }
  }

  // ---- email (non-fatal) ---------------------------------------------------
  if (resend && MAIL_FROM) {
    try {
      const { subject, html } = buildEmail(s);
      const attachments = pdfBuffer
        ? [{ filename: `SSB_Report_${submissionId}.pdf`, content: pdfBuffer.toString('base64') }]
        : [];
      const r = await resend.emails.send({
        from: MAIL_FROM,
        to: s.email,
        ...(MAIL_REPLY_TO ? { replyTo: MAIL_REPLY_TO } : {}),
        subject, html, attachments,
      });
      emailStatus = r && r.error ? 'failed' : 'sent';
      if (r && r.error) console.error('Resend error:', r.error);
    } catch (e) { emailStatus = 'failed'; console.error('Email error:', e); }
    await pool.query('UPDATE submissions SET email_status=$1 WHERE id=$2',
      [emailStatus, submissionId]).catch(() => {});
  }

  res.status(200).json({ ok: true, submissionId, pdfUrl, emailStatus });
});

app.listen(PORT, () => console.log(`SSB backend listening on ${PORT}`));

// ---- bilingual email template ---------------------------------------------
function buildEmail(s) {
  const name = (s.name || '').toString();
  const pattern = s.pattern || '';
  const val = s.estimatedValuation != null
    ? 'RM ' + Number(s.estimatedValuation).toLocaleString('en-US') : '—';
  const subject = `你的 SSB 资本准备度报告 / Your SSB Capital Readiness Report`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#14152E;line-height:1.6">
    <div style="background:#14152E;border-left:4px solid #F5A623;padding:24px 28px;border-radius:12px;color:#fff">
      <div style="font-size:12px;letter-spacing:.15em;color:#FFB942;text-transform:uppercase">SSB Capital Readiness Test</div>
      <h1 style="font-size:22px;margin:10px 0 4px">你的生意，资本怎么看</h1>
      <div style="font-size:13px;color:rgba(255,255,255,.7)">How capital sees your business</div>
    </div>
    <p style="margin:24px 0 8px">${name ? name + '，' : ''}感谢你完成 SSB 测试。以下是你的结果摘要，完整报告见附件 PDF。</p>
    <p style="margin:0 0 20px;color:#555;font-size:14px">${name ? name + ', ' : ''}thank you for completing the SSB Test. Here's a summary of your result — the full report is attached as a PDF.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr>
        <td style="padding:12px 14px;background:#F2EFE8;border-radius:8px 0 0 8px;font-size:13px;color:#8A8576">SSB Pattern</td>
        <td style="padding:12px 14px;background:#F2EFE8;border-radius:0 8px 8px 0;font-weight:700;text-align:right">${pattern}</td>
      </tr>
      <tr><td style="height:8px"></td><td></td></tr>
      <tr>
        <td style="padding:12px 14px;background:#F2EFE8;border-radius:8px 0 0 8px;font-size:13px;color:#8A8576">资本估值 / Est. Valuation</td>
        <td style="padding:12px 14px;background:#F2EFE8;border-radius:0 8px 8px 0;font-weight:700;text-align:right">${val}</td>
      </tr>
    </table>
    <p style="font-size:12px;color:#8A8576;margin:18px 0 0">
      估值为指示性数字，实际成交价取决于行业、交易结构、审计财报与买方类型。<br>
      Valuation is indicative only — actual value depends on industry, deal structure, audited financials, and buyer type.
    </p>
  </div>`;
  return { subject, html };
}
