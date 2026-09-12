require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const EMOJIS_PATH = path.join(__dirname, "application-emojis.json");
const applicationEmojis = require("./application-emojis.json");

// Discord serves emoji images from this CDN by emoji id regardless of which
// application originally uploaded them, as long as the asset itself still
// exists — this lets us recover emojis after the bot's application was
// recreated (new client id) without needing the original source images.
function cdnUrl(emoji) {
  const extension = emoji.animated ? "gif" : "png";
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${extension}?size=128&quality=lossless`;
}

async function main() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    throw new Error("Сначала заполните DISCORD_TOKEN и DISCORD_CLIENT_ID (нового приложения) в .env.");
  }

  const updated = {};

  for (const [key, emoji] of Object.entries(applicationEmojis)) {
    const imageResponse = await fetch(cdnUrl(emoji));
    if (!imageResponse.ok) {
      throw new Error(
        `Не удалось скачать старый эмодзи "${key}" (${emoji.id}): HTTP ${imageResponse.status}. ` +
        "Возможно, старое приложение удалено вместе с эмодзи — этот и оставшиеся эмодзи придётся " +
        "загрузить вручную через Developer Portal (Application -> Emojis) и дописать их id в application-emojis.json."
      );
    }
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    const mimeType = emoji.animated ? "image/gif" : "image/png";
    const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;

    const createResponse = await fetch(`https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}/emojis`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: emoji.name, image: dataUri })
    });
    if (!createResponse.ok) {
      const body = await createResponse.text().catch(() => "");
      throw new Error(`Не удалось загрузить эмодзи "${key}" в новое приложение: HTTP ${createResponse.status} ${body}`);
    }
    const created = await createResponse.json();
    updated[key] = { id: created.id, name: created.name, animated: Boolean(created.animated) };
    console.log(`Перенесён эмодзи "${key}": ${emoji.id} -> ${created.id}`);

    // Stay comfortably under Discord's emoji-creation rate limit.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  fs.writeFileSync(EMOJIS_PATH, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Готово: ${Object.keys(updated).length} эмодзи перенесено, application-emojis.json обновлён.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
