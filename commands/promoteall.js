import dotenv from "dotenv";
dotenv.config();

export default {
  name: "promoteall",
  description: "Promouvoir tous les membres du groupe",

  async execute(sock, message, args) {
    const { from, reply } = message;

    if (!from.endsWith("@g.us")) {
      return await reply("❌ Commande réservée aux groupes.");
    }

    try {
      const metadata = await sock.groupMetadata(from);
      const participants = metadata.participants || [];

      const botJid =
        (sock?.user?.id?.split(":")[0] || sock?.user?.jid?.split(":")[0] || "") +
        "@s.whatsapp.net";

      const ownerNumber = process.env.NUMBER?.replace(/\D/g, "");
      const ownerJid = ownerNumber ? `${ownerNumber}@s.whatsapp.net` : null;

      if (!ownerJid) {
        return await reply("⚠️ Numéro du propriétaire non configuré.");
      }

      const isAdmin = p =>
        p?.admin === "admin" || p?.admin === "superadmin";

      const targets = participants
        .filter(p => {
          const jid = p.id;
          return jid && !isAdmin(p) && jid !== botJid && jid !== ownerJid;
        })
        .map(p => p.id);

      if (targets.length === 0) {
        return await reply("✅ Tous les membres sont déjà admins.");
      }

      await sock.groupParticipantsUpdate(from, targets, "promote");

      const text =
        `*_✅ Promotion réussie\n` +
        `Membres promus : ${targets.length}_*`;

      await sock.sendMessage(
        from,
        { text, mentions: targets },
        { quoted: message.raw }
      );

    } catch (err) {
      console.error("promoteall error:", err);
      await reply("❌ Erreur lors de l'exécution.");
    }
  }
};
