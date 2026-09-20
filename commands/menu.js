import fs from "fs-extra";
import path from "path";

export default {
  name: "menu",
  description: "Afficher le menu complet",

  async execute(sock, message, args) {
    const { from, isGroup, bots } = message;

    const bot = Array.from(bots?.values() || []).find(
      b => b.sock?.user?.id?.split(":")[0] === from.split("@")[0]
    );

    const chatType = isGroup ? "Groupe" : "Privé";
    const prefix = bot?.config?.prefix || ".";

    const menuText = `
╭─❖───────────────────❖─╮
   _*TAKAMURA BOT V1*_
╰─❖───────────────────❖─╯

▸ _*Chat*_        : ${chatType}
▸ _*Préfixe*_     : ${prefix}

╭──❰ *GESTION DE GROUPE* ❱──╮
│ ➤ _*add*_
│ ➤ _*demote*_
│ ➤ _*demoteall*_
│ ➤ _*gpp*_
│ ➤ _*kick*_
│ ➤ _*kickall*_
│ ➤ _*left*_
│ ➤ _*link*_
│ ➤ _*mute*_
│ ➤ _*promote*_
│ ➤ _*promoteall*_
│ ➤ _*purge*_
│ ➤ _*resetlink*_
│ ➤ _*unmute*_
╰────────────────────────────╯

╭──❰ *TÉLÉCHARGEMENTS* ❱──╮
│ ➤ _*img*_
│ ➤ _*save*_
│ ➤ _*url*_
│ ➤ _*vv*_
╰────────────────────────────╯

╭──❰ *UTILITAIRES* ❱──╮
│ ➤ _*ping*_
│ ➤ _*owner*_
╰────────────────────────────╯

╭──❰ *MODÉRATION* ❱──╮
│ ➤ _*autorecording*_
│ ➤ _*autotyping*_
│ ➤ _*autoread*_
│ ➤ _*autoreact*_
│ ➤ _*welcome*_
│ ➤ _*bye*_
╰────────────────────────────╯

╭──❰ *MEDIA* ❱──╮
│ ➤ _*photo*_
│ ➤ _*setpp*_
│ ➤ _*take*_
│ ➤ _*pp*_
│ ➤ _*sticker*_
╰────────────────────────────╯

╭──❰ *TAGS* ❱──╮
│ ➤ _*tag*_
│ ➤ _*tagadmin*_
│ ➤ _*tagall*_
╰────────────────────────────╯

╭─❖───────────────────❖─╮
     Développé par _*TAKAMURA*_
╰─❖───────────────────❖─╯
`;

    try {
      const imagePath = path.join("./assets/menu.jpg");
      const audioPath = path.join("./lib/takamura.mp3");

      if (await fs.pathExists(imagePath)) {
        const imageBuffer = await fs.readFile(imagePath);
        await sock.sendMessage(from, {
          image: imageBuffer,
          caption: menuText
        });
      } else {
        await sock.sendMessage(from, { text: menuText });
      }

      if (await fs.pathExists(audioPath)) {
        const audioBuffer = await fs.readFile(audioPath);
        await sock.sendMessage(from, {
          audio: audioBuffer,
          mimetype: "audio/mp4",
          ptt: true
        });
      }

    } catch (e) {
      console.error("Erreur menu :", e);
      await sock.sendMessage(from, { text: menuText });
    }
  }
};
