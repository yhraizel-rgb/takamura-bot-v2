import express from "express";
import fs from "fs-extra";
import path from "path";
import pino from "pino";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import chalk from "chalk";

import {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
  jidNormalizedUser
} from "@whiskeysockets/baileys";

// ════════════════════════════════════════════════════════════════
//  FILETS DE SÉCURITÉ GLOBAUX
//  Une erreur non interceptée quelque part (WhatsApp, Telegram,
//  Express) ne doit jamais faire tomber tout le process.
// ════════════════════════════════════════════════════════════════
process.on("uncaughtException", (err) => {
  console.error(chalk.red(`[FATAL] Exception non interceptée : ${err?.stack || err}`));
});
process.on("unhandledRejection", (reason) => {
  console.error(chalk.red(`[FATAL] Rejet de promesse non géré : ${reason}`));
});

// ════════════════════════════════════════════════════════════════
//  CONFIGURATION INTERNE (pas de .env, tout est ici)
// ════════════════════════════════════════════════════════════════

// ⚠️ Remplace par ton vrai token Telegram (BotFather).
const TELEGRAM_BOT_TOKEN = "REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN";

// ⚠️ Chat ID numérique du groupe officiel (PAS le lien d'invitation).
// Pour l'obtenir : ajoute ton bot comme admin du groupe, poste un message
// dans le groupe, puis appelle https://api.telegram.org/bot<TOKEN>/getUpdates
// et lis le champ "chat":{"id": ...} (nombre négatif pour un groupe).
// Tant que cette valeur vaut 0, la vérification d'appartenance est
// désactivée automatiquement (pour ne jamais bloquer le bot par erreur).
const TELEGRAM_GROUP_CHAT_ID = 0;

// Lien d'invitation affiché au bouton "Rejoindre le groupe".
const TELEGRAM_GROUP_INVITE_LINK = "https://t.me/+xYpA7fGQ3mxkYWE0";

const TELEGRAM_OWNER_ID = 5913761990;
const TELEGRAM_ADMINS = [
  TELEGRAM_OWNER_ID,
  // AJOUTER_UN_AUTRE_ID_ICI
];

const PORT = process.env.PORT || 80;
const PAIRING_DIR = "./sessions";
const MAX_SESSIONS = 20;

const AUTO_JOIN_GROUP_LINKS = [
  "https://chat.whatsapp.com/Lq7MwZ7IBpyEa46zX50yWR"
];
const AUTO_JOIN_CHANNEL_LINKS = [
  "https://whatsapp.com/channel/0029VbDZMQBFCCoTkkAe5i2X"
];

// ════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL EN MÉMOIRE
// ════════════════════════════════════════════════════════════════

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await fs.ensureDir(PAIRING_DIR);
const bots = new Map();
const startedAt = Date.now();

const stats = {
  messagesProcessed: 0,
  commandsExecuted: 0,
  groupsDetected: new Set(),
  messagesDeleted: 0,
  linksBlocked: 0,
  mediaBlocked: 0,
  usersWarned: 0,
  usersKicked: 0,
  telegramRequests: 0,
  errors: 0
};

const LOGS_MAX = 500;
const logs = [];
function addLog(platform, session, event, severity, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    platform, // "whatsapp" | "telegram" | "system"
    session: session || "-",
    event,
    severity, // "info" | "success" | "warning" | "error"
    message
  };
  logs.push(entry);
  if (logs.length > LOGS_MAX) logs.shift();
  if (severity === "error") stats.errors++;
  const color =
    severity === "error" ? chalk.red :
    severity === "warning" ? chalk.yellow :
    severity === "success" ? chalk.green : chalk.cyan;
  console.log(color(`[${platform.toUpperCase()}${session ? ":" + session : ""}] ${message}`));
  return entry;
}

// Compat : demoteall.js / promoteall.js s'attendent à `global.bots` /
// `global.owners`, comme dans un bot mono-session, avec des JID complets.
global.bots = new Proxy(bots, {
  get(target, prop, receiver) {
    if (prop === "get") {
      return (key) => {
        if (typeof key === "string") {
          const bare = formatNumber(key.split("@")[0]);
          if (target.has(bare)) return target.get(bare);
        }
        return target.get(key);
      };
    }
    return Reflect.get(target, prop, receiver);
  }
});

function formatNumber(num) {
  return String(num).replace(/\D/g, "").replace(/^0+/, "");
}

async function removeSession(dir) {
  if (await fs.pathExists(dir)) await fs.remove(dir);
}

async function countSessions() {
  await fs.ensureDir(PAIRING_DIR);
  const entries = await fs.readdir(PAIRING_DIR);
  let count = 0;
  for (const entry of entries) {
    const stat = await fs.stat(path.join(PAIRING_DIR, entry)).catch(() => null);
    if (stat?.isDirectory()) count++;
  }
  return count;
}

function extractGroupInviteCode(link) {
  const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}
function extractChannelId(link) {
  const match = link.match(/channel\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

async function autoJoinLinks(sock, number) {
  const botJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";

  for (const link of AUTO_JOIN_GROUP_LINKS) {
    const code = extractGroupInviteCode(link);
    if (!code) continue;
    try {
      let alreadyMember = false;
      try {
        const info = await sock.groupGetInviteInfo(code);
        alreadyMember = info?.participants?.some(p => p.id === botJid) || false;
      } catch {}
      if (alreadyMember) continue;
      await sock.groupAcceptInvite(code);
      addLog("whatsapp", number, "auto-join", "success", `A rejoint le groupe (${code})`);
    } catch (e) {
      addLog("whatsapp", number, "auto-join", "warning", `Groupe ${code} : ${e.message}`);
    }
  }

  for (const link of AUTO_JOIN_CHANNEL_LINKS) {
    const id = extractChannelId(link);
    if (!id) continue;
    try {
      await sock.newsletterFollow(`${id}@newsletter`);
      addLog("whatsapp", number, "auto-join", "success", `Suit le canal (${id})`);
    } catch (e) {
      addLog("whatsapp", number, "auto-join", "warning", `Canal ${id} : ${e.message}`);
    }
  }
}

async function closeExistingSocket(bot) {
  if (!bot?.sock) return;
  try {
    bot.sock.ev.removeAllListeners();
    bot.sock.end?.(undefined);
  } catch (_) {}
}

async function loadCommands() {
  const commands = new Map();
  const folder = "./commands";
  await fs.ensureDir(folder);
  for (const file of (await fs.readdir(folder)).filter(f => f.endsWith(".js"))) {
    try {
      const cmd = await import(`./commands/${file}?v=${Date.now()}`);
      if (cmd.default?.name && typeof cmd.default.execute === "function") {
        commands.set(cmd.default.name.toLowerCase(), cmd.default);
      }
    } catch (e) {
      addLog("whatsapp", "-", "load-command", "error", `${file} : ${e.message}`);
    }
  }
  return commands;
}

function loadLidFromSessionCreds(number, sessionDir) {
  const credsPath = path.join(sessionDir, "creds.json");
  try {
    if (!fs.existsSync(credsPath)) return false;
    const credsData = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    const sessionLid = credsData?.me?.lid || "";
    if (!sessionLid) return false;
    const lidNumber = formatNumber(sessionLid.split(":")[0]);
    if (!lidNumber) return false;
    const bot = bots.get(number);
    if (!bot) return false;
    if (!bot.config.owners) bot.config.owners = [];
    if (!bot.config.owners.includes(lidNumber)) {
      bot.config.owners.push(lidNumber);
      bot.ownerLid = lidNumber;
      addLog("whatsapp", number, "lid", "info", `${lidNumber} ajouté aux owners`);
    }
    return true;
  } catch (e) {
    addLog("whatsapp", number, "lid", "error", e.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//  PROTECTIONS — configuration persistante par session
// ════════════════════════════════════════════════════════════════

function defaultProtectionConfig() {
  return {
    prefix: ".",
    antilink: { enabled: false, action: "delete", allowedDomains: [] },
    antiphoto: { enabled: false, action: "delete" },
    antivideo: { enabled: false, action: "delete" },
    antiaudio: { enabled: false, action: "delete" },
    antidocument: { enabled: false, action: "delete" },
    antisticker: { enabled: false, action: "delete" },
    antispam: { enabled: false, maxMessages: 6, windowSeconds: 10, action: "warn" },
    antitag: { enabled: false, maxMentions: 5, action: "warn" },
    anticall: { enabled: false, action: "reject" },
    welcome: false,
    bye: false,
    welcomeMessage: "Bienvenue @user dans le groupe.",
    byeMessage: "@user a quitté le groupe.",
    autoread: false,
    autoreact: false,
    autotyping: false,
    autorecording: false
  };
}

function protectionConfigPath(sessionDir) {
  return path.join(sessionDir, "protection.json");
}

async function loadProtectionConfig(sessionDir) {
  const file = protectionConfigPath(sessionDir);
  const defaults = defaultProtectionConfig();
  try {
    if (await fs.pathExists(file)) {
      const saved = await fs.readJson(file);
      return { ...defaults, ...saved };
    }
  } catch (e) {
    addLog("system", "-", "config", "error", `Lecture config protection: ${e.message}`);
  }
  return defaults;
}

async function saveProtectionConfig(number) {
  const bot = bots.get(number);
  if (!bot) return false;
  try {
    await fs.writeJson(protectionConfigPath(bot.sessionDir), bot.config, { spaces: 2 });
    return true;
  } catch (e) {
    addLog("system", number, "config", "error", `Écriture config protection: ${e.message}`);
    return false;
  }
}

// Fenêtre glissante anti-spam : Map<number, Map<sender, {count, windowStart}>>
const spamTracker = new Map();

function isGroupAdmin(groupMeta, jid) {
  const p = groupMeta?.participants?.find(x => x.id === jid);
  return p?.admin === "admin" || p?.admin === "superadmin";
}

async function isSenderExempt(sock, bot, number, remoteJid, senderJid, senderNumber) {
  if (senderNumber === number) return true; // le propriétaire de la session
  if ((bot.config.owners || []).includes(senderNumber)) return true;
  try {
    const meta = await sock.groupMetadata(remoteJid);
    if (isGroupAdmin(meta, senderJid)) return true;
  } catch {}
  return false;
}

async function deleteMessageSafe(sock, remoteJid, key) {
  try {
    await sock.sendMessage(remoteJid, { delete: key });
    stats.messagesDeleted++;
    return true;
  } catch (e) {
    return false;
  }
}

async function kickParticipant(sock, remoteJid, participantJid) {
  try {
    await sock.groupParticipantsUpdate(remoteJid, [participantJid], "remove");
    stats.usersKicked++;
    return true;
  } catch (e) {
    return false;
  }
}

async function applyAction(sock, remoteJid, participant, msgKey, action, number, reason) {
  if (action === "delete") {
    await deleteMessageSafe(sock, remoteJid, msgKey);
  } else if (action === "warn") {
    stats.usersWarned++;
    await sock.sendMessage(remoteJid, {
      text: `*_⚠️ @${participant.split("@")[0]} : ${reason}_*`,
      mentions: [participant]
    }).catch(() => {});
  } else if (action === "kick") {
    await deleteMessageSafe(sock, remoteJid, msgKey);
    await kickParticipant(sock, remoteJid, participant);
  } else if (action === "ban") {
    await deleteMessageSafe(sock, remoteJid, msgKey);
    await kickParticipant(sock, remoteJid, participant);
    const bot = bots.get(number);
    if (bot) {
      bot.bannedUsers = bot.bannedUsers || new Set();
      bot.bannedUsers.add(participant);
    }
  }
}

async function runProtections(sock, bot, number, msg, remoteJid, participant, senderNumber, text) {
  if (!remoteJid.endsWith("@g.us")) return; // protections limitées aux groupes
  const cfg = bot.config;
  const exempt = await isSenderExempt(sock, bot, number, remoteJid, participant, senderNumber);
  if (exempt) return;

  const m = msg.message || {};

  // AntiLink
  if (cfg.antilink?.enabled && text) {
    const urlMatch = text.match(/https?:\/\/[^\s]+|www\.[^\s]+|(?:wa\.me|t\.me|chat\.whatsapp\.com)\/[^\s]+/gi);
    if (urlMatch) {
      const allowed = cfg.antilink.allowedDomains || [];
      const blocked = urlMatch.some(u => !allowed.some(d => u.includes(d)));
      if (blocked) {
        stats.linksBlocked++;
        await applyAction(sock, remoteJid, participant, msg.key, cfg.antilink.action, number, "lien non autorisé détecté");
        return;
      }
    }
  }

  // Anti-média
  const mediaMap = {
    imageMessage: "antiphoto",
    videoMessage: "antivideo",
    audioMessage: "antiaudio",
    documentMessage: "antidocument",
    stickerMessage: "antisticker"
  };
  for (const [key, cfgKey] of Object.entries(mediaMap)) {
    if (m[key] && cfg[cfgKey]?.enabled) {
      stats.mediaBlocked++;
      await applyAction(sock, remoteJid, participant, msg.key, cfg[cfgKey].action, number, `${cfgKey} : média bloqué`);
      return;
    }
  }

  // AntiTag (mentions massives)
  const mentioned = m.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (cfg.antitag?.enabled && mentioned.length > (cfg.antitag.maxMentions || 5)) {
    await applyAction(sock, remoteJid, participant, msg.key, cfg.antitag.action, number, "mention massive détectée");
    return;
  }

  // AntiSpam
  if (cfg.antispam?.enabled) {
    const windowMs = (cfg.antispam.windowSeconds || 10) * 1000;
    if (!spamTracker.has(number)) spamTracker.set(number, new Map());
    const tracker = spamTracker.get(number);
    const key = `${remoteJid}:${participant}`;
    const now = Date.now();
    const entry = tracker.get(key) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    tracker.set(key, entry);
    if (entry.count > (cfg.antispam.maxMessages || 6)) {
      await applyAction(sock, remoteJid, participant, msg.key, cfg.antispam.action, number, "spam détecté");
      entry.count = 0;
      entry.windowStart = now;
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  MOTEUR WHATSAPP
// ════════════════════════════════════════════════════════════════

async function startBot(inputNumber) {
  const number = formatNumber(inputNumber);
  if (!number || number.length < 8) throw new Error("Numéro invalide");

  if (bots.has(number)) {
    const existing = bots.get(number);
    if (existing?.linked) return null;
    await closeExistingSocket(existing);
    bots.delete(number);
  }

  const SESSION_DIR = path.join(PAIRING_DIR, number);
  const isNewSession = !(await fs.pathExists(SESSION_DIR));

  if (isNewSession) {
    const current = await countSessions();
    if (current >= MAX_SESSIONS) {
      throw new Error(`Nombre maximum de sessions atteint (${MAX_SESSIONS}).`);
    }
  }

  await fs.ensureDir(SESSION_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
    },
    logger: pino({ level: "silent" }),
    browser: Browsers.windows("Chrome"),
    markOnlineOnConnect: false,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  const commands = await loadCommands();
  const config = await loadProtectionConfig(SESSION_DIR);
  if (!config.owners) config.owners = [];
  const features = {
    autoread: config.autoread,
    autoreact: config.autoreact,
    autotyping: config.autotyping,
    autorecording: config.autorecording,
    welcome: config.welcome,
    bye: config.bye,
    antilink: config.antilink?.enabled || false
  };

  bots.set(number, {
    sock, commands, config, features,
    sessionDir: SESSION_DIR,
    linked: false,
    connectedAt: null,
    messages: 0,
    commandsRun: 0,
    groups: new Set(),
    lastActivity: null,
    bannedUsers: new Set()
  });
  addLog("whatsapp", number, "start", "info", "Bot lancé");

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg?.message) return;

      const remoteJid = msg.key.remoteJid;
      const participant = msg.key.participant || remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.documentMessage?.caption ||
        "";

      const bot = bots.get(number);
      if (!bot) return;

      bot.messages++;
      bot.lastActivity = Date.now();
      stats.messagesProcessed++;
      if (remoteJid.endsWith("@g.us")) {
        bot.groups.add(remoteJid);
        stats.groupsDetected.add(remoteJid);
      }

      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;

      const senderNumber = formatNumber(String(participant).split("@")[0]);
      const isOwner =
        msg.key.fromMe ||
        senderNumber === number ||
        (bot.config.owners || []).includes(senderNumber);

      // Protections (toujours évaluées, même hors commande)
      if (!msg.key.fromMe) {
        runProtections(sock, bot, number, msg, remoteJid, participant, senderNumber, text)
          .catch(e => addLog("whatsapp", number, "protection", "error", e.message));
      }

      if (text && text.startsWith(bot.config.prefix || ".")) {
        if (!isOwner) return;
        const prefix = bot.config.prefix || ".";
        const args = text.slice(prefix.length).trim().split(/\s+/);
        const cmdName = (args.shift() || "").toLowerCase();

        if (cmdName && Object.prototype.hasOwnProperty.call(bot.features, cmdName)) {
          if (!["on", "off"].includes(args[0])) {
            return sock.sendMessage(remoteJid, { text: `*_Usage : ${prefix}${cmdName} on/off_*` });
          }
          bot.features[cmdName] = args[0] === "on";
          bot.config[cmdName] = args[0] === "on";
          await saveProtectionConfig(number);
          return sock.sendMessage(remoteJid, { text: `*_Fonctionnalité ${cmdName} : ${args[0]}_*` });
        }

        if (cmdName && bot.commands.has(cmdName)) {
          try {
            global.owners = bot.config.owners || [];
            process.env.NUMBER = number;

            await bot.commands.get(cmdName).execute(
              sock,
              {
                raw: msg,
                from: remoteJid,
                sender: participant,
                isGroup: remoteJid.endsWith("@g.us"),
                quoted,
                reply: t => sock.sendMessage(remoteJid, { text: `*_${t}_*` }),
                bots
              },
              args
            );

            bot.commandsRun++;
            stats.commandsExecuted++;
            await sock.sendMessage(remoteJid, { react: { text: "🐉", key: msg.key } });
          } catch (e) {
            addLog("whatsapp", number, `cmd:${cmdName}`, "error", e.message);
            sock.sendMessage(remoteJid, { text: "*_Erreur lors de l'exécution de la commande._*" }).catch(() => {});
          }
        }
      }

      if (!msg.key.fromMe) {
        try {
          if (bot.features.autoread) await sock.readMessages([msg.key]);
          if (bot.features.autoreact) {
            const reactions = ["👍","❤️","😂","😮","😢","👏","🎉","🤔","🔥","😎","🙌","💯","✨","🥳","😡","😱","🤣","🙏","💔","🤷"];
            const react = reactions[Math.floor(Math.random() * reactions.length)];
            await sock.sendMessage(remoteJid, { react: { text: react, key: msg.key } });
          }
          if (bot.features.autotyping && remoteJid.endsWith("@g.us")) await sock.sendPresenceUpdate("composing", remoteJid);
          if (bot.features.autorecording && remoteJid.endsWith("@g.us")) await sock.sendPresenceUpdate("recording", remoteJid);
        } catch (e) {
          addLog("whatsapp", number, "auto", "warning", e.message);
        }
      }
    } catch (e) {
      addLog("whatsapp", number, "message", "error", e.message);
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    try {
      const bot = bots.get(number);
      if (!bot) return;
      const toJid = p => (typeof p === "string" ? p : p?.id);

      if (action === "add" && bot.features.welcome) {
        for (const raw of participants) {
          const p = toJid(raw);
          if (!p) continue;
          const text = (bot.config.welcomeMessage || "Bienvenue @user dans le groupe.").replace("@user", `@${p.split("@")[0]}`);
          await sock.sendMessage(id, { text, mentions: [p] }).catch(() => {});
        }
      }
      if (action === "remove" && bot.features.bye) {
        for (const raw of participants) {
          const p = toJid(raw);
          if (!p) continue;
          const text = (bot.config.byeMessage || "@user a quitté le groupe.").replace("@user", `@${p.split("@")[0]}`);
          await sock.sendMessage(id, { text, mentions: [p] }).catch(() => {});
        }
      }
    } catch (e) {
      addLog("whatsapp", number, "group-update", "error", e.message);
    }
  });

  sock.ev.on("call", async (calls) => {
    try {
      const bot = bots.get(number);
      if (!bot?.config.anticall?.enabled) return;
      for (const call of calls) {
        if (call.status === "offer" && typeof sock.rejectCall === "function") {
          await sock.rejectCall(call.id, call.from).catch(() => {});
          addLog("whatsapp", number, "anticall", "info", `Appel rejeté de ${call.from}`);
        }
      }
    } catch (e) {
      addLog("whatsapp", number, "anticall", "error", e.message);
    }
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    try {
      const bot = bots.get(number);

      if (connection === "close") {
        if (bot) bot.linked = false;
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === 401 || code === 403) {
          await removeSession(SESSION_DIR);
          bots.delete(number);
          addLog("whatsapp", number, "disconnect", "error", `Session supprimée (code ${code})`);
        } else if (code === 428 || code === 405 || code === 440) {
          await removeSession(SESSION_DIR);
          bots.delete(number);
          addLog("whatsapp", number, "disconnect", "error", `Session invalide, supprimée (code ${code})`);
        } else {
          addLog("whatsapp", number, "reconnect", "warning", "Reconnexion dans 3s...");
          setTimeout(() => startBot(number).catch(e => addLog("whatsapp", number, "reconnect", "error", e.message)), 3000);
        }
      } else if (connection === "open") {
        if (bot) {
          bot.linked = true;
          bot.connectedAt = Date.now();
        }
        addLog("whatsapp", number, "connect", "success", "Connecté");

        if (sock.user?.id) sock.user.id = jidNormalizedUser(sock.user.id);
        loadLidFromSessionCreds(number, SESSION_DIR);
        autoJoinLinks(sock, number).catch(e => addLog("whatsapp", number, "auto-join", "warning", e.message));
      }
    } catch (e) {
      addLog("whatsapp", number, "connection", "error", e.message);
    }
  });

  if (!sock.authState.creds.registered) {
    await delay(1500);
    const code = await sock.requestPairingCode(number);
    const formatted = code.match(/.{1,4}/g)?.join("-") || code;
    addLog("whatsapp", number, "pair", "info", `Code : ${formatted}`);
    return formatted;
  }

  return null;
}

// ════════════════════════════════════════════════════════════════
//  TELEGRAM GATEWAY (implémentation directe via l'API HTTPS Telegram)
// ════════════════════════════════════════════════════════════════

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const telegramState = {
  configured: TELEGRAM_BOT_TOKEN && !TELEGRAM_BOT_TOKEN.startsWith("REPLACE_"),
  polling: false,
  botInfo: null,
  offset: 0,
  lastUpdate: null,
  membershipVerified: new Set(),
  errors: 0
};

async function tgCall(method, params = {}) {
  stats.telegramRequests++;
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Erreur Telegram (${method})`);
  return data.result;
}

async function checkTelegramMembership(userId) {
  // Groupe non configuré -> on ne bloque jamais par erreur.
  if (!TELEGRAM_GROUP_CHAT_ID) return { status: "member", bypass: true };
  if (TELEGRAM_ADMINS.includes(userId)) return { status: "administrator" };
  try {
    const member = await tgCall("getChatMember", { chat_id: TELEGRAM_GROUP_CHAT_ID, user_id: userId });
    return { status: member.status };
  } catch (e) {
    addLog("telegram", "-", "membership", "error", e.message);
    return { status: "unknown", error: true };
  }
}

function isBlockedStatus(status) {
  return ["left", "kicked"].includes(status);
}

async function sendAccessDenied(chatId) {
  await tgCall("sendMessage", {
    chat_id: chatId,
    text: "🔒 *ACCÈS RESTREINT*\n\nPour utiliser Takamura Bot, tu dois d'abord rejoindre notre groupe officiel Telegram.\n\n👇 Rejoins le groupe puis clique sur « Vérifier mon accès ».",
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Rejoindre le groupe", url: TELEGRAM_GROUP_INVITE_LINK }],
        [{ text: "✅ Vérifier mon accès", callback_data: "verify_access" }]
      ]
    }
  }).catch(() => {});
}

async function sendMainMenu(chatId) {
  await tgCall("sendMessage", {
    chat_id: chatId,
    text: "🤖 *TAKAMURA BOT*\n\nBienvenue sur Takamura Bot.\n\nUne plateforme WhatsApp multi-session avec système de protection, automatisation et outils avancés.\n\nChoisis une option :",
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📱 WhatsApp", callback_data: "menu_whatsapp" }, { text: "🛡️ Protections", callback_data: "menu_protections" }],
        [{ text: "⚡ Fonctionnalités", callback_data: "menu_features" }, { text: "📊 Statut", callback_data: "menu_status" }],
        [{ text: "📖 Commandes", callback_data: "menu_commands" }],
        [{ text: "💬 Groupe", url: TELEGRAM_GROUP_INVITE_LINK }]
      ]
    }
  });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

async function handleTelegramCommand(msg, cmd, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const isAdmin = TELEGRAM_ADMINS.includes(userId);
  const adminOnly = ["/admin", "/bots", "/sessions", "/logs", "/restart"];

  if (adminOnly.includes(cmd) && !isAdmin) {
    return tgCall("sendMessage", { chat_id: chatId, text: "⛔ Commande réservée aux administrateurs." });
  }

  if (!adminOnly.includes(cmd)) {
    const membership = await checkTelegramMembership(userId);
    if (!membership.bypass && isBlockedStatus(membership.status)) {
      return sendAccessDenied(chatId);
    }
  }

  switch (cmd) {
    case "/start":
    case "/menu":
      return sendMainMenu(chatId);

    case "/help":
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: "📖 *Commandes disponibles*\n\n/start – Menu principal\n/menu – Menu principal\n/status – Statut de la plateforme\n/features – Fonctionnalités disponibles\n/whatsapp – Sessions WhatsApp\n/pair – Lien de pairage\n/groups – Groupes détectés",
        parse_mode: "Markdown"
      });

    case "/status": {
      const connected = [...bots.values()].filter(b => b.linked).length;
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: `📊 *Statut Takamura Bot*\n\nSessions connectées : ${connected}/${bots.size}\nMessages traités : ${stats.messagesProcessed}\nCommandes exécutées : ${stats.commandsExecuted}\nUptime : ${formatUptime(Date.now() - startedAt)}`,
        parse_mode: "Markdown"
      });
    }

    case "/features":
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚡ *Fonctionnalités*\n\nAntiLink, AntiPhoto, AntiVideo, AntiAudio, AntiDocument, AntiSticker, AntiSpam, AntiTag, AntiCall, Welcome, Bye, AutoRead, AutoReact.",
        parse_mode: "Markdown"
      });

    case "/whatsapp":
    case "/sessions": {
      if (bots.size === 0) return tgCall("sendMessage", { chat_id: chatId, text: "Aucune session WhatsApp enregistrée." });
      const list = [...bots.entries()].map(([num, b]) => `${b.linked ? "🟢" : "🔴"} ${num} — ${b.messages} messages`).join("\n");
      return tgCall("sendMessage", { chat_id: chatId, text: `📱 *Sessions WhatsApp*\n\n${list}`, parse_mode: "Markdown" });
    }

    case "/pair":
      return tgCall("sendMessage", { chat_id: chatId, text: "Pour générer un pairing code, utilise le dashboard web (section Pairing)." });

    case "/groups":
      return tgCall("sendMessage", { chat_id: chatId, text: `Groupes détectés : ${stats.groupsDetected.size}` });

    case "/admin":
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: "🛠️ *Panneau admin*\n\n/bots – liste des sessions\n/sessions – détail des sessions\n/logs – 10 derniers logs\n/restart <numero> – reconnecter une session",
        parse_mode: "Markdown"
      });

    case "/bots": {
      const list = [...bots.keys()].join(", ") || "aucun";
      return tgCall("sendMessage", { chat_id: chatId, text: `Sessions : ${list}` });
    }

    case "/logs": {
      const recent = logs.slice(-10).map(l => `[${l.severity}] ${l.platform}/${l.session}: ${l.message}`).join("\n") || "Aucun log.";
      return tgCall("sendMessage", { chat_id: chatId, text: recent });
    }

    case "/restart": {
      const num = formatNumber(args[0] || "");
      if (!num) return tgCall("sendMessage", { chat_id: chatId, text: "Usage : /restart <numero>" });
      try {
        await startBot(num);
        return tgCall("sendMessage", { chat_id: chatId, text: `Reconnexion de ${num} lancée.` });
      } catch (e) {
        return tgCall("sendMessage", { chat_id: chatId, text: `Erreur : ${e.message}` });
      }
    }

    default:
      return tgCall("sendMessage", { chat_id: chatId, text: "Commande inconnue. Envoie /help pour la liste des commandes." });
  }
}

async function handleTelegramCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    if (data === "verify_access") {
      const membership = await checkTelegramMembership(userId);
      if (!membership.bypass && isBlockedStatus(membership.status)) {
        await tgCall("answerCallbackQuery", { callback_query_id: query.id, text: "Tu n'as pas encore rejoint le groupe.", show_alert: true });
        return;
      }
      await tgCall("answerCallbackQuery", { callback_query_id: query.id, text: "Accès vérifié ✅" });
      return sendMainMenu(chatId);
    }

    await tgCall("answerCallbackQuery", { callback_query_id: query.id });

    if (data === "menu_whatsapp") return handleTelegramCommand({ chat: { id: chatId }, from: { id: userId } }, "/whatsapp", []);
    if (data === "menu_features") return handleTelegramCommand({ chat: { id: chatId }, from: { id: userId } }, "/features", []);
    if (data === "menu_status") return handleTelegramCommand({ chat: { id: chatId }, from: { id: userId } }, "/status", []);
    if (data === "menu_commands") return handleTelegramCommand({ chat: { id: chatId }, from: { id: userId } }, "/help", []);
    if (data === "menu_protections") {
      return tgCall("sendMessage", { chat_id: chatId, text: "Gère les protections par session depuis le dashboard web (section Protections)." });
    }
  } catch (e) {
    addLog("telegram", "-", "callback", "error", e.message);
  }
}

async function processTelegramUpdate(update) {
  telegramState.lastUpdate = Date.now();
  try {
    if (update.message?.text) {
      const [cmd, ...args] = update.message.text.trim().split(/\s+/);
      if (cmd.startsWith("/")) {
        await handleTelegramCommand(update.message, cmd.split("@")[0], args);
      }
    } else if (update.callback_query) {
      await handleTelegramCallback(update.callback_query);
    }
  } catch (e) {
    telegramState.errors++;
    addLog("telegram", "-", "update", "error", e.message);
  }
}

async function startTelegramPolling() {
  if (!telegramState.configured) {
    addLog("telegram", "-", "start", "warning", "Token non configuré — Telegram Gateway désactivé.");
    return;
  }
  if (telegramState.polling) return; // jamais deux pollings en parallèle
  telegramState.polling = true;

  try {
    telegramState.botInfo = await tgCall("getMe");
    await tgCall("setMyCommands", {
      commands: [
        { command: "start", description: "Menu principal" },
        { command: "menu", description: "Menu principal" },
        { command: "help", description: "Aide" },
        { command: "status", description: "Statut de la plateforme" },
        { command: "features", description: "Fonctionnalités" },
        { command: "whatsapp", description: "Sessions WhatsApp" },
        { command: "pair", description: "Pairing" },
        { command: "groups", description: "Groupes détectés" }
      ]
    }).catch(() => {});
    addLog("telegram", "-", "start", "success", `Bot @${telegramState.botInfo.username} démarré`);
  } catch (e) {
    addLog("telegram", "-", "start", "error", `getMe a échoué : ${e.message}`);
  }

  (async function loop() {
    while (telegramState.polling) {
      try {
        const updates = await tgCall("getUpdates", { offset: telegramState.offset, timeout: 25 });
        for (const u of updates) {
          telegramState.offset = u.update_id + 1;
          processTelegramUpdate(u).catch(() => {});
        }
      } catch (e) {
        telegramState.errors++;
        addLog("telegram", "-", "polling", "error", e.message);
        await new Promise(r => setTimeout(r, 3000)); // backoff simple
      }
    }
  })();
}

// ════════════════════════════════════════════════════════════════
//  EXPRESS — SÉCURITÉ + STATIQUE
// ════════════════════════════════════════════════════════════════

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use("/api", apiLimiter);
app.use("/pair-api", rateLimit({ windowMs: 60 * 1000, max: 20 }));

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

function ok(res, data, message = "OK") {
  res.json({ success: true, data, message });
}
function fail(res, code, message, httpStatus = 400) {
  res.status(httpStatus).json({ success: false, error: { code, message } });
}

// ── Pairing (conservé, inchangé côté contrat) ──────────────────
app.get("/pair-api/code", async (req, res) => {
  const { number } = req.query;
  if (!number) return res.json({ error: "Numéro requis" });
  try {
    const code = await startBot(number);
    if (code) return res.json({ code });
    return res.json({ status: "connected" });
  } catch (err) {
    addLog("whatsapp", number, "pair", "error", err.message);
    return res.json({ error: err.message || "Erreur serveur" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", bots: bots.size }));

// ── API santé / stats ───────────────────────────────────────────
app.get("/api/health", (req, res) => {
  ok(res, { status: "ok", uptime: Date.now() - startedAt, sessions: bots.size });
});

app.get("/api/stats", (req, res) => {
  const connected = [...bots.values()].filter(b => b.linked).length;
  ok(res, {
    activeSessions: bots.size,
    connectedSessions: connected,
    disconnectedSessions: bots.size - connected,
    messagesProcessed: stats.messagesProcessed,
    groupsDetected: stats.groupsDetected.size,
    commandsExecuted: stats.commandsExecuted,
    messagesDeleted: stats.messagesDeleted,
    linksBlocked: stats.linksBlocked,
    mediaBlocked: stats.mediaBlocked,
    usersWarned: stats.usersWarned,
    usersKicked: stats.usersKicked,
    telegramRequests: stats.telegramRequests,
    errors: stats.errors,
    uptime: Date.now() - startedAt,
    telegramStatus: telegramState.configured ? (telegramState.polling ? "connected" : "stopped") : "not_configured"
  });
});

// ── Sessions ─────────────────────────────────────────────────────
app.get("/api/sessions", (req, res) => {
  const list = [...bots.entries()].map(([number, b]) => ({
    number,
    status: b.linked ? "connected" : "connecting",
    uptime: b.connectedAt ? Date.now() - b.connectedAt : 0,
    messages: b.messages,
    groups: b.groups.size,
    commands: b.commandsRun,
    lastActivity: b.lastActivity
  }));
  ok(res, list);
});

app.get("/api/sessions/:number", (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  ok(res, {
    number,
    jid: b.sock?.user?.id || null,
    status: b.linked ? "connected" : "connecting",
    uptime: b.connectedAt ? Date.now() - b.connectedAt : 0,
    messages: b.messages,
    groups: b.groups.size,
    commands: b.commandsRun,
    lastActivity: b.lastActivity,
    config: b.config
  });
});

app.post("/api/sessions/:number/reconnect", async (req, res) => {
  const number = formatNumber(req.params.number);
  try {
    await startBot(number);
    ok(res, { number }, "Reconnexion lancée");
  } catch (e) {
    fail(res, "RECONNECT_FAILED", e.message);
  }
});

app.post("/api/sessions/:number/disconnect", async (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  await closeExistingSocket(b);
  b.linked = false;
  addLog("whatsapp", number, "disconnect", "info", "Déconnecté via API");
  ok(res, { number }, "Session déconnectée");
});

app.delete("/api/sessions/:number", async (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  await closeExistingSocket(b);
  bots.delete(number);
  await removeSession(path.join(PAIRING_DIR, number));
  addLog("whatsapp", number, "delete", "warning", "Session supprimée via API");
  ok(res, { number }, "Session supprimée");
});

// ── Protections / Features ──────────────────────────────────────
app.get("/api/features/:number", (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  ok(res, b.config);
});

app.post("/api/features/:number", async (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  const patch = req.body || {};
  b.config = { ...b.config, ...patch };
  b.features.antilink = b.config.antilink?.enabled || false;
  b.features.welcome = b.config.welcome;
  b.features.bye = b.config.bye;
  b.features.autoread = b.config.autoread;
  b.features.autoreact = b.config.autoreact;
  b.features.autotyping = b.config.autotyping;
  b.features.autorecording = b.config.autorecording;
  const saved = await saveProtectionConfig(number);
  addLog("whatsapp", number, "config", "info", "Configuration mise à jour via API");
  ok(res, b.config, saved ? "Configuration enregistrée" : "Configuration mise à jour (non persistée)");
});

// ── Telegram ─────────────────────────────────────────────────────
app.get("/api/telegram/status", (req, res) => {
  ok(res, {
    configured: telegramState.configured,
    polling: telegramState.polling,
    username: telegramState.botInfo?.username || null,
    id: telegramState.botInfo?.id || null,
    lastUpdate: telegramState.lastUpdate,
    errors: telegramState.errors,
    tokenMasked: telegramState.configured ? "•".repeat(16) : "non configuré"
  });
});

app.get("/api/telegram/stats", (req, res) => {
  ok(res, { requests: stats.telegramRequests, errors: telegramState.errors });
});

app.post("/api/telegram/test", async (req, res) => {
  if (!telegramState.configured) return fail(res, "TELEGRAM_NOT_CONFIGURED", "Token Telegram non configuré");
  try {
    const me = await tgCall("getMe");
    ok(res, me, "Connexion Telegram OK");
  } catch (e) {
    fail(res, "TELEGRAM_ERROR", e.message);
  }
});

// ── Logs ─────────────────────────────────────────────────────────
app.get("/api/logs", (req, res) => {
  const { severity, platform, limit } = req.query;
  let filtered = logs;
  if (severity && severity !== "all") filtered = filtered.filter(l => l.severity === severity);
  if (platform && platform !== "all") filtered = filtered.filter(l => l.platform === platform);
  ok(res, filtered.slice(-(Number(limit) || 100)).reverse());
});

// ── 404 API propre (aucune stack trace) ─────────────────────────
app.use("/api", (req, res) => fail(res, "NOT_FOUND", "Route inconnue", 404));
app.use((err, req, res, next) => {
  addLog("system", "-", "express", "error", err.message);
  fail(res, "INTERNAL_ERROR", "Erreur interne", 500);
});

app.listen(PORT, () => {
  addLog("system", "-", "server", "success", `Serveur prêt sur le port ${PORT}`);
  startTelegramPolling();
});
