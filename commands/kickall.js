// commands/kickall.js
export default {
  name: "kickall",
  description: "Expulser tous les membres non-admin",

  async execute(sock, message) {
    const { from, reply, isGroup } = message;
    if (!isGroup) return await reply("❌ Réservé aux groupes");

    try {
      const metadata = await sock.groupMetadata(from);
      const botJid = sock.user.id;

      const targets = metadata.participants
        .filter(p => !p.admin && p.id !== botJid)
        .map(p => p.id);

      if (targets.length === 0) return await reply("⚠️ Aucun membre à expulser");

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        await sock.groupParticipantsUpdate(from, [t], "remove");
        await sock.sendMessage(from, {
          text: `*_✅ @${t.split("@")[0]} expulsé avec succès._*`,
          mentions: [t]
        });
        if (i < targets.length - 1) await new Promise(r => setTimeout(r, 3000)); // 3s delay
      }

    } catch (err) {
      console.error("❌ KickAll error:", err);
      await reply("❌ Impossible d'expulser tout le monde. Vérifie mes permissions.");
    }
  }
};
