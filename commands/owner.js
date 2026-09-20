import axios from "axios";

export default {
  name: "owner",
  description: "Envoie le contact du développeur avec photo",

  async execute(sock, msg, args) {
    try {
      // Vérifie d'où envoyer le message
      const to = msg.from || msg.key?.remoteJid;
      if (!to) return;

      // VCARD de TAKAMURA
      const vcardTakamura =
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        'FN:TAKAMURA\n' +
        'ORG:ROK XD;\n' +
        'TEL;type=CELL;type=VOICE;waid=237673642385:+237673642385\n' +
        'END:VCARD';

      // Télécharger l'image depuis l'URL
      const ppTakamura = (await axios.get("https://files.catbox.moe/l4o82h.jpg", { responseType: "arraybuffer" })).data;

      // Envoi du contact avec photo
      await sock.sendMessage(to, {
        contacts: {
          displayName: "_*ROK XD Developers*_",
          contacts: [
            { vcard: vcardTakamura, jpegThumbnail: ppTakamura }
          ]
        }
      });

    } catch (err) {
      console.error("Erreur commande owner:", err);
      await sock.sendMessage(msg.from || msg.key?.remoteJid, { text: "❌ Une erreur est survenue." });
    }
  }
};
