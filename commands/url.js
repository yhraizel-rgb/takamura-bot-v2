import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import fs from "fs";
import { join } from "path";
import FormData from "form-data";
import axios from "axios";

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export default {
  name: "url",
  description: "Génère une URL à partir d'une image, vidéo ou audio",

  async execute(sock, message) {
    const { from, raw, reply } = message;

    try {
      const quoted = raw.message?.extendedTextMessage?.contextInfo?.quotedMessage || raw.message;
      const type = quoted.imageMessage ? "image" : quoted.videoMessage ? "video" : quoted.audioMessage ? "audio" : null;
      if (!type) return await reply("⚠️ Réponds à un média.");

      const stream = await downloadContentFromMessage(quoted[`${type}Message`], type);
      const buffer = await streamToBuffer(stream);

      const tempDir = "./temp"; fs.mkdirSync(tempDir, { recursive: true });
      const ext = type === "image" ? "jpg" : type === "video" ? "mp4" : "mp3";
      const path = join(tempDir, `media_${Date.now()}.${ext}`);
      fs.writeFileSync(path, buffer);

      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("fileToUpload", fs.createReadStream(path));

      const url = (await axios.post("https://catbox.moe/user/api.php", form, { headers: form.getHeaders() })).data;
      fs.unlinkSync(path);

      await reply(`🔗 ${url}`);
    } catch (err) {
      await reply(`❌ ${err.message}`);
    }
  }
};
