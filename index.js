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

// GET /register
app.get("/register", (req, res) => {
  if (registeredTeams.length >= MAX_TEAMS || availableSlots.length === 0) {
    return res.send(`
      <h1 style="background:black;color:red;text-align:center;padding:40px;">
        ❌ All slots are full. Registration is closed.
      </h1>
    `);
  }

  const userId = req.query.user;
  if (!userId) {
    return res.send(`
      <h1 style="background:black;color:white;text-align:center;padding:40px;">
        ⚠ Invalid link<br><br>
        Please click the **Register Team** button inside Discord again.
      </h1>
    `);
  }

  const existing = findTeamByUser(userId);
  if (existing) {
    return res.send(`
      <h1 style="background:black;color:lightgreen;text-align:center;padding:40px;">
        ✅ You are already registered
      </h1>
      <p style="background:black;color:white;text-align:center;">
        Team: <strong>${existing.teamName}</strong> [${existing.teamTag}]<br/>
        Slot: <strong>${existing.slot}</strong><br/>
        Status: <strong>${existing.status}</strong>
      </p>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <body style="background:black;color:white;text-align:center;padding:40px;">
        <h1>Team Registration</h1>
        <p>Discord ID: <code>${userId}</code></p>
        <form action="/register" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="userId" value="${userId}" />
          <input name="teamName" placeholder="Team Name" required /><br/><br/>
          <input name="teamTag" placeholder="Team Tag" maxlength="6" required /><br/><br/>
          <input type="file" name="teamLogo" required /><br/><br/>
          <button type="submit">Register Team</button>
        </form>
      </body>
    </html>
  `);
});

// POST /register
app.post("/register", upload.single("teamLogo"), async (req, res) => {
  const { teamName, teamTag, userId } = req.body;
  const file = req.file;

  if (!userId) {
    return res.send(`
      <h1 style="background:black;color:red;text-align:center;padding:40px;">
        ⚠ Missing user ID. Please re-open the form from Discord.
      </h1>
    `);
  }

  if (registeredTeams.length >= MAX_TEAMS || availableSlots.length === 0) {
    return res.send(`
      <h1 style="background:black;color:red;text-align:center;padding:40px;">
        ❌ All slots are full. Registration is closed.
      </h1>
    `);
  }

  const existing = findTeamByUser(userId);
  if (existing) {
    return res.send(`
      <h1 style="background:black;color:lightgreen;text-align:center;padding:40px;">
        ✅ You are already registered
      </h1>
      <p style="background:black;color:white;text-align:center;">
        Team: <strong>${existing.teamName}</strong> [${existing.teamTag}]<br/>
        Slot: <strong>${existing.slot}</strong><br/>
        Status: <strong>${existing.status}</strong>
      </p>
    `);
  }

  const slot = getNextSlot();
  if (!slot) {
    return res.send(`
      <h1 style="background:black;color:red;text-align:center;padding:40px;">
        ❌ All slots are full. Registration is closed.
      </h1>
    `);
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

  // 🔹 NEW: auto-give role right after registration (if approverRoleId is set)
  if (staffConfig.approverRoleId) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(userId);
      await member.roles.add(staffConfig.approverRoleId);
      console.log(
        `✅ Gave role ${staffConfig.approverRoleId} to user ${userId} after registration.`
      );
    } catch (err) {
      console.error("Error giving role on registration:", err.message || err);
    }
  } else {
    console.warn("No approverRoleId set in staff_config.json. Run /setapproverole.");
  }

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

  res.send(`
    <h1 style="background:black;color:lightgreen;text-align:center;padding:40px;">
      ✅ Team Registered
    </h1>
    <p style="background:black;color:white;text-align:center;">
      Team: <strong>${teamName}</strong> [${teamTag}]<br/>
      Slot: <strong>${slot}</strong><br/>
      Status: <strong>pending</strong><br/>
      You should now have access to the scrims role in Discord.
    </p>
  `);
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

  // NOTE: not a Link button, we use customId to inject ?user=ID
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
      .setDescription("Set role to give when a team registers")
      .addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Role to give on registration")
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
          content: `✅ Registration role set to ${role}`,
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

          // 🔹 CHANGED: we no longer give the role here,
          // because it's already given at registration time.

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
