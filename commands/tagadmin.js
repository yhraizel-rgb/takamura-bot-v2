export default {
  name: "tagadmin",
  aliases: ["admins", "admin", "tagadmins"],
  description: "Mentionne tous les administrateurs du groupe",
  
  async execute(sock, message) {
    const { from, reply } = message;
    
    try {
      // Vérification que c'est un groupe
      if (!from.endsWith('@g.us')) {
        return await reply("🟡 Réservé aux groupes");
      }
      
      await reply("⏳ Recherche des administrateurs...");
      
      const start = Date.now();
      const groupMetadata = await sock.groupMetadata(from);
      const participants = groupMetadata.participants || [];
      
      // Filtrer uniquement les administrateurs
      const admins = participants.filter(p => 
        p.admin === 'admin' || p.admin === 'superadmin'
      );
      
      const mentions = admins.map(p => p.id);
      const latency = Date.now() - start;
      
      if (admins.length === 0) {
        return await reply("❌ Aucun administrateur trouvé dans ce groupe");
      }
      
      // Formatage liste des administrateurs
      const adminList = admins
        .map((p, i) => `➤ ${i + 1}. @${p.id.split("@")[0]}`)
        .join("\n");
      
      const caption = `⚡ *MENTION ADMINISTRATEURS*\n\n` +
                     `📊 Statistiques :\n` +
                     `├ 👑 Admins : ${admins.length}/${participants.length}\n` +
                     `├ ⚡ Temps : ${latency}ms\n` +
                     `└ 📅 ${new Date().toLocaleDateString()}\n\n` +
                     `🔧 Liste des administrateurs :\n${adminList}`;
      
      try {
        // Charger l'image depuis ./rok.jpg
        const fs = await import('fs/promises');
        const imageBuffer = await fs.readFile('./assets/menu.jpg');
        
        // Envoyer avec image
        await sock.sendMessage(from, {
          image: imageBuffer,
          caption: caption,
          mentions: mentions
        });
        
        console.log("✅ tagadmin envoyé avec image rok.jpg");
        
      } catch (imageError) {
        console.error("Erreur avec l'image:", imageError);
        
        // Fallback sans image
        await sock.sendMessage(from, {
          text: caption,
          mentions: mentions
        });
        
        console.log("⚠️ tagadmin envoyé sans image");
      }
      
    } catch (error) {
      console.error("Erreur tagadmin:", error);
      await reply("❌ Erreur lors de la recherche des administrateurs");
    }
  }
};