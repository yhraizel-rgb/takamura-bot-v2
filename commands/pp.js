// commands/pp.js
export default {
  name: "pp",
  description: "Récupère la photo de profil de plusieurs membres (reply/mention)",

  async execute(sock, message, args) {
    const { from, reply, raw, sender } = message;

    try {
      // 1️⃣ Déterminer les cibles
      let targets = raw.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

      const quotedUser = raw.message?.extendedTextMessage?.contextInfo?.participant;
      if (quotedUser && !targets.includes(quotedUser)) targets.push(quotedUser);

      if (targets.length === 0) targets.push(sender); // par défaut l'auteur

      // 2️⃣ Récupérer toutes les photos
      const photos = [];
      const captions = [];

      for (const target of targets) {
        let ppUrl;
        try {
          ppUrl = await sock.profilePictureUrl(target, "image");
        } catch {
          ppUrl = null;
        }

        if (!ppUrl) {
          captions.push(`❌ Impossible de récupérer la photo de ${target.split("@")[0]}`);
          continue;
        }

        photos.push({ url: ppUrl });
        captions.push(`📸 ${target.split("@")[0]}`);
      }

      if (photos.length === 0) {
        await reply("❌ Aucune photo de profil disponible.");
        return;
      }

      // 3️⃣ Envoyer toutes les photos en un seul message si possible
      // WhatsApp ne permet pas d'envoyer plusieurs images avec des légendes différentes en un seul message,
      // mais on peut envoyer un album de medias
      const mediaMessages = photos.map((p, i) => ({
        image: { url: p.url },
        caption: captions[i]
      }));

      for (const media of mediaMessages) {
        await sock.sendMessage(from, media);
      }

    } catch (err) {
      console.error("❌ PP error:", err);
      await reply("❌ Une erreur est survenue lors de la récupération des photos.");
    }
  }
};