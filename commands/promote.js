// commands/promote.js
export default {
  name: "promote",
  description: "Promouvoir un membre en admin",

  async execute(sock, message, args) {
    const { from, reply, isGroup, raw } = message;

    if (!isGroup) return await reply("❌ Réservé aux groupes");

    try {
      const mentioned = raw.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const quotedUser = raw.message?.extendedTextMessage?.contextInfo?.participant;

      let targets = [...mentioned];
      if (quotedUser && !targets.includes(quotedUser)) targets.push(quotedUser);
      if (targets.length === 0) return await reply("⚠️ Mentionne ou réponds à un utilisateur à promouvoir");

      await sock.groupParticipantsUpdate(from, targets, "promote");

      await sock.sendMessage(from, {
        text: `*_✅ ${targets.map(t => `@${t.split("@")[0]}`).join(", ")} promu(s) admin._*`,
        mentions: targets
      });

    } catch (err) {
      console.error("❌ Promote error:", err);
      await reply("❌ Impossible de promouvoir. Vérifie mes permissions.");
    }
  }
};
