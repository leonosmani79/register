// register/index.js
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const Database = require("better-sqlite3");
const vision = require("@google-cloud/vision");
const visionClient = new vision.ImageAnnotatorClient();
const matchSessions = new Map();
// key: channelId
// value: { scrimId, game, images: [] }

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");

// ---------------------- ENV ---------------------- //
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  PORT = 3010,
  BASE_URL,

  PANEL_CLIENT_ID,
  PANEL_CLIENT_SECRET,
  PANEL_REDIRECT_URI,
  PANEL_SESSION_SECRET,
  PANEL_ADMIN_IDS,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("❌ Missing DISCORD_TOKEN or CLIENT_ID in .env");
  process.exit(1);
}
if (!BASE_URL) {
  console.error("❌ Missing BASE_URL (public URL, e.g. https://darksideorg.com)");
  process.exit(1);
}
if (!PANEL_CLIENT_ID || !PANEL_CLIENT_SECRET || !PANEL_REDIRECT_URI || !PANEL_SESSION_SECRET) {
  console.error("❌ Missing PANEL OAuth envs (PANEL_CLIENT_ID/SECRET/REDIRECT_URI/SESSION_SECRET)");
  process.exit(1);
}

const DS = {
  regColor: 0x5865f2,
  confirmColor: 0xffb300,
  dangerColor: 0xff4b4b,
  okColor: 0x4caf50,
  logoUrl: process.env.DS_LOGO_URL || "",
  divider: "━━━━━━━━━━━━━━━━━━━━",
};

const ADMIN_IDS = (PANEL_ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const BASE = String(BASE_URL).replace(/\/+$/, "");

// ---------------------- UPLOADS ---------------------- //
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || "");
    cb(null, "logo-" + unique + ext);
  },
});
const upload = multer({
  dest: path.join(__dirname, "register/uploads"),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});
// ---------------------- RESULTS UPLOADS ---------------------- //
const resultsDir = path.join(__dirname, "results_uploads");
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

const resultsUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, resultsDir),
    filename: (req, file, cb) => {
      const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, "res-" + unique + path.extname(file.originalname || ""));
    },
  }),
});

const templatesDir = path.join(__dirname, "templates");
const generatedDir = path.join(__dirname, "generated");
if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });

function listTemplates() {
  if (!fs.existsSync(templatesDir)) return [];
  return fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
async function ocrImageFromUrl(url) {
  const [result] = await visionClient.textDetection(url);
  return result.fullTextAnnotation?.text || "";
}

function normalizeForLines(t) {
  // keep newlines, normalize each line
  return String(t || "")
    .toUpperCase()
    .replace(/[^\S\r\n]+/g, " ")       // compress spaces but keep \n
    .replace(/[^A-Z0-9\r\n ]/g, " ");  // strip symbols but keep \n
}
function ffmpegSafeText(text) {
  if (!text) return "";
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function parseScoreboardRows(ocrText) {
  const rawLines = String(ocrText || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const rows = [];
  let i = 0;

  function isPlaceLine(line) {
    const m = String(line).trim().match(/^(?:#\s*)?(\d{1,2})$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 1 || n > 25) return null;
    return n;
  }

  while (i < rawLines.length) {
    const place = isPlaceLine(rawLines[i]);
    if (!place) { i++; continue; }

    const seg = [];
    let j = i + 1;
    while (j < rawLines.length && isPlaceLine(rawLines[j]) == null) {
      seg.push(rawLines[j]);
      j++;
    }

    const players = [];
    const kills = [];

    for (const line of seg) {
      const up = line.toUpperCase();

      // kills like "3 eliminations"
      const km = up.match(/\b(\d{1,2})\s+ELIMINATION(?:S)?\b/);
      if (km) {
        kills.push(Number(km[1]));
        continue;
      }

      // skip headings / noise
      if (up.includes("PUBG") || up.includes("MOBILE") || up.includes("MATCH") || up.includes("RESULT")) continue;

      // candidate player name
      if (/^\d+$/.test(up)) continue;
      if (up.includes("ELIMINATION")) continue;

      if (players.length < 4) players.push(line);
    }

    if (players.length || kills.length) rows.push({ place, players, kills });
    i = j;
  }

  return rows;
}

// teamsForDetect: [{ team_tag, tag, team_name }, ...]
function parseResults(ocrText, teamsForDetect) {
  const rows = parseScoreboardRows(ocrText);
  const out = [];

  for (const row of rows) {
    const team = detectTeamForRow(row.players, teamsForDetect, 2);
    if (!team) continue;

    const ksum = row.kills.reduce((a, b) => a + (Number(b) || 0), 0);
    out.push({ tag: team.team_tag, place: row.place, kills: ksum });
  }

  return out;
}

function loadTemplate(templateKey) {
  const dir = path.join(templatesDir, templateKey);
  const base = path.join(dir, "base.gif");
  const cfgPath = path.join(dir, "template.json");
  if (!fs.existsSync(base) || !fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  return { dir, base, cfg };
}

function escDrawtext(s = "") {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ");
}
function isSendableTextChannel(ch) {
  // discord.js v14
  return !!ch && typeof ch.isTextBased === "function" && ch.isTextBased() && typeof ch.send === "function";
}

async function safeSend(channel, payload) {
  try {
    if (!isSendableTextChannel(channel)) return { ok: false, error: "Not a sendable text channel" };
    await channel.send(payload);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
async function autoUnbanIfExpired(scrim, userId) {
  const ban = q.banByUser.get(scrim.guild_id, userId);
  if (!ban || !ban.expires_at) return;

  if (Date.now() >= new Date(ban.expires_at).getTime()) {
    // remove DB ban
    q.unban.run(scrim.guild_id, userId);

    // remove ban role
    if (scrim.ban_role_id) {
      try {
        const guild = await discord.guilds.fetch(scrim.guild_id);
        const mem = await guild.members.fetch(userId);
        await mem.roles.remove(scrim.ban_role_id);
      } catch {}
    }
  }
}

function ensureScrimGenDir(scrimId) {
  const d = path.join(generatedDir, `scrim_${scrimId}`);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function renderSlotGif({ templateKey, scrimId, slot, teamName, teamTag }) {
  return new Promise((resolve, reject) => {
    const t = loadTemplate(templateKey);
    if (!t) return reject(new Error("Template not found: " + templateKey));

    const outDir = ensureScrimGenDir(scrimId);
    const outPath = path.join(outDir, `slot_${slot}.gif`);

    const cfg = t.cfg;
    const fontFile = cfg.fontFile || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

    const slotText = `#${slot}`;
    const nameText = (teamName || "").slice(0, 22);
    const tagText = (teamTag || "").slice(0, 6);

    const slotF = cfg.slot || { x: 40, y: 42, size: 34, color: "white", stroke: "black", strokeW: 3 };
    const nameF = cfg.name || { x: 200, y: 42, size: 28, color: "white", stroke: "black", strokeW: 3 };
    const tagF = cfg.tag || { x: 700, y: 42, size: 28, color: "white", stroke: "black", strokeW: 3, alignRight: true };

    const tagX = tagF.alignRight ? `(w-text_w-${Math.max(10, (cfg.width || 800) - tagF.x)})` : String(tagF.x);

  function drawText({ text, x, y, size = 40 }) {
  const safe = ffmpegSafeText(text);

  return (
    "drawtext=" +
    "fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:" +
    `text='${safe}':` +
    `x=${x}:y=${y}:` +
    `fontsize=${size}:` +
    "fontcolor=white:" +
    "borderw=3:bordercolor=black"
  );
}
const filters = [
  drawText({ text: "ESPORTS", x: 150, y: 20 }),
  drawText({ text: team.tag, x: "(w-text_w-300)", y: 20 }),
];

ffmpeg(input)
  .videoFilters(filters)
  .save(output);


    ffmpeg(t.base)
      .outputOptions(["-vf", filters.join(","), "-gifflags", "+transdiff"])
      .on("error", (err) => reject(err))
      .on("end", () => resolve(outPath))
      .save(outPath);
  });
}
function toISO(d) {
  if (!d) return null;
  return new Date(d).toISOString();
}

function addDuration(ms) {
  return new Date(Date.now() + ms);
}

function parseDurationToMs(s) {
  // allowed: "1h", "6h", "1d", "7d", "30d", "0" (perm)
  s = String(s || "").trim().toLowerCase();
  if (!s || s === "0" || s === "perm" || s === "perma") return 0;
  const m = s.match(/^(\d+)\s*(h|d)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "h" ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
}

function isBanActive(banRow) {
  if (!banRow) return false;
  if (!banRow.expires_at) return true; // perma
  return Date.now() < new Date(banRow.expires_at).getTime();
}

// ---------------------- SQLITE ---------------------- //
const dbPath = path.join(__dirname, "scrims.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// base tables
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scrims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  min_slot INTEGER NOT NULL DEFAULT 2,
  max_slot INTEGER NOT NULL DEFAULT 25,

  registration_channel_id TEXT,
  list_channel_id TEXT,
  list_message_id TEXT,

  confirm_channel_id TEXT,
  confirm_message_id TEXT,

  team_role_id TEXT,
  ban_role_id TEXT,
  registration_open INTEGER NOT NULL DEFAULT 0,
  confirm_open INTEGER NOT NULL DEFAULT 0,

  open_at TEXT,
  close_at TEXT,
  confirm_open_at TEXT,
  confirm_close_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  team_tag TEXT NOT NULL,
  logo_filename TEXT,
  owner_user_id TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scrim_id, slot),
  UNIQUE(scrim_id, owner_user_id),
  FOREIGN KEY(scrim_id) REFERENCES scrims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  game1 INTEGER DEFAULT 0,
  game2 INTEGER DEFAULT 0,
  game3 INTEGER DEFAULT 0,
  game4 INTEGER DEFAULT 0,
  UNIQUE(scrim_id, slot),
  FOREIGN KEY(scrim_id) REFERENCES scrims(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(guild_id, user_id)
);

`);
// ---- MIGRATIONS (safe to run every startup) ----
function addColumnIfMissing(table, column, typeSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`).run();
  }
}

// Add GameSC screenshots channel column
addColumnIfMissing("scrims", "gamesc_channel_id", "TEXT");

// ✅ migrate columns (NO sqlite3 CLI needed)
function addColumnIfMissing(table, column, defSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql};`);
  console.log(`✅ DB migrated: ${table}.${column}`);
}

addColumnIfMissing("scrims", "slot_template", "TEXT");
addColumnIfMissing("scrims", "slots_channel_id", "TEXT");
addColumnIfMissing("scrims", "slots_spam", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("scrims", "scoring_json", "TEXT"); // per-scrim scoring config JSON

// auto-post toggles + message ids
addColumnIfMissing("scrims", "auto_post_reg", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("scrims", "auto_post_list", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("scrims", "auto_post_confirm", "INTEGER NOT NULL DEFAULT 1");

addColumnIfMissing("scrims", "registration_message_id", "TEXT");

// ban channel log
addColumnIfMissing("scrims", "ban_channel_id", "TEXT");

// results dynamic games
db.exec(`
CREATE TABLE IF NOT EXISTS scrim_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scrim_id, idx),
  FOREIGN KEY(scrim_id) REFERENCES scrims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS results_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  game_idx INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scrim_id, slot, game_idx),
  FOREIGN KEY(scrim_id) REFERENCES scrims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS result_screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_id INTEGER NOT NULL,
  game_idx INTEGER NOT NULL,
  filename TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(scrim_id) REFERENCES scrims(id) ON DELETE CASCADE
);
`);
db.prepare(`
CREATE TABLE IF NOT EXISTS scrim_results (
  scrim_id INTEGER,
  game INTEGER,
  team_tag TEXT,
  place INTEGER,
  kills INTEGER,
  points INTEGER,
  PRIMARY KEY (scrim_id, game, team_tag)
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS scrim_results_manual (
  scrim_id INTEGER,
  game INTEGER,
  team_tag TEXT,
  place INTEGER,
  kills INTEGER,
  points INTEGER,
  PRIMARY KEY (scrim_id, game, team_tag)
)`).run();


function colExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  return cols.includes(col);
}
function defaultScoring() {
  return {
    killPoints: 1,
    p1: 10,
    p2: 6,
    p3: 5,
    p4: 4,
    p5: 3,
    p6: 2,
    p7: 1,
    p8: 1,
    p9plus: 0,
  };
}

function clampInt(n, min, max, fallback) {
  n = Number(n);
  if (!Number.isFinite(n)) return fallback;
  n = Math.trunc(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function getScrimScoring(scrim) {
  const def = defaultScoring();
  try {
    const raw = scrim?.scoring_json;
    if (!raw) return def;
    const obj = JSON.parse(raw);

    const killPoints = clampInt(obj?.killPoints ?? obj?.kills ?? obj?.kill_points, 0, 50, def.killPoints);

    const p1 = clampInt(obj?.p1 ?? obj?.places?.["1"], 0, 200, def.p1);
    const p2 = clampInt(obj?.p2 ?? obj?.places?.["2"], 0, 200, def.p2);
    const p3 = clampInt(obj?.p3 ?? obj?.places?.["3"], 0, 200, def.p3);
    const p4 = clampInt(obj?.p4 ?? obj?.places?.["4"], 0, 200, def.p4);
    const p5 = clampInt(obj?.p5 ?? obj?.places?.["5"], 0, 200, def.p5);
    const p6 = clampInt(obj?.p6 ?? obj?.places?.["6"], 0, 200, def.p6);
    const p7 = clampInt(obj?.p7 ?? obj?.places?.["7"], 0, 200, def.p7);
    const p8 = clampInt(obj?.p8 ?? obj?.places?.["8"], 0, 200, def.p8);
    const p9plus = clampInt(obj?.p9plus ?? obj?.places?.["9+"], 0, 200, def.p9plus);

    return { killPoints, p1, p2, p3, p4, p5, p6, p7, p8, p9plus };
  } catch {
    return def;
  }
}

function placementPoints(place, rankMap) {
  return rankMap?.[place] ?? 0;
}

function scoreRow(row, teams, rankMap) {
  for (const team of teams) {
    const tag = team.team_tag.toUpperCase();
    const matched = row.players.filter(p =>
      p.toUpperCase().includes(tag)
    ).length;

    if (matched >= 2) {
      const kills = row.kills.reduce((a, b) => a + b, 0);
      const placePts = placementPoints(row.place, rankMap);
      const total = placePts + kills;

      return {
        scrim_id: row.scrimId,
        game: row.game,
        team_tag: team.team_tag,
        place: row.place,
        kills,
        points: total,
      };
    }
  }
  return null;
}

function normName(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "")      // remove spaces
    .replace(/[|._-]/g, "");  // remove common separators
}

function hasTag(playerName, tag) {
  const n = normName(playerName);
  const t = normName(tag);
  return t && n.includes(t);
}
function detectTeamForRow(playerNames, teams, minTagged = 2) {
  // teams: [{ name: "DarkSide", tag: "DS" }, ...]
  let best = null;

  for (const team of teams) {
    const tagged = playerNames.reduce((acc, p) => acc + (hasTag(p, team.tag) ? 1 : 0), 0);

    if (tagged >= minTagged) {
      // pick the team with the highest tagged count
      if (!best || tagged > best.tagged) best = { team, tagged };
    }
  }

  return best ? best.team : null; // null means “unknown team”
}
function scoreRow(row, teams, scoring = defaultScoring()) {
  const team = detectTeamForRow(row.players, teams, 2);
  if (!team) return null;

  const kills = row.kills.reduce((a, b) => a + (Number(b) || 0), 0);
  const pp = placementPoints(row.place, scoring);

  return {
    scrim_id: row.scrimId,
    game: row.game,
    team_tag: team.team_tag,
    place: row.place,
    kills,
    points: pp + (kills * (Number(scoring?.killPoints)||0)),
  };
}

function totalPoints(place, kills, scoring = defaultScoring()) {
  const k = Number(kills) || 0;
  const kp = Number(scoring?.killPoints) || 0;
  return placementPoints(place, scoring) + (k * kp);
}

function addCol(table, colDef) {
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
}

try {
  if (!colExists("scrims", "ban_role_id")) addCol("scrims", "ban_role_id TEXT");
  if (!colExists("bans", "expires_at")) addCol("bans", "expires_at TEXT");
} catch (e) {
  console.log("DB migrate warning:", e?.message || e);
}

const q = {
  // scrims
  scrimById: db.prepare(`SELECT * FROM scrims WHERE id = ?`),
  scrimsByGuild: db.prepare(`SELECT * FROM scrims WHERE guild_id = ? ORDER BY id DESC`),

  createScrim: db.prepare(`
    INSERT INTO scrims (
      guild_id, name, min_slot, max_slot,
      registration_channel_id, list_channel_id, confirm_channel_id, team_role_id,
      open_at, close_at, confirm_open_at, confirm_close_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateScrim: db.prepare(`
    UPDATE scrims SET
      name = ?,
      min_slot = ?,
      max_slot = ?,
      registration_channel_id = ?,
      list_channel_id = ?,
      confirm_channel_id = ?,
      team_role_id = ?,
      open_at = ?,
      close_at = ?,
      confirm_open_at = ?,
      confirm_close_at = ?
    WHERE id = ? AND guild_id = ?
  `),

  updateScrimSettings: db.prepare(`
    UPDATE scrims SET
      registration_channel_id=?,
      list_channel_id=?,
      confirm_channel_id=?,
      team_role_id=?,
      ban_role_id=?,
      open_at=?,
      close_at=?,
      confirm_open_at=?,
      confirm_close_at=?
    WHERE id=? AND guild_id=?
  `),

  // reg/list/confirm messages
  setRegMessage: db.prepare(`
    UPDATE scrims SET registration_channel_id = ?, registration_message_id = ? WHERE id = ?
  `),
  setListMessage: db.prepare(`
    UPDATE scrims SET list_channel_id = ?, list_message_id = ? WHERE id = ?
  `),
  setConfirmMessage: db.prepare(`
    UPDATE scrims SET confirm_channel_id = ?, confirm_message_id = ? WHERE id = ?
  `),

  // toggles
  setRegOpen: db.prepare(`UPDATE scrims SET registration_open = ? WHERE id = ? AND guild_id = ?`),
  setConfirmOpen: db.prepare(`UPDATE scrims SET confirm_open = ? WHERE id = ? AND guild_id = ?`),

  // auto post flags
  setAutoPost: db.prepare(`
    UPDATE scrims SET auto_post_reg=?, auto_post_list=?, auto_post_confirm=? WHERE id=? AND guild_id=?
  `),

  // ban channel
  setBanChannel: db.prepare(`
    UPDATE scrims SET ban_channel_id=? WHERE id=? AND guild_id=?
  `),

  // slots settings
  updateSlotsSettings: db.prepare(`
    UPDATE scrims SET
      slot_template = ?,
      slots_channel_id = ?,
      slots_spam = ?
    WHERE id = ? AND guild_id = ?
  `),

  // ✅ GameSC screenshots channel
  setGameScChannel: db.prepare(`
    UPDATE scrims SET gamesc_channel_id=? WHERE id=? AND guild_id=?
  `),

  // ✅ scoring config json
  setScoringJson: db.prepare(`
    UPDATE scrims SET scoring_json=? WHERE id=? AND guild_id=?
  `),

  // teams
  teamsByScrim: db.prepare(`
    SELECT * FROM teams WHERE scrim_id = ? ORDER BY slot ASC
  `),

  teamsByScrimFull: db.prepare(`
    SELECT t.*, s.guild_id
    FROM teams t
    JOIN scrims s ON s.id = t.scrim_id
    WHERE t.scrim_id = ?
    ORDER BY t.slot ASC
  `),

  teamByUser: db.prepare(`
    SELECT * FROM teams WHERE scrim_id = ? AND owner_user_id = ?
  `),

  teamBySlot: db.prepare(`
    SELECT * FROM teams WHERE scrim_id = ? AND slot = ?
  `),

  insertTeam: db.prepare(`
    INSERT INTO teams (scrim_id, slot, team_name, team_tag, logo_filename, owner_user_id, confirmed)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `),

  removeTeamBySlot: db.prepare(`
    DELETE FROM teams WHERE scrim_id = ? AND slot = ?
  `),

  removeTeamByUser: db.prepare(`
    DELETE FROM teams WHERE scrim_id = ? AND owner_user_id = ?
  `),

  setConfirmedByUser: db.prepare(`
    UPDATE teams SET confirmed = 1 WHERE scrim_id = ? AND owner_user_id = ?
  `),

  setConfirmedByTeamId: db.prepare(`
    UPDATE teams SET confirmed = 1
    WHERE id = ? AND scrim_id = ?
  `),

  // bans
  banUpsert: db.prepare(`
    INSERT INTO bans (guild_id, user_id, reason, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      reason = excluded.reason,
      expires_at = excluded.expires_at
  `),

  banByUser: db.prepare(`SELECT * FROM bans WHERE guild_id=? AND user_id=?`),
  bansByGuild: db.prepare(`SELECT * FROM bans WHERE guild_id=? ORDER BY id DESC`),
  unban: db.prepare(`DELETE FROM bans WHERE guild_id=? AND user_id=?`),
  isBanned: db.prepare(`SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?`),

  // results legacy (your old table)
  upsertResults: db.prepare(`
    INSERT INTO results (scrim_id, slot, game1, game2, game3, game4)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scrim_id, slot) DO UPDATE SET
      game1=excluded.game1, game2=excluded.game2, game3=excluded.game3, game4=excluded.game4
  `),
  resultsByScrim: db.prepare(`SELECT * FROM results WHERE scrim_id = ? ORDER BY slot ASC`),

  // ✅ OCR results table (new)
  saveResult: db.prepare(`
    INSERT INTO scrim_results (scrim_id, game, team_tag, place, kills, points)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scrim_id, game, team_tag)
    DO UPDATE SET place=excluded.place, kills=excluded.kills, points=excluded.points
  `),
  // ✅ Manual override results (editable)
  saveManualResult: db.prepare(`
    INSERT INTO scrim_results_manual (scrim_id, game, team_tag, place, kills, points)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scrim_id, game, team_tag)
    DO UPDATE SET place=excluded.place, kills=excluded.kills, points=excluded.points
  `),

  manualResultsByGame: db.prepare(`
    SELECT * FROM scrim_results_manual WHERE scrim_id=? AND game=? ORDER BY points DESC, kills DESC, place ASC, team_tag ASC
  `),

  manualAllByScrim: db.prepare(`
    SELECT * FROM scrim_results_manual WHERE scrim_id=? ORDER BY game ASC, points DESC, kills DESC, place ASC, team_tag ASC
  `),

  clearManualGame: db.prepare(`DELETE FROM scrim_results_manual WHERE scrim_id=? AND game=?`),
  clearManualScrim: db.prepare(`DELETE FROM scrim_results_manual WHERE scrim_id=?`),


  resultsByGame: db.prepare(`
    SELECT * FROM scrim_results WHERE scrim_id=? AND game=?
  `),

  // dynamic games + screenshots (your existing)
  gamesByScrim: db.prepare(`SELECT * FROM scrim_games WHERE scrim_id=? ORDER BY idx ASC`),

  ensureGame1: db.prepare(`
    INSERT INTO scrim_games (scrim_id, idx, name)
    VALUES (?, 1, 'Game 1')
    ON CONFLICT(scrim_id, idx) DO NOTHING
  `),

  addGame: db.prepare(`
    INSERT INTO scrim_games (scrim_id, idx, name)
    VALUES (?, ?, ?)
  `),

  pointsByScrim: db.prepare(`
    SELECT * FROM results_points WHERE scrim_id=? ORDER BY slot ASC, game_idx ASC
  `),

  upsertPoint: db.prepare(`
    INSERT INTO results_points (scrim_id, slot, game_idx, points)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scrim_id, slot, game_idx) DO UPDATE SET points=excluded.points
  `),

  screenshotsByScrim: db.prepare(`
    SELECT * FROM result_screenshots WHERE scrim_id=? AND game_idx=? ORDER BY id DESC
  `),

  addScreenshot: db.prepare(`
    INSERT INTO result_screenshots (scrim_id, game_idx, filename, uploaded_by)
    VALUES (?, ?, ?, ?)
  `),
};

function getNextFreeSlot(scrimId, minSlot, maxSlot) {
  const teams = q.teamsByScrim.all(scrimId);
  const used = new Set(teams.map((t) => t.slot));
  for (let s = minSlot; s <= maxSlot; s++) if (!used.has(s)) return s;
  return null;
}
function ensureGame1(scrimId){
  try { q.ensureGame1.run(scrimId); } catch {}
}

function getMaxGameIdx(scrimId){
  const games = q.gamesByScrim.all(scrimId);
  if (!games.length) return 1;
  return Math.max(...games.map(g=>g.idx));
}

// ---------------------- DISCORD BOT ---------------------- //
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

async function registerCommands() {
  const scrim = new SlashCommandBuilder()
    .setName("scrim")
    .setDescription("DarkSide Scrims commands")

    .addSubcommand(sc =>
      sc.setName("panel").setDescription("Get the web panel link (admins only)")
    )

    .addSubcommand(sc =>
      sc.setName("list").setDescription("List scrims in this server")
    )

    .addSubcommand(sc =>
      sc.setName("create").setDescription("Create a new scrim")
        .addStringOption(o => o.setName("name").setDescription("Scrim name").setRequired(true))
        .addIntegerOption(o => o.setName("min").setDescription("Min slot").setMinValue(2).setMaxValue(25).setRequired(true))
        .addIntegerOption(o => o.setName("max").setDescription("Max slot").setMinValue(2).setMaxValue(25).setRequired(true))
    )

    .addSubcommandGroup(g =>
  g.setName("reg").setDescription("Registration controls")
    .addSubcommand(sc =>
      sc.setName("open").setDescription("Open registration")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("close").setDescription("Close registration")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
    )
)

.addSubcommandGroup(g =>
  g.setName("confirm").setDescription("Confirm controls")
    .addSubcommand(sc =>
      sc.setName("open").setDescription("Open confirms")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("close").setDescription("Close confirms")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
    )
)

    .addSubcommandGroup(g =>
      g.setName("post").setDescription("Post/update Discord messages for a scrim")
        .addSubcommand(sc => sc.setName("reg").setDescription("Create/Update the registration embed/button"))
        .addSubcommand(sc => sc.setName("list").setDescription("Create/Update the teams list embed"))
        .addSubcommand(sc => sc.setName("confirm").setDescription("Create/Update confirm embed/buttons"))
        .addSubcommand(sc => sc.setName("slots").setDescription("Render & post slot GIFs now"))
    )

    .addSubcommand(sc =>
      sc.setName("clear").setDescription("Clear ALL teams + results (keeps scrim)")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
    )

    .addSubcommand(sc =>
      sc.setName("delete").setDescription("Delete a scrim forever")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
    )

    .addSubcommand(sc =>
      sc.setName("ban").setDescription("Ban a user from registering (DB + optional ban role)")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption(o => o.setName("duration").setDescription(`0|perm|1h|6h|1d|7d|30d`).setRequired(false))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false))
    )

    .addSubcommand(sc =>
      sc.setName("unban").setDescription("Unban a user (DB + remove ban role)")
        .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    )

    .addSubcommandGroup(g =>
      g.setName("settings").setDescription("Edit scrim settings from Discord")
        .addSubcommand(sc =>
          sc.setName("set").setDescription("Set channels/roles/template/autopost for a scrim")
            .addIntegerOption(o => o.setName("id").setDescription("Scrim ID").setRequired(true))

            .addChannelOption(o => o.setName("reg_channel").setDescription("Registration channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
            .addChannelOption(o => o.setName("list_channel").setDescription("List channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
            .addChannelOption(o => o.setName("confirm_channel").setDescription("Confirm channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
            .addChannelOption(o => o.setName("slots_channel").setDescription("Slots GIF channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
            .addChannelOption(o => o.setName("banlog_channel").setDescription("Ban log channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))

            .addRoleOption(o => o.setName("team_role").setDescription("Team role (auto give)").setRequired(false))
            .addRoleOption(o => o.setName("ban_role").setDescription("Ban role (optional)").setRequired(false))

            .addStringOption(o => o.setName("slot_template").setDescription("Template folder name in /templates").setRequired(false))
            .addBooleanOption(o => o.setName("slots_spam").setDescription("Spam mode (post every slot)").setRequired(false))

            .addBooleanOption(o => o.setName("auto_post_reg").setDescription("Auto post registration message").setRequired(false))
            .addBooleanOption(o => o.setName("auto_post_list").setDescription("Auto post list message").setRequired(false))
            .addBooleanOption(o => o.setName("auto_post_confirm").setDescription("Auto post confirm message").setRequired(false))
        )
    );

  const commands = [scrim].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  // OPTIONAL: for instant updates while testing
  // set GUILD_ID in env to register guild commands instead of global
  const GUILD_ID = process.env.GUILD_ID;

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Guild slash commands registered.");
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Global slash commands registered.");
  }
}


discord.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${discord.user.tag}`);
});

// ---------- EMBEDS HELPERS ----------
async function ensureListMessage(scrim) {
  if (!scrim.list_channel_id) {
    console.log("ensureListMessage: list_channel_id is empty for scrim", scrim.id);
    return;
  }

  const guild = await discord.guilds.fetch(scrim.guild_id).catch(() => null);
  if (!guild) return console.log("ensureListMessage: guild not found", scrim.guild_id);

  const channel = await guild.channels.fetch(scrim.list_channel_id).catch(() => null);
  if (!channel) return console.log("ensureListMessage: channel not found", scrim.list_channel_id);

  // ✅ allow ANY text-based channel
  if (!channel.isTextBased()) {
    console.log("ensureListMessage: channel is not text based", channel.type);
    return;
  }

  if (!scrim.list_message_id) {
    const msg = await channel.send({ content: "Creating teams list..." });
    q.setListMessage.run(scrim.list_channel_id, msg.id, scrim.id);
    scrim = q.scrimById.get(scrim.id);
  }

  await updateTeamsListEmbed(scrim);
}


async function ensureConfirmMessage(scrim) {
  if (!scrim.confirm_channel_id) return;

  const guild = await discord.guilds.fetch(scrim.guild_id).catch(() => null);
  if (!guild) return;

  const channel = await guild.channels.fetch(scrim.confirm_channel_id).catch(() => null);

  // ✅ allow ANY text-based channel
  if (!channel || !channel.isTextBased()) return;

  if (!scrim.confirm_message_id) {
    const msg = await channel.send({ content: "Creating confirms..." }).catch(() => null);
    if (!msg) return;
    q.setConfirmMessage.run(scrim.confirm_channel_id, msg.id, scrim.id);
    scrim = q.scrimById.get(scrim.id);
  }

  await updateConfirmEmbed(scrim).catch(() => {});
}

function buildRegEmbed(scrim, guild, teamsCount = 0) {
  const totalSlots = scrim.max_slot - scrim.min_slot + 1;
  const open = !!scrim.registration_open;

  return new EmbedBuilder()
    .setColor(open ? 0x22c55e : 0xef4444)
    .setAuthor({ name: "DarkSide Scrims", iconURL: DS.logoUrl || guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`📝 ${scrim.name}`)
    .setDescription(
      [
        `**Registration:** ${open ? "🟢 OPEN" : "🔴 CLOSED"}`,
        `**Slots:** **${scrim.min_slot}-${scrim.max_slot}** • **Filled:** **${teamsCount}/${totalSlots}**`,
        "",
        "⚡ **How to Register**",
        "1) Click **Register Team**",
        "2) You get a private link",
        "3) Fill team name + tag + logo",
        "",
        scrim.open_at || scrim.close_at ? "⏱ **Schedule**" : null,
        scrim.open_at ? `• Open: **${scrim.open_at}**` : null,
        scrim.close_at ? `• Close: **${scrim.close_at}**` : null,
        "",
        `🆔 Scrim ID: **${scrim.id}**`,
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: "DarkSideORG • Scrims Panel" })
    .setTimestamp(new Date());
}


function buildRegComponents(scrim) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`reglink:${scrim.id}`)
        .setLabel("Register Team")
        .setEmoji("📝")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!scrim.registration_open)
    ),
  ];
}

async function updateConfirmEmbed(scrim) {
  if (!scrim.confirm_channel_id || !scrim.confirm_message_id) return;

  const guild = await discord.guilds.fetch(scrim.guild_id).catch(()=>null);
  if (!guild) return;

  const channel = await guild.channels.fetch(scrim.confirm_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const msg = await channel.messages.fetch(scrim.confirm_message_id).catch(() => null);
  if (!msg) return;

  const open = !!scrim.confirm_open;

  const embed = new EmbedBuilder()
    .setColor(open ? 0x22c55e : 0xef4444)
    .setAuthor({ name: "DarkSide Scrims", iconURL: DS.logoUrl || guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`✅ ${scrim.name} — CONFIRMATION`)
    .setDescription(
      [
        `**Confirms:** ${open ? "🟢 OPEN" : "🔴 CLOSED"}`,
        "",
        "✅ Confirm locks your slot",
        "🗑️ Drop removes your slot",
        "",
        scrim.confirm_open_at || scrim.confirm_close_at ? "⏱ **Schedule**" : null,
        scrim.confirm_open_at ? `• Open: **${scrim.confirm_open_at}**` : null,
        scrim.confirm_close_at ? `• Close: **${scrim.confirm_close_at}**` : null,
        "",
        `🆔 Scrim ID: **${scrim.id}**`,
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: "DarkSideORG • Confirm System" })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${scrim.id}`)
      .setLabel("Confirm Slot")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(`drop:${scrim.id}`)
      .setLabel("Drop Slot")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!open)
  );

  await msg.edit({ content: "", embeds: [embed], components: [row] }).catch(()=>{});
}

async function ensureRegMessage(scrim) {
  if (!scrim.registration_channel_id) return;
  const guild = await discord.guilds.fetch(scrim.guild_id).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(scrim.registration_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const teams = q.teamsByScrim.all(scrim.id);

  // create message if missing
  if (!scrim.registration_message_id) {
    const msg = await channel.send({ content: "Creating registration..." }).catch(()=>null);
    if (!msg) return;
    q.setRegMessage.run(scrim.registration_channel_id, msg.id, scrim.id);
    scrim = q.scrimById.get(scrim.id);
  }

  const msg = await channel.messages.fetch(scrim.registration_message_id).catch(() => null);
  if (!msg) {
    // recreate if deleted
    const newMsg = await channel.send({ content: "Recreating registration..." }).catch(()=>null);
    if (!newMsg) return;
    q.setRegMessage.run(scrim.registration_channel_id, newMsg.id, scrim.id);
    scrim = q.scrimById.get(scrim.id);
  }

  const fresh = q.scrimById.get(scrim.id);
  const embed = buildRegEmbed(fresh, guild, teams.length);
  const components = buildRegComponents(fresh);

  const finalMsg = await channel.messages.fetch(fresh.registration_message_id).catch(() => null);
  if (finalMsg) await finalMsg.edit({ content: "", embeds: [embed], components }).catch(()=>{});
}

async function autoPostAll(scrim) {
  const s = q.scrimById.get(scrim.id);
  if (!s) return;

  if (s.auto_post_reg) await ensureRegMessage(s).catch(()=>{});
  if (s.auto_post_list) await ensureListMessage(s).catch(()=>{});
  if (s.auto_post_confirm) await ensureConfirmMessage(s).catch(()=>{});
}

async function updateTeamsListEmbed(scrim) {
  try {
    if (!scrim?.list_channel_id || !scrim?.list_message_id) {
      console.log("updateTeamsListEmbed: missing list channel/message", {
        scrimId: scrim?.id,
        list_channel_id: scrim?.list_channel_id,
        list_message_id: scrim?.list_message_id,
      });
      return;
    }

    const guild = await discord.guilds.fetch(scrim.guild_id).catch((e) => {
      console.log("updateTeamsListEmbed: guild fetch failed", scrim.guild_id, e?.message || e);
      return null;
    });
    if (!guild) return;

    const channel = await guild.channels.fetch(scrim.list_channel_id).catch((e) => {
      console.log("updateTeamsListEmbed: channel fetch failed", scrim.list_channel_id, e?.message || e);
      return null;
    });
    if (!channel) return;

    // ✅ allow ANY text-based channel
    if (!channel.isTextBased()) {
      console.log("updateTeamsListEmbed: channel not text based", {
        channelId: scrim.list_channel_id,
        type: channel.type,
      });
      return;
    }

    const msg = await channel.messages.fetch(scrim.list_message_id).catch((e) => {
      console.log("updateTeamsListEmbed: message fetch failed", {
        channelId: scrim.list_channel_id,
        messageId: scrim.list_message_id,
        err: e?.message || e,
      });
      return null;
    });

    if (!msg) {
      // message deleted or bot can't read history => recreate
      console.log("updateTeamsListEmbed: list message missing, recreating...");
      const newMsg = await channel.send({ content: "Recreating teams list..." }).catch((e) => {
        console.log("updateTeamsListEmbed: failed to recreate message", e?.message || e);
        return null;
      });
      if (!newMsg) return;

      q.setListMessage.run(scrim.list_channel_id, newMsg.id, scrim.id);
      scrim = q.scrimById.get(scrim.id); // refresh
    }

    const teams = q.teamsByScrim.all(scrim.id);
    const totalSlots = scrim.max_slot - scrim.min_slot + 1;
    const teamBySlot = new Map(teams.map((t) => [t.slot, t]));

    const lines = [];
    for (let s = scrim.min_slot; s <= scrim.max_slot; s++) {
      const t = teamBySlot.get(s);
      if (!t) lines.push(`**#${s}** ┃ _empty_`);
      else lines.push(`**#${s}** ┃ **${t.team_tag}** — ${t.team_name} ${t.confirmed ? "✅" : "⏳"}`);
    }

    const half = Math.ceil(lines.length / 2);
    const left = lines.slice(0, half).join("\n");
    const right = lines.slice(half).join("\n");

    const embed = new EmbedBuilder()
      .setColor(0xffb300)
      .setTitle(`📋 ${scrim.name} — TEAM LIST`)
      .setDescription(
        [
          `👥 **Teams:** ${teams.length}/${totalSlots}`,
          `📝 **Registration:** ${scrim.registration_open ? "🟢 OPEN" : "🔴 CLOSED"}`,
          `✅ **Confirms:** ${scrim.confirm_open ? "🟢 OPEN" : "🔴 CLOSED"}`,
          "",
          "✅ = confirmed • ⏳ = waiting",
        ].join("\n")
      )
      .addFields(
        { name: "Slots", value: left || "_none_", inline: true },
        { name: "⠀", value: right || "_none_", inline: true }
      )
      .setFooter({ text: `DarkSide Scrims • Scrim ID: ${scrim.id}` })
      .setTimestamp(new Date());

    const components = [];

    // Discord limit: select menu max 25 options (you already slice ✅)
    const filled = teams.map((t) => ({
      label: `Remove #${t.slot} — ${t.team_tag}`.slice(0, 100),
      description: (t.team_name || "").slice(0, 90),
      value: String(t.slot),
    }));

    if (filled.length) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`rmteam:${scrim.id}`)
            .setPlaceholder("🛠 Staff: remove a team...")
            .addOptions(filled.slice(0, 25))
        )
      );
    }

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`refreshlist:${scrim.id}`)
          .setLabel("Refresh List")
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Secondary)
      )
    );

    // edit the correct message (if recreated, scrim was refreshed above)
// ✅ always re-fetch after any possible recreation
const latest = q.scrimById.get(scrim.id);
const finalMsg = await channel.messages.fetch(latest.list_message_id).catch(() => null);
if (!finalMsg) return;

await finalMsg.edit({ content: "", embeds: [embed], components });


    console.log("updateTeamsListEmbed: updated OK", { scrimId: scrim.id });
  } catch (e) {
    console.log("updateTeamsListEmbed: fatal error", e?.message || e);
  }
}

// ---------- DISCORD INTERACTIONS ----------
discord.on(Events.InteractionCreate, async (interaction) => {
  try {
    // =========================
    // SLASH COMMANDS
    // =========================
    if (interaction.isChatInputCommand()) {
      // ---------- /scrims (panel link) ----------
      if (interaction.commandName === "scrims") {
        const member = interaction.member;
        const can =
          member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
          member?.permissions?.has?.(PermissionFlagsBits.Administrator);

        if (!can) return interaction.reply({ content: "❌ Need Manage Server.", ephemeral: true });

        return interaction.reply({ content: `Panel: ${BASE}/panel`, ephemeral: true });
      }

      // ---------- /scrim reg/confirm with required scrim id ----------
      if (interaction.commandName === "scrim") {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "❌ Use this in a server.", ephemeral: true });
  }

  const member = interaction.member;
  const can =
    member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has?.(PermissionFlagsBits.Administrator);

  if (!can) return interaction.reply({ content: "❌ Need Manage Server.", ephemeral: true });

  const guildId = String(interaction.guildId);
  const group = interaction.options.getSubcommandGroup(false); // reg | confirm | post | settings | null
  const sub = interaction.options.getSubcommand(true);

  // -----------------------------
  // /scrim panel
  // -----------------------------
  if (!group && sub === "panel") {
    return interaction.reply({ content: `✅ Panel: ${BASE}/panel`, ephemeral: true });
  }

  // -----------------------------
  // /scrim list
  // -----------------------------
  if (!group && sub === "list") {
    const scrims = q.scrimsByGuild.all(guildId);
    if (!scrims.length) {
      return interaction.reply({ content: "No scrims in this server yet.", ephemeral: true });
    }

    const text = scrims
      .slice(0, 15)
      .map(s => `• **${s.name}** (ID: \`${s.id}\`) — Reg: ${s.registration_open ? "OPEN" : "CLOSED"} — Confirm: ${s.confirm_open ? "OPEN" : "CLOSED"}`)
      .join("\n");

    return interaction.reply({ content: `📋 **Scrims in this server:**\n${text}`, ephemeral: true });
  }

  // -----------------------------
  // /scrim create
  // -----------------------------
  if (!group && sub === "create") {
    const name = interaction.options.getString("name", true);
    const min = interaction.options.getInteger("min", true);
    const max = interaction.options.getInteger("max", true);

    q.createScrim.run(
      guildId,
      name,
      min,
      max,
      null, null, null, null,
      null, null, null, null
    );

    const newId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
    const fresh = q.scrimById.get(newId);
    autoPostAll(fresh).catch(() => {});

    return interaction.reply({ content: `✅ Scrim created: **${name}** (ID: \`${newId}\`)`, ephemeral: true });
  }

  // -------------------------------------------
  // Everything below needs Scrim ID
  // -------------------------------------------
  const scrimId = interaction.options.getInteger("id", true);
  let scrim = q.scrimById.get(scrimId);

  if (!scrim || String(scrim.guild_id) !== guildId) {
    return interaction.reply({ content: "❌ Scrim not found in this server.", ephemeral: true });
  }

  // -----------------------------
  // /scrim reg open|close
  // -----------------------------
  if (group === "reg") {
    const next = sub === "open" ? 1 : 0;
    q.setRegOpen.run(next, scrimId, guildId);

    scrim = q.scrimById.get(scrimId);
    autoPostAll(scrim).catch(() => {});

    return interaction.reply({
      content: `✅ Registration ${next ? "OPENED" : "CLOSED"} for **${scrim.name}** (ID: ${scrim.id})`,
      ephemeral: true,
    });
  }

  // -----------------------------
  // /scrim confirm open|close
  // -----------------------------
  if (group === "confirm") {
    const next = sub === "open" ? 1 : 0;
    q.setConfirmOpen.run(next, scrimId, guildId);

    scrim = q.scrimById.get(scrimId);
    autoPostAll(scrim).catch(() => {});

    return interaction.reply({
      content: `✅ Confirms ${next ? "OPENED" : "CLOSED"} for **${scrim.name}** (ID: ${scrim.id})`,
      ephemeral: true,
    });
  }

  // -----------------------------
  // /scrim post reg|list|confirm|slots
  // -----------------------------
  if (group === "post") {
    await interaction.deferReply({ ephemeral: true });

    if (sub === "reg") {
      await ensureRegMessage(scrim).catch(() => {});
      return interaction.editReply({ content: "✅ Posted/updated registration message." });
    }

    if (sub === "list") {
      await ensureListMessage(scrim).catch(() => {});
      return interaction.editReply({ content: "✅ Posted/updated teams list." });
    }

    if (sub === "confirm") {
      await ensureConfirmMessage(scrim).catch(() => {});
      return interaction.editReply({ content: "✅ Posted/updated confirm message." });
    }

    if (sub === "slots") {
      // Uses same logic as panel route
      if (!scrim.slot_template) return interaction.editReply({ content: "❌ No slot template set." });
      if (!scrim.slots_channel_id) return interaction.editReply({ content: "❌ No slots channel set." });

      try {
        const guild = await discord.guilds.fetch(scrim.guild_id);
        const chan = await guild.channels.fetch(scrim.slots_channel_id).catch(() => null);
        if (!chan || !chan.isTextBased()) return interaction.editReply({ content: "❌ Slots channel invalid." });

        const teams = q.teamsByScrim.all(scrimId);
        const bySlot = new Map(teams.map((t) => [t.slot, t]));

        for (let slot = scrim.min_slot; slot <= scrim.max_slot; slot++) {
          const t = bySlot.get(slot);
          const name = t ? t.team_name : "EMPTY";
          const tag = t ? t.team_tag : "";

          const filePath = await renderSlotGif({
            templateKey: scrim.slot_template,
            scrimId,
            slot,
            teamName: name,
            teamTag: tag,
          });

          await chan.send({ files: [filePath] });
          if (!scrim.slots_spam) break;
        }

        return interaction.editReply({ content: "✅ Slots posted." });
      } catch (e) {
        console.error("slots post slash error:", e);
        return interaction.editReply({ content: "❌ Failed to post slots. Check logs." });
      }
    }
  }

  // -----------------------------
  // /scrim settings set (...)
  // -----------------------------
  if (group === "settings" && sub === "set") {
    // start with existing, override only provided
    const regCh = interaction.options.getChannel("reg_channel")?.id ?? scrim.registration_channel_id;
    const listCh = interaction.options.getChannel("list_channel")?.id ?? scrim.list_channel_id;
    const confCh = interaction.options.getChannel("confirm_channel")?.id ?? scrim.confirm_channel_id;
    const slotsCh = interaction.options.getChannel("slots_channel")?.id ?? scrim.slots_channel_id;
    const banlogCh = interaction.options.getChannel("banlog_channel")?.id ?? scrim.ban_channel_id;

    const teamRole = interaction.options.getRole("team_role")?.id ?? scrim.team_role_id;
    const banRole = interaction.options.getRole("ban_role")?.id ?? scrim.ban_role_id;

    const slotTemplate = interaction.options.getString("slot_template") ?? scrim.slot_template;
    const slotsSpam = interaction.options.getBoolean("slots_spam");
    const slotsSpamVal = slotsSpam == null ? scrim.slots_spam : (slotsSpam ? 1 : 0);

    q.updateScrimSettings.run(
      regCh, listCh, confCh,
      teamRole, banRole,
      scrim.open_at, scrim.close_at,
      scrim.confirm_open_at, scrim.confirm_close_at,
      scrimId, guildId
    );

    q.updateSlotsSettings.run(slotTemplate, slotsCh, slotsSpamVal, scrimId, guildId);
    q.setBanChannel.run(banlogCh, scrimId, guildId);

    scrim = q.scrimById.get(scrimId);
    autoPostAll(scrim).catch(() => {});

    return interaction.reply({ content: "✅ Settings updated and auto-post refreshed.", ephemeral: true });
  }

  // -----------------------------
  // /scrim ban
  // -----------------------------
  if (!group && sub === "ban") {
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "Banned by staff";
    const duration = interaction.options.getString("duration") || "perm";

    let expiresAt = null;
    const ms = parseDurationToMs(duration);
    if (ms === null) {
      return interaction.reply({ content: "❌ Invalid duration. Use 0|perm|1h|6h|1d|7d|30d", ephemeral: true });
    }
    if (ms > 0) expiresAt = new Date(Date.now() + ms).toISOString();

    q.banUpsert.run(guildId, user.id, reason, expiresAt);

    // give ban role if set
    if (scrim.ban_role_id) {
      try {
        const guild = await discord.guilds.fetch(guildId);
        const mem = await guild.members.fetch(user.id);
        await mem.roles.add(scrim.ban_role_id).catch(() => {});
      } catch {}
    }

    return interaction.reply({
      content: `⛔ Banned <@${user.id}> (${expiresAt ? "until " + expiresAt : "PERMANENT"})`,
      ephemeral: true,
    });
  }

  // -----------------------------
  // /scrim unban
  // -----------------------------
  if (!group && sub === "unban") {
    const user = interaction.options.getUser("user", true);
    q.unban.run(guildId, user.id);

    if (scrim.ban_role_id) {
      try {
        const guild = await discord.guilds.fetch(guildId);
        const mem = await guild.members.fetch(user.id);
        await mem.roles.remove(scrim.ban_role_id).catch(() => {});
      } catch {}
    }

    return interaction.reply({ content: `✅ Unbanned <@${user.id}>`, ephemeral: true });
  }

  // -----------------------------
  // /scrim clear
  // -----------------------------
  if (!group && sub === "clear") {
    db.prepare("DELETE FROM teams WHERE scrim_id=?").run(scrimId);
    db.prepare("DELETE FROM results WHERE scrim_id=?").run(scrimId);
    db.prepare("DELETE FROM results_points WHERE scrim_id=?").run(scrimId);
    q.setRegOpen.run(0, scrimId, guildId);
    q.setConfirmOpen.run(0, scrimId, guildId);

    const fresh = q.scrimById.get(scrimId);
    autoPostAll(fresh).catch(() => {});
    return interaction.reply({ content: "✅ Scrim cleared (teams + results removed).", ephemeral: true });
  }

  // -----------------------------
  // /scrim delete
  // -----------------------------
  if (!group && sub === "delete") {
    db.prepare("DELETE FROM scrims WHERE id=? AND guild_id=?").run(scrimId, guildId);
    return interaction.reply({ content: `🗑️ Deleted scrim ${scrimId}`, ephemeral: true });
  }

  return interaction.reply({ content: "❌ Unknown scrim command.", ephemeral: true });
}

    }

    // =========================
    // BUTTONS
    // =========================
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith("reglink:")) {
        const scrimId = Number(id.split(":")[1]);
        const scrim = q.scrimById.get(scrimId);
        if (!scrim) return interaction.reply({ content: "Scrim not found.", ephemeral: true });
        if (!scrim.registration_open) return interaction.reply({ content: "❌ Registration closed.", ephemeral: true });

        const url = `${BASE}/register/${scrimId}?user=${interaction.user.id}`;
        return interaction.reply({ content: `✅ Your link:\n${url}`, ephemeral: true });
      }

      if (id.startsWith("confirm:")) {
        const scrimId = Number(id.split(":")[1]);
        const scrim = q.scrimById.get(scrimId);
        if (!scrim) return interaction.reply({ content: "Scrim not found.", ephemeral: true });
        if (!scrim.confirm_open) return interaction.reply({ content: "❌ Confirms closed.", ephemeral: true });

        const team = q.teamByUser.get(scrimId, interaction.user.id);
        if (!team) return interaction.reply({ content: "❌ You are not registered.", ephemeral: true });

        q.setConfirmedByUser.run(scrimId, interaction.user.id);
        await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
        return interaction.reply({ content: `✅ Confirmed slot #${team.slot}`, ephemeral: true });
      }

      if (id.startsWith("drop:")) {
        const scrimId = Number(id.split(":")[1]);
        const scrim = q.scrimById.get(scrimId);
        if (!scrim) return interaction.reply({ content: "Scrim not found.", ephemeral: true });
        if (!scrim.confirm_open) return interaction.reply({ content: "❌ Confirms closed.", ephemeral: true });

        const team = q.teamByUser.get(scrimId, interaction.user.id);
        if (!team) return interaction.reply({ content: "❌ You are not registered.", ephemeral: true });

        q.removeTeamByUser.run(scrimId, interaction.user.id);

        if (scrim.team_role_id && interaction.guild) {
          try {
            const m = await interaction.guild.members.fetch(interaction.user.id);
            await m.roles.remove(scrim.team_role_id);
          } catch {}
        }

        await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
        return interaction.reply({ content: `⛔ Dropped slot #${team.slot}`, ephemeral: true });
      }

      if (id.startsWith("refreshlist:")) {
        const scrimId = Number(id.split(":")[1]);
        const scrim = q.scrimById.get(scrimId);
        if (!scrim) return interaction.reply({ content: "Scrim not found.", ephemeral: true });
        await updateTeamsListEmbed(scrim).catch(() => {});
        return interaction.reply({ content: "✅ Updated.", ephemeral: true });
      }
    }

    // =========================
    // SELECT MENUS
    // =========================
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      if (id.startsWith("rmteam:")) {
        const scrimId = Number(id.split(":")[1]);
        const scrim = q.scrimById.get(scrimId);
        if (!scrim) return interaction.reply({ content: "Scrim not found.", ephemeral: true });

        const member = interaction.member;
        const can =
          member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
          member?.permissions?.has?.(PermissionFlagsBits.Administrator);
        if (!can) return interaction.reply({ content: "❌ Need Manage Server.", ephemeral: true });

        const slot = Number(interaction.values[0]);
        const team = q.teamBySlot.get(scrimId, slot);
        if (!team) return interaction.reply({ content: "Team not found.", ephemeral: true });

        q.removeTeamBySlot.run(scrimId, slot);

        if (scrim.team_role_id) {
          try {
            const guild = await discord.guilds.fetch(scrim.guild_id);
            const mem = await guild.members.fetch(team.owner_user_id);
            await mem.roles.remove(scrim.team_role_id);
          } catch {}
        }

        await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
        return interaction.reply({ content: `⛔ Removed #${slot} (${team.team_tag})`, ephemeral: true });
      }
    }
  } catch (e) {
    console.error("Interaction error:", e);
    if (interaction.isRepliable()) {
      interaction.reply({ content: "❌ Error.", ephemeral: true }).catch(() => {});
    }
  }
});


// ---------------------- EXPRESS ---------------------- //
const app = express();
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    name: "ds_scrims_session",
    secret: PANEL_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.use("/logos", express.static(uploadDir));
app.use("/results", express.static(resultsDir));

// ---------------------- HTML helpers ---------------------- //
function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLanding({ title = "DarkSideORG — Login", user = null, error = "" }) {
  const isAuthed = !!user;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg1:#020617;
      --bg2:#050509;
      --card:rgba(18,20,31,.92);
      --border:rgba(255,255,255,.08);
      --text:#f5f5f7;
      --muted:#9ca3af;
      --accent:#ffb300;
      --accent2:#38bdf8;
      --danger:#ff4b4b;
      --ok:#4caf50;
    }
    *{box-sizing:border-box}
    body{
      margin:0; min-height:100vh; color:var(--text);
      font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial;
      background:
        radial-gradient(circle at top,#20263a 0,transparent 55%),
        radial-gradient(circle at bottom,#111827 0,#020617 65%);
      overflow:hidden;
    }

    /* animated aura like your other pages */
    body::before{
      content:"";
      position:fixed; inset:-40px;
      background:
        radial-gradient(circle at 20% 30%, rgba(255,179,0,.14), transparent 60%),
        radial-gradient(circle at 80% 70%, rgba(56,189,248,.10), transparent 60%);
      animation: drift 18s ease-in-out infinite;
      z-index:-2;
    }
    @keyframes drift{
      0%,100%{transform:translate(0,0)}
      50%{transform:translate(-14px,10px)}
    }

    .wrap{
      width:100%;
      max-width:1100px;
      margin:0 auto;
      padding:28px 22px;
      display:grid;
      grid-template-columns: 1.15fr .85fr;
      gap:18px;
      align-items:stretch;
      min-height:100vh;
    }
    @media (max-width: 980px){
      .wrap{grid-template-columns:1fr; padding:22px 16px}
    }

    .card{
      position:relative;
      border-radius:18px;
      background:var(--card);
      border:1px solid var(--border);
      box-shadow:0 25px 40px rgba(0,0,0,.7);
      overflow:hidden;
    }
    .card::before{
      content:"";
      position:absolute; inset:-1px;
      border-radius:inherit;
      background: linear-gradient(135deg, rgba(255,179,0,.30), rgba(56,189,248,.18));
      opacity:.7;
      -webkit-mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      -webkit-mask-composite:xor;
      mask-composite: exclude;
      padding:1px;
      pointer-events:none;
    }

    .main{padding:22px}
    .side{padding:22px; display:flex; flex-direction:column; justify-content:space-between}

    .badge{
      display:inline-flex; align-items:center; gap:8px;
      padding:6px 12px;
      border-radius:999px;
      background: rgba(15,23,42,.85);
      border:1px solid rgba(148,163,184,.35);
      color:var(--muted);
      font-size:11px;
      letter-spacing:.12em;
      text-transform:uppercase;
    }
    .badgeDot{
      width:8px;height:8px;border-radius:50%;
      background:var(--accent);
      box-shadow:0 0 12px rgba(255,179,0,.8);
    }

    .brandRow{
      margin-top:14px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .brand{
      font-family:Orbitron;
      letter-spacing:.16em;
      text-transform:uppercase;
      font-size:30px;
      margin:0;
      line-height:1.05;
    }
    .chip{
      font-size:11px;
      letter-spacing:.16em;
      text-transform:uppercase;
      color:var(--muted);
      border:1px solid rgba(255,255,255,.08);
      background: rgba(15,23,42,.65);
      padding:8px 10px;
      border-radius:999px;
      white-space:nowrap;
    }

    .subtitle{
      margin:8px 0 0;
      color:var(--muted);
      font-size:13px;
      line-height:1.6;
    }

    .hero{
      margin-top:16px;
      padding:14px 14px;
      border-radius:16px;
      background: rgba(15,23,42,.55);
      border:1px solid rgba(148,163,184,.18);
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .heroLeft{
      display:flex;
      align-items:center;
      gap:12px;
    }
    .logoWrap{
      width:54px;height:54px;border-radius:16px;
      border:1px solid rgba(148,163,184,.28);
      background: rgba(2,6,23,.55);
      display:flex;align-items:center;justify-content:center;
      position:relative;
      overflow:hidden;
    }
    .logoWrap::after{
      content:"";
      position:absolute; inset:-20px;
      background: radial-gradient(circle, rgba(255,179,0,.28), transparent 60%);
      filter: blur(18px);
      animation:pulse 6s ease-in-out infinite;
      opacity:.7;
    }
    @keyframes pulse{0%,100%{transform:scale(1);opacity:.35}50%{transform:scale(1.2);opacity:.8}}
    .logoText{
      position:relative;
      font-family:Orbitron;
      letter-spacing:.12em;
      font-size:18px;
    }
    .heroTitle{
      font-family:Orbitron;
      letter-spacing:.12em;
      text-transform:uppercase;
      font-size:14px;
      margin:0;
    }
    .heroSub{
      margin:4px 0 0;
      color:var(--muted);
      font-size:12px;
    }

    .btn{
      width:100%;
      padding:12px 14px;
      border-radius:999px;
      border:none;
      cursor:pointer;
      font-family:Orbitron,system-ui;
      letter-spacing:.15em;
      text-transform:uppercase;
      background: linear-gradient(135deg, #fde68a, #f97316, #ea580c);
      color:#0b0b10;
      box-shadow: 0 14px 30px rgba(0,0,0,.75), 0 0 26px rgba(249,115,22,.55);
      transition: transform .12s ease, filter .12s ease, box-shadow .12s ease;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:10px;
      text-decoration:none;
      margin-top:14px;
    }
    .btn:hover{ transform: translateY(-1px); filter: brightness(1.05); box-shadow: 0 18px 36px rgba(0,0,0,.85), 0 0 32px rgba(249,115,22,.75); }
    .btn:active{ transform: scale(.98); filter: brightness(.98); }

/* ===== BUTTON SYSTEM (same look for <a> and <button>) ===== */
.btn2{
  background:rgba(15,23,42,.85);
  border:1px solid var(--border);
  color:var(--text);

  font-family: Orbitron, system-ui;
  letter-spacing: .12em;
  text-transform: uppercase;

  /* ✅ IMPORTANT: padding + radius for ALL */
  padding: 10px 11px;
  border-radius: 12px;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  text-decoration: none;
  cursor: pointer;
  box-sizing: border-box;
}

button.btn2{
  /* keep button text same + remove gradient */
  background:rgba(15,23,42,.85);
  border:1px solid var(--border);
  color:var(--text);
}

.btn2.primary{
  border-color: rgba(255,179,0,.55);
  box-shadow: 0 0 0 1px rgba(255,179,0,.18);
}

    .btn2:hover{ transform: translateY(-1px); border-color: rgba(255,179,0,.55); }
    .btn2:active{ transform: scale(.99); }

    .grid{
      margin-top:16px;
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
    }
    @media (max-width: 520px){ .grid{grid-template-columns:1fr} }

    .miniCard{
      padding:12px;
      border-radius:16px;
      background: rgba(15,23,42,.55);
      border:1px solid rgba(148,163,184,.18);
    }
    .miniTop{
      display:flex; align-items:center; gap:10px;
      font-family:Orbitron; letter-spacing:.10em;
      text-transform:uppercase;
      font-size:12px;
    }
    .icon{
      width:28px;height:28px;border-radius:10px;
      display:flex;align-items:center;justify-content:center;
      border:1px solid rgba(148,163,184,.25);
      background: rgba(2,6,23,.45);
    }
    .miniSub{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.5}

    .error{
      margin-top:12px;
      padding:10px 12px;
      border-radius:14px;
      background: rgba(239,68,68,.12);
      border:1px solid rgba(239,68,68,.45);
      color:#fecaca;
      font-size:13px;
    }

    .footer{
      margin-top:14px;
      font-size:11px;
      color: rgba(156,163,175,.9);
      display:flex;
      justify-content:space-between;
      gap:10px;
      flex-wrap:wrap;
    }

    code{
      font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
      font-size:11px;
      background: rgba(15,23,42,.85);
      border: 1px solid rgba(148,163,184,.25);
      padding:2px 6px;
      border-radius:9px;
      color: #cbd5e1;
    }
      .banBox{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  align-items:center;
}

.banBox > *{ min-width: 0; }

.banInput{
  flex: 1 1 220px;
}

.banSelect{
  flex: 0 0 110px;
}

.banDays{
  flex: 0 0 90px;
}

@media (max-width: 780px){
  .banInput{ flex: 1 1 100%; }
  .banSelect{ flex: 1 1 48%; }
  .banDays{ flex: 1 1 48%; }
}

  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="main">
        <div class="badge"><span class="badgeDot"></span> DARKSIDE ACCESS</div>

        <div class="brandRow">
          <h1 class="brand">DARKSIDE ORG</h1>
          <div class="chip">SCRIMS PANEL</div>
        </div>

        <p class="subtitle">
          One place to run your scrims — registrations, confirms, slot posting (GIF templates), roles, and results.
        </p>

        <div class="hero">
          <div class="heroLeft">
            <div class="logoWrap"><div class="logoText">DS</div></div>
            <div>
              <p class="heroTitle">Operator Login</p>
              <p class="heroSub">Discord OAuth2 • secure session • staff only</p>
            </div>
          </div>
          <div style="color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.10em">
            ${isAuthed ? "🟢 AUTHENTICATED" : "🟡 READY"}
          </div>
        </div>

        ${error ? `<div class="error">${esc(error)}</div>` : ""}

        ${
          isAuthed
            ? `
              <a class="btn" href="/panel">GO TO PANEL</a>
              <form method="POST" action="/logout" style="margin:0">
                <button class="btn2" type="submit">LOGOUT</button>
              </form>

              <div class="footer">
                <div>Logged in as <b>${esc(user.username)}</b> (ID: <code>${esc(user.id)}</code>)</div>
                <div>Tip: Open <code>/scrims</code> after selecting server</div>
              </div>
            `
            : `
              <a class="btn" href="/auth/discord" id="loginBtn">ENTER DARKSIDE</a>

              <div class="footer">
                <div>✔ Manage Server/Admin required</div>
                <div>✔ Bot must be installed</div>
                <div>✔ No passwords stored</div>
              </div>
            `
        }

        <div class="grid">
          <div class="miniCard">
            <div class="miniTop"><span class="icon">📝</span> Registration</div>
            <div class="miniSub">Post a clean embed + button to generate private register links.</div>
          </div>
          <div class="miniCard">
            <div class="miniTop"><span class="icon">✅</span> Confirms</div>
            <div class="miniSub">Confirm/drop flow with locked status + auto updates.</div>
          </div>
          <div class="miniCard">
            <div class="miniTop"><span class="icon">🖼️</span> Slot GIFs</div>
            <div class="miniSub">Pick a template, render slot gifs, and post them all (spam mode optional).</div>
          </div>
          <div class="miniCard">
            <div class="miniTop"><span class="icon">📊</span> Results</div>
            <div class="miniSub">Enter G1–G4 points and keep everything in one dashboard.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="side">
        <div>
          <div class="badge"><span class="badgeDot"></span> QUICK NOTES</div>
          <div style="margin-top:14px;color:var(--muted);font-size:13px;line-height:1.7">
            <div>• Panel URL: <code>/panel</code></div>
            <div>• Servers: <code>/servers</code></div>
            <div>• Scrims: <code>/scrims</code></div>
            <div style="margin-top:10px">
              If you don’t see your server after login, make sure:
              <br/>1) you have Manage Server/Admin
              <br/>2) the bot is installed in that server
            </div>
          </div>
        </div>

        <div style="margin-top:16px;color:rgba(156,163,175,.9);font-size:11px">
          DarkSideORG • secured by Discord OAuth2
        </div>
      </div>
    </div>
  </div>

  <script>
    // prevent double click spam
    const btn = document.getElementById("loginBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        btn.style.pointerEvents = "none";
        btn.textContent = "REDIRECTING...";
      });
    }
  </script>
</body>
</html>`;
}

function renderLayout({ title, user, selectedGuild, active, body }) {
  const nav = user
    ? `
    <div class="nav">
      <a class="${active === "servers" ? "active" : ""}" href="/servers">Servers</a>
      <a class="${active === "scrims" ? "active" : ""}" href="/scrims">Scrims</a>
      <a class="${active === "new" ? "active" : ""}" href="/scrims/new">Create</a>
      <a class="${active === "logout" ? "active" : ""}" href="/logout">Logout</a>
    </div>`
    : "";

  return `<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#050509;
  --card:rgba(18,20,31,.95);
  --border:rgba(255,255,255,.08);
  --text:#f5f5f7;
  --muted:#9ca3af;
  --accent:#ffb300;
}
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  background:
    radial-gradient(circle at top,#20263a 0,transparent 55%),
    radial-gradient(circle at bottom,#111827 0,#020617 65%);
  color:var(--text);
  font-family:Inter,system-ui;
  padding:22px;
}
a{color:var(--accent);text-decoration:none}
.wrap{max-width:1100px;margin:0 auto}
.top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:14px}
.brand{font-family:Orbitron;letter-spacing:.14em;text-transform:uppercase}
.pill{background:rgba(15,23,42,.8);border:1px solid var(--border);border-radius:999px;padding:8px 10px;font-size:12px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px;box-shadow:0 25px 40px rgba(0,0,0,.7);overflow:hidden}

.nav{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 14px}
.nav a{padding:8px 12px;border-radius:999px;border:1px solid var(--border);background:rgba(15,23,42,.6);color:var(--text);font-size:13px}
.nav a.active{border-color:rgba(255,179,0,.6);box-shadow:0 0 0 1px rgba(255,179,0,.22)}

input,select,button{
  width:100%;
  padding:10px 11px;
  border-radius:12px;
  border:1px solid rgba(148,163,184,.35);
  background:rgba(15,23,42,.9);
  color:var(--text);
}
label{display:block;font-size:12px;color:var(--muted);margin:10px 0 6px;letter-spacing:.08em;text-transform:uppercase}
button{
  cursor:pointer;
  border:none;
  background:linear-gradient(135deg,#fde68a,#f97316,#ea580c);
  color:#0b0b10;
  font-family:Orbitron,system-ui;
  letter-spacing:.12em;
  text-transform:uppercase;
}

/* ✅ BUTTON SYSTEM (works for <a> AND <button>) */
.btn2{
  background:rgba(15,23,42,.85);
  border:1px solid var(--border);
  color:var(--text);
  font-family:Orbitron,system-ui;
  letter-spacing:.12em;
  text-transform:uppercase;

  /* ✅ restore padding + radius ALWAYS */
  padding:10px 12px;
  border-radius:14px;

  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  text-decoration:none;
  cursor:pointer;
  box-sizing:border-box;
  min-height:40px;
}
button.btn2{
  background:rgba(15,23,42,.85);
  border:1px solid var(--border);
  color:var(--text);
}
.btn2.primary{
  border-color: rgba(255,179,0,.55);
  box-shadow: 0 0 0 1px rgba(255,179,0,.18);
}
.btn2:hover{ transform: translateY(-1px); border-color: rgba(255,179,0,.55); }
.btn2:active{ transform: scale(.99); }

.scrimTitle{font-family:Orbitron,system-ui;letter-spacing:.08em;text-transform:uppercase}
.status{
  font-family:Orbitron,system-ui;
  letter-spacing:.10em;
  text-transform:uppercase;
  font-size:12px;
  padding:6px 10px;
  border-radius:999px;
  border:1px solid rgba(148,163,184,.25);
  background:rgba(2,6,23,.35);
  display:inline-block;
}
.status.ok{border-color:rgba(34,197,94,.45)}
.status.bad{border-color:rgba(239,68,68,.45)}

table{width:100%;border-collapse:collapse}
td,th{border-bottom:1px solid rgba(255,255,255,.06);padding:10px;font-size:13px;text-align:left}
th{color:var(--muted)}

.row{display:flex;gap:10px;flex-wrap:wrap}
.row>*{flex:1;min-width:160px}
.muted{color:var(--muted)}
.h{font-family:Orbitron;letter-spacing:.1em;text-transform:uppercase;margin:0 0 10px}
.warn{margin-top:12px;padding:10px;border-radius:12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.55);color:#fecaca;font-size:13px}

.table-wrap{width:100%; overflow:auto; -webkit-overflow-scrolling:touch}

/* ✅ ban controls */
.banBox{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.banBox > *{min-width:0}
.banInput{flex:1 1 220px}
.banSelect{flex:0 0 110px}
.banDays{flex:0 0 90px}
@media (max-width:780px){
  .banInput{flex:1 1 100%}
  .banSelect{flex:1 1 48%}
  .banDays{flex:1 1 48%}
}

/* =========================
   SCRIMS LIST — MOBILE CARDS
   IMPORTANT: we DO NOT hide all tables anymore
   We only hide tables that we mark with .hideOnMobile
   ========================= */
@media (max-width:780px){
  .hideOnMobile{ display:none !important; }
}

/* scrim list cards */
.scrimCards{display:none;}
@media (max-width:780px){
  .scrimCards{display:grid;gap:12px;}
  .scrimCard{background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.18);border-radius:18px;padding:14px;overflow:hidden}
  .scrimTop{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}
  .scrimName{font-family:Orbitron,system-ui;letter-spacing:.08em;text-transform:uppercase;font-size:14px;line-height:1.2;margin:0}
  .scrimMeta{margin-top:6px;color:var(--muted);font-size:12px;word-break:break-word}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .chip{font-family:Orbitron,system-ui;letter-spacing:.10em;text-transform:uppercase;font-size:11px;padding:6px 10px;border-radius:999px;border:1px solid rgba(148,163,184,.25);background:rgba(2,6,23,.35);display:inline-flex;align-items:center;gap:6px}
  .chip.ok{border-color:rgba(34,197,94,.45)}
  .chip.bad{border-color:rgba(239,68,68,.45)}
  .cardActionsRow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;width:100%}
  .cardActionsRow form{margin:0}
  .cardActionsRow *{min-width:0}
  .cardActionsRow a.btn2,.cardActionsRow button.btn2{width:100% !important}
  @media (max-width:420px){ .cardActionsRow{grid-template-columns:1fr} }
}

/* =========================
   MANAGE PAGE — MOBILE TEAM CARDS
   ========================= */
.teamCards{display:none;}
@media (max-width:780px){
  .teamCards{display:grid;gap:12px;margin-top:12px;}
  .teamCard{
    background:rgba(15,23,42,.72);
    border:1px solid rgba(148,163,184,.18);
    border-radius:18px;
    padding:14px;
    overflow:hidden;
  }
  .teamTop{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
  .teamSlot{font-family:Orbitron;letter-spacing:.10em;text-transform:uppercase;font-size:13px}
  .teamName{margin:6px 0 0;font-weight:700}
  .teamMeta{margin-top:4px;color:var(--muted);font-size:12px;word-break:break-word}
  .teamActions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
  .teamActions form{margin:0}
  @media (max-width:420px){ .teamActions{grid-template-columns:1fr} }
  .teamActions .btn2{width:100%}
}
/* ===== show/hide helpers ===== */
.hideOnMobile{ display: table; width:100%; }
.showOnMobile{ display: none; }

@media (max-width: 760px){
  .hideOnMobile{ display: none !important; }
  .showOnMobile{ display: flex !important; flex-direction: column; gap:12px; }
}

</style></head>
<body><div class="wrap">
<div class="top">
  <div class="brand">DarkSide Scrims Panel</div>
  <div class="pill">
    ${user ? `Logged: <b>${esc(user.username)}</b> • ` : ""}
    ${selectedGuild ? `Guild: <b>${esc(selectedGuild.name)}</b>` : ""}
  </div>
</div>
${nav}
<div class="card">${body}</div>
</div></body></html>`;
}


function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/");
  if (ADMIN_IDS.length && !ADMIN_IDS.includes(req.session.user.id)) return res.status(403).send("Forbidden");
  next();
}

async function discordApi(pathname, accessToken) {
  const r = await fetch("https://discord.com/api/v10" + pathname, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Discord API ${pathname} failed: ${r.status}`);
  return r.json();
}

function hasManagePermission(g) {
  const p = BigInt(g.permissions || "0");
  const ADMIN = BigInt(0x8);
  const MANAGE_GUILD = BigInt(0x20);
  return (p & ADMIN) === ADMIN || (p & MANAGE_GUILD) === MANAGE_GUILD || g.owner;
}

function botIsInGuild(guildId) {
  return discord.guilds.cache.has(String(guildId));
}

// ---------------------- OAUTH ---------------------- //
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: PANEL_CLIENT_ID,
    redirect_uri: PANEL_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds",
    prompt: "consent",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.redirect("/auth/discord");

    const data = new URLSearchParams({
      client_id: PANEL_CLIENT_ID,
      client_secret: PANEL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: PANEL_REDIRECT_URI,
    });

    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: data,
    });

    if (!tokenRes.ok) {
      console.error(await tokenRes.text());
      return res.status(400).send("OAuth token exchange failed.");
    }

    const tokens = await tokenRes.json();
    const user = await discordApi("/users/@me", tokens.access_token);

    req.session.user = user;
    req.session.access_token = tokens.access_token;
    req.session.selectedGuildId = null;
    req.session.selectedGuildName = null;

    return res.redirect("/servers");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth callback error.");
  }
});

// HOME
app.get("/", (req, res) => {
  res.send(
    renderLanding({
      title: "DarkSideORG — Login",
      user: req.session.user || null,
      error: req.query.err ? "Login failed. Please try again." : "",
    })
  );
});

app.get("/panel", requireLogin, (req, res) => {
  if (!req.session.selectedGuildId) return res.redirect("/servers");
  return res.redirect("/scrims");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ds_scrims_session");
    res.redirect("/");
  });
});
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ds_scrims_session");
    res.redirect("/");
  });
});

// SERVERS
app.get("/servers", requireLogin, async (req, res) => {
  try {
    const guilds = await discordApi("/users/@me/guilds", req.session.access_token);
    const manageable = guilds.filter(hasManagePermission);
    const filtered = manageable.filter((g) => botIsInGuild(g.id));

    const rows = filtered
      .map(
        (g) => `
      <tr>
        <td><b>${esc(g.name)}</b><div class="muted">${esc(g.id)}</div></td>
        <td style="width:220px">
          <form method="POST" action="/servers/select">
            <input type="hidden" name="guildId" value="${esc(g.id)}"/>
            <input type="hidden" name="guildName" value="${esc(g.name)}"/>
            <button type="submit">Manage</button>
          </form>
        </td>
      </tr>`
      )
      .join("");
  const cards = filtered.map((g) => `
  <div class="cardItem">
    <div class="cardTop">
      <div>
        <div class="cardName">${esc(g.name)}</div>
        <div class="cardId">${esc(g.id)}</div>
      </div>
    </div>
    <div class="cardActions">
      <form method="POST" action="/servers/select">
        <input type="hidden" name="guildId" value="${esc(g.id)}"/>
        <input type="hidden" name="guildName" value="${esc(g.name)}"/>
        <button type="submit">Manage</button>
      </form>
    </div>
  </div>
`).join("");

    const note =
      filtered.length === 0
        ? `<div class="warn">
             No servers found where (1) you have Manage Server/Admin AND (2) the bot is installed.<br/>
             Add the bot to your server first, then login again.
           </div>`
        : "";

    res.send(
      renderLayout({
        title: "Choose Server",
        user: req.session.user,
        selectedGuild: null,
        active: "servers",
       body: `
  <h2 class="h">Choose a server</h2>
  <p class="muted">Showing only servers you manage <b>AND</b> where the bot is installed.</p>
  ${note}

  <table class="hideOnMobile">
    <thead><tr><th>Server</th><th>Action</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="2">No servers to show.</td></tr>`}</tbody>
  </table>

  <div class="showOnMobile">
    ${cards || `<div class="warn">No servers to show.</div>`}
  </div>
`

,
      })
    );
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to load servers.");
  }
});

app.post("/servers/select", requireLogin, (req, res) => {
  const { guildId, guildName } = req.body;
  if (!guildId) return res.redirect("/servers");
  if (!botIsInGuild(guildId)) return res.status(400).send("Bot is not in this server.");
  req.session.selectedGuildId = String(guildId);
  req.session.selectedGuildName = String(guildName || "Selected");
  res.redirect("/scrims");
});

// SCRIMS LIST
app.get("/scrims", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrims = q.scrimsByGuild.all(guildId);

  const rows = scrims
    .map(
      (s) => `
    <tr>
      <td>
        <div class="scrimTitle">${esc(s.name)}</div>
        <div class="muted">Scrim ID: ${s.id}</div>
      </td>

      <td>
        <span class="status ${s.registration_open ? "ok" : "bad"}">
          ${s.registration_open ? "OPEN" : "CLOSED"}
        </span>
      </td>

      <td>
        <span class="status ${s.confirm_open ? "ok" : "bad"}">
          ${s.confirm_open ? "OPEN" : "CLOSED"}
        </span>
      </td>

      <td style="width:460px">
        <div class="row">
          <a class="btn2 primary" href="/scrims/${s.id}">Manage</a>
          <form method="POST" action="/scrims/${s.id}/clear" style="margin:0">
  <button class="btn2" type="submit" onclick="return confirm('Clear ALL slots + results and remove team roles?')">Clear</button>
</form>

          <form method="POST" action="/scrims/${s.id}/toggleReg" style="margin:0">
            <button class="btn2" type="submit">${s.registration_open ? "Close Reg" : "Open Reg"}</button>
          </form>

          <form method="POST" action="/scrims/${s.id}/toggleConfirm" style="margin:0">
            <button class="btn2" type="submit">${s.confirm_open ? "Close Confirms" : "Open Confirms"}</button>
          </form>
        </div>
      </td>
    </tr>`
    )
    .join("");

  res.send(
    renderLayout({
      title: "Scrims",
      user: req.session.user,
      selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
      active: "scrims",
      body: `
        <h2 class="h">Scrims</h2>

        <div class="table-wrap">
          <table class="hideOnMobile">
            <thead><tr><th>Scrim</th><th>Reg</th><th>Confirms</th><th>Actions</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="4">No scrims. Create one.</td></tr>`}</tbody>
          </table>
        </div>

        <div class="scrimCards">
          ${
            scrims
              .map(
                (s) => `
                  <div class="scrimCard">
                    <div class="scrimTop">
                      <div style="min-width:0">
                        <div class="scrimName">${esc(s.name)}</div>
                        <div class="scrimMeta">Scrim ID: ${s.id}</div>
                      </div>
                    </div>

                    <div class="chips">
                      <div class="chip ${s.registration_open ? "ok" : "bad"}">
                        ${s.registration_open ? "🟢" : "🔴"} REG: ${s.registration_open ? "OPEN" : "CLOSED"}
                      </div>
                      <div class="chip ${s.confirm_open ? "ok" : "bad"}">
                        ${s.confirm_open ? "🟢" : "🔴"} CONFIRMS: ${s.confirm_open ? "OPEN" : "CLOSED"}
                      </div>
                    </div>

                    <!-- Row 1: Manage + Results -->
                    <div class="cardActionsRow">
                      <a class="btn2 primary" href="/scrims/${s.id}">Manage</a>
                      <form method="POST" action="/scrims/${s.id}/clear" style="margin:0">
  <button class="btn2" type="submit" onclick="return confirm('Clear ALL slots + results and remove team roles?')">Clear</button>
</form>

                    </div>

                    <!-- Row 2: Toggles -->
                    <div class="cardActionsRow">
                      <form method="POST" action="/scrims/${s.id}/toggleReg">
                        <button class="btn2" type="submit">${s.registration_open ? "Close Reg" : "Open Reg"}</button>
                      </form>

                      <form method="POST" action="/scrims/${s.id}/toggleConfirm">
                        <button class="btn2" type="submit">${s.confirm_open ? "Close Confirms" : "Open Confirms"}</button>
                      </form>
                    </div>
                  </div>
                `
              )
              .join("")
          }
        </div>
      `,
    })
  );
});


// CREATE SCRIM
app.get("/scrims/new", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  res.send(
    renderLayout({
      title: "Create Scrim",
      user: req.session.user,
      selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
      active: "new",
      body: `
        <h2 class="h">Create Scrim</h2>
        <form method="POST" action="/scrims/new">
          <label>Scrim Name</label>
          <input name="name" placeholder="EU T3 SCRIMS" required />

          <div class="row">
            <div><label>Min Slot</label><input name="minSlot" type="number" value="2" required/></div>
            <div><label>Max Slot</label><input name="maxSlot" type="number" value="25" required/></div>
          </div>

          <label>Registration Channel ID</label>
          <input name="registrationChannelId" placeholder="channel id" />

          <label>Teams List Channel ID</label>
          <input name="listChannelId" placeholder="channel id" />

          <label>Confirm Channel ID</label>
          <input name="confirmChannelId" placeholder="channel id" />

          <label>Team Role ID (auto give)</label>
          <input name="teamRoleId" placeholder="role id" />

          <div class="row">
            <div><label>Reg Open Time (text)</label><input name="openAt" placeholder="18:00 CET"/></div>
            <div><label>Reg Close Time (text)</label><input name="closeAt" placeholder="18:15 CET"/></div>
          </div>

          <div class="row">
            <div><label>Confirms Open Time</label><input name="confirmOpenAt" placeholder="18:20 CET"/></div>
            <div><label>Confirms Close Time</label><input name="confirmCloseAt" placeholder="18:30 CET"/></div>
          </div>

          <button type="submit">Create</button>
        </form>
      `,
    })
  );
});

app.post("/scrims/:id/clear", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const teams = q.teamsByScrim.all(scrimId);

  // remove team role from all registered users
  if (scrim.team_role_id) {
    try {
      const guild = await discord.guilds.fetch(scrim.guild_id);
      for (const t of teams) {
        try {
          const mem = await guild.members.fetch(t.owner_user_id);
          await mem.roles.remove(scrim.team_role_id).catch(()=>{});
        } catch {}
      }
    } catch {}
  }

  // delete teams + all results tables (cascade handles extra, but results_points not linked to teams)
  db.prepare("DELETE FROM teams WHERE scrim_id=?").run(scrimId);
  db.prepare("DELETE FROM results WHERE scrim_id=?").run(scrimId);
  db.prepare("DELETE FROM results_points WHERE scrim_id=?").run(scrimId);

  // close toggles
  q.setRegOpen.run(0, scrimId, guildId);
  q.setConfirmOpen.run(0, scrimId, guildId);

  // refresh list/confirm/reg messages
  const fresh = q.scrimById.get(scrimId);
  await autoPostAll(fresh).catch(()=>{});

  res.redirect("/scrims");
});

app.post("/scrims/new", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const name = String(req.body.name || "").trim();
  const minSlot = Number(req.body.minSlot || 2);
  const maxSlot = Number(req.body.maxSlot || 25);

  const registrationChannelId = String(req.body.registrationChannelId || "").trim() || null;
  const listChannelId = String(req.body.listChannelId || "").trim() || null;
  const confirmChannelId = String(req.body.confirmChannelId || "").trim() || null;
  const teamRoleId = String(req.body.teamRoleId || "").trim() || null;

  const openAt = String(req.body.openAt || "").trim() || null;
  const closeAt = String(req.body.closeAt || "").trim() || null;
  const confirmOpenAt = String(req.body.confirmOpenAt || "").trim() || null;
  const confirmCloseAt = String(req.body.confirmCloseAt || "").trim() || null;

  q.createScrim.run(
    guildId,
    name,
    minSlot,
    maxSlot,
    registrationChannelId,
    listChannelId,
    confirmChannelId,
    teamRoleId,
    openAt,
    closeAt,
    confirmOpenAt,
    confirmCloseAt
  );

  // ✅ AUTO POST after create
  const newId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
  const fresh = q.scrimById.get(newId);
  autoPostAll(fresh).catch(() => {});

  res.redirect("/scrims");
});



// ✅ MANAGE SCRIM PAGE (THIS FIXES /scrims/:id)
// MANAGE SCRIM
app.get("/scrims/:id", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || String(scrim.guild_id) !== String(guildId)) {
    return res.status(404).send("Scrim not found");
  }

  const teams = q.teamsByScrim.all(scrimId);
  const totalSlots = scrim.max_slot - scrim.min_slot + 1;

  // TABLE ROWS (desktop)
  const rows = teams.map((t) => `
    <tr>
      <td><b>#${t.slot}</b></td>
      <td>
        <b>${esc(t.team_name)}</b>
        <div class="muted">[${esc(t.team_tag)}] • TeamID: ${t.id}</div>
      </td>
      <td><code>${esc(t.owner_user_id)}</code></td>
      <td>${t.confirmed ? "✅ Confirmed" : "⏳ Waiting"}</td>
      <td style="width:420px">
        <div class="row" style="gap:8px; align-items:flex-start">

          <form method="POST" action="/scrims/${scrimId}/team/${t.id}/accept" style="margin:0">
            <button class="btn2" type="submit" ${t.confirmed ? "disabled" : ""}>Accept</button>
          </form>

          <form method="POST" action="/scrims/${scrimId}/team/${t.id}/delete" style="margin:0"
                onsubmit="return confirm('Delete slot #${t.slot} (${t.team_tag})?')">
            <button class="btn2" type="submit">Delete</button>
          </form>

          <form method="POST" action="/scrims/${scrimId}/team/${t.id}/ban" style="margin:0"
                onsubmit="return confirm('Ban this user?')">
            <div class="banBox">
              <input class="banInput" name="reason" placeholder="Reason (optional)" value="Banned by staff" />
              <select class="banSelect" name="mode">
                <option value="perm">Perm</option>
                <option value="days" selected>Days</option>
              </select>
              <input class="banDays" name="days" type="number" min="1" max="365" value="7" />
              <button class="btn2" type="submit">Ban</button>
            </div>
          </form>

        </div>
      </td>
    </tr>
  `).join("");

  // MOBILE TEAM CARDS (slots visible on phone)
  const teamCards = teams.map((t) => `
    <div class="teamCard">
      <div class="teamTop">
        <div style="min-width:0">
          <div class="teamSlot">#${t.slot} • ${t.confirmed ? "✅ Confirmed" : "⏳ Waiting"}</div>
          <div class="teamName">${esc(t.team_name)} <span class="muted">[${esc(t.team_tag)}]</span></div>
          <div class="teamMeta">Owner: <code>${esc(t.owner_user_id)}</code> • TeamID: ${t.id}</div>
        </div>
      </div>

      <div class="teamActions">
        <form method="POST" action="/scrims/${scrimId}/team/${t.id}/accept">
          <button class="btn2 ${t.confirmed ? "" : "primary"}" type="submit" ${t.confirmed ? "disabled" : ""}>Accept</button>
        </form>

        <form method="POST" action="/scrims/${scrimId}/team/${t.id}/delete"
              onsubmit="return confirm('Delete slot #${t.slot} (${t.team_tag})?')">
          <button class="btn2" type="submit">Delete</button>
        </form>
      </div>

      <form method="POST" action="/scrims/${scrimId}/team/${t.id}/ban" style="margin-top:10px"
            onsubmit="return confirm('Ban this user?')">
        <div class="banBox">
          <input class="banInput" name="reason" placeholder="Reason (optional)" value="Banned by staff" />
          <select class="banSelect" name="mode">
            <option value="perm">Perm</option>
            <option value="days" selected>Days</option>
          </select>
          <input class="banDays" name="days" type="number" min="1" max="365" value="7" />
          <button class="btn2" type="submit">Ban</button>
        </div>
      </form>
    </div>
  `).join("");

  const bans = q.bansByGuild ? q.bansByGuild.all(guildId) : [];
  const banRows = bans.map((b) => `
    <tr>
      <td><code>${esc(b.user_id)}</code></td>
      <td class="muted">${esc(b.reason || "—")}</td>
      <td class="muted">${esc(b.expires_at || "PERMA")}</td>
      <td style="width:160px">
        <form method="POST" action="/scrims/${scrimId}/unban" style="margin:0">
          <input type="hidden" name="userId" value="${esc(b.user_id)}"/>
          <button class="btn2" type="submit">Unban</button>
        </form>
      </td>
    </tr>
  `).join("");

  res.send(renderLayout({
    title: `Manage • ${scrim.name}`,
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
      <h2 class="h">${esc(scrim.name)} — Manage Slots</h2>
      <p class="muted">
        Teams: <b>${teams.length}/${totalSlots}</b> •
        Reg: <b>${scrim.registration_open ? "OPEN" : "CLOSED"}</b> •
        Confirms: <b>${scrim.confirm_open ? "OPEN" : "CLOSED"}</b>
      </p>

      <div class="row" style="margin:12px 0">
  <a class="btn2 primary" href="/scrims/${scrimId}/results">Results</a>
  <a class="btn2" href="/scrims/${scrimId}">Table</a>
  <a class="btn2" href="/scrims/${scrimId}/settings">Settings</a>
  <a class="btn2" href="/scrims">Back</a>
</div>

      <div class="teamCards">
        ${teamCards || `<div class="warn">No teams registered yet.</div>`}
      </div>

      <div class="table-wrap">
        <table class="hideOnMobile">
          <thead><tr><th>Slot</th><th>Team</th><th>Owner</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5">No teams registered yet.</td></tr>`}</tbody>
        </table>
      </div>

      <hr style="margin:18px 0;opacity:.2"/>

      <h3 class="h" style="font-size:14px">Bans</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Reason</th><th>Expires</th><th>Action</th></tr></thead>
          <tbody>${banRows || `<tr><td colspan="4">No bans.</td></tr>`}</tbody>
        </table>
      </div>
    `
  }));
});

app.get("/scrims/:id/messages", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const ok = req.query.ok ? `<div class="warn" style="background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.55);color:#bbf7d0">✅ Posted: ${esc(req.query.ok)}</div>` : "";
  const err = req.query.err ? `<div class="warn">❌ ${esc(req.query.err)}</div>` : "";

  res.send(renderLayout({
    title: "Messages",
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
      <h2 class="h">Messages — ${esc(scrim.name)}</h2>
      <p class="muted">Post the Discord embeds into the channels you set in Settings.</p>
      ${ok}${err}

      <div class="smallrow">
        <form method="POST" action="/scrims/${scrimId}/postRegMessage" style="margin:0">
          <button type="submit">📨 Post Registration Embed</button>
        </form>

        <form method="POST" action="/scrims/${scrimId}/postList" style="margin:0">
          <button type="submit" class="btn2">📋 Create/Update List Message</button>
        </form>

        <form method="POST" action="/scrims/${scrimId}/postConfirmMessage" style="margin:0">
          <button type="submit" class="btn2">✅ Create/Update Confirm Message</button>
        </form>
      </div>
    `
  }));
});


// Save slot settings
app.post("/scrims/:id/slotSettings", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const slotTemplate = String(req.body.slot_template || "").trim() || null;
  const slotsChannelId = String(req.body.slots_channel_id || "").trim() || null;
  const slotsSpam = Number(req.body.slots_spam || 0) ? 1 : 0;

  q.updateSlotsSettings.run(slotTemplate, slotsChannelId, slotsSpam, scrimId, guildId);
  // Save scoring settings (OCR)
  const defScoring = defaultScoring();
  const scoringCfg = {
    killPoints: clampInt(req.body.killPoints ?? req.body.kill_points, 0, 50, defScoring.killPoints),
    p1: clampInt(req.body.p1, 0, 200, defScoring.p1),
    p2: clampInt(req.body.p2, 0, 200, defScoring.p2),
    p3: clampInt(req.body.p3, 0, 200, defScoring.p3),
    p4: clampInt(req.body.p4, 0, 200, defScoring.p4),
    p5: clampInt(req.body.p5, 0, 200, defScoring.p5),
    p6: clampInt(req.body.p6, 0, 200, defScoring.p6),
    p7: clampInt(req.body.p7, 0, 200, defScoring.p7),
    p8: clampInt(req.body.p8, 0, 200, defScoring.p8),
    p9plus: clampInt(req.body.p9plus, 0, 200, defScoring.p9plus),
  };
  q.setScoringJson.run(JSON.stringify(scoringCfg), scrimId, guildId);

  res.redirect(`/scrims/${scrimId}/slots`);
});


// ---------------------- PANEL ACTION ROUTES ---------------------- //
app.post("/scrims/:id/edit", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const name = String(req.body.name || "").trim();
  const minSlot = Number(req.body.minSlot || 2);
  const maxSlot = Number(req.body.maxSlot || 25);

  const registrationChannelId = String(req.body.registrationChannelId || "").trim() || null;
  const listChannelId = String(req.body.listChannelId || "").trim() || null;
  const confirmChannelId = String(req.body.confirmChannelId || "").trim() || null;
  const teamRoleId = String(req.body.teamRoleId || "").trim() || null;

  const openAt = String(req.body.openAt || "").trim() || null;
  const closeAt = String(req.body.closeAt || "").trim() || null;
  const confirmOpenAt = String(req.body.confirmOpenAt || "").trim() || null;
  const confirmCloseAt = String(req.body.confirmCloseAt || "").trim() || null;

  q.updateScrim.run(
    name,
    minSlot,
    maxSlot,
    registrationChannelId,
    listChannelId,
    confirmChannelId,
    teamRoleId,
    openAt,
    closeAt,
    confirmOpenAt,
    confirmCloseAt,
    scrimId,
    guildId
  );

  res.redirect(`/scrims/${scrimId}`);
});

app.post("/scrims/:id/toggleReg", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const next = scrim.registration_open ? 0 : 1;
  q.setRegOpen.run(next, scrimId, guildId);

  const fresh = q.scrimById.get(scrimId);
  await autoPostAll(fresh).catch(() => {});

  res.redirect("/scrims");
});


app.post("/scrims/:id/toggleConfirm", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const next = scrim.confirm_open ? 0 : 1;
  q.setConfirmOpen.run(next, scrimId, guildId);

  const fresh = q.scrimById.get(scrimId);
  await autoPostAll(fresh).catch(() => {});

  res.redirect("/scrims");
});


app.post("/scrims/:id/postRegMessage", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");
  if (!scrim.registration_channel_id) return res.redirect(`/scrims/${scrimId}/messages?err=noregchan`);

  try {
    const guild = await discord.guilds.fetch(scrim.guild_id);
    const chan = await guild.channels.fetch(scrim.registration_channel_id).catch(() => null);
    const teams = q.teamsByScrim.all(scrim.id);

    const embed = buildRegEmbed(scrim, guild, teams.length);
    const components = buildRegComponents(scrim);

    const result = await safeSend(chan, { embeds: [embed], components });
    if (!result.ok) return res.redirect(`/scrims/${scrimId}/messages?err=${encodeURIComponent(result.error)}`);
  } catch (e) {
    console.error("postRegMessage error:", e);
    return res.redirect(`/scrims/${scrimId}/messages?err=exception`);
  }

  res.redirect(`/scrims/${scrimId}/messages?ok=reg`);
});

app.post("/scrims/:id/postList", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  await ensureListMessage(scrim).catch((e) => console.error("ensureListMessage:", e));
  res.redirect(`/scrims/${scrimId}/messages?ok=list`);
});

app.post("/scrims/:id/postConfirmMessage", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  await ensureConfirmMessage(scrim).catch((e) => console.error("ensureConfirmMessage:", e));
  res.redirect(`/scrims/${scrimId}/messages?ok=confirm`);
});
app.get("/scrims/:id/slots", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const templates = listTemplates();
  const options = templates.map(t => `<option value="${esc(t)}" ${scrim.slot_template===t?"selected":""}>${esc(t)}</option>`).join("");

  res.send(renderLayout({
    title: "Slots",
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
  <h2 class="h">Slots — ${esc(scrim.name)}</h2>
  <p class="muted">Choose a GIF template and where to post the slot GIFs.</p>

  <form method="POST" action="/scrims/${scrimId}/slotSettings">
    <label>Slots Channel ID</label>
    <input name="slots_channel_id" value="${esc(scrim.slots_channel_id || "")}" placeholder="channel id" />

    <label>Template</label>
    <select name="slot_template"
      style="width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)">
      <option value="">-- choose --</option>
      ${options}
    </select>

    <label>Spam Mode</label>
    <select name="slots_spam"
      style="width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)">
      <option value="0" ${scrim.slots_spam ? "" : "selected"}>OFF (one message)</option>
      <option value="1" ${scrim.slots_spam ? "selected" : ""}>ON (post every slot)</option>
    </select>

    <button class="btn2 primary" type="submit" style="margin-top:12px">Save Slot Settings</button>
  </form>

  <hr style="margin:18px 0;opacity:.2"/>

  <form method="POST" action="/scrims/${scrimId}/postSlots" style="margin:0">
    <button class="btn2" type="submit">🎞️ Post Slots Now</button>
  </form>
`

  }));
});


app.post("/scrims/:id/postSlots", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  if (!scrim.slot_template) return res.status(400).send("Select a slot template first.");
  if (!scrim.slots_channel_id) return res.status(400).send("Set slots_channel_id first.");

  try {
    const guild = await discord.guilds.fetch(scrim.guild_id);
    const chan = await guild.channels.fetch(scrim.slots_channel_id).catch(() => null);
if (!chan || !chan.isTextBased()) return res.status(400).send("Slots channel invalid.");

    const teams = q.teamsByScrim.all(scrimId);
    const bySlot = new Map(teams.map((t) => [t.slot, t]));

    const sends = [];
    for (let slot = scrim.min_slot; slot <= scrim.max_slot; slot++) {
      const t = bySlot.get(slot);
      const name = t ? t.team_name : "EMPTY";
      const tag = t ? t.team_tag : "";
      const filePath = await renderSlotGif({
        templateKey: scrim.slot_template,
        scrimId,
        slot,
        teamName: name,
        teamTag: tag,
      });

      if (scrim.slots_spam) {
        sends.push(chan.send({ files: [filePath] }));
      } else {
        // not spam: post one per request (first only)
        await chan.send({ files: [filePath] });
        break;
      }
    }

    if (scrim.slots_spam) await Promise.allSettled(sends);
  } catch (e) {
    console.error("postSlots error:", e);
  }

  res.redirect(`/scrims/${scrimId}`);
});
app.post("/scrims/:id/team/:teamId/accept", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const teamId = Number(req.params.teamId);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const team = db.prepare("SELECT * FROM teams WHERE id=? AND scrim_id=?").get(teamId, scrimId);
  if (!team) return res.status(404).send("Team not found");

  // mark confirmed
  db.prepare("UPDATE teams SET confirmed=1 WHERE id=? AND scrim_id=?").run(teamId, scrimId);

  // give role
  if (scrim.team_role_id) {
    try {
      const guild = await discord.guilds.fetch(scrim.guild_id);
      const mem = await guild.members.fetch(team.owner_user_id);
      await mem.roles.add(scrim.team_role_id);
    } catch {}
  }

  await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
  await updateConfirmEmbed(q.scrimById.get(scrimId)).catch(() => {});
  res.redirect(`/scrims/${scrimId}`);
});

app.post("/scrims/:id/team/:teamId/delete", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const teamId = Number(req.params.teamId);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const team = db.prepare("SELECT * FROM teams WHERE id=? AND scrim_id=?").get(teamId, scrimId);
  if (!team) return res.redirect(`/scrims/${scrimId}`);

  db.prepare("DELETE FROM teams WHERE id=? AND scrim_id=?").run(teamId, scrimId);

  // remove role
  if (scrim.team_role_id) {
    try {
      const guild = await discord.guilds.fetch(scrim.guild_id);
      const mem = await guild.members.fetch(team.owner_user_id);
      await mem.roles.remove(scrim.team_role_id);
    } catch {}
  }

  await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
  await updateConfirmEmbed(q.scrimById.get(scrimId)).catch(() => {});
  res.redirect(`/scrims/${scrimId}`);
});

function parseDurationToMs(s) {
  s = String(s || "").trim().toLowerCase();
  if (!s || s === "0" || s === "perm" || s === "perma") return 0;
  const m = s.match(/^(\d+)\s*(h|d)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600000 : n * 86400000;
}

app.post("/scrims/:id/team/:teamId/ban", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const teamId = Number(req.params.teamId);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const team = db.prepare("SELECT * FROM teams WHERE id = ? AND scrim_id = ?").get(teamId, scrimId);
  if (!team) return res.status(404).send("Team not found");

  const reason = String(req.body.reason || "Banned by staff").trim();
  const mode = String(req.body.mode || "perm").trim();

  let expiresAt = null;
  if (mode === "days") {
    const days = Math.max(1, Math.min(365, Number(req.body.days || 0)));
    const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    expiresAt = d.toISOString();
  }

  // save ban
q.banUpsert.run(scrim.guild_id, team.owner_user_id, reason, expiresAt);


  // give ban role (optional)
  const guild = await discord.guilds.fetch(scrim.guild_id).catch(() => null);
  if (guild && scrim.ban_role_id) {
    try {
      const mem = await guild.members.fetch(team.owner_user_id);
      await mem.roles.add(scrim.ban_role_id);
    } catch {}
  }

// ban log channel (optional)
if (guild && scrim.ban_channel_id) {
  try {
    const ch = await guild.channels.fetch(scrim.ban_channel_id).catch(() => null);

    // ✅ allow ANY text-based channel (text, news, thread, etc.)
    if (ch && typeof ch.isTextBased === "function" && ch.isTextBased()) {
      const logoPath = team.logo_filename ? path.join(uploadDir, team.logo_filename) : null;
      const hasLogo = logoPath && fs.existsSync(logoPath);

      const embed = new EmbedBuilder()
        .setTitle("⛔ Team Banned")
        .setColor(0xef4444)
        .addFields(
          { name: "Team", value: `**${team.team_name}** [**${team.team_tag}**]`, inline: false },
          { name: "User ID", value: `\`${team.owner_user_id}\``, inline: true },
          { name: "Reason", value: reason || "—", inline: true },
          { name: "Duration", value: expiresAt ? banTimeLeft(expiresAt) : "Permanent", inline: true }
        )
        .setFooter({ text: `DarkSide Scrims • Scrim ${scrim.id} • Slot #${team.slot}` })
        .setTimestamp(new Date());

      const payload = { embeds: [embed] };

      if (hasLogo) {
        payload.files = [{ attachment: logoPath, name: "teamlogo.png" }];
        embed.setThumbnail("attachment://teamlogo.png");
      }

      await ch.send(payload);
    }
  } catch (e) {
    console.error("ban log send error:", e);
  }
}


  // remove their slot after ban (recommended)
  q.removeTeamByUser.run(scrimId, team.owner_user_id);

  await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
  await updateConfirmEmbed(q.scrimById.get(scrimId)).catch(() => {});

  return res.redirect(`/scrims/${scrimId}`);
});


app.post("/scrims/:id/unban", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const userId = String(req.body.userId || "").trim();

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  if (userId) {
    q.unban.run(guildId, userId);

    // remove ban role too
    if (scrim.ban_role_id) {
      try {
        const guild = await discord.guilds.fetch(scrim.guild_id);
        const mem = await guild.members.fetch(userId);
        await mem.roles.remove(scrim.ban_role_id);
      } catch {}
    }
  }

  res.redirect(`/scrims/${scrimId}`);
});

// RESULTS
app.get("/scrims/:id/results", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  // teams list (registered)
  const teams = q.teamsByScrim.all(scrimId);

  // manual points table (old UI)
  const pointsRows = q.pointsByScrim.all(scrimId);
  const games = q.gamesByScrim.all(scrimId);

  
// ✅ OCR results (auto)
const ocrRows = db.prepare(`
  SELECT scrim_id, game, team_tag, place, kills, points
  FROM scrim_results
  WHERE scrim_id=?
  ORDER BY game ASC, points DESC, kills DESC, place ASC, team_tag ASC
`).all(scrimId);

// ✅ Manual overrides (editable)
const manualRows = q.manualAllByScrim.all(scrimId);

// Merge: manual overrides OCR per (game, team_tag)
const key = (r) => `${r.game}::${(r.team_tag||"").trim().toUpperCase()}`;
const manualMap = new Map();
for (const r of manualRows) manualMap.set(key(r), r);

const mergedRows = [];
const seen = new Set();

for (const r of ocrRows) {
  const k = key(r);
  if (manualMap.has(k)) {
    mergedRows.push(manualMap.get(k));
  } else {
    mergedRows.push(r);
  }
  seen.add(k);
}
for (const r of manualRows) {
  const k = key(r);
  if (seen.has(k)) continue;
  mergedRows.push(r);
  seen.add(k);
}

const ocrByGame = new Map();
for (const r of ocrRows) {
  if (!ocrByGame.has(r.game)) ocrByGame.set(r.game, []);
  ocrByGame.get(r.game).push(r);
}

const manualByGame = new Map();
for (const r of manualRows) {
  if (!manualByGame.has(r.game)) manualByGame.set(r.game, []);
  manualByGame.get(r.game).push(r);
}

const mergedByGame = new Map();
for (const r of mergedRows) {
  if (!mergedByGame.has(r.game)) mergedByGame.set(r.game, []);
  mergedByGame.get(r.game).push(r);
}

const scoring = getScrimScoring(scrim);

// Aggregate totals by team_tag (merged = OCR + manual overrides)
  // Aggregate OCR totals by team_tag
  
const agg = new Map();
const gamesByTag = new Map(); // tag -> Set(game)
for (const r of mergedRows) {
  const tag = (r.team_tag || "").trim();
  if (!tag) continue;

  const place = Number(r.place || 0);
  const kills = Number(r.kills || 0);

  const placePts = placementPoints(place, scoring);
  const killPts = kills * Number(scoring.killPoints || 0);
  const totalPts = placePts + killPts;

  if (!agg.has(tag)) agg.set(tag, { team_tag: tag, games: 0, kills: 0, placement_points: 0, kill_points: 0, points: 0 });
  const a = agg.get(tag);

  if (!gamesByTag.has(tag)) gamesByTag.set(tag, new Set());
  gamesByTag.get(tag).add(Number(r.game || 0));

  a.kills += kills;
  a.placement_points += placePts;
  a.kill_points += killPts;
  a.points += totalPts;
}
for (const [tag, set] of gamesByTag.entries()) {
  if (agg.has(tag)) agg.get(tag).games = set.size;
}

// Try to match team_tag -> registered team slot/name

  // Try to match OCR team_tag -> registered team slot/name
  const tagToTeam = new Map();
  for (const t of teams) {
    const tag = (t.team_tag || "").trim();
    if (tag && !tagToTeam.has(tag)) tagToTeam.set(tag, t);
  }

  // Build leaderboard rows including teams with 0 OCR points (so you see "every team")
  const leaderboard = teams.map(t => {
    const tag = (t.team_tag || "").trim();
    const a = agg.get(tag) || { games: 0, kills: 0, placement_points: 0, kill_points: 0, points: 0, team_tag: tag };
    return {
      slot: t.slot,
      team_tag: tag,
      team_name: t.team_name,
      games: a.games,
      placement_points: a.placement_points || 0,
      kills: a.kills,
      kill_points: a.kill_points || 0,
      points: a.points,
    };
  });

  // Add OCR tags that are NOT registered (still show them)
  for (const [tag, a] of agg.entries()) {
    if (!tagToTeam.has(tag)) {
      leaderboard.push({
        slot: "",
        team_tag: tag,
        team_name: "(not registered)",
        games: a.games,
        placement_points: a.placement_points || 0,
        kills: a.kills,
        kill_points: a.kill_points || 0,
        points: a.points,
      });
    }
  }

  leaderboard.sort((x, y) => (y.points - x.points) || (y.kills - x.kills) || ((x.slot || 9999) - (y.slot || 9999)));

  // Manual points view model (existing)
  const gameCount = Math.max(4, games.length || 0);
  const gameIdxs = Array.from({ length: gameCount }, (_, i) => i + 1);

  const bySlot = new Map(); // slot -> {slot, games: Map(game_idx -> points)}
  for (const r of pointsRows) {
    if (!bySlot.has(r.slot)) bySlot.set(r.slot, { slot: r.slot, games: new Map() });
    bySlot.get(r.slot).games.set(r.game_idx, r.points);
  }

  const pointsTable = teams.map(t => {
    const row = bySlot.get(t.slot) || { slot: t.slot, games: new Map() };
    const perGame = gameIdxs.map(g => Number(row.games.get(g) || 0));
    const total = perGame.reduce((a, b) => a + b, 0);
    return { slot: t.slot, team_name: t.team_name, team_tag: t.team_tag, perGame, total };
  });

  res.send(renderLayout({
    title: `Results • ${scrim.name}`,
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
      <h2 class="h">${esc(scrim.name)} — Results</h2>

      <div class="card" style="margin-top:12px">
        <h3 class="h" style="margin:0 0 8px 0">✅ OCR Leaderboard (auto)</h3>
        <p class="muted" style="margin-top:0">
          This section shows what your <code>!match</code> OCR saved in <code>scrim_results</code>.
          It includes all registered teams (even if they have 0 points so far).
        </p>

        <div class="tablewrap">
          <table class="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Slot</th>
                <th>Tag</th>
                <th>Team</th>
                <th>Games</th>
                <th>Placement</th>
                <th>Kills</th>
                <th>Kill Pts</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${leaderboard.map((r, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>${esc(String(r.slot ?? ""))}</td>
                  <td><b>${esc(r.team_tag || "")}</b></td>
                  <td>${esc(r.team_name || "")}</td>
                  <td>${esc(String(r.games || 0))}</td>
                  <td>${esc(String(r.placement_points || 0))}</td>
                  <td>${esc(String(r.kills || 0))}</td>
                  <td>${esc(String(r.kill_points || 0))}</td>
                  <td><b>${esc(String(r.points || 0))}</b></td>
                </tr>
              `).join("")}
            </tbody>
          
        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center">
          <form method="POST" action="/scrims/${scrimId}/results/addGame" style="margin:0">
            <button class="btn" type="submit">Add Game</button>
          </form>
          <div class="muted" style="font-size:13px">Tip: Use “Add Game” then open the Game editor to set placements + kills if OCR is wrong.</div>
        </div>

        <div style="margin-top:10px">
          ${games.map(g => `
            <a class="btn" style="margin:4px 6px 4px 0" href="/scrims/${scrimId}/results/game/${g.idx}">Edit Game ${g.idx}</a>
          `).join("")}
        </div>

</table>
        </div>

        <hr style="margin:16px 0; opacity:.2" />

        <h4 class="h" style="margin:0 0 8px 0">Per-game OCR tables</h4>
        ${Array.from(ocrByGame.entries()).sort((a,b)=>a[0]-b[0]).map(([g, rows]) => `
          <details style="margin:10px 0">
            <summary style="cursor:pointer"><b>Game ${g}</b> — ${rows.length} rows</summary>
            <div class="tablewrap" style="margin-top:10px">
              <table class="table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Tag</th>
                    <th>Team</th>
                    <th>Place</th>
                    <th>Kills</th>
                    <th>Points</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(r => {
                    const t = tagToTeam.get((r.team_tag || "").trim());
                    return `
                      <tr>
                        <td>${esc(String(t?.slot ?? ""))}</td>
                        <td><b>${esc(r.team_tag || "")}</b></td>
                        <td>${esc(t?.team_name || "(not registered)")}</td>
                        <td>${esc(String(r.place ?? ""))}</td>
                        <td>${esc(String(r.kills ?? 0))}</td>
                        <td><b>${esc(String(r.points ?? 0))}</b></td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>
          </details>
        `).join("") || `<p class="muted">No OCR results saved yet.</p>`}
      </div>

      <div class="card" style="margin-top:12px">
        <h3 class="h" style="margin:0 0 8px 0">🧾 Manual Points Table (old)</h3>
        <p class="muted" style="margin-top:0">This is your old points UI (results_points). Keep it if you still use it.</p>

        <form method="POST" action="/scrims/${scrimId}/results">
          <div class="tablewrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Team</th>
                  ${gameIdxs.map(i => `<th>${esc(games.find(x=>x.idx===i)?.name || ("Game " + i))}</th>`).join("")}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                ${pointsTable.map(r => `
                  <tr>
                    <td>${esc(String(r.slot))}</td>
                    <td>${esc(r.team_name)} <span class="muted">(${esc(r.team_tag || "")})</span></td>
                    ${r.perGame.map((p, gi) => `
                      <td>
                        <input type="number" name="p_${r.slot}_${gi + 1}" value="${esc(String(p))}" style="width:80px">
                      </td>
                    `).join("")}
                    <td><b>${esc(String(r.total))}</b></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>

          <div style="margin-top:12px">
            <button class="btn" type="submit">Save Manual Points</button>
          </div>
        </form>
      </div>
    `
  }));
});

app.post("/scrims/:id/results/addGame", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  ensureGame1(scrimId);
  const next = getMaxGameIdx(scrimId) + 1;

  try {
    q.addGame.run(scrimId, next, `Game ${next}`);
  } catch {}

  res.redirect(`/scrims/${scrimId}/results/game/${next}`);
});



// Manual per-game editor (override OCR)
// ----------------------------------------------------
app.get("/scrims/:id/results/game/:gameIdx", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const gameIdx = Number(req.params.gameIdx);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  ensureGame1(scrimId);

  // ensure this game exists in scrim_games
  const gRow = q.gameByIdx?.get?.(scrimId, gameIdx) || db.prepare(`SELECT * FROM scrim_games WHERE scrim_id=? AND idx=?`).get(scrimId, gameIdx);
  if (!gRow) {
    try { q.addGame.run(scrimId, gameIdx, `Game ${gameIdx}`); } catch {}
  }

  const teams = q.teamsByScrim.all(scrimId);
  const scoring = getScrimScoring(scrim);

  // load current manual rows (if any), else blank
  const existing = q.manualResultsByGame.all(scrimId, gameIdx);
  const byPlace = new Map();
  for (const r of existing) byPlace.set(Number(r.place), r);

  // build 1..20 rows (you can scroll + edit)
  const rows = Array.from({ length: 20 }, (_, i) => {
    const place = i + 1;
    const r = byPlace.get(place);
    return { place, team_tag: r?.team_tag || "", kills: Number(r?.kills || 0) };
  });

  const teamOptions = [`<option value="">-- none --</option>`].concat(
    teams.map(t => `<option value="${esc(t.team_tag)}">${esc(t.team_tag)} — ${esc(t.team_name || "")} (slot ${esc(String(t.slot))})</option>`)
  ).join("");

  res.send(renderLayout({
    title: `Edit Game ${gameIdx} • ${scrim.name}`,
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
      <div class="card">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap">
          <div>
            <h2 class="h" style="margin:0">Game ${gameIdx} — Manual Editor</h2>
            <p class="muted" style="margin:6px 0 0 0">Pick the team for each placement and enter kills. This will override OCR for this game.</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center">
            <a class="btn" href="/scrims/${scrimId}/results">Back to Results</a>
          </div>
        </div>

        <div style="margin-top:12px; padding:10px; border:1px solid rgba(255,255,255,.08); border-radius:10px">
          <div class="muted" style="font-size:13px">
            Scoring: kills=${esc(String(scoring.killPoints))} pt each • places: 1=${esc(String(scoring.p1))}, 2=${esc(String(scoring.p2))}, 3=${esc(String(scoring.p3))}, 4=${esc(String(scoring.p4))}, 5=${esc(String(scoring.p5))}, 6=${esc(String(scoring.p6))}, 7=${esc(String(scoring.p7))}, 8=${esc(String(scoring.p8))}, 9+=${esc(String(scoring.p9plus))}
          </div>
        </div>

        <form method="POST" action="/scrims/${scrimId}/results/game/${gameIdx}/save">
          <div class="tablewrap" style="margin-top:12px">
            <table class="table">
              <thead>
                <tr>
                  <th style="width:70px">Place</th>
                  <th>Team</th>
                  <th style="width:110px">Kills</th>
                  <th style="width:140px">Computed pts</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => {
                  const pts = placementPoints(r.place, scoring) + (Number(r.kills||0) * Number(scoring.killPoints||0));
                  return `
                    <tr>
                      <td><b>${esc(String(r.place))}</b></td>
                      <td>
                        <select name="team_${r.place}">
                          ${[`<option value="">-- none --</option>`].concat(teams.map(t => `<option value="${esc(t.team_tag)}" ${(String(t.team_tag||"").trim()===String(r.team_tag||"").trim()) ? "selected" : ""}>${esc(t.team_tag)} — ${esc(t.team_name || "")} (slot ${esc(String(t.slot))})</option>`)).join("")}
                        </select>
                      </td>
                      <td><input type="number" min="0" max="200" name="kills_${r.place}" value="${esc(String(r.kills||0))}" /></td>
                      <td>${esc(String(pts))}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>

          <div style="display:flex; gap:10px; margin-top:12px; flex-wrap:wrap">
            <button class="btn" type="submit">Save Game</button>
          </div>
        </form>

        <form method="POST" action="/scrims/${scrimId}/results/game/${gameIdx}/delete" onsubmit="return confirm('Delete Game ${gameIdx}? This will remove screenshots + OCR + manual rows for this game.')">
          <div style="margin-top:14px">
            <button class="btn danger" type="submit">Delete this Game</button>
          </div>
        </form>
      </div>
    `
  }));
});

app.post("/scrims/:id/results/game/:gameIdx/save", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const gameIdx = Number(req.params.gameIdx);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const teams = q.teamsByScrim.all(scrimId);
  const validTags = new Set(teams.map(t => String(t.team_tag || "").trim()).filter(Boolean));

  const scoring = getScrimScoring(scrim);

  // Clear old manual rows for this game
  try { q.clearManualGame.run(scrimId, gameIdx); } catch {}

  // Save new rows
  for (let place = 1; place <= 20; place++) {
    const tag = String(req.body[`team_${place}`] || "").trim();
    if (!tag) continue;
    if (!validTags.has(tag)) continue;

    const kills = Math.max(0, Math.trunc(Number(req.body[`kills_${place}`] || 0) || 0));
    const pts = placementPoints(place, scoring) + (kills * Number(scoring.killPoints || 0));

    q.saveManualResult.run(scrimId, gameIdx, tag, place, kills, pts);
  }

  res.redirect(`/scrims/${scrimId}/results`);
});

app.post("/scrims/:id/results/game/:gameIdx/delete", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const gameIdx = Number(req.params.gameIdx);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  // Delete manual + OCR + screenshots + points for this game
  try { q.clearManualGame.run(scrimId, gameIdx); } catch {}
  try { db.prepare(`DELETE FROM scrim_results WHERE scrim_id=? AND game=?`).run(scrimId, gameIdx); } catch {}
  try { db.prepare(`DELETE FROM result_screenshots WHERE scrim_id=? AND game_idx=?`).run(scrimId, gameIdx); } catch {}
  try { db.prepare(`DELETE FROM results_points WHERE scrim_id=? AND game_idx=?`).run(scrimId, gameIdx); } catch {}
  try { db.prepare(`DELETE FROM scrim_games WHERE scrim_id=? AND idx=?`).run(scrimId, gameIdx); } catch {}

  res.redirect(`/scrims/${scrimId}/results`);
});

app.post("/scrims/:id/results", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  ensureGame1(scrimId);
  const games = q.gamesByScrim.all(scrimId);
  const teams = q.teamsByScrim.all(scrimId);

  for (const t of teams) {
    for (const g of games) {
      const key = `p_${t.slot}_${g.idx}`;
      const val = Number(req.body[key] || 0);
      q.upsertPoint.run(scrimId, t.slot, g.idx, val);
    }
  }

  res.redirect(`/scrims/${scrimId}/results`);
});
app.post("/scrims/:id/results/:gameIdx/upload", requireLogin, resultsUpload.array("shots", 20), (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const gameIdx = Number(req.params.gameIdx);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const files = req.files || [];
  for (const f of files) {
    q.addScreenshot.run(scrimId, gameIdx, f.filename, req.session.user?.id || null);
  }

  res.redirect(`/scrims/${scrimId}/results`);
});


// ---------------------- PUBLIC REGISTRATION ---------------------- //
function renderRegisterPage(title, inner) {
  return `<!doctype html><html><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <style>
    :root{--card:rgba(18,20,31,.95);--border:rgba(255,255,255,.08);--text:#f5f5f7;--muted:#9ca3af;}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px;background:
      radial-gradient(circle at top,#20263a 0,transparent 55%),
      radial-gradient(circle at bottom,#111827 0,#020617 65%);color:var(--text);font-family:Inter,system-ui}
    .card{width:100%;max-width:560px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:20px;box-shadow:0 25px 40px rgba(0,0,0,.7)}
    h1{margin:0 0 8px;font-family:Orbitron;text-transform:uppercase;letter-spacing:.12em}
    .muted{color:var(--muted);font-size:13px}
    input,button{width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text);outline:none}
    label{display:block;font-size:12px;color:var(--muted);margin:10px 0 6px;letter-spacing:.08em;text-transform:uppercase}
    button{cursor:pointer;border:none;background:linear-gradient(135deg,#fde68a,#f97316,#ea580c);color:#0b0b10;font-family:Orbitron;letter-spacing:.12em;text-transform:uppercase;margin-top:10px}
    .boxOk{margin-top:12px;padding:10px;border-radius:12px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.55);color:#bbf7d0;font-size:13px}
    .boxBad{margin-top:12px;padding:10px;border-radius:12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.55);color:#fecaca;font-size:13px}
    code{background:rgba(15,23,42,.9);border:1px solid rgba(148,163,184,.35);padding:2px 6px;border-radius:8px}
  </style>
</head><body><div class="card">${inner}</div></body></html>`;
}

// helper (put it somewhere above routes)
function isBanActive(ban) {
  if (!ban) return false;
  if (!ban.expires_at) return true; // no expiry = permanent
  const exp = new Date(ban.expires_at).getTime();
  return Number.isFinite(exp) && exp > Date.now();
}

// ✅ FIXED: must be async + guild fetched before ban-role check
app.get("/register/:scrimId", async (req, res) => {
  const scrimId = Number(req.params.scrimId);
  const userId = String(req.query.user || "");

  const scrim = q.scrimById.get(scrimId);
if (scrim) {
  await autoUnbanIfExpired(scrim, userId);
}


  if (!scrim) {
    return res.send(renderRegisterPage("Invalid", `<h1>Invalid Scrim</h1><div class="boxBad">Scrim not found.</div>`));
  }
  if (!userId) {
    return res.send(renderRegisterPage("Invalid", `<h1>Invalid Link</h1><div class="boxBad">Missing user id.</div>`));
  }
  if (!scrim.registration_open) {
    return res.send(renderRegisterPage("Closed", `<h1>Closed</h1><div class="boxBad">Registration is closed.</div>`));
  }

  // --- Ban check (DB) ---
  // expects: q.banByUser.get(guild_id, user_id) -> { expires_at, reason, ... }
  if (q.banByUser) {
    const ban = q.banByUser.get(scrim.guild_id, userId);
    if (ban && isBanActive(ban)) {
      return res.send(renderRegisterPage("Banned", `
        <h1>Access Blocked</h1>
        <div class="boxBad">
          You are banned from registering in this server.<br/>
          ${ban.expires_at ? `Expires: <b>${esc(ban.expires_at)}</b>` : `<b>Permanent ban</b>`}
        </div>
      `));
    }
  }

  // --- Ban check (Discord Role) ---
  if (scrim.ban_role_id) {
    try {
      const guild = await discord.guilds.fetch(scrim.guild_id);
      const mem = await guild.members.fetch(userId);
      if (mem?.roles?.cache?.has(scrim.ban_role_id)) {
        return res.send(renderRegisterPage("Banned", `
          <h1>Access Blocked</h1>
          <div class="boxBad">You have the ban role and cannot register.</div>
        `));
      }
    } catch {
      // If member fetch fails (not in server), you can decide:
      // return banned or ignore. We'll ignore for now.
    }
  }

  // already registered?
  const existing = q.teamByUser.get(scrimId, userId);
  if (existing) {
    return res.send(renderRegisterPage("Already", `
      <h1>Already Registered</h1>
      <div class="boxOk">
        Team: <b>${esc(existing.team_name)}</b> [${esc(existing.team_tag)}]<br/>
        Slot: <b>#${existing.slot}</b><br/>
        Confirmed: <b>${existing.confirmed ? "YES" : "NO"}</b>
      </div>
    `));
  }

  return res.send(renderRegisterPage("Register", `
    <h1>${esc(scrim.name)}</h1>
    <div class="muted">Discord ID: <code>${esc(userId)}</code></div>

    <form action="/register/${scrimId}" method="POST" enctype="multipart/form-data">
      <input type="hidden" name="userId" value="${esc(userId)}"/>

      <label>Team Name</label>
      <input name="teamName" required/>

      <label>Team Tag (max 6)</label>
      <input name="teamTag" maxlength="6" required/>

      <label>Team Logo</label>
      <input type="file" name="teamLogo" accept="image/png,image/jpeg,image/jpg" required/>

      <button type="submit">Register Team</button>
    </form>

    <div class="muted" style="margin-top:10px">Auto-approved. Role is added instantly.</div>
  `));
});


app.post("/register/:scrimId", upload.single("teamLogo"), async (req, res) => {
  try {
    const scrimId = Number(req.params.scrimId);
    const scrim = q.scrimById.get(scrimId);
    if (!scrim) {
      return res.send(
        renderRegisterPage("Invalid", `<h1>Invalid</h1><div class="boxBad">Scrim not found.</div>`)
      );
    }

    const userId = String(req.body.userId || "").trim();
    const teamName = String(req.body.teamName || "").trim();
    const teamTag = String(req.body.teamTag || "").trim().toUpperCase().slice(0, 6);
    const file = req.file;

    // ✅ basic validation first
    if (!userId || !teamName || !teamTag || !file) {
      return res.send(
        renderRegisterPage("Error", `<h1>Error</h1><div class="boxBad">Missing data.</div>`)
      );
    }

    if (!scrim.registration_open) {
      return res.send(
        renderRegisterPage("Closed", `<h1>Closed</h1><div class="boxBad">Registration closed.</div>`)
      );
    }

    // ✅ auto remove expired bans (DB + role)
    if (typeof autoUnbanIfExpired === "function") {
      await autoUnbanIfExpired(scrim, userId);
    }

    // ✅ ban check (DB)
    if (q.banByUser) {
      const ban = q.banByUser.get(scrim.guild_id, userId);
      if (ban && isBanActive(ban)) {
        return res.send(
          renderRegisterPage(
            "Banned",
            `
            <h1>Access Blocked</h1>
            <div class="boxBad">
              You are banned from registering in this server.<br/>
              ${ban.expires_at ? `Expires: <b>${esc(ban.expires_at)}</b>` : `<b>Permanent ban</b>`}
            </div>
          `
          )
        );
      }
    }

    // ✅ ban role check (Discord)
    if (scrim.ban_role_id) {
      try {
        const guild = await discord.guilds.fetch(scrim.guild_id);
        const mem = await guild.members.fetch(userId);
        if (mem?.roles?.cache?.has(scrim.ban_role_id)) {
          return res.send(
            renderRegisterPage(
              "Banned",
              `
              <h1>Access Blocked</h1>
              <div class="boxBad">You have the ban role and cannot register.</div>
            `
            )
          );
        }
      } catch {}
    }

    // already registered?
    const existing = q.teamByUser.get(scrimId, userId);
    if (existing) {
      return res.send(
        renderRegisterPage(
          "Already",
          `<h1>Already Registered</h1><div class="boxOk">Slot: <b>#${existing.slot}</b></div>`
        )
      );
    }

    const slot = getNextFreeSlot(scrimId, scrim.min_slot, scrim.max_slot);
    if (!slot) {
      return res.send(
        renderRegisterPage("Full", `<h1>Full</h1><div class="boxBad">No slots left.</div>`)
      );
    }

    // insert team
    try {
      q.insertTeam.run(scrimId, slot, teamName, teamTag, file.filename, userId);
    } catch (e) {
      console.error(e);
      return res.send(
        renderRegisterPage("Error", `<h1>Error</h1><div class="boxBad">Registration failed.</div>`)
      );
    }

    // give role
    if (scrim.team_role_id) {
      try {
        const guild = await discord.guilds.fetch(scrim.guild_id);
        const member = await guild.members.fetch(userId);
        await member.roles.add(scrim.team_role_id);
      } catch (e) {
        console.error("Role add failed:", e?.message || e);
      }
    }

    await ensureListMessage(scrim).catch(() => {});
    await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});

    return res.send(
      renderRegisterPage(
        "Registered",
        `
        <h1>Registered ✅</h1>
        <div class="boxOk">
          Team: <b>${esc(teamName)}</b> [${esc(teamTag)}]<br/>
          Slot: <b>#${slot}</b>
        </div>
      `
      )
    );
  } catch (e) {
    console.error("POST /register error:", e);
    return res.send(
      renderRegisterPage("Error", `<h1>Error</h1><div class="boxBad">Something went wrong.</div>`)
    );
  }
});



app.get("/scrims/:id/settings", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || String(scrim.guild_id) !== String(guildId)) {
    return res.status(404).send("Scrim not found");
  }

  // safe templates list
  let templates = [];
  try {
    const t = typeof listTemplates === "function" ? listTemplates() : [];
    templates = Array.isArray(t) ? t : [];
  } catch {
    templates = [];
  }

  const slotsSpamOn =
    scrim.slots_spam === 1 ||
    scrim.slots_spam === "1" ||
    scrim.slots_spam === true;

  // scoring config (defaults if not set)
  const scoring = getScrimScoring(scrim);

  res.send(
    renderLayout({
      title: `Settings • ${scrim.name}`,
      user: req.session.user,
      selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
      active: "scrims",
      body: `
        <h2 class="h">${esc(scrim.name)} — Settings</h2>
        <p class="muted">Set channels/roles used by the bot for this scrim.</p>

        <form method="POST" action="/scrims/${scrimId}/settings">

          <label>Registration Channel ID</label>
          <input name="registrationChannelId" value="${esc(scrim.registration_channel_id || "")}" placeholder="123..." />

          <label>List Channel ID</label>
          <input name="listChannelId" value="${esc(scrim.list_channel_id || "")}" placeholder="123..." />

          <label>Confirm Channel ID</label>
          <input name="confirmChannelId" value="${esc(scrim.confirm_channel_id || "")}" placeholder="123..." />

          <label>Ban Log Channel ID (where bans will be posted)</label>
          <input name="banChannelId" value="${esc(scrim.ban_channel_id || "")}" placeholder="123..." />

          <label>Auto Post Messages</label>
          <div class="row">
            <div>
              <label style="margin-top:0">Auto Post Registration</label>
              <select name="autoPostReg">
                <option value="1" ${scrim.auto_post_reg ? "selected" : ""}>ON</option>
                <option value="0" ${scrim.auto_post_reg ? "" : "selected"}>OFF</option>
              </select>
            </div>
            <div>
              <label style="margin-top:0">Auto Post Team List</label>
              <select name="autoPostList">
                <option value="1" ${scrim.auto_post_list ? "selected" : ""}>ON</option>
                <option value="0" ${scrim.auto_post_list ? "" : "selected"}>OFF</option>
              </select>
            </div>
            <div>
              <label style="margin-top:0">Auto Post Confirm</label>
              <select name="autoPostConfirm">
                <option value="1" ${scrim.auto_post_confirm ? "selected" : ""}>ON</option>
                <option value="0" ${scrim.auto_post_confirm ? "" : "selected"}>OFF</option>
              </select>
            </div>
          </div>

          <label>Team Role ID (auto give on register)</label>
          <input name="teamRoleId" value="${esc(scrim.team_role_id || "")}" placeholder="123..." />

          <label>Ban Role ID (given on ban, blocks register)</label>
          <input name="banRoleId" value="${esc(scrim.ban_role_id || "")}" placeholder="123..." />

          <!-- ✅ GameSC -->
          <label>GameSC Screenshots Channel ID</label>
          <input name="gamescChannelId" value="${esc(scrim.gamesc_channel_id || "")}" placeholder="123..." />
          <p class="muted">This is the channel where <b>!match &lt;scrimId&gt; &lt;game&gt;</b> is allowed and screenshots are uploaded.</p>

          <div class="row">
            <div>
              <label>Reg Open Time (text)</label>
              <input name="openAt" value="${esc(scrim.open_at || "")}" placeholder="18:00 CET" />
            </div>
            <div>
              <label>Reg Close Time (text)</label>
              <input name="closeAt" value="${esc(scrim.close_at || "")}" placeholder="18:15 CET" />
            </div>
          </div>

          <div class="row">
            <div>
              <label>Confirm Open Time</label>
              <input name="confirmOpenAt" value="${esc(scrim.confirm_open_at || "")}" placeholder="18:20 CET" />
            </div>
            <div>
              <label>Confirm Close Time</label>
              <input name="confirmCloseAt" value="${esc(scrim.confirm_close_at || "")}" placeholder="18:30 CET" />
            </div>
          </div>

          
          <hr style="margin:18px 0;opacity:.2"/>

          <h3 class="h" style="font-size:14px">Scoring (OCR)</h3>
          <p class="muted">Default: 1st=10, 2nd=6, 3rd=5, 4th=4, 5th=3, 6th=2, 7-8=1, 9+=0 • Kill=1</p>

          <div class="row">
            <div>
              <label style="margin-top:0">Kill Points</label>
              <input name="killPoints" value="${esc(scoring.killPoints)}" placeholder="1" />
            </div>
            <div>
              <label style="margin-top:0">9+ Place Points</label>
              <input name="p9plus" value="${esc(scoring.p9plus)}" placeholder="0" />
            </div>
          </div>

          <div class="row">
            <div><label style="margin-top:0">1st</label><input name="p1" value="${esc(scoring.p1)}" /></div>
            <div><label style="margin-top:0">2nd</label><input name="p2" value="${esc(scoring.p2)}" /></div>
            <div><label style="margin-top:0">3rd</label><input name="p3" value="${esc(scoring.p3)}" /></div>
            <div><label style="margin-top:0">4th</label><input name="p4" value="${esc(scoring.p4)}" /></div>
          </div>
          <div class="row">
            <div><label style="margin-top:0">5th</label><input name="p5" value="${esc(scoring.p5)}" /></div>
            <div><label style="margin-top:0">6th</label><input name="p6" value="${esc(scoring.p6)}" /></div>
            <div><label style="margin-top:0">7th</label><input name="p7" value="${esc(scoring.p7)}" /></div>
            <div><label style="margin-top:0">8th</label><input name="p8" value="${esc(scoring.p8)}" /></div>
          </div>

          <h3 class="h" style="font-size:14px">Slots Posting</h3>

          <label>Slots Channel ID</label>
          <input name="slotsChannelId" value="${esc(scrim.slots_channel_id || "")}" placeholder="123..." />

          <label>Slot Template</label>
          <select name="slotTemplate"
            style="width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)">
            <option value="">-- choose --</option>
            ${templates.map(t => `
              <option value="${esc(t)}" ${scrim.slot_template === t ? "selected" : ""}>${esc(t)}</option>
            `).join("")}
          </select>

          <label>Spam Mode</label>
          <select name="slotsSpam"
            style="width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)">
            <option value="0" ${slotsSpamOn ? "" : "selected"}>OFF (one message)</option>
            <option value="1" ${slotsSpamOn ? "selected" : ""}>ON (post every slot)</option>
          </select>

          <div class="row" style="margin-top:12px">
            <button class="btn2 primary" type="submit">Save Settings</button>

            <a class="btn2" style="text-align:center;display:inline-flex" href="/scrims/${scrimId}">Back</a>

            <button class="btn2" type="submit"
              formaction="/scrims/${scrimId}/postSlots"
              formmethod="POST">
              🎞️ Post Slots Now
            </button>

            <button class="btn2" type="submit"
              formaction="/scrims/${scrimId}/delete"
              formmethod="POST"
              onclick="return confirm('DELETE this scrim forever?')">
              Delete Scrim
            </button>
          </div>

        </form>
      `,
    })
  );
});

app.get("/scrims/:id/postSlotsNow", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  // call your existing POST logic by redirecting to POST route via fetch is hard,
  // so just duplicate minimal:
  try {
    if (!scrim.slot_template || !scrim.slots_channel_id) return res.redirect(`/scrims/${scrimId}/settings`);

    const guild = await discord.guilds.fetch(scrim.guild_id);
    const chan = await guild.channels.fetch(scrim.slots_channel_id).catch(() => null);
    if (!chan || !chan.isTextBased()) return res.redirect(`/scrims/${scrimId}/settings`);

    const teams = q.teamsByScrim.all(scrimId);
    const bySlot = new Map(teams.map((t) => [t.slot, t]));

    const sends = [];
    for (let slot = scrim.min_slot; slot <= scrim.max_slot; slot++) {
      const t = bySlot.get(slot);
      const name = t ? t.team_name : "EMPTY";
      const tag = t ? t.team_tag : "";

      const filePath = await renderSlotGif({
        templateKey: scrim.slot_template,
        scrimId,
        slot,
        teamName: name,
        teamTag: tag,
      });

      if (scrim.slots_spam) sends.push(chan.send({ files: [filePath] }));
      else { await chan.send({ files: [filePath] }); break; }
    }

    if (scrim.slots_spam) await Promise.allSettled(sends);
  } catch (e) {
    console.error("postSlotsNow error:", e);
  }

  res.redirect(`/scrims/${scrimId}/settings`);
});


app.post("/scrims/:id/settings", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || String(scrim.guild_id) !== String(guildId)) {
    return res.status(404).send("Scrim not found");
  }

  const registrationChannelId = String(req.body.registrationChannelId || "").trim() || null;
  const listChannelId = String(req.body.listChannelId || "").trim() || null;
  const confirmChannelId = String(req.body.confirmChannelId || "").trim() || null;

  const teamRoleId = String(req.body.teamRoleId || "").trim() || null;
  const banRoleId = String(req.body.banRoleId || "").trim() || null;

  const gamescChannelId = String(req.body.gamescChannelId || "").trim() || null;

  const openAt = String(req.body.openAt || "").trim() || null;
  const closeAt = String(req.body.closeAt || "").trim() || null;
  const confirmOpenAt = String(req.body.confirmOpenAt || "").trim() || null;
  const confirmCloseAt = String(req.body.confirmCloseAt || "").trim() || null;

  const banChannelId = String(req.body.banChannelId || "").trim() || null;

  const autoPostReg = Number(req.body.autoPostReg || 0) ? 1 : 0;
  const autoPostList = Number(req.body.autoPostList || 0) ? 1 : 0;
  const autoPostConfirm = Number(req.body.autoPostConfirm || 0) ? 1 : 0;

  const slotsChannelId = String(req.body.slotsChannelId || "").trim() || null;
  const slotTemplate = String(req.body.slotTemplate || "").trim() || null;
  const slotsSpam = Number(req.body.slotsSpam || 0) ? 1 : 0;

  // Save main settings
  q.updateScrimSettings.run(
    registrationChannelId,
    listChannelId,
    confirmChannelId,
    teamRoleId,
    banRoleId,
    openAt,
    closeAt,
    confirmOpenAt,
    confirmCloseAt,
    scrimId,
    guildId
  );

  // Save extra settings
  q.setGameScChannel.run(gamescChannelId, scrimId, guildId);
  q.setBanChannel.run(banChannelId, scrimId, guildId);
  q.setAutoPost.run(autoPostReg, autoPostList, autoPostConfirm, scrimId, guildId);
  q.updateSlotsSettings.run(slotTemplate, slotsChannelId, slotsSpam, scrimId, guildId);
  // Save scoring settings (OCR)
  const defScoring = defaultScoring();
  const scoringCfg = {
    killPoints: clampInt(req.body.killPoints ?? req.body.kill_points, 0, 50, defScoring.killPoints),
    p1: clampInt(req.body.p1, 0, 200, defScoring.p1),
    p2: clampInt(req.body.p2, 0, 200, defScoring.p2),
    p3: clampInt(req.body.p3, 0, 200, defScoring.p3),
    p4: clampInt(req.body.p4, 0, 200, defScoring.p4),
    p5: clampInt(req.body.p5, 0, 200, defScoring.p5),
    p6: clampInt(req.body.p6, 0, 200, defScoring.p6),
    p7: clampInt(req.body.p7, 0, 200, defScoring.p7),
    p8: clampInt(req.body.p8, 0, 200, defScoring.p8),
    p9plus: clampInt(req.body.p9plus, 0, 200, defScoring.p9plus),
  };
  q.setScoringJson.run(JSON.stringify(scoringCfg), scrimId, guildId);


  // Refresh auto-post messages
  const fresh = q.scrimById.get(scrimId);
  autoPostAll(fresh).catch(() => {});

  return res.redirect(`/scrims/${scrimId}`);
});


app.post("/scrims/:id/delete", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  db.prepare("DELETE FROM scrims WHERE id=? AND guild_id=?").run(scrimId, guildId);
  res.redirect("/scrims");
});

discord.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    // ---------- START MATCH ----------
if (msg.content === "!match done") {
  const session = matchSessions.get(msg.channel.id);
  if (!session) return msg.reply("❌ No active match.");

  const { scrimId, game, images } = session;
  matchSessions.delete(msg.channel.id);

  if (!images.length) return msg.reply("❌ No screenshots uploaded.");

  const scrim = q.scrimById.get(scrimId);
  const rankMap = getRankPointsForScrim(scrim);
  const teams = q.teamsByScrim.all(scrimId);

  let saved = 0;

  for (const url of images) {
    const text = await ocrImageFromUrl(url);
    const rows = buildRowsFromOCR(text); // must return [{ place, players[], kills[] }]

    for (const row of rows) {
      const scored = scoreRow(
        { ...row, scrimId, game },
        teams,
        rankMap
      );

      if (!scored) continue;

      q.saveResult.run(
        scored.scrim_id,
        scored.game,
        scored.team_tag,
        scored.place,
        scored.kills,
        scored.points
      );

      saved++;
    }
  }

  return msg.reply(
    `🏁 Scrim ${scrimId} • Game ${game} Saved\n` +
    `✅ Rows written/updated: ${saved}\n` +
    `Tip: Upload clear full scoreboard screenshots`
  );
}

    // ---------- COLLECT IMAGES ----------
    if (msg.attachments.size && matchSessions.has(msg.channel.id)) {
      const session = matchSessions.get(msg.channel.id);
      for (const a of msg.attachments.values()) {
        // accept images only
        const url = a.url || "";
        if (/\.(png|jpg|jpeg|webp)$/i.test(url) || a.contentType?.startsWith("image/")) {
          session.images.push(url);
        }
      }
    }

  } catch (e) {
    console.error("!match error:", e);
    try { await msg.reply("❌ OCR failed. Check VM logs + Vision permissions."); } catch {}
  }
});

// HEALTH
app.get("/health", (req, res) => res.json({ ok: true }));

// START
app.listen(PORT, () => console.log(`🌐 Web running: ${BASE} (port ${PORT})`));
registerCommands().catch((e) => console.error("Command register error:", e));
discord.login(DISCORD_TOKEN);