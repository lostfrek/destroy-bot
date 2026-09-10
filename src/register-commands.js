require("dotenv").config();

const { ChannelType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Переместить всех участников из одного голосового канала в другой.")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((option) =>
      option
        .setName("from")
        .setDescription("Голосовой канал, из которого нужно переместить участников")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName("to")
        .setDescription("Голосовой канал, в который нужно переместить участников")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("capts")
    .setDescription("Открыть или закрыть приём откатов с капта на 90 минут.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
].map((command) => command.toJSON());

async function main() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    throw new Error("Сначала заполните DISCORD_TOKEN, DISCORD_CLIENT_ID и DISCORD_GUILD_ID в .env.");
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
    body: commands
  });

  console.log(`Зарегистрировано slash-команд: ${commands.length}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { commands };
