import fetch from "node-fetch";

export default {
  name: "img",
  description: "Recherche et envoie des images depuis un mot-clé",
  category: "Images",

  async execute(sock, message, args, prefix = ".") {
    const { from, reply } = message;

    if (!args[0]) {
      return await reply(`⚠️ Utilisation : ${prefix}img <mot-clé> [nombre]\nExemples :\n• ${prefix}img naruto\n• ${prefix}img voiture 5`);
    }

    const lastArg = args[args.length - 1];
    const count = !isNaN(lastArg) ? Math.min(parseInt(lastArg), 10) : 5;
    const query = !isNaN(lastArg) ? args.slice(0, -1).join(" ") : args.join(" ");

    try {
      await sock.sendMessage(from, { text: `*_🖼️ Recherche de ${count} image(s) pour : "${query}"...\n⏳ Veuillez patienter..._*` });

      // ───── Requête Bing Images ─────
      const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`;
      const res = await fetch(bingUrl);
      const html = await res.text();

      const imageUrls = [...html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)]
        .map(m => m[1])
        .filter(u => u.startsWith("http"));

      if (!imageUrls.length) {
        return await reply(`⚠️ Aucune image trouvée pour : "${query}"`);
      }

      // ───── Envoi des images ─────
      const imagesToSend = imageUrls.slice(0, count);
      for (let i = 0; i < imagesToSend.length; i++) {
        try {
          const response = await fetch(imagesToSend[i]);
          const buffer = Buffer.from(await response.arrayBuffer());

          if (buffer.length < 5000) continue;

          await sock.sendMessage(from, {
            image: buffer,
            caption: `*_🖼️ ${query} (${i + 1}/${imagesToSend.length})_*`
          });

          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
          console.error("Erreur envoi image :", e.message);
        }
      }

      await sock.sendMessage(from, { text: `*_✅ ${imagesToSend.length}/${count} image(s) envoyée(s) pour "${query}"._*` });

    } catch (err) {
      console.error("❌ Img error:", err);
      await reply("❌ Une erreur est survenue lors de la recherche d'images.");
    }
  }
};
