export default {
  name: "link",
  async execute(sock, ctx) {
    const { from, reply } = ctx;

    if (!from.endsWith("@g.us"))
      return reply("🔴 𝙶𝚛𝚘𝚞𝚙 𝚘𝚗𝚕𝚢");

    try {
      const code = await sock.groupInviteCode(from);
      reply(`🔗 𝙶𝚛𝚘𝚞𝚙 𝙻𝚒𝚗𝚔\nhttps://chat.whatsapp.com/${code}`);
    } catch {
      reply("🔴 𝙵𝚊𝚒𝚕𝚎𝚍 𝚝𝚘 𝚐𝚎𝚝 𝚕𝚒𝚗𝚔");
    }
  }
};