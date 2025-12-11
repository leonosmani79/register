// index.js
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
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
  MessageFlags,
} = require("discord.js");
const { google } = require("googleapis");

// ---------------------- CONFIG & ENV ---------------------- //

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CLIENT_ID,
  PORT = 3010,
  BASE_URL,
  SHEET_ID,
  GOOGLE_CREDENTIALS,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !CLIENT_ID) {
  console.error("❌ Missing DISCORD_TOKEN, GUILD_ID or CLIENT_ID in .env");
  process.exit(1);
}
if (!SHEET_ID || !GOOGLE_CREDENTIALS) {
  console.warn(
    "⚠ Google Sheets not fully configured (SHEET_ID / GOOGLE_CREDENTIALS). Sheets append may fail."
  );
}

// staff_config.json
let staffConfig;
try {
  staffConfig = require("./staff_config.json");
} catch (e) {
  staffConfig = { staffChannelId: null, approverRoleId: null };
}

// ---------------------- GLOBAL REGISTRATION STATE ---------------------- //

const MIN_SLOT = 2;
const MAX_SLOT = 25;
const MAX_TEAMS = MAX_SLOT - MIN_SLOT + 1; // 24

let registeredTeams = [];
let activeRegistrationChannels = new Set();
let availableSlots = [];
for (let i = MIN_SLOT; i <= MAX_SLOT; i++) {
  availableSlots.push(i);
}

// helpers to manage slots
function getNextSlot() {
  if (availableSlots.length === 0) return null;
  return availableSlots.shift();
}
function freeSlot(slot) {
  if (!Number.isInteger(slot)) return;
  if (!availableSlots.includes(slot)) {
    availableSlots.push(slot);
    availableSlots.sort((a, b) => a - b);
  }
}

// find a team by user or by slot+user
function findTeamByUser(userId) {
  return registeredTeams.find(
    (t) => t.userId === userId && t.status !== "removed"
  );
}
function findTeamBySlotAndUser(slot, userId) {
  return registeredTeams.find(
    (t) => t.slot === slot && t.userId === userId && t.status !== "removed"
  );
}

// ---------------------- GOOGLE SHEETS ---------------------- //

async function appendToGoogleSheet(slot, teamName, teamTag, logoFile, userId) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_CREDENTIALS,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:F",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            slot,
            teamName,
            teamTag,
            logoFile || "none",
            userId,
            new Date().toLocaleString(),
          ],
        ],
      },
    });

    console.log("✔ Added to Google Sheet:", teamName);
  } catch (err) {
    console.error("Google Sheets Error:", err.message || err);
  }
}

// ---------------------- EXPRESS (WEB SERVER) ---------------------- //

const app = express();
app.use(express.urlencoded({ extended: true }));

// 🔥 Styled HTML helper
function renderPage({ title, body }) {
  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>${title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;800&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg: #050509;
          --card-bg: rgba(18, 20, 31, 0.95);
          --accent: #ffb300;
          --accent-soft: rgba(255, 179, 0, 0.2);
          --danger: #ff4b4b;
          --success: #4caf50;
          --border: rgba(255, 255, 255, 0.06);
          --text-main: #f5f5f7;
          --text-sub: #9ca3af;
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background:
            radial-gradient(circle at top, #20263a 0, transparent 55%),
            radial-gradient(circle at bottom, #111827 0, #020617 65%);
          color: var(--text-main);
          font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .glow-orb {
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0.4;
          background:
            radial-gradient(circle at 10% 20%, rgba(255, 179, 0, 0.18) 0, transparent 55%),
            radial-gradient(circle at 80% 70%, rgba(56, 189, 248, 0.16) 0, transparent 55%);
          z-index: -1;
        }

        .wrapper { width: 100%; max-width: 520px; }

        .card {
          position: relative;
          background: var(--card-bg);
          border-radius: 18px;
          padding: 28px 26px 24px;
          border: 1px solid var(--border);
          box-shadow:
            0 25px 40px rgba(0, 0, 0, 0.7),
            0 0 0 1px rgba(148, 163, 184, 0.12);
          backdrop-filter: blur(22px);
        }

        .card::before {
          content: "";
          position: absolute;
          inset: -1px;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(135deg, rgba(255, 179, 0, 0.35), rgba(56, 189, 248, 0.2));
          mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          mask-composite: exclude;
          opacity: 0.75;
          pointer-events: none;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          background: rgba(15, 23, 42, 0.85);
          border: 1px solid rgba(148, 163, 184, 0.45);
          color: var(--text-sub);
          margin-bottom: 12px;
        }

        .badge-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--accent);
          box-shadow: 0 0 12px rgba(255, 179, 0, 0.8);
        }

        h1 {
          margin: 0;
          font-family: "Orbitron", system-ui;
          font-size: 26px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .tagline {
          margin-top: 8px;
          font-size: 13px;
          color: var(--text-sub);
        }

        .divider {
          margin: 18px 0;
          height: 1px;
          border: none;
          background: linear-gradient(to right, transparent, rgba(148, 163, 184, 0.5), transparent);
        }

        .status-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 9px;
          border-radius: 999px;
          font-size: 11px;
          background: rgba(15, 23, 42, 0.9);
          border: 1px solid rgba(148, 163, 184, 0.5);
          color: var(--text-sub);
          margin-top: 6px;
        }

        .status-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
        }
        .status-dot.green { background: var(--success); box-shadow: 0 0 12px rgba(74, 222, 128, 0.8); }
        .status-dot.red { background: var(--danger); box-shadow: 0 0 12px rgba(248, 113, 113, 0.8); }
        .status-dot.amber { background: var(--accent); box-shadow: 0 0 12px rgba(253, 224, 71, 0.8); }

        form {
          margin-top: 8px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        label {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--text-sub);
          display: flex;
          justify-content: space-between;
          margin-bottom: 4px;
        }

        .label-hint {
          font-size: 10px;
          color: rgba(148, 163, 184, 0.9);
        }

        input[type="text"],
        input[type="file"] {
          width: 100%;
          padding: 10px 11px;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.5);
          background: rgba(15, 23, 42, 0.95);
          color: var(--text-main);
          font-size: 14px;
          outline: none;
          transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
        }

        input[type="text"]:focus,
        input[type="file"]:focus {
          border-color: var(--accent);
          background: rgba(15, 23, 42, 1);
          box-shadow: 0 0 0 1px rgba(255, 179, 0, 0.45), 0 0 18px rgba(255, 179, 0, 0.3);
        }

        input[type="file"] {
          padding: 7px 8px;
          font-size: 13px;
        }

        .fields-row {
          display: flex;
          gap: 12px;
        }

        .fields-row .field { flex: 1; }

        button[type="submit"] {
          margin-top: 8px;
          width: 100%;
          padding: 11px 14px;
          border-radius: 999px;
          border: none;
          cursor: pointer;
          font-family: "Orbitron", system-ui;
          font-size: 14px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          background: radial-gradient(circle at 0 0, #fde68a 0, #f97316 40%, #ea580c 60%, #7c2d12 100%);
          color: #0b0b10;
          box-shadow:
            0 12px 24px rgba(0, 0, 0, 0.75),
            0 0 24px rgba(249, 115, 22, 0.75);
          transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
        }

        button[type="submit"]:hover {
          transform: translateY(-1px);
          filter: brightness(1.05);
          box-shadow:
            0 18px 36px rgba(0, 0, 0, 0.9),
            0 0 32px rgba(249, 115, 22, 0.9);
        }

        button[type="submit"]:active {
          transform: translateY(0);
          filter: brightness(0.96);
          box-shadow:
            0 10px 20px rgba(0, 0, 0, 0.8),
            0 0 22px rgba(249, 115, 22, 0.7);
        }

        .meta {
          margin-top: 14px;
          display: flex;
          justify-content: space-between;
          gap: 8px;
          font-size: 11px;
          color: var(--text-sub);
        }

        .meta strong { color: var(--accent); }

        .note {
          margin-top: 10px;
          font-size: 11px;
          color: rgba(156, 163, 175, 0.95);
        }

        .note span {
          color: var(--accent);
          font-family: "Orbitron", system-ui;
          letter-spacing: 0.08em;
        }

        .center-text { text-align: center; }

        .center-text p {
          margin: 6px 0 0;
          font-size: 13px;
          color: var(--text-sub);
        }

        .status-big {
          margin-top: 14px;
          padding: 9px 11px;
          border-radius: 10px;
          font-size: 13px;
          line-height: 1.45;
        }

        .status-big.success {
          background: rgba(34, 197, 94, 0.12);
          border: 1px solid rgba(34, 197, 94, 0.65);
          color: #bbf7d0;
        }

        .status-big.error {
          background: rgba(248, 113, 113, 0.08);
          border: 1px solid rgba(248, 113, 113, 0.6);
          color: #fecaca;
        }

        code {
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-size: 11px;
          background: rgba(15, 23, 42, 0.9);
          padding: 2px 5px;
          border-radius: 5px;
          border: 1px solid rgba(148, 163, 184, 0.45);
        }

        @media (max-width: 520px) {
          .card { padding: 22px 18px 18px; }
          h1 { font-size: 22px; }
          .fields-row { flex-direction: column; }
        }
      </style>
    </head>
    <body>
      <div class="glow-orb"></div>
      <div class="wrapper">
        <div class="card">
          ${body}
        </div>
      </div>
    </body>
  </html>
  `;
}

// uploads dir
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});
const upload = multer({ storage });

const publicBaseUrl = BASE_URL || `http://localhost:${PORT}`;

// ---------------------- ROUTES ---------------------- //

// GET /register (styled)
app.get("/register", (req, res) => {
  if (registeredTeams.length >= MAX_TEAMS || availableSlots.length === 0) {
    return res.send(
      renderPage({
        title: "Registration Closed",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            LOBBY STATUS
          </div>
          <h1>Lobby Full</h1>
          <p class="tagline">
            All available slots for this scrim lobby have been claimed.
          </p>
          <hr class="divider" />
          <div class="center-text">
            <div class="status-big error">
              ❌ Registration is currently <strong>closed</strong>.<br/>
              Please wait for the next lobby announcement in Discord.
            </div>
          </div>
        `,
      })
    );
  }

  const userId = req.query.user;
  if (!userId) {
    return res.send(
      renderPage({
        title: "Invalid Link",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            ACCESS LINK
          </div>
          <h1>Link Invalid</h1>
          <p class="tagline">
            This registration URL is missing the Discord user reference.
          </p>
          <hr class="divider" />
          <div class="status-big error">
            ⚠ Please return to the Discord server and click
            <strong>Register Team</strong> again to get a fresh link.
          </div>
        `,
      })
    );
  }

  const existing = findTeamByUser(userId);
  if (existing) {
    return res.send(
      renderPage({
        title: "Already Registered",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            TEAM STATUS
          </div>
          <h1>You&apos;re In</h1>
          <p class="tagline">
            This Discord account is already linked to a registered team.
          </p>
          <hr class="divider" />
          <div class="status-big success">
            ✅ <strong>Team:</strong> ${existing.teamName} [${existing.teamTag}]<br/>
            🎯 <strong>Slot:</strong> #${existing.slot}<br/>
            📡 <strong>Status:</strong> ${existing.status.toUpperCase()}
          </div>
          <p class="note">
            If you need to update your team, contact a staff member in Discord.
          </p>
        `,
      })
    );
  }

  // normal registration form
  res.send(
    renderPage({
      title: "Register Your Team",
      body: `
        <div class="badge">
          <span class="badge-dot"></span>
          PUBGM SCRIM REGISTRATION
        </div>

        <h1>
          DarkSide Lobby
          <span style="font-size: 11px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.16em; color: var(--text-sub);">
            SIGN-UP
          </span>
        </h1>

        <p class="tagline">
          Submit your squad details to lock in your slot for the next lobby.
        </p>

        <div class="status-pill">
          <span class="status-dot amber"></span>
          Linked Discord ID: <code>${userId}</code>
        </div>

        <hr class="divider" />

        <form action="/register" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="userId" value="${userId}" />

          <div class="field">
            <label>
              TEAM NAME
              <span class="label-hint">Full squad name as it should appear on overlays</span>
            </label>
            <input
              type="text"
              name="teamName"
              placeholder="e.g. DarkSide Esports"
              required
            />
          </div>

          <div class="fields-row">
            <div class="field">
              <label>
                TEAM TAG
                <span class="label-hint">Max 6 characters</span>
              </label>
              <input
                type="text"
                name="teamTag"
                placeholder="DS"
                maxlength="6"
                required
              />
            </div>

            <div class="field">
              <label>
                TEAM LOGO
                <span class="label-hint">PNG / JPG, square preferred</span>
              </label>
              <input
                type="file"
                name="teamLogo"
                accept="image/png, image/jpeg, image/jpg"
                required
              />
            </div>
          </div>

          <button type="submit">
            Confirm Squad
          </button>

          <div class="meta">
            <div>
              <strong>Reminder:</strong> One team per Discord account.
            </div>
            <div>
              Slots are confirmed after staff <strong>approval</strong>.
            </div>
          </div>

          <p class="note">
            After submitting, your team will appear in the staff panel for review.
            Watch the Discord announcements for slot confirmations.
          </p>
        </form>
      `,
    })
  );
});

// POST /register (styled responses)
app.post("/register", upload.single("teamLogo"), async (req, res) => {
  const { teamName, teamTag, userId } = req.body;
  const file = req.file;

  if (!userId) {
    return res.send(
      renderPage({
        title: "Missing User ID",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            ACCESS LINK
          </div>
          <h1>Link Error</h1>
          <p class="tagline">
            This registration URL is missing the Discord user reference.
          </p>
          <hr class="divider" />
          <div class="status-big error">
            ⚠ Please return to the Discord server and click
            <strong>Register Team</strong> again to get a fresh link.
          </div>
        `,
      })
    );
  }

  if (registeredTeams.length >= MAX_TEAMS || availableSlots.length === 0) {
    return res.send(
      renderPage({
        title: "Registration Closed",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            LOBBY STATUS
          </div>
          <h1>Lobby Full</h1>
          <p class="tagline">
            All available slots for this scrim lobby have been claimed.
          </p>
          <hr class="divider" />
          <div class="status-big error">
            ❌ Registration is currently <strong>closed</strong>.<br/>
            Please wait for the next lobby announcement in Discord.
          </div>
        `,
      })
    );
  }

  const existing = findTeamByUser(userId);
  if (existing) {
    return res.send(
      renderPage({
        title: "Already Registered",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            TEAM STATUS
          </div>
          <h1>You&apos;re In</h1>
          <p class="tagline">
            This Discord account is already linked to a registered team.
          </p>
          <hr class="divider" />
          <div class="status-big success">
            ✅ <strong>Team:</strong> ${existing.teamName} [${existing.teamTag}]<br/>
            🎯 <strong>Slot:</strong> #${existing.slot}<br/>
            📡 <strong>Status:</strong> ${existing.status.toUpperCase()}
          </div>
          <p class="note">
            If you need to update your team, contact a staff member in Discord.
          </p>
        `,
      })
    );
  }

  const slot = getNextSlot();
  if (!slot) {
    return res.send(
      renderPage({
        title: "Registration Closed",
        body: `
          <div class="badge">
            <span class="badge-dot"></span>
            LOBBY STATUS
          </div>
          <h1>Lobby Full</h1>
          <p class="tagline">
            All available slots for this scrim lobby have been claimed.
          </p>
          <hr class="divider" />
          <div class="status-big error">
            ❌ Registration is currently <strong>closed</strong>.
          </div>
        `,
      })
    );
  }

  const team = {
    slot,
    teamName,
    teamTag,
    logo: file?.filename || null,
    userId,
    status: "pending",
    registeredAt: new Date(),
  };
  registeredTeams.push(team);

  // save to Google Sheets
  appendToGoogleSheet(slot, teamName, teamTag, team.logo, userId).catch(() => {});

  console.log(`Team registered → Slot ${slot}: ${teamName} [${teamTag}] (user ${userId})`);

  // send to staff channel
  if (staffConfig.staffChannelId) {
    try {
      const staffChannel = await client.channels.fetch(staffConfig.staffChannelId);

      const embed = new EmbedBuilder()
        .setTitle("New Team Registration")
        .setColor(0x5865f2)
        .addFields(
          { name: "Team", value: `${teamName} [${teamTag}]`, inline: false },
          { name: "Slot", value: `#${slot}`, inline: true },
          { name: "Player", value: `<@${userId}> \`(${userId})\``, inline: true },
        )
        .setTimestamp(team.registeredAt);

      if (team.logo) {
        embed.addFields({
          name: "Logo File",
          value: team.logo,
          inline: false,
        });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve:${slot}:${userId}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`remove:${slot}:${userId}`)
          .setLabel("Remove")
          .setStyle(ButtonStyle.Danger),
      );

      await staffChannel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error("Error sending to staff channel:", err.message || err);
    }
  }

  // if now full => notify staff + disable registration buttons
  if (availableSlots.length === 0) {
    if (staffConfig.staffChannelId) {
      try {
        const staffChannel = await client.channels.fetch(staffConfig.staffChannelId);

        let text = "⛔ **All Registration Slots Are Now Full**\n\n**Final Team List:**\n";
        registeredTeams.forEach((t) => {
          text += `• Slot ${t.slot}: ${t.teamName} [${t.teamTag}] (${t.status})\n`;
        });

        await staffChannel.send(text);
      } catch (err) {
        console.error("Error sending full list to staff channel:", err.message || err);
      }
    }

    for (const channelId of activeRegistrationChannels) {
      try {
        const channel = await client.channels.fetch(channelId);
        const messages = await channel.messages.fetch({ limit: 20 });
        const regMessage = messages.find(
          (m) => m.author.id === client.user.id && m.components.length > 0
        );
        if (regMessage) {
          await regMessage.edit({ components: [] });
        }
        await channel.send("⛔ Registration Closed — Slots Full.");
      } catch (err) {
        console.error("Error closing registration channel:", err.message || err);
      }
    }
  }

  // success page
  return res.send(
    renderPage({
      title: "Team Registered",
      body: `
        <div class="badge">
          <span class="badge-dot"></span>
          REGISTRATION COMPLETE
        </div>

        <h1>Squad Locked</h1>
        <p class="tagline">
          Your team has been submitted to the DarkSide staff panel.
        </p>

        <hr class="divider" />

        <div class="status-big success">
          ✅ <strong>Team:</strong> ${teamName} [${teamTag}]<br/>
          🎯 <strong>Slot:</strong> #${slot}<br/>
          ⏱ <strong>Status:</strong> PENDING APPROVAL
        </div>

        <p class="note">
          Once approved by staff, your in-game slot and role will be confirmed.
          Make sure all players are ready in time for the lobby start.
        </p>

        <div class="center-text" style="margin-top: 10px;">
          <p>You can now safely close this tab and return to Discord.</p>
        </div>
      `,
    })
  );
});

// static logos if you ever need to serve them
app.use("/logos", express.static(uploadDir));

// ---------------------- DISCORD BOT ---------------------- //

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// embed & button for /startregister
function buildRegistrationMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Team Registration")
    .setDescription(
      [
        "Click **Register Team** to get your personal registration link.",
        "",
        "Each Discord account can register **one** team.",
        `Available slots: **${MIN_SLOT}–${MAX_SLOT}**`,
      ].join("\n")
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_register_link")
      .setLabel("Register Team")
      .setStyle(ButtonStyle.Primary)
  );

  return { embed, row };
}

// Slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setstaffchannel")
      .setDescription("Set staff channel for registration notifications")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Staff channel")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("setapproverole")
      .setDescription("Set role to give when a team is approved")
      .addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Approval role")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("startregister")
      .setDescription("Start registration in this channel")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel to post the embed in")
          .setRequired(true)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("✅ Slash commands registered.");
}

registerCommands().catch((e) =>
  console.error("Error registering commands:", e.message || e)
);

// ready
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// interactions
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setstaffchannel") {
        const chan = interaction.options.getChannel("channel");
        if (!chan || chan.type !== ChannelType.GuildText) {
          return interaction.reply({
            content: "Please select a **text channel**.",
            flags: MessageFlags.Ephemeral,
          });
        }
        staffConfig.staffChannelId = chan.id;
        fs.writeFileSync(
          path.join(__dirname, "staff_config.json"),
          JSON.stringify(staffConfig, null, 2)
        );
        return interaction.reply({
          content: `📌 Staff channel set to ${chan}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === "setapproverole") {
        const role = interaction.options.getRole("role");
        staffConfig.approverRoleId = role.id;
        fs.writeFileSync(
          path.join(__dirname, "staff_config.json"),
          JSON.stringify(staffConfig, null, 2)
        );
        return interaction.reply({
          content: `✅ Approver role set to ${role}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === "startregister") {
        const chan = interaction.options.getChannel("channel");
        if (!chan || chan.type !== ChannelType.GuildText) {
          return interaction.reply({
            content: "Please select a **text channel**.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const { embed, row } = buildRegistrationMessage();
        await chan.send({ embeds: [embed], components: [row] });

        activeRegistrationChannels.add(chan.id);

        return interaction.reply({
          content: `✅ Registration started in ${chan}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      return;
    }

    // button interactions
    if (interaction.isButton()) {
      const { customId } = interaction;

      // user clicks "Register Team" button in public channel
      if (customId === "open_register_link") {
        const url = `${publicBaseUrl}/register?user=${interaction.user.id}`;
        return interaction.reply({
          content: `Here is your personal registration link:\n${url}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // staff clicks Approve / Remove
      if (customId.startsWith("approve:") || customId.startsWith("remove:")) {
        const [action, slotStr, userId] = customId.split(":");
        const slot = parseInt(slotStr, 10);

        const team = findTeamBySlotAndUser(slot, userId);
        if (!team) {
          return interaction.reply({
            content: "Could not find this registration (maybe already removed).",
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === "approve") {
          team.status = "accepted";

          // give role if configured
          if (staffConfig.approverRoleId && interaction.guild) {
            try {
              const member = await interaction.guild.members.fetch(userId);
              await member.roles.add(staffConfig.approverRoleId);
            } catch (err) {
              console.error("Error giving role:", err.message || err);
            }
          }

          // disable buttons on the message
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(customId)
              .setLabel("Approved")
              .setStyle(ButtonStyle.Success)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId("noop_remove")
              .setLabel("Remove")
              .setStyle(ButtonStyle.Danger)
              .setDisabled(true)
          );

          await interaction.update({
            components: [disabledRow],
          });

          return interaction.followUp({
            content: `✅ Approved team **${team.teamName} [${team.teamTag}]** (slot ${team.slot}).`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === "remove") {
          team.status = "removed";
          freeSlot(team.slot);

          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("noop_approve")
              .setLabel("Approve")
              .setStyle(ButtonStyle.Success)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(customId)
              .setLabel("Removed")
              .setStyle(ButtonStyle.Danger)
              .setDisabled(true)
          );

          await interaction.update({
            components: [disabledRow],
          });

          return interaction.followUp({
            content: `⛔ Removed team **${team.teamName} [${team.teamTag}]** and freed slot ${team.slot}.`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    }
  } catch (err) {
    console.error("Interaction error:", err.message || err);
    if (interaction.isRepliable()) {
      interaction
        .reply({
          content: "❌ Something went wrong handling this interaction.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
});

// ---------------------- START ---------------------- //

app.listen(PORT, () => {
  console.log(`Web server running on ${publicBaseUrl}`);
});

client.login(DISCORD_TOKEN);
