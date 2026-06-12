const functions = require('firebase-functions');
const express   = require('express');
const multer    = require('multer');
const nodemailer= require('nodemailer');
const fs        = require('fs');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');
const os        = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── On Firebase Functions, use /tmp for writable storage ────────────────────
const TMP          = os.tmpdir();
const CONFIG_PATH  = path.join(__dirname, '..', 'config.json'); // read-only bundled config
const UPLOADS_DIR  = path.join(TMP, 'uploads');
const SUBMISSIONS_PATH = path.join(TMP, 'submissions.json');

if (!fs.existsSync(UPLOADS_DIR))      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_PATH)) fs.writeFileSync(SUBMISSIONS_PATH, '[]');

// NOTE: On Firebase Functions /tmp is ephemeral (cleared between cold starts).
// For production persistence of config changes and submissions,
// replace the file-based storage below with Firebase Firestore and Firebase Storage.
// For a quick working deployment, this works fine for email-sending and short-lived storage.

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch(e) { return {}; }
}
function saveConfig(cfg) {
  // On Firebase, writes to /tmp — ephemeral but works within the same instance
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(cfg, null, 2));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 15*1024*1024 }, fileFilter: (req,file,cb) => file.mimetype.startsWith('image/') ? cb(null,true) : cb(new Error('Images only')) });

function adminAuth(req, res, next) {
  const cfg = getConfig();
  if (req.headers['x-admin-password'] === cfg.adminPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Routes (same as server.js — copy all routes here) ────────────────────────
// Copy all the route handlers from your server.js into this file,
// replacing `app.listen(...)` at the bottom with the exports line below.

// ─── Export as Firebase Function ─────────────────────────────────────────────
exports.api = functions.https.onRequest(app);
