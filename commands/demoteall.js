export default {
  name: "demoteall",
  description: "Rétrograder tous les admins sauf le bot, les owners et le sudo",

  async execute(sock, message, args) {
    const { from, reply, raw, sender } = message;

    try {
      // --- Récupère les metadata du groupe ---
      const groupMeta = await sock.groupMetadata(from);
      const participants = groupMeta.participants;

      const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      const botLid = sock.user.lid?.split(":")[0] + "@lid" || "";

      // --- Owners et sudo depuis config global ---
      const owners = global.owners || [];
      const sudoList = (global.bots?.get(botJid)?.config?.sudoList || []).map(n => n.split("@")[0]);

      // --- Détermine qui démotrer ---
      const toDemote = participants
        .filter(p => 
          p.admin &&               // est admin
          p.id !== botJid &&       // pas le bot
          p.id.split("@")[0] !== botLid && // pas le LID du bot
          !owners.includes(p.id.split("@")[0]) &&
          !sudoList.includes(p.id.split("@")[0])
        )
        .map(p => p.id);

      if (toDemote.length === 0) {
        return await reply("⚠️ Aucun admin à rétrograder.");
      }

      // --- Démote les cibles ---
      await sock.groupParticipantsUpdate(from, toDemote, "demote");
      await sock.sendMessage(from, { react: { text: "⬇️", key: raw.key } });

      const teks = `*_⬇️ ${toDemote.map(t => `@${t.split("@")[0]}`).join(", ")} rétrogradé(s) en membre.\nDemandé par : ${sender.split("@")[0]}_*`;
      await sock.sendMessage(from, { text: teks, mentions: toDemote });

    } catch (err) {
      console.error("❌ demoteall error:", err);
      await reply("❌ Impossible de rétrograder les admins. Vérifie mes permissions.");
    }
  }
};
