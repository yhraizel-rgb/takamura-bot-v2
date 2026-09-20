export default {
  name: "gpp",
  aliases: ["grouppp", "groupicon", "groupavatar"],
  description: "Révéler la photo de profil d'un groupe",

  async execute(sock, message) {
    const { from, reply, raw } = message;

    if (!from.endsWith("@g.us")) {
      return await reply("❌ Commande réservée aux groupes.");
    }

    try {
      let ppUrl;
      try {
        ppUrl = await sock.profilePictureUrl(from, "image");
      } catch {
        ppUrl = "https://files.catbox.moe/2yz2qu.jpg";
      }

      const metadata = await sock.groupMetadata(from);

      const captionText = `*_📸 Photo de profil du groupe_*\n👥 Nom : ${metadata.subject}\n📊 Membres : ${metadata.participants.length}`;

      await sock.sendMessage(from, {
        image: { url: ppUrl },
        caption: captionText
      }, { quoted: raw });

    } catch (err) {
      console.error("❌ Erreur gpp :", err);
      await reply(`❌ Impossible de récupérer la photo du groupe : ${err.message}`);
    }
  }
};
