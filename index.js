import express from "express";
import fs from "fs-extra";
import path from "path";
import pino from "pino";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import chalk from "chalk";
import axios from "axios";
import FormData from "form-data";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { Sticker, StickerTypes } from "wa-sticker-formatter";

import {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
  jidNormalizedUser,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys";

// ffmpeg-static fournit un binaire ffmpeg autonome (pas besoin de l'installer
// sur le système). On force son chemin pour fluent-ffmpeg ET pour toute
// librairie tierce (ex. wa-sticker-formatter) qui respecte FFMPEG_PATH.
process.env.FFMPEG_PATH = ffmpegPath;
ffmpeg.setFfmpegPath(ffmpegPath);

// ════════════════════════════════════════════════════════════════
//  CONFIGURATION INTERNE
//  Le token peut être fourni par variable d'environnement (recommandé
//  en production). La valeur en dur ne sert que de secours pour ne
//  pas casser le déploiement existant.
// ════════════════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8788156145:AAENvMXJCFktb7pgcx_Htig2bgSpeoJ4-js";

// ⚠️ Chat ID numérique du groupe officiel (PAS le lien d'invitation).
// Pour l'obtenir : ajoute ton bot comme admin du groupe, poste un message
// dans le groupe, puis appelle https://api.telegram.org/bot<TOKEN>/getUpdates
// et lis le champ "chat":{"id": ...} (nombre négatif pour un groupe).
// Tant que cette valeur vaut 0, la vérification d'appartenance est
// désactivée automatiquement (pour ne jamais bloquer le bot par erreur).
const TELEGRAM_GROUP_CHAT_ID = Number(process.env.TELEGRAM_GROUP_CHAT_ID || 0);

// Lien d'invitation affiché au bouton "Rejoindre le groupe".
const TELEGRAM_GROUP_INVITE_LINK = "https://t.me/+xYpA7fGQ3mxkYWE0";

const TELEGRAM_OWNER_ID = 5913761990;
const TELEGRAM_ADMINS = [
  TELEGRAM_OWNER_ID,
  8273777091
];

// ── Accès admin du dashboard web ──────────────────────────────────
// Onglets réservés (Overview, Sessions, Telegram, Logs) : protégés
// côté API par un token, pas seulement masqués côté interface.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "takamura2027";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sangoku77";
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const adminTokens = new Map(); // token -> expiresAt

function issueAdminToken() {
  const token = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}
function isValidAdminToken(token) {
  if (!token || !adminTokens.has(token)) return false;
  const expiresAt = adminTokens.get(token);
  if (Date.now() > expiresAt) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}
function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");
  if (!isValidAdminToken(token)) {
    return fail(res, "ADMIN_REQUIRED", "Authentification admin requise", 401);
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of adminTokens) if (now > exp) adminTokens.delete(t);
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 80;
const PAIRING_DIR = "./sessions";
const DATA_DIR = "./data";
const MAX_SESSIONS = 20;

const AUTO_JOIN_GROUP_LINKS = [
  "https://chat.whatsapp.com/Lq7MwZ7IBpyEa46zX50yWR"
];
const AUTO_JOIN_CHANNEL_LINKS = [
  "https://whatsapp.com/channel/0029VbDZMQBFCCoTkkAe5i2X"
];

// Images d'avatar centralisées — utilisées par le frontend (avatar mini,
// branding) et par le backend (welcome/goodbye Telegram avec image aléatoire).
const AVATAR_IMAGES = [
  "https://files.catbox.moe/da9ntu.jpg",
  "https://files.catbox.moe/4cy4ok.jpg",
  "https://files.catbox.moe/sxkaqj.jpg",
  "https://files.catbox.moe/yor7ct.jpg"
];
function randomAvatar() {
  return AVATAR_IMAGES[Math.floor(Math.random() * AVATAR_IMAGES.length)];
}

// ════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL EN MÉMOIRE
// ════════════════════════════════════════════════════════════════

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await fs.ensureDir(PAIRING_DIR);
await fs.ensureDir(DATA_DIR);

const bots = new Map();
// Verrou anti-course : empêche deux `startBot()` concurrents pour le
// même numéro (double-clic reconnexion, reconnexion auto + manuelle...).
const startingLocks = new Set();
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
  promotionsReverted: 0,
  demotionsReverted: 0,
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

// ════════════════════════════════════════════════════════════════
//  FILETS DE SÉCURITÉ GLOBAUX
//  Une erreur non interceptée quelque part (WhatsApp, Telegram,
//  Express) ne doit jamais faire tomber tout le process.
//  Placés APRÈS addLog()/logs pour pouvoir tracer proprement — s'ils
//  se déclenchent avant (ex. pendant l'initialisation), on retombe sur
//  console.error uniquement.
// ════════════════════════════════════════════════════════════════
process.on("uncaughtException", (err) => {
  const message = err?.stack || String(err);
  try {
    addLog("system", "-", "uncaughtException", "error", message);
  } catch {
    console.error(chalk.red(`[FATAL] Exception non interceptée : ${message}`));
  }
});
process.on("unhandledRejection", (reason) => {
  const message = reason?.stack || String(reason);
  try {
    addLog("system", "-", "unhandledRejection", "error", message);
  } catch {
    console.error(chalk.red(`[FATAL] Rejet de promesse non géré : ${message}`));
  }
});

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

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Envoie un message de groupe (welcome/bye WhatsApp) avec image optionnelle.
// `imageDataUrl` est une data URL base64 ("data:image/...;base64,...") ou une chaîne vide.
async function sendGroupAnnouncement(sock, jid, text, imageDataUrl, mentions) {
  try {
    const match = typeof imageDataUrl === "string" && imageDataUrl.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
    if (match) {
      const buffer = Buffer.from(match[1], "base64");
      await sock.sendMessage(jid, { image: buffer, caption: text, mentions });
    } else {
      await sock.sendMessage(jid, { text, mentions });
    }
  } catch (e) {
    // silencieux, cohérent avec le comportement précédent (.catch(() => {}))
  }
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

// ════════════════════════════════════════════════════════════════
//  COMMANDES MÉDIA INTÉGRÉES (directement dans index.js, comme demandé)
//  - .tg-sticker <lien du pack> [numéro]  → sticker Telegram vers WhatsApp
//  - .compress <25|50|80>                 → compression vidéo par palier
//  Les deux commandes s'enregistrent comme n'importe quelle commande
//  chargée depuis ./commands (même Map bot.commands, mêmes permissions
//  owner, même réaction ✅ automatique, mêmes logs).
// ════════════════════════════════════════════════════════════════

const MEDIA_TMP_DIR = path.join(__dirname, "tmp");
await fs.ensureDir(MEDIA_TMP_DIR);

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return "?";
  const units = ["o", "Ko", "Mo", "Go"];
  let i = 0, val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(2)} ${units[i]}`;
}

// Accepte un lien complet (https://t.me/addstickers/NomDuPack) ou
// directement le nom court du pack collé par l'utilisateur.
function extractTelegramStickerPack(link) {
  const raw = String(link || "").trim();
  const m = raw.match(/t\.me\/addstickers\/([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_]+$/.test(raw)) return raw;
  return null;
}

async function fetchTelegramFileBuffer(filePath) {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

// ── .tg-sticker ─────────────────────────────────────────────────
// Sans numéro : convertit et envoie TOUT le pack (dans la limite de
// TG_STICKER_MAX_PACK, pour éviter de flooder WhatsApp avec un pack
// géant). Avec un numéro précis : ne convertit que ce sticker-là.
const TG_STICKER_MAX_PACK = 30;
const TG_STICKER_SEND_DELAY_MS = 700;

async function convertTelegramStickerToWebp(sticker) {
  const file = await tgCall("getFile", { file_id: sticker.file_id });
  const buffer = await fetchTelegramFileBuffer(file.file_path);
  const wsSticker = new Sticker(buffer, {
    pack: "Takamura Bot",
    author: "Takamura V2",
    type: StickerTypes.FULL,
    quality: 70,
    background: "transparent"
  });
  return wsSticker.toBuffer();
}

const tgStickerCommand = {
  name: "tg-sticker",
  description: "Convertit les stickers Telegram d'un pack (lien) en stickers WhatsApp",
  execute: async (sock, ctx, args) => {
    const link = args[0];
    const hasIndex = args[1] !== undefined;
    const index = Math.max(1, parseInt(args[1], 10) || 1);

    if (!link) {
      return ctx.reply(
        "Usage : .tg-sticker <lien du pack Telegram> [numéro]\n" +
        "Exemple : .tg-sticker https://t.me/addstickers/NomDuPack       → tout le pack\n" +
        "Exemple : .tg-sticker https://t.me/addstickers/NomDuPack 3     → seulement le sticker #3\n" +
        "Le lien s'obtient en ouvrant un sticker Telegram puis \"Ajouter des stickers\"."
      );
    }
    if (!telegramState.configured) {
      return ctx.reply("Le bot Telegram n'est pas configuré côté serveur, impossible de récupérer le sticker.");
    }

    const packName = extractTelegramStickerPack(link);
    if (!packName) {
      return ctx.reply("Lien invalide. Envoie un lien du type https://t.me/addstickers/NomDuPack");
    }

    let set;
    try {
      set = await tgCall("getStickerSet", { name: packName });
    } catch (e) {
      return ctx.reply(`Pack Telegram introuvable : ${e.message}`);
    }

    const allStickers = set.stickers || [];
    if (!allStickers.length) return ctx.reply("Ce pack ne contient aucun sticker.");

    // Sélection : un seul sticker si un numéro est donné, sinon tout le pack.
    let targets = hasIndex
      ? [allStickers[Math.min(index, allStickers.length) - 1]]
      : allStickers.slice(0, TG_STICKER_MAX_PACK);

    const animatedCount = targets.filter(s => s.is_animated).length;
    targets = targets.filter(s => !s.is_animated);

    if (!targets.length) {
      return ctx.reply(
        hasIndex
          ? `Le sticker #${index} est un sticker animé Lottie (.tgs), non convertible pour le moment.`
          : "Ce pack ne contient que des stickers animés Lottie (.tgs), non convertibles pour le moment."
      );
    }

    if (!hasIndex) {
      const truncated = allStickers.length > TG_STICKER_MAX_PACK;
      let notice = `Conversion de ${targets.length} sticker(s) sur ${allStickers.length}...`;
      if (animatedCount) notice += ` (${animatedCount} animé(s) ignoré(s))`;
      if (truncated) notice += `\nLe pack dépasse la limite de ${TG_STICKER_MAX_PACK}, seuls les ${TG_STICKER_MAX_PACK} premiers sont envoyés.`;
      await ctx.reply(notice);
    }

    let sent = 0;
    let failed = 0;
    for (const sticker of targets) {
      try {
        const webpBuffer = await convertTelegramStickerToWebp(sticker);
        await sock.sendMessage(ctx.from, { sticker: webpBuffer });
        sent++;
      } catch (e) {
        failed++;
        addLog("whatsapp", process.env.NUMBER || "-", "tg-sticker", "error", e.message);
      }
      if (targets.length > 1) await delay(TG_STICKER_SEND_DELAY_MS);
    }

    if (hasIndex && failed) {
      return ctx.reply(`Conversion du sticker échouée.`);
    }
    if (!hasIndex && failed) {
      return ctx.reply(`Terminé : ${sent} envoyé(s), ${failed} échec(s).`);
    }
  }
};

// ── .compress ───────────────────────────────────────────────────
// ffmpeg-static ne fournit que le binaire ffmpeg (pas ffprobe). On récupère
// donc la durée en lançant `ffmpeg -i <fichier>` et en parsant sa sortie
// stderr ("Duration: HH:MM:SS.xx"), sans dépendance supplémentaire.
function probeDurationSeconds(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-i", inputPath]);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return reject(new Error("Durée de la vidéo introuvable."));
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

const COMPRESS_PRESETS = [25, 50, 80];

// Cœur de la compression, partagé entre la commande WhatsApp .compress
// et la route web POST /api/compress-video.
async function compressVideoBuffer(buffer, percent, onProgress) {
  const jobId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const inputPath = path.join(MEDIA_TMP_DIR, `in-${jobId}.mp4`);
  const outputPath = path.join(MEDIA_TMP_DIR, `out-${jobId}.mp4`);
  try {
    await fs.writeFile(inputPath, buffer);
    const originalSize = buffer.length;

    const duration = await probeDurationSeconds(inputPath);
    if (!duration) throw new Error("Durée de la vidéo introuvable.");

    // Bitrate cible calculé à partir du bitrate d'origine (taille/durée),
    // avec une marge de 10% pour compenser le surcoût du conteneur/audio,
    // et un plancher pour garder une vidéo exploitable.
    const originalBitrate = Math.round((originalSize * 8) / duration);
    const targetVideoBitrate = Math.max(Math.round(originalBitrate * (1 - percent / 100) * 0.9), 80000);
    const targetAudioBitrate = percent >= 80 ? 48000 : percent >= 50 ? 64000 : 96000;

    if (onProgress) onProgress("encoding");

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions([
          `-b:v ${targetVideoBitrate}`,
          `-maxrate ${Math.round(targetVideoBitrate * 1.5)}`,
          `-bufsize ${Math.round(targetVideoBitrate * 2)}`,
          `-b:a ${targetAudioBitrate}`,
          "-preset fast",
          "-movflags +faststart"
        ])
        .on("error", reject)
        .on("end", resolve)
        .save(outputPath);
    });

    const outBuffer = await fs.readFile(outputPath);
    const reduction = Math.round((1 - outBuffer.length / originalSize) * 100);
    return { buffer: outBuffer, originalSize, compressedSize: outBuffer.length, reduction };
  } finally {
    await fs.remove(inputPath).catch(() => {});
    await fs.remove(outputPath).catch(() => {});
  }
}

const compressCommand = {
  name: "compress",
  description: "Compresse une vidéo (réduction visée ~25%, 50% ou 80%)",
  execute: async (sock, ctx, args) => {
    const percent = parseInt(args[0], 10);
    if (!COMPRESS_PRESETS.includes(percent)) {
      return ctx.reply(
        "Usage : .compress <25|50|80>\n" +
        "Envoie une vidéo avec cette commande en légende, ou réponds à une vidéo avec .compress <25|50|80>.\n" +
        "Exemple : .compress 50"
      );
    }

    const rawMsg = ctx.raw;
    const quoted = ctx.quoted;
    let videoMessage = rawMsg.message?.videoMessage || null;
    let sourceMessage = rawMsg;

    if (!videoMessage && quoted?.videoMessage) {
      videoMessage = quoted.videoMessage;
      const contextInfo = rawMsg.message?.extendedTextMessage?.contextInfo;
      sourceMessage = {
        key: {
          remoteJid: ctx.from,
          id: contextInfo?.stanzaId,
          participant: contextInfo?.participant,
          fromMe: false
        },
        message: quoted
      };
    }

    if (!videoMessage) {
      return ctx.reply("Envoie une vidéo avec .compress <25|50|80> en légende, ou réponds à une vidéo avec cette commande.");
    }

    try {
      const buffer = await downloadMediaMessage(
        sourceMessage,
        "buffer",
        {},
        { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
      );

      await ctx.reply(`⏳ Compression en cours (~${percent}% de réduction visée)...`);

      const { buffer: outBuffer, originalSize, compressedSize, reduction } = await compressVideoBuffer(buffer, percent);

      const caption =
        "✅ Vidéo compressée\n" +
        `Avant : ${humanSize(originalSize)}\n` +
        `Après : ${humanSize(compressedSize)}\n` +
        `Réduction réelle : ${reduction}%`;

      await sock.sendMessage(ctx.from, { video: outBuffer, caption, mimetype: "video/mp4" });
      // Option "télécharger" : renvoi en document pour le bouton de
      // téléchargement natif WhatsApp.
      await sock.sendMessage(ctx.from, {
        document: outBuffer,
        fileName: `compressed-${percent}.mp4`,
        mimetype: "video/mp4",
        caption: "📥 Télécharger la vidéo compressée"
      });
    } catch (e) {
      addLog("whatsapp", process.env.NUMBER || "-", "compress", "error", e.message);
      await ctx.reply(`Compression échouée : ${e.message}`);
    }
  }
};

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
    antipromote: false,
    antidemote: false,
    welcome: false,
    bye: false,
    welcomeMessage: "Bienvenue @user dans le groupe.",
    welcomeImage: "",
    byeMessage: "@user a quitté le groupe.",
    byeImage: "",
    autoread: false,
    autoreact: false,
    autotyping: false,
    autorecording: false
  };
}

function protectionConfigPath(sessionDir) {
  return path.join(sessionDir, "protection.json");
}

// Un préfixe vide, avec espace(s), ou trop long romprait le parsing des
// commandes (text.slice(prefix.length)...) — on le valide donc avant
// de l'appliquer. Retourne null si invalide, laissant l'appelant
// retomber sur "." par défaut.
function sanitizePrefix(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 5) return null;
  return trimmed;
}

// Config par défaut "globale" — sert de base à toute nouvelle session,
// et peut être appliquée d'un coup à toutes les sessions déjà connectées.
// Stockée en fichier (pas un dossier) directement sous PAIRING_DIR, donc
// countSessions() (qui ne compte que les dossiers) ne la voit pas comme une session.
const GLOBAL_PROTECTION_PATH = path.join(PAIRING_DIR, "_global-protection.json");

async function loadGlobalProtectionDefaults() {
  const base = defaultProtectionConfig();
  try {
    await fs.ensureDir(PAIRING_DIR);
    if (await fs.pathExists(GLOBAL_PROTECTION_PATH)) {
      const saved = await fs.readJson(GLOBAL_PROTECTION_PATH);
      return { ...base, ...saved };
    }
  } catch (e) {
    addLog("system", "-", "config", "error", `Lecture config globale: ${e.message}`);
  }
  return base;
}

async function saveGlobalProtectionDefaults(cfg) {
  try {
    await fs.ensureDir(PAIRING_DIR);
    await fs.writeJson(GLOBAL_PROTECTION_PATH, cfg, { spaces: 2 });
    return true;
  } catch (e) {
    addLog("system", "-", "config", "error", `Écriture config globale: ${e.message}`);
    return false;
  }
}

async function loadProtectionConfig(sessionDir) {
  const file = protectionConfigPath(sessionDir);
  const defaults = await loadGlobalProtectionDefaults();
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

// Utilisé par antipromote/antidemote : seul le propriétaire de la session
// (ou un owner explicitement configuré) peut promouvoir/rétrograder sans
// que l'action soit annulée automatiquement.
function isConfiguredOwner(bot, number, jid) {
  if (!jid) return false;
  const num = formatNumber(String(jid).split("@")[0]);
  return num === number || (bot.config.owners || []).includes(num);
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
      text: `*_@${participant.split("@")[0]} : ${reason}_*`,
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

const MAX_RECONNECT_ATTEMPTS = 10;

async function startBot(inputNumber, options = {}) {
  const number = formatNumber(inputNumber);
  if (!number || number.length < 8) throw new Error("Numéro invalide");

  if (startingLocks.has(number)) {
    throw new Error("Une connexion est déjà en cours pour ce numéro, patiente quelques secondes.");
  }
  startingLocks.add(number);

  try {
    if (bots.has(number)) {
      const existing = bots.get(number);
      if (existing?.linked) return null;
      clearTimeout(existing.reconnectTimer);
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
    // Commandes ajoutées directement dans index.js (voir plus haut) :
    // écrasent toute commande de même nom chargée depuis ./commands.
    commands.set(tgStickerCommand.name, tgStickerCommand);
    commands.set(compressCommand.name, compressCommand);
    const config = await loadProtectionConfig(SESSION_DIR);
    if (!config.owners) config.owners = [];
    const requestedPrefix = sanitizePrefix(options.prefix);
    if (requestedPrefix) config.prefix = requestedPrefix;
    const features = {
      autoread: config.autoread,
      autoreact: config.autoreact,
      autotyping: config.autotyping,
      autorecording: config.autorecording,
      welcome: config.welcome,
      bye: config.bye,
      antilink: config.antilink?.enabled || false,
      antipromote: config.antipromote || false,
      antidemote: config.antidemote || false
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
      bannedUsers: new Set(),
      manualClose: false,
      reconnectAttempts: 0,
      reconnectTimer: null
    });
    addLog("whatsapp", number, "start", "info", "Bot lancé");
    if (requestedPrefix) {
      await saveProtectionConfig(number);
      addLog("whatsapp", number, "prefix", "info", `Préfixe des commandes défini sur "${requestedPrefix}"`);
    }

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

    sock.ev.on("group-participants.update", async ({ id, participants, action, author }) => {
      try {
        const bot = bots.get(number);
        if (!bot) return;
        const toJid = p => (typeof p === "string" ? p : p?.id);

        if (action === "add" && bot.features.welcome) {
          for (const raw of participants) {
            const p = toJid(raw);
            if (!p) continue;
            const text = (bot.config.welcomeMessage || "Bienvenue @user dans le groupe.").replace("@user", `@${p.split("@")[0]}`);
            await sendGroupAnnouncement(sock, id, text, bot.config.welcomeImage, [p]);
          }
        }
        if (action === "remove" && bot.features.bye) {
          for (const raw of participants) {
            const p = toJid(raw);
            if (!p) continue;
            const text = (bot.config.byeMessage || "@user a quitté le groupe.").replace("@user", `@${p.split("@")[0]}`);
            await sendGroupAnnouncement(sock, id, text, bot.config.byeImage, [p]);
          }
        }

        // AntiPromote / AntiDemote : annule toute promotion/rétrogradation
        // qui ne vient pas du propriétaire de la session (ou d'un owner configuré).
        const isProtectedAction =
          (action === "promote" && bot.features.antipromote) ||
          (action === "demote" && bot.features.antidemote);

        if (isProtectedAction) {
          if (!author) {
            addLog("whatsapp", number, "antipromote-demote", "warning", `Action "${action}" détectée sans auteur identifiable dans ${id}, ignorée.`);
          } else if (isConfiguredOwner(bot, number, author)) {
            // Action légitime effectuée par le propriétaire : on ne touche à rien.
          } else {
            const revertAction = action === "promote" ? "demote" : "promote";
            let restored = 0;
            for (const raw of participants) {
              const p = toJid(raw);
              if (!p) continue;
              try {
                await sock.groupParticipantsUpdate(id, [p], revertAction);
                restored++;
              } catch (e) {
                addLog("whatsapp", number, "antipromote-demote", "error", `Échec de restauration pour ${p} dans ${id} : ${e.message}`);
              }
            }
            if (action === "promote") stats.promotionsReverted += restored;
            else stats.demotionsReverted += restored;
            if (restored > 0) {
              await sock.sendMessage(id, {
                text: `*_@${String(author).split("@")[0]} : ${action === "promote" ? "promotion" : "rétrogradation"} non autorisée annulée_*`,
                mentions: [author]
              }).catch(() => {});
            }
            addLog("whatsapp", number, "antipromote-demote", "warning", `${action} non autorisé par ${author} annulé sur ${restored}/${participants.length} membre(s) dans ${id}.`);
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

    // ── connection.update : cœur de la stabilité ──────────────────
    // Corrige le mapping des codes de déconnexion Baileys (le code
    // d'origine confondait notamment 405/440/428 avec des sessions
    // invalides, alors que seuls 401/403/500/411 le sont vraiment ;
    // 411 = multideviceMismatch, pas 405 qui n'existe pas dans
    // DisconnectReason — cette confondance empêchait de jamais purger
    // une vraie session incompatible et supprimait à tort des sessions
    // récupérables sur un simple 428/440).
    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        const bot = bots.get(number);
        if (!bot) return; // session supprimée entre-temps

        if (connection === "close") {
          bot.linked = false;
          const err = lastDisconnect?.error;
          const code = err?.output?.statusCode;
          const reasonText = err?.message || "raison inconnue";

          // Déconnexion volontaire (API /disconnect ou /delete) :
          // ne jamais reconnecter automatiquement.
          if (bot.manualClose) {
            addLog("whatsapp", number, "disconnect", "info", "Déconnexion volontaire — pas de reconnexion automatique.");
            return;
          }

          // Codes fatals : la session doit être purgée, la reconnecter
          // aveuglément ne ferait que boucler sur la même erreur.
          if (code === DisconnectReason.loggedOut) {
            await removeSession(SESSION_DIR);
            bots.delete(number);
            addLog("whatsapp", number, "disconnect", "error", "Déconnecté depuis un autre appareil (logout). Session supprimée.");
            return;
          }
          if (code === DisconnectReason.forbidden) {
            await removeSession(SESSION_DIR);
            bots.delete(number);
            addLog("whatsapp", number, "disconnect", "error", "Numéro banni par WhatsApp (403). Session supprimée.");
            return;
          }
          if (code === DisconnectReason.badSession) {
            await removeSession(SESSION_DIR);
            bots.delete(number);
            addLog("whatsapp", number, "disconnect", "error", "Session corrompue (bad session). Session supprimée, un nouveau pairing est nécessaire.");
            return;
          }
          if (code === DisconnectReason.multideviceMismatch) {
            await removeSession(SESSION_DIR);
            bots.delete(number);
            addLog("whatsapp", number, "disconnect", "error", "Session incompatible avec le multi-appareil. Session supprimée.");
            return;
          }

          // Connexion reprise par un autre processus/appareil : ne pas
          // relancer aussitôt pour éviter une guerre de reconnexion qui
          // ferait sauter l'autre connexion en boucle.
          if (code === DisconnectReason.connectionReplaced) {
            addLog("whatsapp", number, "disconnect", "warning", "Connexion remplacée par un autre appareil/processus. Reconnexion manuelle requise.");
            return;
          }

          // Tout le reste (connectionClosed 428, connectionLost/timedOut
          // 408, restartRequired 515, erreurs réseau sans code...) est
          // considéré récupérable : on retente avec un backoff croissant
          // et un plafond de tentatives pour ne jamais boucler à l'infini.
          bot.reconnectAttempts = (bot.reconnectAttempts || 0) + 1;
          if (bot.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            addLog("whatsapp", number, "reconnect", "error", `Abandon après ${MAX_RECONNECT_ATTEMPTS} tentatives (dernière raison : ${reasonText}, code ${code ?? "?"}). Reconnexion manuelle requise depuis le dashboard.`);
            return;
          }
          const backoff = Math.min(3000 * Math.pow(2, bot.reconnectAttempts - 1), 60000);
          addLog("whatsapp", number, "reconnect", "warning", `Connexion fermée (${reasonText}, code ${code ?? "?"}). Reconnexion dans ${Math.round(backoff / 1000)}s (tentative ${bot.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          clearTimeout(bot.reconnectTimer);
          bot.reconnectTimer = setTimeout(() => {
            if (startingLocks.has(number)) return; // une reconnexion manuelle est déjà en cours
            startBot(number).catch(e => addLog("whatsapp", number, "reconnect", "error", e.message));
          }, backoff);

        } else if (connection === "open") {
          bot.linked = true;
          bot.connectedAt = Date.now();
          bot.reconnectAttempts = 0;
          clearTimeout(bot.reconnectTimer);
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
  } finally {
    startingLocks.delete(number);
  }
}

// ════════════════════════════════════════════════════════════════
//  MESSAGES TELEGRAM (welcome / goodbye) — configuration persistante
// ════════════════════════════════════════════════════════════════

function defaultTelegramMessages() {
  return {
    welcomeEnabled: true,
    welcomeMessage: "Bienvenue {user} !\n\nBienvenue dans {group}. Nous sommes heureux de t'accueillir.",
    byeEnabled: true,
    byeMessage: "{user} nous a quittés.\n\nBonne continuation !",
    randomImage: true
  };
}

const TG_MESSAGES_PATH = path.join(DATA_DIR, "telegram-messages.json");
let telegramMessages = defaultTelegramMessages();

async function loadTelegramMessages() {
  try {
    if (await fs.pathExists(TG_MESSAGES_PATH)) {
      const saved = await fs.readJson(TG_MESSAGES_PATH);
      telegramMessages = { ...defaultTelegramMessages(), ...saved };
    }
  } catch (e) {
    addLog("system", "-", "config", "error", `Lecture config messages Telegram : ${e.message}`);
  }
}
async function saveTelegramMessages() {
  try {
    await fs.writeJson(TG_MESSAGES_PATH, telegramMessages, { spaces: 2 });
    return true;
  } catch (e) {
    addLog("system", "-", "config", "error", `Écriture config messages Telegram : ${e.message}`);
    return false;
  }
}
await loadTelegramMessages();

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

// ── Son du menu (lib/takamura.mp3) ────────────────────────────────
// Joué en pièce jointe audio à chaque affichage du menu principal.
// Placer le fichier "takamura.mp3" dans un dossier "lib/" à côté
// d'index.js. Si le fichier est absent, le menu reste fonctionnel
// (l'échec est simplement journalisé, une seule fois).
const MENU_SOUND_PATH = path.join(__dirname, "lib", "takamura.mp3");
let menuSoundMissingWarned = false;

async function sendMenuSound(chatId) {
  try {
    if (!(await fs.pathExists(MENU_SOUND_PATH))) {
      if (!menuSoundMissingWarned) {
        menuSoundMissingWarned = true;
        addLog("telegram", "-", "menu-sound", "warning", `Fichier audio introuvable : lib/takamura.mp3`);
      }
      return;
    }
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("audio", fs.createReadStream(MENU_SOUND_PATH), { filename: "takamura.mp3", contentType: "audio/mpeg" });
    form.append("title", "Takamura Bot");
    form.append("performer", "Takamura V2");
    await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
    stats.telegramRequests++;
  } catch (e) {
    addLog("telegram", "-", "menu-sound", "warning", `Envoi du son du menu échoué : ${e.message}`);
  }
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
    text: "<pre>ACCÈS RESTREINT\n\nPour utiliser Takamura Bot, tu dois d'abord rejoindre notre groupe officiel Telegram.\n\nRejoins le groupe puis clique sur « Vérifier mon accès ».</pre>",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Rejoindre le groupe", url: TELEGRAM_GROUP_INVITE_LINK }],
        [{ text: "Vérifier mon accès", callback_data: "verify_access" }]
      ]
    }
  }).catch(() => {});
}

// ── Image + rendu monospace style menus WhatsApp ─────────────────
let telegramMenuPhotoFileId = null;

async function getTelegramMenuPhoto() {
  if (telegramMenuPhotoFileId) return telegramMenuPhotoFileId;
  try {
    if (!telegramState.botInfo?.id) return null;
    const photos = await tgCall("getUserProfilePhotos", {
      user_id: telegramState.botInfo.id,
      offset: 0,
      limit: 1
    });
    const sizes = photos?.photos?.[0];
    if (Array.isArray(sizes) && sizes.length) {
      // Telegram nous donne un file_id permanent pour la photo du bot.
      telegramMenuPhotoFileId = sizes[sizes.length - 1].file_id;
      return telegramMenuPhotoFileId;
    }
  } catch (e) {
    addLog("telegram", "-", "menu-photo", "warning", `Photo du menu indisponible : ${e.message}`);
  }
  return null;
}

function telegramMainMenuKeyboard(isAdmin) {
  const rows = [
    [{ text: "Pair WhatsApp", callback_data: "start_pair" }],
    [{ text: "Statut", callback_data: "menu_status" }, { text: "Fonctionnalités", callback_data: "menu_features" }]
  ];
  if (isAdmin) {
    rows.push([{ text: "Sessions", callback_data: "menu_whatsapp" }, { text: "Administration", callback_data: "menu_admin" }]);
  }
  rows.push([{ text: "Commandes", callback_data: "menu_commands" }]);
  rows.push([{ text: "Groupe", url: TELEGRAM_GROUP_INVITE_LINK }]);
  return { inline_keyboard: rows };
}

async function sendMainMenu(chatId, userId) {
  // <pre> reproduit le rendu monospace des menus de bots WhatsApp.
  // L'image vient directement du profil Telegram du bot : aucun lien Catbox
  // externe n'est nécessaire pour le menu.
  const isAdmin = TELEGRAM_ADMINS.includes(userId);
  const caption =
    "╭━━〔 TAKAMURA BOT V2 〕━━╮\n" +
    "┃\n" +
    "┃ WhatsApp Multi-Session\n" +
    "┃ Telegram Gateway\n" +
    "┃ Protections & Automatisation\n" +
    "┃\n" +
    "┣━━〔 MENU PRINCIPAL 〕━━╮\n" +
    "┃\n" +
    "┃ Pair WhatsApp\n" +
    "┃ Statut\n" +
    "┃ Fonctionnalités\n" +
    (isAdmin ? "┃ Sessions\n┃ Administration\n" : "") +
    "┃ Commandes\n" +
    "┃\n" +
    "╰━━━━━━━━━━━━━━━━━━━━━━╯";

  const photo = await getTelegramMenuPhoto();
  const params = {
    chat_id: chatId,
    caption: `<pre>${caption}</pre>`,
    parse_mode: "HTML",
    reply_markup: telegramMainMenuKeyboard(isAdmin)
  };

  sendMenuSound(chatId).catch(() => {});

  try {
    if (photo) {
      return await tgCall("sendPhoto", { ...params, photo });
    }
  } catch (e) {
    addLog("telegram", "-", "menu-photo", "warning", `Envoi de la photo du menu échoué : ${e.message}`);
  }

  // Aucun avatar configuré sur le bot : le menu reste fonctionnel sans image.
  return tgCall("sendMessage", {
    chat_id: chatId,
    text: params.caption,
    parse_mode: "HTML",
    reply_markup: params.reply_markup
  });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function mentionHtml(user) {
  const name = escapeHtml(user.first_name || user.username || String(user.id));
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

// Nom brut échappé, sans lien cliquable : utilisé dans les blocs <pre>,
// où Telegram interdit d'imbriquer une autre balise (ex : <a>).
function plainName(user) {
  return escapeHtml(user.first_name || user.username || String(user.id));
}

// ── Pairing WhatsApp depuis Telegram (même moteur que le dashboard) ──

const telegramPairState = new Map(); // userId -> { chatId, expiresAt }
const telegramPairCooldown = new Map(); // userId -> timestamp dernière demande
const TELEGRAM_PAIR_TIMEOUT_MS = 5 * 60 * 1000;
const TELEGRAM_PAIR_COOLDOWN_MS = 15 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [uid, st] of telegramPairState) {
    if (now > st.expiresAt) telegramPairState.delete(uid);
  }
}, 60 * 1000);

async function beginPairFlow(chatId, userId) {
  if (telegramPairState.has(userId)) {
    return tgCall("sendMessage", {
      chat_id: chatId,
      text: "<pre>Pairing en cours\n\nEnvoie ton numéro, ou attends l'expiration (5 min).</pre>",
      parse_mode: "HTML"
    });
  }
  const lastAt = telegramPairCooldown.get(userId) || 0;
  if (Date.now() - lastAt < TELEGRAM_PAIR_COOLDOWN_MS) {
    return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Merci de patienter quelques secondes avant de relancer un pairing.</pre>", parse_mode: "HTML" });
  }
  telegramPairCooldown.set(userId, Date.now());
  telegramPairState.set(userId, { chatId, expiresAt: Date.now() + TELEGRAM_PAIR_TIMEOUT_MS });
  return tgCall("sendMessage", {
    chat_id: chatId,
    text: "<pre>Pairing WhatsApp\n\nEntrez votre numéro avec l'indicatif international.\n\nExemple : 237XXXXXXXXX</pre>",
    parse_mode: "HTML"
  });
}

async function handlePairingNumberInput(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = telegramPairState.get(userId);
  if (!state) return;

  if (Date.now() > state.expiresAt) {
    telegramPairState.delete(userId);
    return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Délai expiré.\n\nEnvoie /pair pour recommencer.</pre>", parse_mode: "HTML" });
  }

  const number = formatNumber(msg.text);
  if (!number || number.length < 8 || number.length > 15) {
    return tgCall("sendMessage", {
      chat_id: chatId,
      text: "<pre>Numéro invalide.\n\nEnvoie ton numéro WhatsApp avec l'indicatif international (ex : 237XXXXXXXXX).</pre>",
      parse_mode: "HTML"
    });
  }

  telegramPairState.delete(userId);
  await tgCall("sendMessage", { chat_id: chatId, text: "<pre>Génération du code en cours…</pre>", parse_mode: "HTML" }).catch(() => {});
  try {
    const code = await startBot(number);
    if (code) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: `<pre>Votre code de connexion\n\n${code}\n\nWhatsApp -> Appareils connectés -> Connecter un appareil -> Entrer le code.</pre>`,
        parse_mode: "HTML"
      });
      addLog("telegram", number, "pair", "success", `Code de pairing généré pour ${userId} via Telegram`);
    } else {
      await tgCall("sendMessage", { chat_id: chatId, text: "<pre>Ce numéro est déjà connecté.</pre>", parse_mode: "HTML" });
    }
  } catch (e) {
    addLog("telegram", "-", "pair", "error", e.message);
    await tgCall("sendMessage", { chat_id: chatId, text: `<pre>Erreur : ${escapeHtml(e.message)}</pre>`, parse_mode: "HTML" }).catch(() => {});
  }
}

// ── Bienvenue / au revoir Telegram ────────────────────────────────

async function handleTelegramWelcome(msg) {
  if (!telegramMessages.welcomeEnabled) return;
  const chatId = msg.chat.id;
  for (const member of msg.new_chat_members) {
    if (member.id === telegramState.botInfo?.id) continue; // le bot lui-même rejoint le groupe
    const text = telegramMessages.welcomeMessage
      .replaceAll("{user}", mentionHtml(member))
      .replaceAll("{name}", escapeHtml(member.first_name || ""))
      .replaceAll("{username}", member.username ? "@" + escapeHtml(member.username) : escapeHtml(member.first_name || ""))
      .replaceAll("{group}", escapeHtml(msg.chat.title || ""));
    try {
      if (telegramMessages.randomImage) {
        await tgCall("sendPhoto", { chat_id: chatId, photo: randomAvatar(), caption: text, parse_mode: "HTML" });
      } else {
        await tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
      }
      addLog("telegram", "-", "welcome", "success", `Bienvenue envoyée à ${member.id} dans ${chatId}`);
    } catch (e) {
      addLog("telegram", "-", "welcome", "error", e.message);
    }
  }
}

async function handleTelegramGoodbye(msg) {
  if (!telegramMessages.byeEnabled) return;
  const chatId = msg.chat.id;
  const member = msg.left_chat_member;
  if (!member || member.id === telegramState.botInfo?.id) return;
  const text = telegramMessages.byeMessage
    .replaceAll("{user}", mentionHtml(member))
    .replaceAll("{name}", escapeHtml(member.first_name || ""))
    .replaceAll("{username}", member.username ? "@" + escapeHtml(member.username) : escapeHtml(member.first_name || ""))
    .replaceAll("{group}", escapeHtml(msg.chat.title || ""));
  try {
    if (telegramMessages.randomImage) {
      await tgCall("sendPhoto", { chat_id: chatId, photo: randomAvatar(), caption: text, parse_mode: "HTML" });
    } else {
      await tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    }
    addLog("telegram", "-", "goodbye", "success", `Au revoir envoyé pour ${member.id} dans ${chatId}`);
  } catch (e) {
    addLog("telegram", "-", "goodbye", "error", e.message);
  }
}

// ── Modération de groupe Telegram (admins réels, permissions réelles) ──

const TELEGRAM_GROUP_TYPES = ["group", "supergroup"];
function isGroupChat(msg) {
  return TELEGRAM_GROUP_TYPES.includes(msg.chat.type);
}

async function isTelegramGroupAdmin(chatId, userId) {
  if (TELEGRAM_ADMINS.includes(userId)) return true;
  try {
    const member = await tgCall("getChatMember", { chat_id: chatId, user_id: userId });
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

async function requireBotPermission(chatId, permission) {
  try {
    const me = await tgCall("getChatMember", { chat_id: chatId, user_id: telegramState.botInfo.id });
    if (me.status !== "administrator") return false;
    return permission ? !!me[permission] : true;
  } catch {
    return false;
  }
}

function resolveTargetUser(msg, args) {
  if (msg.reply_to_message?.from) return msg.reply_to_message.from;
  const arg = (args[0] || "").replace(/^@/, "");
  if (arg && /^\d+$/.test(arg)) return { id: Number(arg) };
  return null;
}

async function runModerationCommand(msg, args, { permission, action, successText, needTarget = true }) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isGroupChat(msg)) {
    return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Cette commande fonctionne uniquement dans un groupe.</pre>", parse_mode: "HTML" });
  }
  if (!(await isTelegramGroupAdmin(chatId, userId))) {
    return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Vous devez être administrateur pour utiliser cette commande.</pre>", parse_mode: "HTML" });
  }

  let target = null;
  if (needTarget) {
    target = resolveTargetUser(msg, args);
    if (!target) {
      return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Réponds au message de l'utilisateur ciblé (ou indique son ID numérique) pour utiliser cette commande.</pre>", parse_mode: "HTML" });
    }
  }

  if (!(await requireBotPermission(chatId, permission))) {
    return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Impossible d'effectuer cette action. Le bot doit être administrateur avec les permissions nécessaires.</pre>", parse_mode: "HTML" });
  }

  try {
    await action(chatId, target);
    return tgCall("sendMessage", { chat_id: chatId, text: `<pre>${successText(target)}</pre>`, parse_mode: "HTML" });
  } catch (e) {
    addLog("telegram", "-", "moderation", "error", e.message);
    if (/user not found|USER_ID_INVALID|PARTICIPANT_ID_INVALID/i.test(e.message || "")) {
      return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Utilisateur introuvable.</pre>", parse_mode: "HTML" });
    }
    return tgCall("sendMessage", { chat_id: chatId, text: `<pre>Action refusée par Telegram : ${escapeHtml(e.message)}</pre>`, parse_mode: "HTML" });
  }
}

async function handleTelegramCommand(msg, cmd, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const isAdmin = TELEGRAM_ADMINS.includes(userId);
  const ownerOnly = ["/admin", "/bots", "/restart", "/whatsapp", "/sessions"];

  if (ownerOnly.includes(cmd) && !isAdmin) {
    return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Commande réservée aux administrateurs du bot.</pre>", parse_mode: "HTML" });
  }

  if (!ownerOnly.includes(cmd)) {
    const membership = await checkTelegramMembership(userId);
    if (!membership.bypass && isBlockedStatus(membership.status)) {
      return sendAccessDenied(chatId);
    }
  }

  switch (cmd) {
    case "/start":
    case "/menu":
      return sendMainMenu(chatId, userId);

    case "/help": {
      const commandRows = [
        [{ text: "Statut", callback_data: "menu_status" }, { text: "Fonctionnalités", callback_data: "menu_features" }],
        [{ text: "Pairing WhatsApp", callback_data: "start_pair" }, { text: "Groupes", callback_data: "menu_groups" }]
      ];
      if (isAdmin) {
        commandRows.push([{ text: "Sessions", callback_data: "menu_whatsapp" }, { text: "Administration", callback_data: "menu_admin" }]);
      }
      return tgCall("sendMessage", {
        chat_id: chatId,
        text:
          "Centre de commandes\n\n" +
          "▸ Général\n" +
          "/start /menu — Menu principal\n" +
          "/help — Cette aide\n" +
          "/pair — Pairing WhatsApp\n" +
          "/status — Statut de la plateforme\n" +
          "/features — Fonctionnalités\n" +
          "/groups — Groupes détectés\n" +
          "/id — Afficher un ID\n\n" +
          "▸ Modération (réponds au message de la cible)\n" +
          "/promote /demote /restrict /unrestrict\n" +
          "/kick /ban /unban /userinfo /admins" +
          (isAdmin ? "\n\n▸ Propriétaire\n/whatsapp /sessions — Sessions WhatsApp\n/admin — Panneau admin" : "") +
          "\n\nTouche un bouton ou une commande pour l'exécuter directement.",
        reply_markup: { inline_keyboard: commandRows }
      });
    }

    case "/status": {
      const connected = [...bots.values()].filter(b => b.linked).length;
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: `<pre>╭━━〔 TAKAMURA STATUS 〕━━╮
┃
┃ Sessions   : ${connected}/${bots.size}
┃ Messages   : ${stats.messagesProcessed}
┃ Commandes  : ${stats.commandsExecuted}
┃ Uptime     : ${formatUptime(Date.now() - startedAt)}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯</pre>`,
        parse_mode: "HTML"
      });
    }

    case "/features":
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: `<pre>╭━━〔 FONCTIONNALITÉS 〕━━╮
┃
┃ AntiLink
┃ AntiPhoto   AntiVideo
┃ AntiAudio   AntiDocument
┃ AntiSticker AntiSpam
┃ AntiTag     AntiCall
┃ Welcome     Bye
┃ AutoRead    AutoReact
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯</pre>`,
        parse_mode: "HTML"
      });

    case "/whatsapp":
    case "/sessions": {
      if (bots.size === 0) return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Aucune session WhatsApp enregistrée.</pre>", parse_mode: "HTML" });
      const list = [...bots.entries()].map(([num, b]) => `${b.linked ? "[ON] " : "[OFF]"} ${num} — ${b.messages} messages`).join("\n");
      return tgCall("sendMessage", { chat_id: chatId, text: `<pre>Sessions WhatsApp\n\n${list}</pre>`, parse_mode: "HTML" });
    }

    case "/pair":
      return beginPairFlow(chatId, userId);

    case "/groups":
      return tgCall("sendMessage", { chat_id: chatId, text: `<pre>Groupes détectés : ${stats.groupsDetected.size}</pre>`, parse_mode: "HTML" });

    case "/id":
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: `<pre>Chat ID : ${chatId}\nVotre ID : ${userId}${msg.reply_to_message ? `\nID de l'utilisateur cité : ${msg.reply_to_message.from.id}` : ""}</pre>`,
        parse_mode: "HTML"
      });

    case "/promote":
      return runModerationCommand(msg, args, {
        permission: "can_promote_members",
        action: (cid, target) => tgCall("promoteChatMember", {
          chat_id: cid, user_id: target.id,
          can_change_info: true, can_delete_messages: true, can_invite_users: true,
          can_restrict_members: true, can_pin_messages: true, can_manage_video_chats: true
        }),
        successText: (t) => `${plainName(t)} a été promu administrateur.`
      });

    case "/demote":
      return runModerationCommand(msg, args, {
        permission: "can_promote_members",
        action: (cid, target) => tgCall("promoteChatMember", {
          chat_id: cid, user_id: target.id,
          can_change_info: false, can_delete_messages: false, can_invite_users: false,
          can_restrict_members: false, can_pin_messages: false, can_manage_video_chats: false
        }),
        successText: (t) => `${plainName(t)} a été rétrogradé.`
      });

    case "/restrict":
      return runModerationCommand(msg, args, {
        permission: "can_restrict_members",
        action: (cid, target) => tgCall("restrictChatMember", {
          chat_id: cid, user_id: target.id,
          permissions: { can_send_messages: false, can_send_photos: false, can_send_videos: false, can_send_other_messages: false }
        }),
        successText: (t) => `${plainName(t)} a été restreint.`
      });

    case "/unrestrict":
      return runModerationCommand(msg, args, {
        permission: "can_restrict_members",
        action: (cid, target) => tgCall("restrictChatMember", {
          chat_id: cid, user_id: target.id,
          permissions: { can_send_messages: true, can_send_photos: true, can_send_videos: true, can_send_other_messages: true, can_add_web_page_previews: true }
        }),
        successText: (t) => `${plainName(t)} n'est plus restreint.`
      });

    case "/kick":
      return runModerationCommand(msg, args, {
        permission: "can_restrict_members",
        action: async (cid, target) => {
          await tgCall("banChatMember", { chat_id: cid, user_id: target.id });
          await tgCall("unbanChatMember", { chat_id: cid, user_id: target.id, only_if_banned: true });
        },
        successText: (t) => `${plainName(t)} a été exclu du groupe.`
      });

    case "/ban":
      return runModerationCommand(msg, args, {
        permission: "can_restrict_members",
        action: (cid, target) => tgCall("banChatMember", { chat_id: cid, user_id: target.id }),
        successText: (t) => `${plainName(t)} a été banni.`
      });

    case "/unban":
      return runModerationCommand(msg, args, {
        permission: "can_restrict_members",
        action: (cid, target) => tgCall("unbanChatMember", { chat_id: cid, user_id: target.id }),
        successText: (t) => `${plainName(t)} a été débanni.`
      });

    case "/userinfo": {
      if (!isGroupChat(msg)) return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Cette commande fonctionne uniquement dans un groupe.</pre>", parse_mode: "HTML" });
      const target = resolveTargetUser(msg, args) || msg.from;
      try {
        const member = await tgCall("getChatMember", { chat_id: chatId, user_id: target.id });
        return tgCall("sendMessage", {
          chat_id: chatId,
          text: `<pre>Utilisateur\n\nID : ${member.user.id}\nNom : ${escapeHtml(member.user.first_name || "")}\nUsername : ${member.user.username ? "@" + escapeHtml(member.user.username) : "—"}\nStatut : ${member.status}</pre>`,
          parse_mode: "HTML"
        });
      } catch (e) {
        return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Utilisateur introuvable.</pre>", parse_mode: "HTML" });
      }
    }

    case "/admins": {
      if (!isGroupChat(msg)) return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Cette commande fonctionne uniquement dans un groupe.</pre>", parse_mode: "HTML" });
      try {
        const admins = await tgCall("getChatAdministrators", { chat_id: chatId });
        const list = admins.map(a => `${a.status === "creator" ? "[Owner]" : "[Admin]"} ${escapeHtml(a.user.first_name || "")}${a.user.username ? " (@" + escapeHtml(a.user.username) + ")" : ""}`).join("\n");
        return tgCall("sendMessage", { chat_id: chatId, text: `<pre>Administrateurs\n\n${list}</pre>`, parse_mode: "HTML" });
      } catch (e) {
        return tgCall("sendMessage", { chat_id: chatId, text: `<pre>Action refusée par Telegram : ${escapeHtml(e.message)}</pre>`, parse_mode: "HTML" });
      }
    }

    case "/admin":
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: "Panneau admin\n\n/bots – liste des sessions\n/logs – 10 derniers logs\n/restart <numero> – reconnecter une session"
      });

    case "/bots": {
      const list = [...bots.keys()].join(", ") || "aucun";
      return tgCall("sendMessage", { chat_id: chatId, text: `<pre>Sessions : ${list}</pre>`, parse_mode: "HTML" });
    }

    case "/logs": {
      const recent = logs.slice(-10).map(l => `[${l.severity}] ${l.platform}/${l.session}: ${l.message}`).join("\n") || "Aucun log.";
      return tgCall("sendMessage", { chat_id: chatId, text: `<pre>${escapeHtml(recent)}</pre>`, parse_mode: "HTML" });
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
      await tgCall("answerCallbackQuery", { callback_query_id: query.id, text: "Accès vérifié" });
      return sendMainMenu(chatId, userId);
    }

    await tgCall("answerCallbackQuery", { callback_query_id: query.id });

    const isAdmin = TELEGRAM_ADMINS.includes(userId);
    const fakeMsg = { chat: { id: chatId }, from: { id: userId } };

    if (data === "start_pair") return beginPairFlow(chatId, userId);
    if (data === "menu_features") return handleTelegramCommand(fakeMsg, "/features", []);
    if (data === "menu_status") return handleTelegramCommand(fakeMsg, "/status", []);
    if (data === "menu_groups") return handleTelegramCommand(fakeMsg, "/groups", []);
    if (data === "menu_commands") return handleTelegramCommand(fakeMsg, "/help", []);

    if (data === "menu_whatsapp" || data === "menu_admin") {
      if (!isAdmin) {
        return tgCall("sendMessage", { chat_id: chatId, text: "<pre>Section réservée aux administrateurs du bot.</pre>", parse_mode: "HTML" });
      }
      if (data === "menu_whatsapp") return handleTelegramCommand(fakeMsg, "/whatsapp", []);
      return tgCall("sendMessage", {
        chat_id: chatId,
        text: "Administration\n\nModération de groupe (admins du groupe, en réponse au message de la cible) :\n/promote /demote /restrict /unrestrict /kick /ban /unban /userinfo /admins\n\nPanneau propriétaire du bot : /admin"
      });
    }
  } catch (e) {
    addLog("telegram", "-", "callback", "error", e.message);
  }
}

async function processTelegramUpdate(update) {
  telegramState.lastUpdate = Date.now();
  try {
    if (update.message) {
      const msg = update.message;

      if (msg.new_chat_members?.length) {
        await handleTelegramWelcome(msg).catch(e => addLog("telegram", "-", "welcome", "error", e.message));
      }
      if (msg.left_chat_member) {
        await handleTelegramGoodbye(msg).catch(e => addLog("telegram", "-", "goodbye", "error", e.message));
      }

      if (typeof msg.text === "string") {
        const trimmed = msg.text.trim();
        if (trimmed.startsWith("/")) {
          const [cmdRaw, ...args] = trimmed.split(/\s+/);
          await handleTelegramCommand(msg, cmdRaw.split("@")[0].toLowerCase(), args);
        } else if (telegramPairState.has(msg.from.id)) {
          await handlePairingNumberInput(msg);
        }
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
        { command: "pair", description: "Générer un code de pairing WhatsApp" },
        { command: "status", description: "Statut de la plateforme" },
        { command: "features", description: "Fonctionnalités" },
        { command: "whatsapp", description: "Sessions WhatsApp" },
        { command: "groups", description: "Groupes détectés" },
        { command: "promote", description: "Promouvoir un membre (admin)" },
        { command: "demote", description: "Rétrograder un membre (admin)" },
        { command: "restrict", description: "Restreindre un membre (admin)" },
        { command: "unrestrict", description: "Lever les restrictions (admin)" },
        { command: "kick", description: "Exclure un membre (admin)" },
        { command: "ban", description: "Bannir un membre (admin)" },
        { command: "unban", description: "Débannir un membre (admin)" },
        { command: "userinfo", description: "Infos sur un membre" },
        { command: "admins", description: "Liste des administrateurs" },
        { command: "id", description: "Afficher un ID" }
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
// Limite relevée pour accepter les images welcome/bye envoyées en base64.
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

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

// ── Authentification admin (dashboard web) ──────────────────────
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = issueAdminToken();
    addLog("system", "-", "admin-login", "success", "Connexion admin réussie");
    return ok(res, { token, expiresIn: ADMIN_TOKEN_TTL_MS }, "Connexion réussie");
  }
  addLog("system", "-", "admin-login", "warning", `Tentative de connexion admin échouée (${username || "?"})`);
  return fail(res, "INVALID_CREDENTIALS", "Identifiants invalides", 401);
});

// ── Pairing (conservé, inchangé côté contrat, + préfixe optionnel) ──
app.get("/pair-api/code", async (req, res) => {
  const { number, prefix } = req.query;
  if (!number) return res.json({ error: "Numéro requis" });
  try {
    const code = await startBot(number, { prefix });
    if (code) return res.json({ code });
    return res.json({ status: "connected" });
  } catch (err) {
    addLog("whatsapp", number, "pair", "error", err.message);
    return res.json({ error: err.message || "Erreur serveur" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", bots: bots.size }));

// ── Compression vidéo (outil web public, sans authentification) ──
// Le corps de la requête est le fichier vidéo brut (Content-Type
// quelconque, non parsé par express.json/urlencoded ci-dessus car ce
// n'est ni du JSON ni de l'urlencoded — express.raw le récupère donc
// intact). ?percent=25|50|80 choisit le palier de compression.
app.post("/api/compress-video", express.raw({ limit: "300mb", type: () => true }), async (req, res) => {
  const percent = parseInt(req.query.percent, 10);
  if (!COMPRESS_PRESETS.includes(percent)) {
    return fail(res, "BAD_PERCENT", "Le paramètre percent doit valoir 25, 50 ou 80", 400);
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return fail(res, "NO_FILE", "Aucun fichier vidéo reçu", 400);
  }
  try {
    const { buffer, originalSize, compressedSize, reduction } = await compressVideoBuffer(req.body, percent);
    addLog("system", "-", "compress-web", "success", `Vidéo compressée : ${humanSize(originalSize)} → ${humanSize(compressedSize)} (${reduction}%)`);
    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="compressed-${percent}.mp4"`,
      "X-Original-Size": String(originalSize),
      "X-Compressed-Size": String(compressedSize),
      "X-Reduction-Percent": String(reduction)
    });
    res.send(buffer);
  } catch (e) {
    addLog("system", "-", "compress-web", "error", e.message);
    fail(res, "COMPRESS_FAILED", e.message || "Compression échouée", 500);
  }
});

// ── Config générale (avatars, liens communauté, etc.) ─────────────
app.get("/api/config", (req, res) => {
  ok(res, {
    avatarImages: AVATAR_IMAGES,
    whatsappGroupLink: AUTO_JOIN_GROUP_LINKS[0] || null,
    whatsappChannelLink: AUTO_JOIN_CHANNEL_LINKS[0] || null,
    telegramGroupLink: TELEGRAM_GROUP_INVITE_LINK || null
  });
});

// ── API santé / stats ───────────────────────────────────────────
app.get("/api/health", (req, res) => {
  ok(res, { status: "ok", uptime: Date.now() - startedAt, sessions: bots.size });
});

app.get("/api/stats", requireAdmin, (req, res) => {
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
    promotionsReverted: stats.promotionsReverted,
    demotionsReverted: stats.demotionsReverted,
    telegramRequests: stats.telegramRequests,
    errors: stats.errors,
    uptime: Date.now() - startedAt,
    telegramStatus: telegramState.configured ? (telegramState.polling ? "connected" : "stopped") : "not_configured"
  });
});

// ── Sessions ─────────────────────────────────────────────────────
app.get("/api/sessions", requireAdmin, (req, res) => {
  const list = [...bots.entries()].map(([number, b]) => ({
    number,
    status: b.linked ? "connected" : "connecting",
    uptime: b.connectedAt ? Date.now() - b.connectedAt : 0,
    messages: b.messages,
    groups: b.groups.size,
    commands: b.commandsRun,
    lastActivity: b.lastActivity,
    reconnectAttempts: b.reconnectAttempts || 0
  }));
  ok(res, list);
});

app.get("/api/sessions/:number", requireAdmin, (req, res) => {
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

app.post("/api/sessions/:number/reconnect", requireAdmin, async (req, res) => {
  const number = formatNumber(req.params.number);
  const existing = bots.get(number);
  if (existing) {
    existing.manualClose = false;
    existing.reconnectAttempts = 0;
    clearTimeout(existing.reconnectTimer);
  }
  try {
    await startBot(number);
    ok(res, { number }, "Reconnexion lancée");
  } catch (e) {
    fail(res, "RECONNECT_FAILED", e.message);
  }
});

app.post("/api/sessions/:number/disconnect", requireAdmin, async (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  b.manualClose = true;
  clearTimeout(b.reconnectTimer);
  await closeExistingSocket(b);
  b.linked = false;
  addLog("whatsapp", number, "disconnect", "info", "Déconnecté via API");
  ok(res, { number }, "Session déconnectée");
});

app.delete("/api/sessions/:number", requireAdmin, async (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  b.manualClose = true;
  clearTimeout(b.reconnectTimer);
  await closeExistingSocket(b);
  bots.delete(number);
  await removeSession(path.join(PAIRING_DIR, number));
  addLog("whatsapp", number, "delete", "warning", "Session supprimée via API");
  ok(res, { number }, "Session supprimée");
});

// ── Protections / Features ──────────────────────────────────────

// Resynchronise le cache rapide `bot.features` à partir de `bot.config`
// (utilisé par le moteur WhatsApp) après application d'un patch.
function syncFeaturesFromConfig(b) {
  b.features.antilink = b.config.antilink?.enabled || false;
  b.features.welcome = b.config.welcome;
  b.features.bye = b.config.bye;
  b.features.antipromote = b.config.antipromote || false;
  b.features.antidemote = b.config.antidemote || false;
  b.features.autoread = b.config.autoread;
  b.features.autoreact = b.config.autoreact;
  b.features.autotyping = b.config.autotyping;
  b.features.autorecording = b.config.autorecording;
}

app.get("/api/features/:number", requireAdmin, (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  ok(res, b.config);
});

app.post("/api/features/:number", requireAdmin, async (req, res) => {
  const number = formatNumber(req.params.number);
  const b = bots.get(number);
  if (!b) return fail(res, "SESSION_NOT_FOUND", "Session introuvable", 404);
  const patch = req.body || {};
  b.config = { ...b.config, ...patch };
  syncFeaturesFromConfig(b);
  const saved = await saveProtectionConfig(number);
  addLog("whatsapp", number, "config", "info", "Configuration mise à jour via API");
  ok(res, b.config, saved ? "Configuration enregistrée" : "Configuration mise à jour (non persistée)");
});

// Config "tous les numéros" : sert de défaut pour toute session future,
// et peut être appliquée en un clic à toutes les sessions déjà connectées.
app.get("/api/features-all", requireAdmin, async (req, res) => {
  const defaults = await loadGlobalProtectionDefaults();
  ok(res, defaults);
});

app.post("/api/features-all", requireAdmin, async (req, res) => {
  const patch = req.body || {};
  const merged = { ...(await loadGlobalProtectionDefaults()), ...patch };
  const savedGlobal = await saveGlobalProtectionDefaults(merged);

  let appliedCount = 0;
  for (const [number, b] of bots.entries()) {
    b.config = { ...b.config, ...patch };
    syncFeaturesFromConfig(b);
    await saveProtectionConfig(number);
    appliedCount++;
  }

  addLog("whatsapp", "-", "config", "info", `Configuration globale mise à jour via API (${appliedCount} session(s) connectée(s) impactée(s))`);
  ok(res, merged, savedGlobal
    ? `Défaut global enregistré et appliqué à ${appliedCount} session(s) connectée(s)`
    : "Configuration appliquée aux sessions connectées (non persistée comme défaut global)");
});

// ── Telegram ─────────────────────────────────────────────────────
app.get("/api/telegram/status", requireAdmin, (req, res) => {
  ok(res, {
    configured: telegramState.configured,
    polling: telegramState.polling,
    username: telegramState.botInfo?.username || null,
    id: telegramState.botInfo?.id || null,
    lastUpdate: telegramState.lastUpdate,
    errors: telegramState.errors,
    tokenMasked: telegramState.configured ? "•".repeat(16) : "non configuré",
    automation: {
      welcome: telegramMessages.welcomeEnabled,
      bye: telegramMessages.byeEnabled,
      randomImage: telegramMessages.randomImage,
      moderationAvailable: telegramState.configured
    }
  });
});

app.get("/api/telegram/stats", requireAdmin, (req, res) => {
  ok(res, { requests: stats.telegramRequests, errors: telegramState.errors });
});

app.post("/api/telegram/test", requireAdmin, async (req, res) => {
  if (!telegramState.configured) return fail(res, "TELEGRAM_NOT_CONFIGURED", "Token Telegram non configuré");
  try {
    const me = await tgCall("getMe");
    ok(res, me, "Connexion Telegram OK");
  } catch (e) {
    fail(res, "TELEGRAM_ERROR", e.message);
  }
});

app.get("/api/telegram/messages", requireAdmin, (req, res) => {
  ok(res, telegramMessages);
});

app.post("/api/telegram/messages", requireAdmin, async (req, res) => {
  const patch = req.body || {};
  telegramMessages = { ...telegramMessages, ...patch };
  const saved = await saveTelegramMessages();
  addLog("telegram", "-", "config", "info", "Messages welcome/goodbye mis à jour via API");
  ok(res, telegramMessages, saved ? "Messages enregistrés" : "Messages mis à jour (non persistés)");
});

// ── Logs ─────────────────────────────────────────────────────────
app.get("/api/logs", requireAdmin, (req, res) => {
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
