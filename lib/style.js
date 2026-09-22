// lib/style.js
// Mise en forme commune des réponses du bot : un rendu sobre et cohérent
// (gras WhatsApp natif, pas de police "unicode" décorative) qui suit
// l'identité du site — icône dragon comme signature de marque.

export const BRAND = "Takamura Bot";
export const REACT_EMOJI = "🐉";

// WhatsApp rend _*texte*_ en gras + italique. Demandé pour TOUT le texte
// envoyé par le bot, y compris les messages simples.
export const bi = (t) => `_*${t}*_`;

function block(icon, body, title) {
  const head = title ? `${icon} ${bi(title)}` : icon;
  return body ? `${head}\n${bi(body)}` : head;
}

export const style = {
  ok: (body, title) => block("✅", body, title),
  err: (body, title) => block("❌", body, title),
  warn: (body, title) => block("⚠️", body, title),
  info: (body, title) => block("ℹ️", body, title),

  // Bloc titré avec une liste à puces, pour les menus / listes de résultats.
  section: (title, lines = []) =>
    `${bi(title)}\n${lines.map(l => bi(`• ${l}`)).join("\n")}`,

  // En-tête de marque, utilisé une fois en haut des messages longs (menu, owner...).
  header: (subtitle) => `🐉 ${bi(BRAND)}${subtitle ? `\n${bi(subtitle)}` : ""}`
};

// Réagit au message de commande en cours de traitement.
// Appelé une seule fois, de façon centralisée, par index.js avant
// d'exécuter la commande — inutile de le refaire dans chaque fichier.
export async function reactProcessing(sock, msg) {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: REACT_EMOJI, key: msg.key }
    });
  } catch (_) {
    // La réaction n'est jamais bloquante pour l'exécution de la commande.
  }
}
