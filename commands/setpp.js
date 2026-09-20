import { downloadContentFromMessage } from "@whiskeysockets/baileys";

export default {
  name: "setpp",
  description: "Changer la photo de profil du bot via une image citée",

  async execute(sock, message, args) {
    const { from, reply, raw } = message;

    const ctxInfo = raw.message?.extendedTextMessage?.contextInfo;

    if (!ctxInfo || !ctxInfo.quotedMessage?.imageMessage) {
      return await reply(
        "⚠️ Réponds à une image pour changer la photo de profil du bot."
      );
    }

    try {
      const quoted = ctxInfo.quotedMessage.imageMessage;

      // Télécharger l'image
      const stream = await downloadContentFromMessage(quoted, "image");
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

      // Mettre à jour la photo de profil
      await sock.updateProfilePicture(sock.user.id, buffer);

      await reply("✅ La photo de profil du bot a été mise à jour !");
    } catch (err) {
      console.error("❌ Erreur setpp :", err);
      await reply("❌ Impossible de changer la photo de profil.");
    }
  }
};
