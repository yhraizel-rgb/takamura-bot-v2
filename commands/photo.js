import { downloadContentFromMessage } from "@whiskeysockets/baileys";

export default {
  name: "photo",
  description: "Convertir un sticker en image",

  async execute(sock, message) {
    const { from, reply, quoted } = message;

    try {
      if (!quoted?.stickerMessage) {
        return await reply("❌ Réponds à un sticker");
      }

      const stream = await downloadContentFromMessage(quoted.stickerMessage, "sticker");
      const chunks = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      await sock.sendMessage(from, {
        image: Buffer.concat(chunks)
      });

      await reply("✅");

    } catch {
      await reply("❌");
    }
  }
};
