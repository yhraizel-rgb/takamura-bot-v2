export default {
  name: "tag",
  description: "Taguer tous les membres d’un groupe avec un message ou un média cité",

  async execute(sock, message, args) {
    const { from, reply, raw } = message;

    if (!from.endsWith("@g.us")) {
      return await reply("❌ Commande réservée aux groupes.");
    }

    try {
      const groupMetadata = await sock.groupMetadata(from);
      const mentions = groupMetadata.participants.map(p => p.id);

      const quotedMsg = raw.message?.extendedTextMessage?.contextInfo?.quotedMessage;

      if (quotedMsg) {
        const text = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text;
        if (text) return await sock.sendMessage(from, { text, mentions }, { quoted: raw });

        // Vérifie chaque type de média séparément
        if (quotedMsg.imageMessage) {
          return await sock.sendMessage(from, { image: quotedMsg.imageMessage, mentions }, { quoted: raw });
        }

        if (quotedMsg.videoMessage) {
          return await sock.sendMessage(from, { video: quotedMsg.videoMessage, mentions }, { quoted: raw });
        }

        if (quotedMsg.stickerMessage) {
          return await sock.sendMessage(from, { sticker: quotedMsg.stickerMessage, mentions }, { quoted: raw });
        }

        if (quotedMsg.documentMessage) {
          return await sock.sendMessage(from, { document: quotedMsg.documentMessage, mentions }, { quoted: raw });
        }

        return await sock.sendMessage(from, { text: "❌ Type de message non supporté.", mentions }, { quoted: raw });
      }

      if (args.length) {
        return await sock.sendMessage(from, { text: args.join(" "), mentions }, { quoted: raw });
      }

      // Texte par défaut "hey"
      await sock.sendMessage(from, { text: "hey", mentions }, { quoted: raw });

    } catch (err) {
      await reply(`❌ Erreur tag : ${err.message}`);
    }
  }
};
