export default {
  name: "mute",
  description: "Rendre le groupe silencieux (seuls les admins peuvent écrire)",

  async execute(sock, message, args) {
    const { from, reply, isGroup } = message;
    if (!isGroup) return await reply("❌ Cette commande fonctionne uniquement dans les groupes");

    try {
      await sock.groupSettingUpdate(from, "announcement"); // seuls les admins peuvent écrire
      await reply("🔇 Groupe muet : seuls les admins peuvent écrire");
    } catch (e) {
      console.error("Mute error:", e);
      await reply("❌ Impossible de rendre le groupe muet");
    }
  }
};
