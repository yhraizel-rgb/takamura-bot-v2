// commands/take.js
import { Sticker, StickerTypes } from "wa-sticker-formatter";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

export default {
  name: "take",
  description: "Reprendre un sticker et le re-signer",

  async execute(sock, message, args) {
    const { from, reply, isGroup, sender, raw } = message;

    try {
      // 🎯 Sticker cité
      const quotedSticker =
        raw.message?.extendedTextMessage?.contextInfo?.quotedMessage
          ?.stickerMessage;

      if (!quotedSticker) {
        return await reply(
          "⚠️ Réponds à un sticker pour que je le re-signe."
        );
      }

      // ⬇️ Téléchargement du sticker
      const stream = await downloadContentFromMessage(
        quotedSticker,
        "sticker"
      );

      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      // 🔥 Re-création du sticker
      const sticker = new Sticker(buffer, {
        pack: "",
        author: sender?.pushName || "TAKAMURA",
        type: StickerTypes.FULL,
        quality: 80,
      });

      await sock.sendMessage(
        from,
        { sticker: await sticker.build() },
        { quoted: raw }
      );

      await reply("✅ Le sticker a été re-signé avec succès.");
    } catch (err) {
      console.error("❌ TAKE error:", err);
      await reply(
        "❌ Échec de la re-création du sticker."
      );
    }
  }
};
