// register/index.js
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
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
const upload = multer({ storage });

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

    const filters = [
      `drawtext=fontfile='${fontFile}':text='${escDrawtext(slotText)}':x=${slotF.x}:y=${slotF.y}:fontsize=${slotF.size}:fontcolor=${slotF.color}:borderw=${slotF.strokeW}:bordercolor=${slotF.stroke}`,
      `drawtext=fontfile='${fontFile}':text='${escDrawtext(nameText)}':x=${nameF.x}:y=${nameF.y}:fontsize=${nameF.size}:fontcolor=${nameF.color}:borderw=${nameF.strokeW}:bordercolor=${nameF.stroke}`,
      `drawtext=fontfile='${fontFile}':text='${escDrawtext(tagText)}':x=${tagX}:y=${tagF.y}:fontsize=${tagF.size}:fontcolor=${tagF.color}:borderw=${tagF.strokeW}:bordercolor=${tagF.stroke}`,
    ];

    ffmpeg(t.base)
      .outputOptions(["-vf", filters.join(","), "-gifflags", "+transdiff"])
      .on("error", (err) => reject(err))
      .on("end", () => resolve(outPath))
      .save(outPath);
  });
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
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(guild_id, user_id)
);

`);

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

const q = {
  scrimById: db.prepare("SELECT * FROM scrims WHERE id = ?"),
  scrimsByGuild: db.prepare("SELECT * FROM scrims WHERE guild_id = ? ORDER BY id DESC"),

  updateSlotsSettings: db.prepare(`
    UPDATE scrims SET
      slot_template = ?,
      slots_channel_id = ?,
      slots_spam = ?
    WHERE id = ? AND guild_id = ?
  `),

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
  for (let s = minSlot; s <= maxSlot; s++) if (!used.has(s)) return s;
  return null;
}

// ---------------------- DISCORD BOT ---------------------- //
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("scrims").setDescription("Get the panel link (admins only)"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Slash commands registered.");
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

function buildRegEmbed(scrim, guild, teamsCount = 0) {
  const totalSlots = scrim.max_slot - scrim.min_slot + 1;
  return new EmbedBuilder()
    .setTitle(`📝 ${scrim.name} — REGISTRATION`)
    .setColor(scrim.registration_open ? 0x5865f2 : 0xff4b4b)
    .setDescription(
      [
        "━━━━━━━━━━━━━━━━━━━━",
        `Status: ${scrim.registration_open ? "✅ OPEN" : "❌ CLOSED"}`,
        `Slots: **${scrim.min_slot}-${scrim.max_slot}**`,
        `Filled: **${teamsCount}/${totalSlots}**`,
        "",
        scrim.open_at ? `⏱ Open: **${scrim.open_at}**` : null,
        scrim.close_at ? `⏱ Close: **${scrim.close_at}**` : null,
        "",
        "**How it works**",
        "• Click **Register Team**",
        "• You get a private link",
        "• One team per Discord account",
        "━━━━━━━━━━━━━━━━━━━━",
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: `DarkSide Scrims • Scrim ID ${scrim.id}` })
    .setThumbnail(guild.iconURL({ size: 256 }));
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

  const guild = await discord.guilds.fetch(scrim.guild_id);
  const channel = await guild.channels.fetch(scrim.confirm_channel_id).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(scrim.confirm_message_id).catch(() => null);
  if (!msg) return;

  const statusLine = scrim.confirm_open ? "🟢 **CONFIRMS ARE OPEN**" : "🔴 **CONFIRMS ARE CLOSED**";

  const timeBlock = [
    scrim.confirm_open_at ? `⏱ **Open:** ${scrim.confirm_open_at}` : null,
    scrim.confirm_close_at ? `⏳ **Close:** ${scrim.confirm_close_at}` : null,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(scrim.confirm_open ? 0x22c55e : 0xef4444)
    .setTitle(`✅ ${scrim.name} — CONFIRMATION`)
    .setDescription(
      [
        statusLine,
        "",
        "Only teams that **registered** can confirm or drop.",
        "If you confirm, your slot becomes **locked** ✅",
        "",
        timeBlock.length ? "**Schedule**" : null,
        ...timeBlock,
      ].filter(Boolean).join("\n")
    )
    .setFooter({ text: `DarkSide Scrims • Scrim ID: ${scrim.id}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${scrim.id}`)
      .setLabel("Confirm Slot")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!scrim.confirm_open),
    new ButtonBuilder()
      .setCustomId(`drop:${scrim.id}`)
      .setLabel("Drop Slot")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!scrim.confirm_open)
  );

  await msg.edit({ content: "", embeds: [embed], components: [row] });
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
    const finalMsg = await channel.messages.fetch(scrim.list_message_id).catch(() => null);
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
    if (interaction.isChatInputCommand() && interaction.commandName === "scrims") {
      const member = interaction.member;
      const can =
        member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
        member?.permissions?.has?.(PermissionFlagsBits.Administrator);

      if (!can) return interaction.reply({ content: "❌ Need Manage Server.", ephemeral: true });

      return interaction.reply({ content: `Panel: ${BASE}/panel`, ephemeral: true });
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

    .btn2{
      width:100%;
      padding:12px 14px;
      border-radius:999px;
      border:1px solid rgba(148,163,184,.35);
      background: rgba(15,23,42,.82);
      color:var(--text);
      cursor:pointer;
      font-family:Orbitron,system-ui;
      letter-spacing:.15em;
      text-transform:uppercase;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:10px;
      text-decoration:none;
      transition: transform .12s ease, border-color .12s ease;
      margin-top:10px;
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
:root{--bg:#050509;--card:rgba(18,20,31,.95);--border:rgba(255,255,255,.08);--text:#f5f5f7;--muted:#9ca3af;--accent:#ffb300;}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#20263a 0,transparent 55%),radial-gradient(circle at bottom,#111827 0,#020617 65%);
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
input,select,button{width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)}
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
/* ===== DASHBOARD ICON CARDS ===== */
.grid4{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}
@media (max-width:900px){
  .grid4{grid-template-columns:repeat(2,1fr)}
}
@media (max-width:520px){
  .grid4{grid-template-columns:1fr}
}

.tile{
  background:rgba(15,23,42,.65);
  border:1px solid rgba(255,255,255,.08);
  border-radius:18px;
  padding:14px;
  display:flex;
  gap:12px;
  align-items:center;
  transition:transform .12s ease,border-color .12s ease;
}
.tile:hover{
  transform:translateY(-2px);
  border-color:rgba(255,179,0,.45);
}

.ico{
  width:44px;
  height:44px;
  border-radius:14px;
  display:flex;
  align-items:center;
  justify-content:center;
  background:rgba(255,179,0,.12);
  border:1px solid rgba(255,179,0,.25);
  font-size:20px;
}

.t1{
  font-family:Orbitron;
  letter-spacing:.08em;
  text-transform:uppercase;
  margin:0;
  font-size:14px;
}
.t2{
  margin:2px 0 0;
  color:var(--muted);
  font-size:12px;
  line-height:1.4;
}

.smallrow{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}
.smallrow>*{
  flex:1;
  min-width:200px;
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

// SCRIMS LIST
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
      <td style="width:460px">
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
app.get("/scrims/:id/settings", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  res.send(renderLayout({
    title: "Scrim Settings",
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
      <h2 class="h">Settings — ${esc(scrim.name)}</h2>
      <form method="POST" action="/scrims/${scrimId}/edit">

        <label>Name</label>
        <input name="name" value="${esc(scrim.name)}" />

        <div class="row">
          <div><label>Min Slot</label><input name="minSlot" type="number" value="${scrim.min_slot}"/></div>
          <div><label>Max Slot</label><input name="maxSlot" type="number" value="${scrim.max_slot}"/></div>
        </div>

        <label>Registration Channel ID</label>
        <input name="registrationChannelId" value="${esc(scrim.registration_channel_id || "")}" />

        <label>List Channel ID</label>
        <input name="listChannelId" value="${esc(scrim.list_channel_id || "")}" />

        <label>Confirm Channel ID</label>
        <input name="confirmChannelId" value="${esc(scrim.confirm_channel_id || "")}" />

        <label>Team Role ID</label>
        <input name="teamRoleId" value="${esc(scrim.team_role_id || "")}" />

        <div class="row">
          <div><label>Reg Open</label><input name="openAt" value="${esc(scrim.open_at || "")}"/></div>
          <div><label>Reg Close</label><input name="closeAt" value="${esc(scrim.close_at || "")}"/></div>
        </div>

        <div class="row">
          <div><label>Confirm Open</label><input name="confirmOpenAt" value="${esc(scrim.confirm_open_at || "")}"/></div>
          <div><label>Confirm Close</label><input name="confirmCloseAt" value="${esc(scrim.confirm_close_at || "")}"/></div>
        </div>

        <button type="submit">Save Settings</button>
      </form>
    `
  }));
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

  res.redirect("/scrims");
});

// ✅ MANAGE SCRIM PAGE (THIS FIXES /scrims/:id)
app.get("/scrims/:id", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  if (!guildId) return res.redirect("/servers");

  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  res.send(renderLayout({
    title: `Scrim ${scrim.id}`,
    user: req.session.user,
    selectedGuild: { id: guildId, name: req.session.selectedGuildName || "Selected" },
    active: "scrims",
    body: `
      <h2 class="h">${esc(scrim.name)}</h2>
      <p class="muted">Choose what you want to manage.</p>

      <div class="grid4">
        <a class="tile" href="/scrims/${scrimId}/settings">
          <div class="ico">⚙️</div>
          <div><p class="t1">Settings</p><p class="t2">Channels, role, times, limits</p></div>
        </a>

        <a class="tile" href="/scrims/${scrimId}/messages">
          <div class="ico">📨</div>
          <div><p class="t1">Messages</p><p class="t2">Post Reg/List/Confirm embeds</p></div>
        </a>

        <a class="tile" href="/scrims/${scrimId}/slots">
          <div class="ico">🎞️</div>
          <div><p class="t1">Slots</p><p class="t2">Template, spam mode, post all GIF slots</p></div>
        </a>

        <a class="tile" href="/scrims/${scrimId}/results">
          <div class="ico">🏆</div>
          <div><p class="t1">Results</p><p class="t2">Enter G1–G4 points</p></div>
        </a>
      </div>

      <div style="margin-top:14px" class="smallrow">
        <form method="POST" action="/scrims/${scrimId}/toggleReg" style="margin:0">
          <button class="btn2" type="submit">${scrim.registration_open ? "Close Registration" : "Open Registration"}</button>
        </form>
        <form method="POST" action="/scrims/${scrimId}/toggleConfirm" style="margin:0">
          <button class="btn2" type="submit">${scrim.confirm_open ? "Close Confirms" : "Open Confirms"}</button>
        </form>
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
  res.redirect(`/scrims/${scrimId}`);
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
  await updateTeamsListEmbed(fresh).catch(() => {});
  await updateConfirmEmbed(fresh).catch(() => {});
  res.redirect(`/scrims/${scrimId}`);
});

app.post("/scrims/:id/toggleConfirm", requireLogin, async (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);

  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const next = scrim.confirm_open ? 0 : 1;
  q.setConfirmOpen.run(next, scrimId, guildId);

  const fresh = q.scrimById.get(scrimId);
  await updateTeamsListEmbed(fresh).catch(() => {});
  await updateConfirmEmbed(fresh).catch(() => {});
  res.redirect(`/scrims/${scrimId}`);
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

      <form method="POST" action="/scrims/${scrimId}/slotsSettings">
        <label>Slots Channel ID</label>
        <input name="slotsChannelId" value="${esc(scrim.slots_channel_id || "")}" placeholder="channel id" />

        <label>Template</label>
        <select name="slotTemplate" style="width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)">
          <option value="">-- choose --</option>
          ${options}
        </select>

        <label>Spam Mode</label>
        <select name="slotsSpam" style="width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.9);color:var(--text)">
          <option value="0" ${scrim.slots_spam ? "" : "selected"}>OFF (one message)</option>
          <option value="1" ${scrim.slots_spam ? "selected" : ""}>ON (post every slot)</option>
        </select>

        <button type="submit" style="margin-top:12px">Save Slot Settings</button>
      </form>

      <hr class="hr"/>

      <form method="POST" action="/scrims/${scrimId}/postSlots" style="margin:0">
        <button type="submit">🎞️ Post Slots Now</button>
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
    if (!chan || chan.type !== ChannelType.GuildText) return res.status(400).send("Slots channel invalid.");

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

// RESULTS
app.get("/scrims/:id/results", requireLogin, (req, res) => {
  const guildId = req.session.selectedGuildId;
  const scrimId = Number(req.params.id);
  const scrim = q.scrimById.get(scrimId);
  if (!scrim || scrim.guild_id !== guildId) return res.status(404).send("Scrim not found");

  const teams = q.teamsByScrim.all(scrimId);
  const results = q.resultsByScrim.all(scrimId);
  const bySlot = new Map(results.map((r) => [r.slot, r]));

  const rows = teams
    .map((t) => {
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
    })
    .join("");

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

  res.send(renderRegisterPage("Registered", `
    <h1>Registered ✅</h1>
    <div class="boxOk">
      Team: <b>${esc(teamName)}</b> [${esc(teamTag)}]<br/>
      Slot: <b>#${slot}</b>
    </div>
  `));
});

// HEALTH
app.get("/health", (req, res) => res.json({ ok: true }));

// START
app.listen(PORT, () => console.log(`🌐 Web running: ${BASE} (port ${PORT})`));
registerCommands().catch((e) => console.error("Command register error:", e));
discord.login(DISCORD_TOKEN);














