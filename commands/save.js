// commands/save.js
import { downloadMediaMessage } from "@whiskeysockets/baileys";

export default {
  name: "save",
  description: "Sauvegarde un texte ou un média en message privé",

  async execute(sock, message, args) {
    const { from, reply, isGroup, sender, raw } = message;
    const selfJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";

    try {
      // 📌 Message ciblé (reply ou direct)
      const quoted =
        raw.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
        raw.message;

      if (!quoted) {
        return await reply(
          "⚠️ Réponds à un message, média ou sticker avec .save"
        );
      }

      const type = Object.keys(quoted)[0];

      // ========= TEXTE =========
      if (type === "conversation" || type === "extendedTextMessage") {
        const text =
          quoted.conversation ||
          quoted.extendedTextMessage?.text ||
          "⚡ Message vide";

        await sock.sendMessage(selfJid, {
          text:
            "*_📜 Message sauvegardé\n\n✏️ Contenu : " + text + "_*",
        });

        await reply("✅ Le texte a été sauvegardé.");
        return;
      }

      // ========= MÉDIAS =========
      const buffer = await downloadMediaMessage(
        { message: quoted },
        "buffer",
        {},
        { logger: console }
      );

      let content = {};

      if (type === "imageMessage") {
        content = { image: buffer, caption: "*_🖼️ Image sauvegardée_*" };
      } else if (type === "videoMessage") {
        content = { video: buffer, caption: "*_🎥 Vidéo sauvegardée_*" };
      } else if (type === "audioMessage") {
        content = {
          audio: buffer,
          mimetype: "audio/mpeg",
          fileName: "saved_audio.mp3",
        };
      } else if (type === "documentMessage") {
        content = {
          document: buffer,
          fileName: quoted.documentMessage?.fileName || "saved_file",
        };
      } else if (type === "stickerMessage") {
        content = { sticker: buffer };
      } else {
        await reply(
          "❌ Ce type de média n'est pas supporté."
        );
        return;
      }

      // 📥 Envoi privé
      await sock.sendMessage(selfJid, content);

      await reply("✅ Le média a été sauvegardé avec succès.");
    } catch (err) {
      console.error("❌ SAVE error:", err);
      await reply(
        "❌ Impossible de sauvegarder le contenu."
      );
    }
  }
};
