export default {
  name: "resetlink",
  description: "Réinitialise le lien du groupe actuel",

  async execute(sock, message, args) {
    const { from, reply, isGroup } = message;

    try {
      if (!isGroup) {
        return await reply("❌ Commande réservée aux groupes.");
      }

      // Réinitialise le lien DU GROUPE COURANT
      await sock.groupRevokeInvite(from);

      await reply("✅ Lien du groupe réinitialisé.");
    } catch (err) {
      console.error("❌ RESETLINK error:", err);
      await reply("❌ Permissions insuffisantes.");
    }
  }
};
