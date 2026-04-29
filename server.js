const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  SMTP_HOST = 'smtp.gmail.com',
  SMTP_PORT = '465',
  SMTP_USER,
  SMTP_PASS,
  NOTIFY_EMAIL,
  ALLOWED_ORIGIN = '*',
  PORT = 3000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY');
  process.exit(1);
}
if (!SMTP_USER || !SMTP_PASS) {
  console.error('Missing SMTP_USER / SMTP_PASS');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '25mb' }));

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

const HEBREW_FONT_URL =
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/heebo/Heebo%5Bwght%5D.ttf';
let cachedFontBytes = null;
async function loadHebrewFont() {
  if (cachedFontBytes) return cachedFontBytes;
  const r = await fetch(HEBREW_FONT_URL);
  if (!r.ok) throw new Error('Failed to fetch Hebrew font: ' + r.status);
  cachedFontBytes = new Uint8Array(await r.arrayBuffer());
  return cachedFontBytes;
}

const HEBREW_RE = /[֐-׿]/;
function shapeRtl(s) {
  if (s == null) return '';
  const str = String(s);
  if (!HEBREW_RE.test(str)) return str;
  const tokens = str.match(/[֐-׿]+|[^֐-׿]+/g) || [];
  return tokens
    .map(t => (HEBREW_RE.test(t) ? [...t].reverse().join('') : t))
    .reverse()
    .join('');
}

async function fetchForm(formId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/forms?id=eq.${formId}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!r.ok) throw new Error('Form fetch failed: ' + r.status);
  const arr = await r.json();
  if (!arr?.length) throw new Error('Form not found');
  return arr[0];
}

async function fetchPdf(pdfUrl) {
  const r = await fetch(pdfUrl, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error('PDF fetch failed: ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

function fitFontSize(text, font, maxWidth, maxHeight) {
  let size = Math.min(maxHeight * 0.7, 14);
  while (size > 6) {
    const w = font.widthOfTextAtSize(text, size);
    if (w <= maxWidth) return size;
    size -= 0.5;
  }
  return 6;
}

function drawTextInBox(page, text, font, x, y, w, h) {
  const shaped = shapeRtl(text);
  const size = fitFontSize(shaped, font, w - 4, h);
  const textWidth = font.widthOfTextAtSize(shaped, size);
  const drawX = x + (w - textWidth) - 2;
  const drawY = y + (h - size) / 2 + size * 0.2;
  page.drawText(shaped, {
    x: drawX,
    y: drawY,
    size,
    font,
    color: rgb(0.07, 0.09, 0.15),
  });
}

function drawCheckmark(page, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const s = Math.min(w, h) * 0.35;
  page.drawLine({
    start: { x: cx - s, y: cy },
    end: { x: cx - s * 0.3, y: cy - s * 0.5 },
    thickness: 1.8,
    color: rgb(0.05, 0.4, 0.15),
  });
  page.drawLine({
    start: { x: cx - s * 0.3, y: cy - s * 0.5 },
    end: { x: cx + s, y: cy + s * 0.6 },
    thickness: 1.8,
    color: rgb(0.05, 0.4, 0.15),
  });
}

function answerForField(field, answers) {
  const key = field.groupId || field.id;
  return answers[key];
}

async function fillPdf(pdfBytes, template, answers, signatureDataUrl) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = await loadHebrewFont();
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });
  const pages = pdfDoc.getPages();

  const fields = template?.fields || [];

  for (const f of fields) {
    const pageIdx = (f.page || 1) - 1;
    if (pageIdx < 0 || pageIdx >= pages.length) continue;
    const page = pages[pageIdx];
    const { width: pw, height: ph } = page.getSize();

    const x = f.xR * pw;
    const w = f.wR * pw;
    const h = f.hR * ph;
    const y = ph - f.yR * ph - h;

    const ans = answerForField(f, answers);

    if (f.type === 'choicegroup') {
      const selected = ans;
      if (selected && f.optionLabel === selected) {
        drawCheckmark(page, x, y, w, h);
      }
      continue;
    }

    if (f.type === 'checkbox') {
      if (ans === 'true' || ans === true) drawCheckmark(page, x, y, w, h);
      continue;
    }

    if (f.type === 'yesno') {
      if (ans) drawTextInBox(page, ans, font, x, y, w, h);
      continue;
    }

    if (f.type === 'starrating') {
      if (ans) drawTextInBox(page, `${ans} / 5`, font, x, y, w, h);
      continue;
    }

    if (f.type === 'emoji') {
      const emojis = ['😞', '😐', '🙂', '😊', '😄'];
      const idx = parseInt(ans, 10) - 1;
      const label = idx >= 0 && idx < emojis.length ? `${idx + 1}/5` : ans || '';
      if (label) drawTextInBox(page, label, font, x, y, w, h);
      continue;
    }

    if (f.type === 'signature') {
      if (signatureDataUrl) {
        try {
          const b64 = signatureDataUrl.split(',')[1];
          const sigBytes = Buffer.from(b64, 'base64');
          const png = await pdfDoc.embedPng(sigBytes);
          const ratio = png.width / png.height;
          let dw = w, dh = w / ratio;
          if (dh > h) { dh = h; dw = h * ratio; }
          page.drawImage(png, {
            x: x + (w - dw) / 2,
            y: y + (h - dh) / 2,
            width: dw,
            height: dh,
          });
        } catch (e) {
          console.warn('Signature embed failed:', e.message);
        }
      }
      continue;
    }

    if (f.type === 'fileupload' || f.type === 'image') {
      if (ans) drawTextInBox(page, `📎 ${ans}`, font, x, y, w, h);
      continue;
    }

    if (ans != null && ans !== '') {
      drawTextInBox(page, ans, font, x, y, w, h);
    }
  }

  return await pdfDoc.save();
}

async function saveSubmission(formId, answers, signature, clientName, pdfBytes) {
  const fileName = `${formId}/${Date.now()}-${(clientName || 'submission').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
  const upload = await fetch(
    `${SUPABASE_URL}/storage/v1/object/submissions/${fileName}`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
      },
      body: pdfBytes,
    }
  );
  let pdfUrl = null;
  if (upload.ok) {
    pdfUrl = `${SUPABASE_URL}/storage/v1/object/public/submissions/${fileName}`;
  } else {
    console.warn('Submission PDF upload failed:', upload.status, await upload.text());
  }

  const payload = {
    form_id: formId,
    answers,
    signature,
    client_name: clientName,
    pdf_url: pdfUrl,
    submitted_at: new Date().toISOString(),
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.warn('Submission row insert failed:', await r.text());
  return pdfUrl;
}

async function sendMail({ formName, clientName, answersText, pdfBytes, toEmail }) {
  const recipient = toEmail || NOTIFY_EMAIL || SMTP_USER;
  const safeName = (clientName || 'submission').replace(/[^a-zA-Z0-9._֐-׿ -]/g, '');
  await transporter.sendMail({
    from: `"Smart PDF Forms" <${SMTP_USER}>`,
    to: recipient,
    subject: `טופס חדש: ${formName} — ${clientName || ''}`.trim(),
    text:
`התקבל טופס חדש.

טופס: ${formName}
לקוח: ${clientName || '-'}
תאריך: ${new Date().toLocaleString('he-IL')}

תשובות:
${answersText}

ה-PDF המלא מצורף.`,
    attachments: [
      {
        filename: `${safeName || 'form'}.pdf`,
        content: Buffer.from(pdfBytes),
        contentType: 'application/pdf',
      },
    ],
  });
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/submit', async (req, res) => {
  try {
    const { form_id, answers = {}, signature, client_name, to_email } = req.body || {};
    if (!form_id) return res.status(400).json({ error: 'form_id is required' });

    const form = await fetchForm(form_id);
    if (!form.pdf_url) return res.status(400).json({ error: 'Form has no PDF' });

    const pdfBytes = await fetchPdf(form.pdf_url);
    const filledBytes = await fillPdf(pdfBytes, form.template, answers, signature);

    const seen = new Set();
    const lines = [];
    for (const f of form.template?.fields || []) {
      if (!f.question) continue;
      const key = f.groupId || f.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = answers[key];
      lines.push(`• ${f.question}: ${v ?? '(לא מולא)'}`);
    }
    const answersText = lines.join('\n');

    const pdfUrl = await saveSubmission(form_id, answers, signature, client_name, filledBytes);

    await sendMail({
      formName: form.name,
      clientName: client_name,
      answersText,
      pdfBytes: filledBytes,
      toEmail: to_email || form.owner_email,
    });

    res.json({ ok: true, pdf_url: pdfUrl });
  } catch (err) {
    console.error('submit error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Smart PDF backend listening on :${PORT}`);
});
