export default {
  name: "add",
  description: "Ajouter un membre au groupe",

  async execute(sock, message, args) {
    const { from, reply, isGroup } = message;

    if (!isGroup) return await reply("❌ Réservé aux groupes");

    try {
      const number = args[0]?.replace(/\D/g, "");
      if (!number) return await reply("⚠️ Numéro requis");

      const target = `${number}@s.whatsapp.net`;
      await sock.groupParticipantsUpdate(from, [target], "add");

      await sock.sendMessage(from, {
        text: `*_✅ Membre @${target.split("@")[0]} ajouté au groupe._*`,
        mentions: [target]
      });

    } catch (err) {
      console.error("❌ Add error:", err);
      await reply("❌ Impossible d'ajouter ce membre. Vérifie mes permissions.");
    }
  }
};
