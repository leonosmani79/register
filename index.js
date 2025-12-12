// register/index.js
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const Database = require("better-sqlite3");

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
  console.error("❌ Missing BASE_URL (public URL, e.g. https://register.darksideorg.com)");
  process.exit(1);
}
if (!PANEL_CLIENT_ID || !PANEL_CLIENT_SECRET || !PANEL_REDIRECT_URI || !PANEL_SESSION_SECRET) {
  console.error("❌ Missing PANEL OAuth envs (PANEL_CLIENT_ID/SECRET/REDIRECT_URI/SESSION_SECRET)");
  process.exit(1);
}

const ADMIN_IDS = (PANEL_ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// helper: normalize base url (no trailing slash)
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
const upload = multer({ storage });

// ---------------------- SQLITE ---------------------- //
const dbPath = path.join(__dirname, "scrims.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

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
`);

const q = {
  scrimById: db.prepare("SELECT * FROM scrims WHERE id = ?"),
  scrimsByGuild: db.prepare("SELECT * FROM scrims WHERE guild_id = ? ORDER BY id DESC"),

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

  setRegOpen: db.prepare("UPDATE scrims SET registration_open = ? WHERE id = ? AND guild_id = ?"),
  setConfirmOpen: db.prepare("UPDATE scrims SET confirm_open = ? WHERE id = ? AND guild_id = ?"),

  setListMessage: db.prepare("UPDATE scrims SET list_channel_id = ?, list_message_id = ? WHERE id = ?"),
  setConfirmMessage: db.prepare("UPDATE scrims SET confirm_channel_id = ?, confirm_message_id = ? WHERE id = ?"),

  teamsByScrim: db.prepare("SELECT * FROM teams WHERE scrim_id = ? ORDER BY slot ASC"),
  teamByUser: db.prepare("SELECT * FROM teams WHERE scrim_id = ? AND owner_user_id = ?"),
  teamBySlot: db.prepare("SELECT * FROM teams WHERE scrim_id = ? AND slot = ?"),

  insertTeam: db.prepare(`
    INSERT INTO teams (scrim_id, slot, team_name, team_tag, logo_filename, owner_user_id, confirmed)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `),

  removeTeamBySlot: db.prepare("DELETE FROM teams WHERE scrim_id = ? AND slot = ?"),
  removeTeamByUser: db.prepare("DELETE FROM teams WHERE scrim_id = ? AND owner_user_id = ?"),

  setConfirmedByUser: db.prepare("UPDATE teams SET confirmed = 1 WHERE scrim_id = ? AND owner_user_id = ?"),

  upsertResults: db.prepare(`
    INSERT INTO results (scrim_id, slot, game1, game2, game3, game4)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scrim_id, slot) DO UPDATE SET
      game1=excluded.game1, game2=excluded.game2, game3=excluded.game3, game4=excluded.game4
  `),
  resultsByScrim: db.prepare("SELECT * FROM results WHERE scrim_id = ? ORDER BY slot ASC"),
};

function getNextFreeSlot(scrimId, minSlot, maxSlot) {
  const teams = q.teamsByScrim.all(scrimId);
  const used = new Set(teams.map((t) => t.slot));
  for (let s = minSlot; s <= maxSlot; s++) {
    if (!used.has(s)) return s;
  }
  return null;
}

// ---------------------- DISCORD BOT ---------------------- //
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("scrims")
      .setDescription("Get the panel link (admins only)"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Slash commands registered.");
}

discord.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${discord.user.tag}`);
});

// ---------- DISCORD EMBEDS HELPERS ----------
async function ensureListMessage(scrim) {
  if (!scrim.list_channel_id) return;
  const guild = await discord.guilds.fetch(scrim.guild_id);
  const channel = await guild.channels.fetch(scrim.list_channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  if (!scrim.list_message_id) {
    const msg = await channel.send({ content: "Creating teams list..." });
    q.setListMessage.run(scrim.list_channel_id, msg.id, scrim.id);
    scrim = q.scrimById.get(scrim.id);
  }
  await updateTeamsListEmbed(scrim);
}

async function ensureConfirmMessage(scrim) {
  if (!scrim.confirm_channel_id) return;
  const guild = await discord.guilds.fetch(scrim.guild_id);
  const channel = await guild.channels.fetch(scrim.confirm_channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  if (!scrim.confirm_message_id) {
    const msg = await channel.send({ content: "Creating confirms..." });
    q.setConfirmMessage.run(scrim.confirm_channel_id, msg.id, scrim.id);
    scrim = q.scrimById.get(scrim.id);
  }
  await updateConfirmEmbed(scrim);
}

async function updateConfirmEmbed(scrim) {
  if (!scrim.confirm_channel_id || !scrim.confirm_message_id) return;
  const guild = await discord.guilds.fetch(scrim.guild_id);
  const channel = await guild.channels.fetch(scrim.confirm_channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const msg = await channel.messages.fetch(scrim.confirm_message_id).catch(() => null);
  if (!msg) return;

  const embed = new EmbedBuilder()
    .setTitle(`${scrim.name} — CONFIRMS`)
    .setDescription(
      [
        scrim.confirm_open_at ? `Open: **${scrim.confirm_open_at}**` : null,
        scrim.confirm_close_at ? `Close: **${scrim.confirm_close_at}**` : null,
        "",
        scrim.confirm_open ? "✅ Confirms are **OPEN**" : "❌ Confirms are **CLOSED**",
        "",
        "Only teams that registered can confirm/drop.",
      ].filter(Boolean).join("\n")
    )
    .setColor(0xffb300);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${scrim.id}`).setLabel("Confirm Slot").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`drop:${scrim.id}`).setLabel("Drop Slot").setStyle(ButtonStyle.Danger),
  );

  await msg.edit({ content: "", embeds: [embed], components: [row] });
}

async function updateTeamsListEmbed(scrim) {
  if (!scrim.list_channel_id || !scrim.list_message_id) return;

  const guild = await discord.guilds.fetch(scrim.guild_id);
  const channel = await guild.channels.fetch(scrim.list_channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const msg = await channel.messages.fetch(scrim.list_message_id).catch(() => null);
  if (!msg) return;

  const teams = q.teamsByScrim.all(scrim.id);
  const totalSlots = scrim.max_slot - scrim.min_slot + 1;

  const lines = [];
  for (let s = scrim.min_slot; s <= scrim.max_slot; s++) {
    const t = teams.find((x) => x.slot === s);
    if (!t) lines.push(`**#${s}** — *(empty)*`);
    else lines.push(`**#${t.slot}** — **${t.team_name}** [**${t.team_tag}**] ${t.confirmed ? "✅" : "⏳"}`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`${scrim.name} — Teams (${teams.length}/${totalSlots})`)
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({ text: `REG: ${scrim.registration_open ? "OPEN" : "CLOSED"} | CONFIRMS: ${scrim.confirm_open ? "OPEN" : "CLOSED"}` });

  const components = [];

  const filled = teams.map((t) => ({
    label: `Remove #${t.slot} — ${t.team_tag}`,
    description: t.team_name.slice(0, 90),
    value: String(t.slot),
  }));

  if (filled.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`rmteam:${scrim.id}`)
          .setPlaceholder("Staff: remove a team...")
          .addOptions(filled.slice(0, 25))
      )
    );
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`refreshlist:${scrim.id}`).setLabel("Refresh").setStyle(ButtonStyle.Secondary)
    )
  );

  await msg.edit({ embeds: [embed], components });
}

// ---------- DISCORD INTERACTIONS ----------
discord.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "scrims") {
      const member = interaction.member;
      const can =
        member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
        member?.permissions?.has?.(PermissionFlagsBits.Administrator);

      if (!can) return interaction.reply({ content: "❌ Need Manage Server.", ephemeral: true });

      return interaction.reply({
        content: `Panel: ${BASE}/panel`,
        ephemeral: true,
      });
    }

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
    if (interaction.isRepliable()) interaction.reply({ content: "❌ Error.", ephemeral: true }).catch(() => {});
  }
});

// ---------------------- EXPRESS ---------------------- //
const app = express();

// behind nginx
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// IMPORTANT: secure cookies for HTTPS (fix login loops behind nginx)
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

// ---------------------- HTML helpers ---------------------- //
function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#050509;--card:rgba(18,20,31,.95);--border:rgba(255,255,255,.08);--text:#f5f5f7;--muted:#9ca3af;--accent:#ffb300;}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:
      radial-gradient(circle at top,#20263a 0,transparent 55%),
      radial-gradient(circle at bottom,#111827 0,#020617 65%);
      color:var(--text);font-family:Inter,system-ui;padding:22px}
    a{color:var(--accent);text-decoration:none}
    .wrap{max-width:1100px;margin:0 auto}
    .top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:14px}
    .brand{font-family:Orbitron;letter-spacing:.14em;text-transform:uppercase}
    .pill{background:rgba(15,23,42,.8);border:1px solid var(--border);border-radius:999px;padding:8px 10px;font-size:12px;color:var(--muted)}
    .card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px;box-shadow:0 25px 40px rgba(0,0,0,.7)}
    .nav{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 14px}
    .nav a{padding:8px 12px;border-radius:999px;border:1px solid var(--border);background:rgba(15,23,42,.6);color:var(--text);font-size:13px}
    .nav a.active{border-color:rgba(255,179,0,.6);box-shadow:0 0 0 1px rgba(255,179,0,.22)}
    input,button{width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)}
    label{display:block;font-size:12px;color:var(--muted);margin:10px 0 6px;letter-spacing:.08em;text-transform:uppercase}
    button{cursor:pointer;border:none;background:linear-gradient(135deg,#fde68a,#f97316,#ea580c);color:#0b0b10;font-family:Orbitron;letter-spacing:.12em;text-transform:uppercase}
    .btn2{background:rgba(15,23,42,.85);border:1px solid var(--border);color:var(--text)}
    table{width:100%;border-collapse:collapse}
    td,th{border-bottom:1px solid rgba(255,255,255,.06);padding:10px;font-size:13px;text-align:left}
    th{color:var(--muted)}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .row>*{flex:1;min-width:160px}
    .muted{color:var(--muted)}
    .h{font-family:Orbitron;letter-spacing:.1em;text-transform:uppercase;margin:0 0 10px}
    .warn{margin-top:12px;padding:10px;border-radius:12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.55);color:#fecaca;font-size:13px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">DarkSide Scrims Panel</div>
      <div class="pill">
        ${user ? `Logged: <b>${esc(user.username)}</b> • ` : ""}
        ${selectedGuild ? `Guild: <b>${esc(selectedGuild.name)}</b>` : ""}
      </div>
    </div>
    ${nav}
    <div class="card">${body}</div>
  </div>
</body>
</html>`;
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/auth/discord");
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

// IMPORTANT: filter only servers where bot exists
function botIsInGuild(guildId) {
  // bot must be logged in and in that server
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

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ---------------------- PANEL ROUTES ---------------------- //
app.get("/", (req, res) => {
  const logged = !!req.session.user;

  return res.send(
    renderLayout({
      title: "DarkSide",
      user: req.session.user || null,
      selectedGuild: null,
      active: "",
      body: `
        <h2 class="h">DarkSide Scrims</h2>
        <p class="muted">Manage scrims, open/close registration, confirms, and results.</p>

        ${
          logged
            ? `
              <div class="row" style="margin-top:12px">
                <a class="btn2" style="text-align:center;display:inline-block;padding:10px 11px;border-radius:12px;" href="/servers">Go to Panel</a>
                <a class="btn2" style="text-align:center;display:inline-block;padding:10px 11px;border-radius:12px;" href="/logout">Logout</a>
              </div>
            `
            : `
              <div class="row" style="margin-top:12px">
                <a style="text-align:center;display:inline-block;padding:10px 11px;border-radius:12px;" href="/auth/discord">Login with Discord</a>
              </div>
            `
        }
      `,
    })
  );
});


app.get("/panel", (req, res) => {
  if (!req.session.user) return res.redirect("/");   // landing page
  if (!req.session.selectedGuildId) return res.redirect("/servers");
  return res.redirect("/scrims");
});

// ✅ ONLY show servers the user can manage AND that already have the bot
app.get("/servers", requireLogin, async (req, res) => {
  try {
    const guilds = await discordApi("/users/@me/guilds", req.session.access_token);

    // user can manage
    const manageable = guilds.filter(hasManagePermission);

    // bot is inside
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
          <table>
            <thead><tr><th>Server</th><th>Action</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="2">No servers to show.</td></tr>`}</tbody>
          </table>
        `,
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

app.get("/scrims", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrims = q.scrimsByGuild.all(guildId);

  const rows = scrims
    .map(
      (s) => `
    <tr>
      <td><b>${esc(s.name)}</b><div class="muted">Scrim ID: ${s.id}</div></td>
      <td>${s.registration_open ? "✅ OPEN" : "❌ CLOSED"}</td>
      <td>${s.confirm_open ? "✅ OPEN" : "❌ CLOSED"}</td>
      <td style="width:420px">
        <div class="row">
          <a class="btn2" style="text-align:center;display:inline-block;padding:10px 11px;border-radius:12px;" href="/scrims/${s.id}">Manage</a>
          <a class="btn2" style="text-align:center;display:inline-block;padding:10px 11px;border-radius:12px;" href="/scrims/${s.id}/results">Results</a>
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
        <table>
          <thead><tr><th>Scrim</th><th>Reg</th><th>Confirms</th><th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4">No scrims. Create one.</td></tr>`}</tbody>
        </table>
      `,
    })
  );
});

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
            <div>
              <label>Min Slot</label>
              <input name="minSlot" type="number" value="2" required/>
            </div>
            <div>
              <label>Max Slot</label>
              <input name="maxSlot" type="number" value="25" required/>
            </div>
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

app.post("/scrims/new", requireLogin, (req, res) => {
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
    guildId, name, minSlot, maxSlot,
    registrationChannelId, listChannelId, confirmChannelId, teamRoleId,
    openAt, closeAt, confirmOpenAt, confirmCloseAt
  );

  res.redirect("/scrims");
});

app.get("/scrims/:id", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const teams = q.teamsByScrim.all(scrimId);

  res.send(
    renderLayout({
      title: "Manage Scrim",
      user: req.session.user,
      selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
      active: "scrims",
      body: `
        <h2 class="h">${esc(scrim.name)} <span class="muted">#${scrim.id}</span></h2>

        <div class="row">
          <form method="POST" action="/scrims/${scrimId}/toggleReg" style="margin:0"><button type="submit">${scrim.registration_open ? "Close Registration" : "Open Registration"}</button></form>
          <form method="POST" action="/scrims/${scrimId}/toggleConfirm" style="margin:0"><button class="btn2" type="submit">${scrim.confirm_open ? "Close Confirms" : "Open Confirms"}</button></form>
          <form method="POST" action="/scrims/${scrimId}/postRegMessage" style="margin:0"><button class="btn2" type="submit">Post Reg Message</button></form>
          <form method="POST" action="/scrims/${scrimId}/postList" style="margin:0"><button class="btn2" type="submit">Post/Update List</button></form>
          <form method="POST" action="/scrims/${scrimId}/postConfirmMessage" style="margin:0"><button class="btn2" type="submit">Post/Update Confirms</button></form>
        </div>

        <hr style="border:none;height:1px;background:rgba(255,255,255,.06);margin:14px 0"/>

        <h3 class="h">Settings</h3>
        <form method="POST" action="/scrims/${scrimId}/edit">
          <label>Scrim Name</label>
          <input name="name" value="${esc(scrim.name)}" required/>

          <div class="row">
            <div><label>Min Slot</label><input name="minSlot" type="number" value="${scrim.min_slot}" required/></div>
            <div><label>Max Slot</label><input name="maxSlot" type="number" value="${scrim.max_slot}" required/></div>
          </div>

          <label>Registration Channel ID</label>
          <input name="registrationChannelId" value="${esc(scrim.registration_channel_id || "")}"/>

          <label>Teams List Channel ID</label>
          <input name="listChannelId" value="${esc(scrim.list_channel_id || "")}"/>

          <label>Confirm Channel ID</label>
          <input name="confirmChannelId" value="${esc(scrim.confirm_channel_id || "")}"/>

          <label>Team Role ID</label>
          <input name="teamRoleId" value="${esc(scrim.team_role_id || "")}"/>

          <div class="row">
            <div><label>Reg Open Time</label><input name="openAt" value="${esc(scrim.open_at || "")}"/></div>
            <div><label>Reg Close Time</label><input name="closeAt" value="${esc(scrim.close_at || "")}"/></div>
          </div>
          <div class="row">
            <div><label>Confirms Open Time</label><input name="confirmOpenAt" value="${esc(scrim.confirm_open_at || "")}"/></div>
            <div><label>Confirms Close Time</label><input name="confirmCloseAt" value="${esc(scrim.confirm_close_at || "")}"/></div>
          </div>

          <button type="submit">Save</button>
        </form>

        <hr style="border:none;height:1px;background:rgba(255,255,255,.06);margin:14px 0"/>

        <h3 class="h">Teams (${teams.length})</h3>
        <table>
          <thead><tr><th>Slot</th><th>Team</th><th>Owner</th><th>Confirmed</th><th>Remove</th></tr></thead>
          <tbody>
            ${
              teams.map((t)=>`
                <tr>
                  <td>#${t.slot}</td>
                  <td><b>${esc(t.team_name)}</b> <span class="muted">[${esc(t.team_tag)}]</span></td>
                  <td class="muted">${esc(t.owner_user_id)}</td>
                  <td>${t.confirmed ? "✅" : "⏳"}</td>
                  <td>
                    <form method="POST" action="/scrims/${scrimId}/removeSlot" style="margin:0">
                      <input type="hidden" name="slot" value="${t.slot}"/>
                      <button class="btn2" type="submit">Remove</button>
                    </form>
                  </td>
                </tr>
              `).join("") || `<tr><td colspan="5">No teams yet.</td></tr>`
            }
          </tbody>
        </table>
      `,
    })
  );
});

app.post("/scrims/:id/edit", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

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
    name, minSlot, maxSlot,
    registrationChannelId, listChannelId, confirmChannelId, teamRoleId,
    openAt, closeAt, confirmOpenAt, confirmCloseAt,
    scrimId, guildId
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

  await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
  res.redirect("/scrims");
});

app.post("/scrims/:id/toggleConfirm", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const next = scrim.confirm_open ? 0 : 1;
  q.setConfirmOpen.run(next, scrimId, guildId);

  await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});
  await updateConfirmEmbed(q.scrimById.get(scrimId)).catch(() => {});
  res.redirect("/scrims");
});

app.post("/scrims/:id/postRegMessage", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  if (scrim.registration_channel_id) {
    try {
      const guild = await discord.guilds.fetch(scrim.guild_id);
      const chan = await guild.channels.fetch(scrim.registration_channel_id);
      if (chan && chan.type === ChannelType.GuildText) {
        const embed = new EmbedBuilder()
          .setTitle(`${scrim.name} — Registration`)
          .setDescription(
            [
              `Slots: **${scrim.min_slot}-${scrim.max_slot}**`,
              scrim.open_at ? `Open: **${scrim.open_at}**` : null,
              scrim.close_at ? `Close: **${scrim.close_at}**` : null,
              "",
              "Click **Register Team** to get your personal link.",
            ].filter(Boolean).join("\n")
          )
          .setColor(0x5865f2);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`reglink:${scrim.id}`).setLabel("Register Team").setStyle(ButtonStyle.Primary)
        );

        await chan.send({ embeds: [embed], components: [row] });
      }
    } catch (e) {
      console.error("postRegMessage error:", e);
    }
  }

  res.redirect(`/scrims/${scrimId}`);
});

app.post("/scrims/:id/postList", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  await ensureListMessage(scrim).catch(() => {});
  res.redirect(`/scrims/${scrimId}`);
});

app.post("/scrims/:id/postConfirmMessage", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  await ensureConfirmMessage(scrim).catch(() => {});
  res.redirect(`/scrims/${scrimId}`);
});

app.post("/scrims/:id/removeSlot", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const slot = Number(req.body.slot);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const team = q.teamBySlot.get(scrimId, slot);
  if (team) {
    q.removeTeamBySlot.run(scrimId, slot);
    if (scrim.team_role_id) {
      try {
        const guild = await discord.guilds.fetch(scrim.guild_id);
        const mem = await guild.members.fetch(team.owner_user_id);
        await mem.roles.remove(scrim.team_role_id);
      } catch {}
    }
    await updateTeamsListEmbed(scrim).catch(() => {});
  }

  res.redirect(`/scrims/${scrimId}`);
});

// RESULTS
app.get("/scrims/:id/results", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const teams = q.teamsByScrim.all(scrimId);
  const results = q.resultsByScrim.all(scrimId);
  const bySlot = new Map(results.map((r) => [r.slot, r]));

  const rows = teams.map((t) => {
    const r = bySlot.get(t.slot) || { game1: 0, game2: 0, game3: 0, game4: 0 };
    return `
      <tr>
        <td>#${t.slot}</td>
        <td><b>${esc(t.team_name)}</b> <span class="muted">[${esc(t.team_tag)}]</span></td>
        <td><input name="g1_${t.slot}" type="number" value="${r.game1 || 0}"/></td>
        <td><input name="g2_${t.slot}" type="number" value="${r.game2 || 0}"/></td>
        <td><input name="g3_${t.slot}" type="number" value="${r.game3 || 0}"/></td>
        <td><input name="g4_${t.slot}" type="number" value="${r.game4 || 0}"/></td>
      </tr>`;
  }).join("");

  res.send(
    renderLayout({
      title: "Results",
      user: req.session.user,
      selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
      active: "scrims",
      body: `
        <h2 class="h">${esc(scrim.name)} — Results</h2>
        <form method="POST" action="/scrims/${scrimId}/results">
          <table>
            <thead><tr><th>Slot</th><th>Team</th><th>G1</th><th>G2</th><th>G3</th><th>G4</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6">No teams yet.</td></tr>`}</tbody>
          </table>
          <div style="margin-top:12px"><button type="submit">Save Results</button></div>
        </form>
      `,
    })
  );
});

app.post("/scrims/:id/results", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const teams = q.teamsByScrim.all(scrimId);
  for (const t of teams) {
    const g1 = Number(req.body[`g1_${t.slot}`] || 0);
    const g2 = Number(req.body[`g2_${t.slot}`] || 0);
    const g3 = Number(req.body[`g3_${t.slot}`] || 0);
    const g4 = Number(req.body[`g4_${t.slot}`] || 0);
    q.upsertResults.run(scrimId, t.slot, g1, g2, g3, g4);
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
    :root{--bg:#050509;--card:rgba(18,20,31,.95);--border:rgba(255,255,255,.08);--text:#f5f5f7;--muted:#9ca3af;--accent:#ffb300;--danger:#ff4b4b;--ok:#4caf50;}
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

app.get("/register/:scrimId", (req, res) => {
  const scrimId = Number(req.params.scrimId);
  const userId = String(req.query.user || "");

  const scrim = q.scrimById.get(scrimId);
  if (!scrim) return res.send(renderRegisterPage("Invalid", `<h1>Invalid Scrim</h1><div class="boxBad">Scrim not found.</div>`));
  if (!userId) return res.send(renderRegisterPage("Invalid", `<h1>Invalid Link</h1><div class="boxBad">Missing user id.</div>`));
  if (!scrim.registration_open) return res.send(renderRegisterPage("Closed", `<h1>Closed</h1><div class="boxBad">Registration is closed.</div>`));

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

  res.send(renderRegisterPage("Register", `
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
  const scrimId = Number(req.params.scrimId);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim) return res.send(renderRegisterPage("Invalid", `<h1>Invalid</h1><div class="boxBad">Scrim not found.</div>`));

  const userId = String(req.body.userId || "");
  const teamName = String(req.body.teamName || "").trim();
  const teamTag = String(req.body.teamTag || "").trim().toUpperCase().slice(0, 6);
  const file = req.file;

  if (!userId || !teamName || !teamTag || !file) {
    return res.send(renderRegisterPage("Error", `<h1>Error</h1><div class="boxBad">Missing data.</div>`));
  }
  if (!scrim.registration_open) return res.send(renderRegisterPage("Closed", `<h1>Closed</h1><div class="boxBad">Registration closed.</div>`));

  const existing = q.teamByUser.get(scrimId, userId);
  if (existing) {
    return res.send(renderRegisterPage("Already", `<h1>Already Registered</h1><div class="boxOk">Slot: <b>#${existing.slot}</b></div>`));
  }

  const slot = getNextFreeSlot(scrimId, scrim.min_slot, scrim.max_slot);
  if (!slot) return res.send(renderRegisterPage("Full", `<h1>Full</h1><div class="boxBad">No slots left.</div>`));

  try {
    q.insertTeam.run(scrimId, slot, teamName, teamTag, file.filename, userId);
  } catch (e) {
    console.error(e);
    return res.send(renderRegisterPage("Error", `<h1>Error</h1><div class="boxBad">Registration failed.</div>`));
  }

  // auto role
  if (scrim.team_role_id) {
    try {
      const guild = await discord.guilds.fetch(scrim.guild_id);
      const member = await guild.members.fetch(userId);
      await member.roles.add(scrim.team_role_id);
    } catch (e) {
      console.error("Role add failed:", e?.message || e);
    }
  }

  // update list
  await ensureListMessage(scrim).catch(() => {});
  await updateTeamsListEmbed(q.scrimById.get(scrimId)).catch(() => {});

  res.send(renderRegisterPage("Registered", `
    <h1>Registered ✅</h1>
    <div class="boxOk">
      Team: <b>${esc(teamName)}</b> [${esc(teamTag)}]<br/>
      Slot: <b>#${slot}</b>
    </div>
  `));
});

// ---------------------- HEALTH ---------------------- //
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------- START ---------------------- //
app.listen(PORT, () => console.log(`🌐 Web running: ${BASE} (port ${PORT})`));
registerCommands().catch((e) => console.error("Command register error:", e));
discord.login(DISCORD_TOKEN);


