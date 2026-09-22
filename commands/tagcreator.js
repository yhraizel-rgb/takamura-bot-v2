export default {
  name: "tagcreator",
  description: "𝙰𝚏𝚏𝚒𝚌𝚑𝚎 𝚕𝚎 𝚌𝚛é𝚊𝚝𝚎𝚞𝚛 𝚍𝚞 𝚐𝚛𝚘𝚞𝚙𝚎",

  async execute(sock, message, args) {
    const { from, reply } = message;

    try {
      if (!from.endsWith("@g.us")) {
        return await reply("❌ 𝙲𝚘𝚖𝚖𝚊𝚗𝚍𝚎 𝚛é𝚜𝚎𝚛𝚟é𝚎 𝚊𝚞𝚡 𝚐𝚛𝚘𝚞𝚙𝚎𝚜.");
      }

      const metadata = await sock.groupMetadata(from);
      const creator = metadata.owner;

      if (!creator) {
        return await reply("⚠️ 𝙲𝚛é𝚊𝚝𝚎𝚞𝚛 𝚒𝚗𝚌𝚘𝚗𝚗𝚞 𝚘𝚞 𝚊𝚋𝚜𝚎𝚗𝚝.");
      }

      const text =
        `𝙲𝚛é𝚊𝚝𝚎𝚞𝚛 𝚍𝚞 𝚐𝚛𝚘𝚞𝚙𝚎 :\n` +
        `@${creator.split("@")[0]}`;

      await sock.sendMessage(
        from,
        { text, mentions: [creator] },
        { quoted: message.raw }
      );

    } catch (err) {
      console.error("tagcreator error:", err);
      await reply("❌ 𝙴𝚛𝚛𝚎𝚞𝚛 𝚕𝚘𝚛𝚜 𝚍𝚎 𝚕’𝚎𝚡é𝚌𝚞𝚝𝚒𝚘𝚗.");
    }
  }
};
