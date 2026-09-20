import { Sticker, StickerTypes } from "wa-sticker-formatter";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export default {
  name: "sticker",
  description: "Transformer une image/vidéo en sticker",

  async execute(sock, message) {
    const { from, raw, reply, pushName } = message;

    try {
      const quoted = raw.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const mediaMsg = quoted || raw.message;

      const type = mediaMsg.imageMessage ? "imageMessage" : mediaMsg.videoMessage ? "videoMessage" : null;
      if (!type) return await reply("⚠️ Réponds ou envoie une image ou vidéo.");

      const stream = await downloadContentFromMessage(mediaMsg[type], type === "imageMessage" ? "image" : "video");
      const buffer = await streamToBuffer(stream);

      const sticker = new Sticker(buffer, { pack: "TAKAMURA", author: pushName || "Bot", type: StickerTypes.FULL, quality: 80 });
      await sock.sendMessage(from, { sticker: await sticker.build() }, { quoted: raw });

    } catch (err) {
      await reply(`❌ ${err.message}`);
    }
  }
};
