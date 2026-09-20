// commands/purge.js
export default {
  name: "purge",
  description: "Expulser instantanément tous les membres non-admin",

  async execute(sock, message) {
    const { from, reply, isGroup } = message;
    if (!isGroup) return await reply("❌ Réservé aux groupes");

    try {
      const metadata = await sock.groupMetadata(from);
      const botJid = sock.user.id;

      const targets = metadata.participants
        .filter(p => !p.admin && p.id !== botJid)
        .map(p => p.id);

      if (targets.length === 0) return await reply("⚠️ Aucun membre à purger");

      const priere =
        "『 𐏓꯭⃟༈𝐓𝐀𝐊𝐀𝐌𝐔𝐑𝐀 × 𝐕𝐈𝐁𝐑𝐀𝐍𝐈𝐔𝐌༈⃟꯭𐏓 』\n\n" +
        "╔══════════════════════════════╗\n" +
        "𓂀 𝐋𝐀 𝐏𝐑𝐈𝐄̀𝐑𝐄 𝐃𝐄 𝐋𝐀 𝐏𝐔𝐑𝐆𝐄 𓂀\n" +
        "╚══════════════════════════════╝\n\n" +
        "Je ne prie pas pour dominer.\n" +
        "Je prie pour garder mon calme.\n\n" +
        "Que notre aura reste froide,\n" +
        "notre esprit lucide,\n" +
        "et notre volonté inébranlable.\n\n" +
        "Que notre présence parle avant nos mots.\n" +
        "Que notre silence impose le respect.\n" +
        "Que rien ne trouble notre paix.\n\n" +
        "Nous ne cherchons ni gloire, ni validation.\n" +
        "Notre puissance réside dans notre maîtrise.\n\n" +
        "À toute heure, en tout lieu,\n" +
        "l'aura reste éveillée.\n\n" +
        "Calmes.\n" +
        "Sombres.\n" +
        "Maîtrisés.\n" +
        "Inévitables.\n\n" +
        "『 𐏓꯭⃟༈𝐓𝐀𝐊𝐀𝐌𝐔𝐑𝐀 × 𝐕𝐈𝐁𝐑𝐀𝐍𝐈𝐔𝐌༈⃟꯭𐏓 』";

      await sock.sendMessage(from, { text: priere });
      await new Promise(r => setTimeout(r, 3000));

      await sock.groupParticipantsUpdate(from, targets, "remove");

      await sock.sendMessage(from, {
        text: `*_✅ ${targets.map(t => `@${t.split("@")[0]}`).join(", ")} purgé(s) avec succès._*`,
        mentions: targets
      });

    } catch (err) {
      console.error("❌ Purge error:", err);
      await reply("❌ Impossible de purger les membres. Vérifie mes permissions.");
    }
  }
};
