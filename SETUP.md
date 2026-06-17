# SSB Test → Cloud Run + Cloud SQL + GCS + Resend

Frontend stays on **Vercel** (static `index.html`). The backend is a **Cloud Run**
service that authenticates to GCP using its **service account identity (ADC)** —
no key file, so it complies with your org's `disableServiceAccountKeyCreation`
policy.

```
Browser (index.html on Vercel)
   │ POST https://<cloud-run-url>/submit   {submission, answers, pdfBase64}
   ▼ (CORS-allowlisted)
Cloud Run service  (runs as ssb-backend SA, no key)
   ├─ Cloud SQL (ssb)   via Unix socket  /cloudsql/<conn-name>
   ├─ GCS (ssb-reports)
   └─ Resend email
```

---

## ⚠️ Do these FIRST
1. **Rotate the DB password** — one was shared in plain text earlier; treat it as
   compromised. Use a new strong password everywhere below.
2. Use the scoped **`ssb_app`** user, not `postgres`, for the app (least privilege
   on a public endpoint).

---

## 1 · Enable the APIs you'll need
```bash
gcloud config set project invictus-venture
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com artifactregistry.googleapis.com
```

## 2 · Database + scoped user
```bash
gcloud sql databases create ssb --instance=invictus-venture
gcloud sql users create ssb_app \
  --instance=invictus-venture \
  --password='REPLACE_WITH_STRONG_PASSWORD'
```
Then create the tables: open **Cloud SQL Studio** on the `ssb` database and paste
`schema.sql`. After tables exist, grant the app user rights (run in Studio):
```sql
GRANT ALL PRIVILEGES ON DATABASE ssb TO ssb_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ssb_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ssb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ssb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ssb_app;
```

## 3 · GCS bucket
```bash
gcloud storage buckets create gs://ssb-reports \
  --location=asia-southeast1 --uniform-bucket-level-access
```
Reports are written private to `reports/YYYY-MM-DD/`. To make the `pdf_url` links
open without auth (optional; world-readable if a URL leaks):
```bash
gcloud storage buckets add-iam-policy-binding gs://ssb-reports \
  --member=allUsers --role=roles/storage.objectViewer
```
The email attachment works regardless.

## 4 · Grant the existing service account its roles (NO key)
```bash
SA="ssb-backend@invictus-venture.iam.gserviceaccount.com"

# connect to Cloud SQL
gcloud projects add-iam-policy-binding invictus-venture \
  --member="serviceAccount:$SA" --role="roles/cloudsql.client"

# write objects to just this bucket
gcloud storage buckets add-iam-policy-binding gs://ssb-reports \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

## 5 · Deploy the backend to Cloud Run
From the `backend/` folder. Cloud Build builds the container from the Dockerfile
(`--source .`), so you don't need Docker locally. Put the real Resend key and DB
password in this command (they become Cloud Run env vars, encrypted at rest):
```bash
cd backend

gcloud run deploy ssb-backend \
  --source . \
  --region=asia-southeast1 \
  --service-account="ssb-backend@invictus-venture.iam.gserviceaccount.com" \
  --add-cloudsql-instances=invictus-venture:asia-southeast1:invictus-venture \
  --allow-unauthenticated \
  --memory=512Mi \
  --set-env-vars="INSTANCE_CONNECTION_NAME=invictus-venture:asia-southeast1:invictus-venture,DB_USER=ssb_app,DB_PASSWORD=YOUR_PASSWORD,DB_NAME=ssb,GCS_BUCKET=ssb-reports,RESEND_API_KEY=YOUR_RESEND_KEY,MAIL_FROM=SSB Report <onboarding@resend.dev>,MAIL_REPLY_TO=you@gmail.com,ALLOWED_ORIGINS=https://your-project.vercel.app"
```
When it finishes, gcloud prints the **Service URL** (e.g.
`https://ssb-backend-abc123-as.a.run.app`). Copy it.

> Tip: if the env-var string is fiddly (commas in `MAIL_FROM`), use
> `--env-vars-file env.yaml` instead — a simple `KEY: value` YAML file.

## 6 · Point the frontend at the backend, deploy to Vercel
In `index.html`, set:
```js
const CONFIG = { API_ENDPOINT: 'https://YOUR-CLOUD-RUN-URL/submit' };
```
Push `index.html` to your Vercel project (it's a plain static deploy — no build,
no functions, no vercel.json needed). Note your Vercel URL.

## 7 · Tighten CORS to your real origin
Once you know the Vercel URL, update the backend so only it (plus `*.vercel.app`)
can call `/submit`:
```bash
gcloud run services update ssb-backend --region=asia-southeast1 \
  --update-env-vars="ALLOWED_ORIGINS=https://your-project.vercel.app,https://yourdomain.com"
```

## 8 · Seed the questions table (one-time)
From **Cloud Shell** (easiest; the repo + proxy are handy there), or locally:
```bash
# start the Cloud SQL Auth Proxy in one shell
./cloud-sql-proxy invictus-venture:asia-southeast1:invictus-venture &

# in the repo root (where seed-questions.js + index.html live)
npm install
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=ssb_app DB_PASSWORD=YOUR_PASSWORD DB_NAME=ssb \
  node seed-questions.js
# → "Seeded 240 questions."
```

## 9 · Test end-to-end
1. Open the Vercel URL, take the test, fill the gate form with a real email.
2. `submissions` table → one new row with scores + valuation.
3. `answers` table → 30 rows for that `submission_id`.
4. `ssb-reports` bucket → a PDF under `reports/<today>/`.
5. Inbox → bilingual report email with the PDF attached.
6. `submissions.email_status` = `sent`.

If email shows `failed`: `MAIL_FROM` not verified, or `RESEND_API_KEY` wrong. DB +
GCS still succeed independently (email/GCS failures are non-fatal by design).

---

## Email note (important before going public)
Resend cannot send from an `@gmail.com` address — Gmail's DMARC blocks third-party
sending and you can't add DNS records to a domain you don't own. `onboarding@resend.dev`
works immediately for testing but looks unprofessional and risks spam. Before sharing
the link widely, verify a domain you own in Resend (4 DNS records) and set
`MAIL_FROM=SSB Report <report@yourdomain.com>`. Your gmail can stay as `MAIL_REPLY_TO`.
Switching is just an env-var update — no code change:
```bash
gcloud run services update ssb-backend --region=asia-southeast1 \
  --update-env-vars="MAIL_FROM=SSB Report <report@yourdomain.com>"
```

## Design choices baked in
- **No service-account key** — Cloud Run uses the SA identity (ADC), satisfying the
  org policy that blocked Option B.
- **Cloud SQL over Unix socket** (`--add-cloudsql-instances`) — no connector library,
  works even if the instance is private-IP only.
- **Answer text denormalized** into `answers`, so rewording questions later won't break
  old submissions. `questions` kept as a clean reference table.
- DB write happens **first**; GCS + email are non-fatal (you never lose a submission).
- **CORS allowlist + rate limit + payload cap** guard the public endpoint.
- PDF render at `scale:1.5` / JPEG `0.85` keeps payloads small.

## Cost note
Cloud Run scales to zero — you pay only per request, so an idle service costs ~nothing.
The Cloud SQL instance you already run is the main fixed cost, unchanged by this.
