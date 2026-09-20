export default {
  name: "unmute",
  description: "Réactiver la parole pour tous dans le groupe",

  async execute(sock, message, args) {
    const { from, reply, isGroup } = message;
    if (!isGroup) return await reply("❌ Cette commande fonctionne uniquement dans les groupes");

    try {
      await sock.groupSettingUpdate(from, "not_announcement"); // tout le monde peut écrire
      await reply("🔊 Groupe réactivé : tout le monde peut écrire");
    } catch (e) {
      console.error("Unmute error:", e);
      await reply("❌ Impossible de réactiver le groupe");
    }
  }
};
