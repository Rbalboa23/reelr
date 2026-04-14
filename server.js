require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'reelr.db');

// ── Directories ───────────────────────────────────────────────────────────────
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    platforms TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    yt_title TEXT DEFAULT '',
    yt_desc TEXT DEFAULT '',
    yt_privacy TEXT DEFAULT 'public',
    scheduled_at INTEGER DEFAULT 0,
    scheduled_display TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    file_path TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    yt_uploaded INTEGER DEFAULT 0,
    yt_video_id TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: 512 * 1024 * 1024 } }); // 512MB max

// ── Helpers ───────────────────────────────────────────────────────────────────
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function deserialize(p) {
  return {
    id: p.id,
    platforms: p.platforms ? p.platforms.split(',').filter(Boolean) : [],
    caption: p.caption || '',
    ytTitle: p.yt_title || '',
    ytDesc: p.yt_desc || '',
    ytPrivacy: p.yt_privacy || 'public',
    scheduledAt: p.scheduled_at || 0,
    scheduledDisplay: p.scheduled_display || '',
    status: p.status || 'draft',
    fileName: p.file_name || '',
    hasFile: !!(p.file_path && fs.existsSync(p.file_path)),
    ytUploaded: !!p.yt_uploaded,
    ytVideoId: p.yt_video_id || '',
    createdAt: p.created_at
  };
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
function getOAuth2Client() {
  const redirectUri = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/youtube/callback`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

async function getAuthClient() {
  const row = db.prepare("SELECT value FROM settings WHERE key='yt_tokens'").get();
  if (!row) throw new Error('YouTube not connected. Go to Settings and click Connect YouTube.');
  const tokens = JSON.parse(row.value);
  const client = getOAuth2Client();
  client.setCredentials(tokens);
  // Refresh token proactively if expiring within 2 minutes
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 120000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run('yt_tokens', JSON.stringify(credentials));
      client.setCredentials(credentials);
    } catch (e) {
      console.error('Token refresh failed:', e.message);
    }
  }
  return client;
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/youtube', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(500).send('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars are not set.');
  const url = getOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`/?yt_error=${encodeURIComponent(error || 'no_code')}`);
  try {
    const { tokens } = await getOAuth2Client().getToken(code);
    db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run('yt_tokens', JSON.stringify(tokens));
    res.redirect('/?yt_connected=1');
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.redirect(`/?yt_error=${encodeURIComponent(e.message)}`);
  }
});

app.get('/auth/youtube/status', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key='yt_tokens'").get();
  res.json({ connected: !!row });
});

app.post('/auth/youtube/disconnect', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key='yt_tokens'").run();
  res.json({ ok: true });
});

// ── Posts API ─────────────────────────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  res.json(db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all().map(deserialize));
});

app.post('/api/posts', upload.single('file'), (req, res) => {
  const d = req.body;
  const id = d.id || genId();
  const existing = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  // Delete old file if replacing
  if (existing && req.file && existing.file_path && fs.existsSync(existing.file_path)) {
    try { fs.unlinkSync(existing.file_path); } catch (e) {}
  }
  db.prepare(`
    INSERT OR REPLACE INTO posts
      (id,platforms,caption,yt_title,yt_desc,yt_privacy,scheduled_at,scheduled_display,status,file_path,file_name,yt_uploaded,yt_video_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    d.platforms || '',
    d.caption || '',
    d.ytTitle || '',
    d.ytDesc || '',
    d.ytPrivacy || 'public',
    parseInt(d.scheduledAt) || 0,
    d.scheduledDisplay || '',
    d.status || 'draft',
    req.file ? req.file.path : (existing?.file_path || ''),
    req.file ? req.file.originalname : (existing?.file_name || ''),
    existing ? existing.yt_uploaded : 0,
    existing ? existing.yt_video_id : '',
    existing ? existing.created_at : Date.now()
  );
  res.json(deserialize(db.prepare('SELECT * FROM posts WHERE id=?').get(id)));
});

app.delete('/api/posts/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (p?.file_path && fs.existsSync(p.file_path)) try { fs.unlinkSync(p.file_path); } catch (e) {}
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/posts/:id', (req, res) => {
  db.prepare('UPDATE posts SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// ── YouTube upload ────────────────────────────────────────────────────────────
async function uploadToYouTube(post) {
  const auth = await getAuthClient();
  const yt = google.youtube({ version: 'v3', auth });

  const privacyStatus = post.yt_privacy === 'scheduled' ? 'private' : (post.yt_privacy || 'public');
  const publishAt = (post.yt_privacy === 'scheduled' && post.scheduled_at)
    ? new Date(post.scheduled_at).toISOString()
    : undefined;

  const fileStat = fs.statSync(post.file_path);
  console.log(`  Uploading: "${post.yt_title || post.caption?.slice(0, 50) || 'My Video'}" (${(fileStat.size / 1048576).toFixed(1)} MB)`);

  const response = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: post.yt_title || post.caption?.slice(0, 100) || 'My Video',
        description: post.yt_desc || post.caption || '',
        categoryId: '22'
      },
      status: {
        privacyStatus,
        ...(publishAt ? { publishAt } : {})
      }
    },
    media: { body: fs.createReadStream(post.file_path) }
  }, {
    onUploadProgress: e => {
      const pct = Math.round(e.bytesRead / fileStat.size * 100);
      if (pct % 25 === 0) console.log(`  ${pct}%...`);
    }
  });

  return response.data.id;
}

// Manual upload endpoint
app.post('/api/posts/:id/upload', async (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!post.file_path || !fs.existsSync(post.file_path))
    return res.status(400).json({ error: 'No video file attached. Edit the post and attach a video.' });
  try {
    console.log(`▶ Manual upload triggered for post ${post.id}`);
    const videoId = await uploadToYouTube(post);
    db.prepare('UPDATE posts SET yt_uploaded=1,yt_video_id=?,status=? WHERE id=?').run(videoId, 'posted', post.id);
    console.log(`✓ Uploaded: https://youtube.com/watch?v=${videoId}`);
    res.json({ ok: true, videoId, url: `https://youtube.com/watch?v=${videoId}` });
  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Scheduler ─────────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  const due = db.prepare(`
    SELECT * FROM posts
    WHERE status='scheduled' AND yt_uploaded=0
    AND platforms LIKE '%yt%'
    AND scheduled_at > 0
    AND scheduled_at <= ?
    AND scheduled_at > ?
  `).all(now, now - 60000);

  for (const post of due) {
    if (!post.file_path || !fs.existsSync(post.file_path)) {
      console.log(`⚠ Post ${post.id}: no video file found, skipping auto-upload`);
      continue;
    }
    console.log(`⏰ Auto-uploading post ${post.id}...`);
    try {
      const videoId = await uploadToYouTube(post);
      db.prepare('UPDATE posts SET yt_uploaded=1,yt_video_id=?,status=? WHERE id=?').run(videoId, 'posted', post.id);
      console.log(`✓ Auto-upload done: https://youtube.com/watch?v=${videoId}`);
    } catch (e) {
      console.error(`✗ Auto-upload failed for ${post.id}:`, e.message);
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 Reelr running on http://localhost:${PORT}`);
  console.log(`   Scheduler active — checking for due posts every minute.\n`);
});
