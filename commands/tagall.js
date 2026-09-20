import fs from 'fs/promises';

export default {
  name: "tagall",
  description: "Afficher et mentionner tous les membres",

  async execute(sock, message) {
    const { from, reply } = message;

    try {
      // Vérification que c'est un groupe
      if (!from.endsWith('@g.us')) {
        return await reply("🟡 Réservé aux groupes");
      }

      await reply("⏳ Recensement en cours...");

      const start = Date.now();
      const groupMetadata = await sock.groupMetadata(from);
      const participants = groupMetadata.participants || [];
      const mentions = participants.map(p => p.id);
      const latency = Date.now() - start;

      // Formatage liste des membres
      let membersList = "";
      const maxDisplay = 15;

      if (participants.length <= maxDisplay) {
        membersList = participants
          .map((p, i) => `➤ ${i + 1}. @${p.id.split("@")[0]}`)
          .join("\n");
      } else {
        membersList = participants
          .slice(0, maxDisplay)
          .map((p, i) => `➤ ${i + 1}. @${p.id.split("@")[0]}`)
          .join("\n");
        membersList += `\n... et ${participants.length - maxDisplay} autres`;
      }

      const caption = `*_🔊 APPEL GÉNÉRAL_*\n\n` +
                     `📊 Statistiques :\n` +
                     `┣ 👥 Membres : ${participants.length}\n` +
                     `┣ ⚡ Temps : ${latency}ms\n` +
                     `┗ 📅 ${new Date().toLocaleDateString()}\n\n` +
                     `👤 Liste des membres :\n${membersList}`;

      // Chemin vers l'image (ajuster selon votre structure)
      const imagePath = './assets/menu.jpg';

      // Lire l'image
      const imageBuffer = await fs.readFile(imagePath);

      // Envoyer l'image avec légende
      await sock.sendMessage(from, {
        image: imageBuffer,
        caption: caption,
        mentions: mentions
      });

    } catch (error) {
      console.error("Erreur tagall:", error);

      // Fallback sans image
      try {
        const groupMetadata = await sock.groupMetadata(from);
        const participants = groupMetadata.participants || [];
        const mentions = participants.map(p => p.id);

        const fallbackText = `*_🔊 APPEL GÉNÉRAL_*\n\n` +
                           `📊 Statistiques :\n` +
                           `┣ 👥 Membres : ${participants.length}\n` +
                           `┗ 📅 ${new Date().toLocaleDateString()}\n\n` +
                           `⚠️ Image menu.jpg non trouvée`;

        await sock.sendMessage(from, {
          text: fallbackText,
          mentions: mentions
        });
      } catch (fallbackError) {
        await reply("❌ Erreur de recensement");
      }
    }
  }
};
