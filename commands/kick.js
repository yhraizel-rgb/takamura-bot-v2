// commands/kick.js
export default {
  name: "kick",
  description: "Expulser un membre du groupe",

  async execute(sock, message, args) {
    const { from, reply, isGroup, raw } = message;

    if (!isGroup) return await reply("❌ Réservé aux groupes");

    try {
      const mentioned = raw.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const quotedUser = raw.message?.extendedTextMessage?.contextInfo?.participant;

      let targets = [...mentioned];
      if (quotedUser && !targets.includes(quotedUser)) targets.push(quotedUser);

      if (targets.length === 0 && args[0]) {
        const phoneNumber = args[0].replace(/\D/g, "");
        if (phoneNumber.length < 8) return await reply("❌ Numéro de téléphone invalide");
        targets.push(`${phoneNumber}@s.whatsapp.net`);
      }

      if (targets.length === 0) return await reply("⚠️ Mentionne ou réponds à un utilisateur à expulser");

      await sock.groupParticipantsUpdate(from, targets, "remove");

      await sock.sendMessage(from, {
        text: `*_✅ ${targets.map(t => `@${t.split("@")[0]}`).join(", ")} expulsé(s) avec succès._*`,
        mentions: targets
      });

    } catch (err) {
      console.error("❌ Kick error:", err);
      await reply("❌ Impossible d'expulser ces membres. Vérifie mes permissions.");
    }
  }
};
