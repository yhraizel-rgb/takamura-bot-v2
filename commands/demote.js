export default {
  name: "demote",
  description: "Rétrograder un admin en membre",

  async execute(sock, message, args) {
    const { from, reply, isGroup, raw } = message;

    if (!isGroup) return await reply("❌ Réservé aux groupes");

    try {
      const mentioned = raw.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const quotedUser = raw.message?.extendedTextMessage?.contextInfo?.participant;

      let targets = [...mentioned];
      if (quotedUser && !targets.includes(quotedUser)) targets.push(quotedUser);
      if (targets.length === 0) return await reply("⚠️ Mentionne ou réponds à un utilisateur à rétrograder");

      await sock.groupParticipantsUpdate(from, targets, "demote");

      await sock.sendMessage(from, {
        text: `*_✅ ${targets.map(t => `@${t.split("@")[0]}`).join(", ")} rétrogradé(s) en membre._*`,
        mentions: targets
      });

    } catch (err) {
      console.error("❌ Demote error:", err);
      await reply("❌ Impossible de rétrograder. Vérifie mes permissions.");
    }
  }
};
