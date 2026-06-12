// FGF Brands — Production Shutdown Report Server
// NOTE: This is a standard Express app.
// Deploy on Render.com or Railway.com (free tier, GitHub deploy) — both support Node/Express natively.
// Netlify only supports static sites; for Netlify you would need to refactor to serverless functions.

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ───────────────────────────────────────────────────────────────────
const CONFIG_PATH      = path.join(__dirname, 'config.json');
const SUBMISSIONS_PATH = path.join(__dirname, 'submissions.json');
const UPLOADS_DIR      = path.join(__dirname, 'uploads');

// ─── Bootstrap ───────────────────────────────────────────────────────────────
if (!fs.existsSync(UPLOADS_DIR))      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_PATH)) fs.writeFileSync(SUBMISSIONS_PATH, '[]');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded photos (admin view)
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Config helpers ───────────────────────────────────────────────────────────
// Environment variables always win over config.json — they survive redeploys.
// Set these in Render Dashboard → Environment tab.
function getConfig() {
  const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Override with env vars if present
  if (process.env.SMTP_HOST)      file.smtpHost      = process.env.SMTP_HOST;
  if (process.env.SMTP_PORT)      file.smtpPort      = parseInt(process.env.SMTP_PORT);
  if (process.env.SMTP_USER)      file.smtpUser      = process.env.SMTP_USER;
  if (process.env.SMTP_PASS)      file.smtpPass      = process.env.SMTP_PASS;
  if (process.env.SMTP_FROM)      file.emailFrom     = process.env.SMTP_FROM;
  if (process.env.ADMIN_PASSWORD) file.adminPassword = process.env.ADMIN_PASSWORD;
  return file;
}
function saveConfig(cfg) {
  // Writes to config.json — note env vars still override on next read.
  // SMTP/password changes via admin panel apply immediately but revert on redeploy
  // unless the matching env var is also updated in Render.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// upload.any() captures all file fields:
//   'photos'            → general photos
//   'question_photo_N'  → photos attached to checklist item N

// ─── Admin auth middleware ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const cfg = getConfig();
  const pwd = req.headers['x-admin-password'];
  if (pwd && pwd === cfg.adminPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ═════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/config  — config needed to render the form
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    lines:            ['L02', 'L03', 'L05', 'L08'],
    checklistItems:   cfg.checklistItems,
    productionFields: cfg.productionFields
  });
});

// POST /api/submit  — submit shutdown report (with optional photos per question + general)
app.post('/api/submit', upload.any(), async (req, res) => {
  try {
    const cfg  = getConfig();
    const body = req.body;
    const allFiles = req.files || [];

    const { line, submittedBy, productionName } = body;

    // ── Separate general photos from per-question photos ──
    const generalPhotos  = allFiles.filter(f => f.fieldname === 'photos');
    const questionPhotos = {}; // { questionId: [file, ...] }
    allFiles.forEach(f => {
      const match = f.fieldname.match(/^question_photo_(.+)$/);
      if (match) {
        const qId = match[1];
        if (!questionPhotos[qId]) questionPhotos[qId] = [];
        questionPhotos[qId].push(f);
      }
    });

    // ── Production fields ──
    const productionDetails = {};
    cfg.productionFields.forEach(f => {
      productionDetails[f.id] = body[f.id] || '';
    });

    // ── Checklist ──
    const checklistResponses = {};
    const checklistComments  = {};
    Object.keys(body).forEach(key => {
      if (key.startsWith('checklist_answer_'))  checklistResponses[key.replace('checklist_answer_', '')] = body[key];
      if (key.startsWith('checklist_comment_')) checklistComments[key.replace('checklist_comment_', '')]  = body[key];
    });

    // ── Build record ──
    const submission = {
      id: uuidv4(),
      line,
      productionName: productionName || '',
      submittedBy:    submittedBy    || '',
      submittedAt:    new Date().toISOString(),
      productionDetails,
      checklistResponses,
      checklistComments,
      generalPhotos:  generalPhotos.map(p  => ({ filename: p.filename,  original: p.originalname })),
      questionPhotos: Object.fromEntries(
        Object.entries(questionPhotos).map(([qId, files]) => [
          qId, files.map(p => ({ filename: p.filename, original: p.originalname }))
        ])
      )
    };

    // ── Persist ──
    const submissions = JSON.parse(fs.readFileSync(SUBMISSIONS_PATH, 'utf8'));
    submissions.unshift(submission);
    if (submissions.length > 500) submissions.splice(500);
    fs.writeFileSync(SUBMISSIONS_PATH, JSON.stringify(submissions, null, 2));

    // ── Email ──
    const recipients = cfg.emailRecipients[line] || [];
    if (recipients.length > 0 && cfg.smtpUser && cfg.smtpPass) {
      try {
        await sendEmail(cfg, submission, generalPhotos, questionPhotos);
      } catch (emailErr) {
        console.error('Email send failed:', emailErr.message);
        // Report was saved — don't fail the request
      }
    }

    res.json({ success: true, id: submission.id });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit report. ' + err.message });
  }
});

// ─── Email builder ────────────────────────────────────────────────────────────
async function sendEmail(cfg, submission, generalPhotos, questionPhotos) {
  const transporter = nodemailer.createTransport({
    host:               cfg.smtpHost,
    port:               cfg.smtpPort,
    secure:             cfg.smtpPort === 465,
    auth:               { user: cfg.smtpUser, pass: cfg.smtpPass },
    connectionTimeout:  10000,   // fail after 10 seconds
    greetingTimeout:    10000,
    socketTimeout:      15000
  });

  const recipients = cfg.emailRecipients[submission.line] || [];

  // ── Build all attachments with descriptive names ──
  const attachments = [];
  let attachCounter = 1;

  // Per-question photos: named "Q1-Photo1.jpg", "Q2-Photo1.jpg" etc.
  cfg.checklistItems.forEach(item => {
    const qFiles = questionPhotos[item.id] || [];
    qFiles.forEach((f, i) => {
      const ext  = path.extname(f.originalname || f.filename);
      attachments.push({
        filename: `Q${item.id}-Photo${i + 1}${ext}`,
        path:     path.join(UPLOADS_DIR, f.filename),
        cid:      `q${item.id}_photo${i + 1}`   // for potential inline use
      });
    });
  });

  // General photos: named "General-Photo1.jpg" etc.
  generalPhotos.forEach((f, i) => {
    const ext = path.extname(f.originalname || f.filename);
    attachments.push({
      filename: `General-Photo${i + 1}${ext}`,
      path:     path.join(UPLOADS_DIR, f.filename)
    });
  });

  // ── Production rows ──
  const prodRows = cfg.productionFields.map(f => `
    <tr>
      <td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9;width:40%">${f.label}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;">${submission.productionDetails[f.id] || '—'}</td>
    </tr>`).join('');

  // ── Checklist rows — include per-question photo count ──
  const checklistRows = cfg.checklistItems.map(item => {
    const ans      = submission.checklistResponses[item.id] || '—';
    const comment  = submission.checklistComments[item.id]  || '';
    const color    = ans === 'YES' ? '#2e7d32' : ans === 'NO' ? '#c62828' : '#555';
    const qPhotos  = questionPhotos[item.id] || [];
    const photoNote = qPhotos.length > 0
      ? `<br><span style="color:#388e3c;font-size:12px;">📷 ${qPhotos.length} photo(s) attached — see Q${item.id}-Photo*.* in attachments</span>`
      : '';
    return `
    <tr>
      <td style="padding:8px 12px;border:1px solid #ddd;">${item.question}${photoNote}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;color:${color};font-weight:700;text-align:center;width:70px">${ans}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;color:#555;font-style:italic;">${comment || ''}</td>
    </tr>`;
  }).join('');

  // ── Total photo count ──
  const totalPhotos = attachments.length;
  const photoSummary = totalPhotos > 0
    ? `<tr><td style="padding:12px 30px 20px;">
        <p style="background:#e8f5e9;padding:10px 14px;border-radius:6px;color:#2e7d32;margin:0;">
          📷 <strong>${totalPhotos} photo(s)</strong> attached to this email.
          Per-question photos are named <strong>Q[number]-Photo[number]</strong>.
          General photos are named <strong>General-Photo[number]</strong>.
        </p>
       </td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0;">
    <tr><td align="center">
      <table width="700" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
        <!-- Header -->
        <tr><td style="background:#388e3c;padding:24px 30px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:1px;">FGF BRANDS — 1235 ORMONT</h1>
          <h2 style="margin:6px 0 0;color:#fff;font-size:16px;font-weight:400;">Production Shutdown Report — Line ${submission.line}</h2>
        </td></tr>
        <!-- Meta -->
        <tr><td style="padding:16px 30px;border-bottom:1px solid #eee;background:#f9fbe7;">
          <table width="100%"><tr>
            <td style="padding:4px 0"><strong>Production:</strong> ${submission.productionName || '—'}</td>
          </tr><tr>
            <td style="padding:4px 0"><strong>Submitted by:</strong> ${submission.submittedBy || '—'}</td>
          </tr><tr>
            <td style="padding:4px 0"><strong>Date/Time:</strong> ${new Date(submission.submittedAt).toLocaleString('en-CA', { hour12: true })}</td>
          </tr></table>
        </td></tr>
        <!-- Production Details -->
        <tr><td style="padding:20px 30px;">
          <h3 style="color:#388e3c;border-bottom:2px solid #388e3c;padding-bottom:6px;margin-top:0;">Production Details</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            ${prodRows}
          </table>
        </td></tr>
        <!-- Checklist -->
        <tr><td style="padding:0 30px 20px;">
          <h3 style="color:#388e3c;border-bottom:2px solid #388e3c;padding-bottom:6px;">Shutdown Checklist</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr style="background:#388e3c;color:#fff;">
              <th style="padding:8px 12px;text-align:left;">Checklist Item</th>
              <th style="padding:8px 12px;text-align:center;width:70px;">Answer</th>
              <th style="padding:8px 12px;text-align:left;">Comments</th>
            </tr>
            ${checklistRows}
          </table>
        </td></tr>
        <!-- Photo summary -->
        ${photoSummary}
        <!-- Footer -->
        <tr><td style="background:#f0f0f0;padding:14px 30px;text-align:center;color:#888;font-size:12px;">
          FGF Brands — 1235 Ormont — Automated Shutdown Report System
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  // attachments array was already built above with descriptive names

  await transporter.sendMail({
    from:        `"FGF Shutdown Report" <${cfg.emailFrom || cfg.smtpUser}>`,
    to:          recipients.join(', '),
    subject:     `[${submission.line}] Shutdown Report — ${new Date(submission.submittedAt).toLocaleDateString('en-CA')}`,
    html,
    attachments
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES  (all require x-admin-password header)
// ═════════════════════════════════════════════════════════════════════════════

// Verify password
app.post('/api/admin/login', (req, res) => {
  const cfg = getConfig();
  if (req.body.password === cfg.adminPassword) res.json({ success: true });
  else res.status(401).json({ error: 'Invalid password' });
});

// Get full config
app.get('/api/admin/config', adminAuth, (req, res) => {
  res.json(getConfig());
});

// ── SMTP ──
app.post('/api/admin/smtp', adminAuth, (req, res) => {
  const cfg = getConfig();
  const { smtpHost, smtpPort, smtpUser, smtpPass, emailFrom } = req.body;
  if (smtpHost)  cfg.smtpHost  = smtpHost;
  if (smtpPort)  cfg.smtpPort  = parseInt(smtpPort);
  if (smtpUser)  cfg.smtpUser  = smtpUser;
  if (smtpPass)  cfg.smtpPass  = smtpPass;
  if (emailFrom) cfg.emailFrom = emailFrom;
  saveConfig(cfg);
  res.json({ success: true });
});

// ── Test Email ──
app.post('/api/admin/test-email', adminAuth, async (req, res) => {
  const cfg = getConfig();
  const { testAddress } = req.body;

  if (!cfg.smtpUser || !cfg.smtpPass) {
    return res.status(400).json({ error: 'SMTP credentials not configured. Save your SMTP settings first.' });
  }
  if (!testAddress) {
    return res.status(400).json({ error: 'Please provide a test email address.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host:   cfg.smtpHost,
      port:   cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth:   { user: cfg.smtpUser, pass: cfg.smtpPass }
    });

    await transporter.verify();   // checks credentials before sending
    await transporter.sendMail({
      from:    `"FGF Shutdown Report" <${cfg.emailFrom || cfg.smtpUser}>`,
      to:      testAddress,
      subject: '✅ FGF Shutdown Report — Test Email',
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;max-width:500px">
          <div style="background:#388e3c;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
            <strong>FGF Brands — 1235 Ormont</strong>
          </div>
          <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
            <p>✅ Your SMTP settings are working correctly.</p>
            <p>Shutdown report emails will be delivered successfully.</p>
            <p style="color:#888;font-size:12px;margin-top:16px">Sent from the FGF Shutdown Report admin panel.</p>
          </div>
        </div>`
    });

    res.json({ success: true, message: `Test email sent to ${testAddress}` });
  } catch (err) {
    console.error('Test email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email recipients ──
app.post('/api/admin/emails', adminAuth, (req, res) => {
  const cfg = getConfig();
  const { line, emails } = req.body; // emails: array of strings
  if (!['L02','L03','L05','L08'].includes(line)) return res.status(400).json({ error: 'Invalid line' });
  cfg.emailRecipients[line] = emails.filter(e => e && e.trim());
  saveConfig(cfg);
  res.json({ success: true });
});

// ── Checklist ──
app.post('/api/admin/checklist', adminAuth, (req, res) => {
  const cfg  = getConfig();
  const item = { id: Date.now(), question: req.body.question };
  cfg.checklistItems.push(item);
  saveConfig(cfg);
  res.json({ success: true, item });
});

app.put('/api/admin/checklist/:id', adminAuth, (req, res) => {
  const cfg  = getConfig();
  const id   = parseInt(req.params.id);
  const item = cfg.checklistItems.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  item.question = req.body.question;
  saveConfig(cfg);
  res.json({ success: true });
});

app.delete('/api/admin/checklist/:id', adminAuth, (req, res) => {
  const cfg = getConfig();
  cfg.checklistItems = cfg.checklistItems.filter(i => i.id !== parseInt(req.params.id));
  saveConfig(cfg);
  res.json({ success: true });
});

// ── Production fields ──
app.post('/api/admin/field', adminAuth, (req, res) => {
  const cfg   = getConfig();
  const field = { id: `field_${Date.now()}`, label: req.body.label, type: req.body.type || 'text', required: false };
  cfg.productionFields.push(field);
  saveConfig(cfg);
  res.json({ success: true, field });
});

app.delete('/api/admin/field/:id', adminAuth, (req, res) => {
  const cfg = getConfig();
  cfg.productionFields = cfg.productionFields.filter(f => f.id !== req.params.id);
  saveConfig(cfg);
  res.json({ success: true });
});

// ── Admin password ──
app.post('/api/admin/password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const cfg = getConfig();
  cfg.adminPassword = newPassword;
  saveConfig(cfg);
  res.json({ success: true });
});

// ── Recent submissions (last 50) ──
app.get('/api/admin/submissions', adminAuth, (req, res) => {
  try {
    const submissions = JSON.parse(fs.readFileSync(SUBMISSIONS_PATH, 'utf8'));
    res.json(submissions.slice(0, 50));
  } catch { res.json([]); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  FGF Shutdown Report running → http://localhost:${PORT}`);
});
