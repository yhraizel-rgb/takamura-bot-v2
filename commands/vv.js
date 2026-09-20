import { downloadContentFromMessage } from "@whiskeysockets/baileys";

export default {
  name: "vv",
  description: "Récupère le média vue unique",

  async execute(sock, message, args) {
    const msg = message.raw;
    const from = msg.key.remoteJid;

    try {
      const context = msg.message?.extendedTextMessage?.contextInfo;

      if (!context?.quotedMessage) {
        return await sock.sendMessage(from, {
          text: "```⚠️ Réponds à une photo, vidéo ou audio vue unique.```"
        });
      }

      // 🔓 unwrap view once / ephemeral
      const quoted =
        context.quotedMessage.viewOnceMessageV2?.message ||
        context.quotedMessage.viewOnceMessageV2Extension?.message ||
        context.quotedMessage.ephemeralMessage?.message ||
        context.quotedMessage;

      // ---------- IMAGE ----------
      if (quoted.imageMessage) {
        const stream = await downloadContentFromMessage(
          quoted.imageMessage,
          "image"
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream)
          buffer = Buffer.concat([buffer, chunk]);

        await sock.sendMessage(from, {
          image: buffer,
          caption: "```📸 Vue unique désactivée```"
        }, { quoted: msg });

        await sock.sendMessage(from, {
          react: { text: "📸", key: msg.key }
        });
        return;
      }

      // ---------- VIDEO ----------
      if (quoted.videoMessage) {
        const stream = await downloadContentFromMessage(
          quoted.videoMessage,
          "video"
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream)
          buffer = Buffer.concat([buffer, chunk]);

        await sock.sendMessage(from, {
          video: buffer,
          caption: "```🎥 Vue unique désactivée```"
        }, { quoted: msg });

        await sock.sendMessage(from, {
          react: { text: "🎥", key: msg.key }
        });
        return;
      }

      // ---------- AUDIO ----------
      if (quoted.audioMessage) {
        const stream = await downloadContentFromMessage(
          quoted.audioMessage,
          "audio"
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream)
          buffer = Buffer.concat([buffer, chunk]);

        await sock.sendMessage(from, {
          audio: buffer,
          mimetype: "audio/mp4",
          ptt: quoted.audioMessage.ptt || false
        }, { quoted: msg });

        await sock.sendMessage(from, {
          react: { text: "🎵", key: msg.key }
        });
        return;
      }

      // ---------- ERREUR ----------
      await sock.sendMessage(from, {
        text: "```❌ Ce message n’est pas un média vue unique.```"
      });

    } catch (e) {
      console.error("❌ Erreur vv :", e);
      await sock.sendMessage(from, {
        text: "```❌ Erreur lors de la récupération du média.```"
      });
    }
  }
};