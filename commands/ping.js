export default {
  name: "ping",
  description: "Vérifier la latence du bot",

  async execute(sock, message, args) {
    const { from, reply } = message;

    const start = Date.now();
    await reply("🏓 Ping...");
    const latency = Date.now() - start;

    await sock.sendMessage(from, {
      text: `*_🏓 Pong ! ${latency}ms_*`
    });
  }
};
