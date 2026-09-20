export default {
  name: "left",
  async execute(sock, ctx) {
    const { from, reply } = ctx;

    try {
      await sock.groupLeave(from);
    } catch {
      reply("🔴 𝙵𝚊𝚒𝚕𝚎𝚍 𝚝𝚘 𝚕𝚎𝚊𝚟𝚎");
    }
  }
};