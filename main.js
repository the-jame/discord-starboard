const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const tt = '⭐';
let settings;
let messagePosted = {};

try {
  settings = require('./settings.json');
} catch (e) {
  console.log(`Could not load settings.json.`);
  process.exit();
}

client.on('ready', () => {
  console.log(`Starboard Bot started: ${client.guilds.cache.size} guilds.`);
  loadIntoMemory(settings.serverID, settings.channelID, settings.fetchLimit);
});

async function loadIntoMemory(guildID, channelID, limit) {
  const guild = client.guilds.cache.get(guildID);
  if (!guild) return console.log("Guild not found in cache.");
  const channel = guild.channels.cache.get(channelID);
  if (!channel) return console.log("Starboard channel not found.");

  console.log(`Loading last ${limit} messages from starboard...`);
  messagePosted = {}; // Reset memory
  let lastId = null;
  let totalFetched = 0;

  try {
    while (totalFetched < limit) {
      // Fetch 100 at a time (Discord's max)
      const amountToFetch = Math.min(limit - totalFetched, 100);
      const options = { limit: amountToFetch };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break; // No more messages left in channel

      messages.forEach(m => {
        // Find original ID in content or footer
        const idMatch = m.content.match(/\((\d{18,})\)/) || (m.embeds[0]?.footer?.text?.match(/\((\d{18,})\)/));
        if (idMatch) {
          messagePosted[idMatch[1]] = { p: true, lc: settings.threshold + 1, psm: m.id };
        }
      });

      lastId = messages.lastKey();
      totalFetched += messages.size;
      console.log(`Fetched ${totalFetched}/${limit}...`);
    }
    console.log(`Loading complete. Found ${Object.keys(messagePosted).length} active posts in memory.`);
  } catch (e) {
    console.log("Error loading messages:", e.message);
  }
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  
  const { message } = reaction;
  
  // Ignore reactions in the starboard channel itself or from bots
  if (message.channel.id === settings.channelID) return;
  if (reaction.emoji.name !== settings.reactionEmoji) return;

  // Date Cutoff Check (ignore very old messages)
  const dateDiff = new Date() - message.createdAt;
  const daysOld = Math.floor(dateDiff / (1000 * 60 * 60 * 24));
  if (daysOld >= settings.dateCutoff) return;

  const starChannel = client.channels.cache.get(settings.channelID);
  if (!starChannel) return;

  if (!messagePosted[message.id]) {
    messagePosted[message.id] = { p: false, lc: 0 };
  }

  const starCount = reaction.count;
  if (starCount >= settings.threshold) {
    const footer = `${starCount} ${tt} (${message.id})`;
    const embedColor = settings.hexcolor.startsWith('#') ? settings.hexcolor : `#${settings.hexcolor}`;
    
    if (messagePosted[message.id].psm) {
      // Update existing post count
      try {
        const starMsg = await starChannel.messages.fetch(messagePosted[message.id].psm);
        const oldEmbed = starMsg.embeds[0];
        const newEmbed = EmbedBuilder.from(oldEmbed).setFooter({ text: footer });
        await starMsg.edit({ embeds: [newEmbed] });
      } catch (e) { console.log("Could not update starboard message."); }
    } else if (!messagePosted[message.id].p) {
      // Create new post
      messagePosted[message.id].p = true;
      
      const embed = new EmbedBuilder()
        .setAuthor({ name: message.member?.displayName || message.author.displayName || message.author.username, iconURL: message.author.displayAvatarURL() })
        .setColor(embedColor)
        .setDescription(`${message.content || ''}\n\n→ [original message](${message.url})`)
        .setTimestamp(message.createdAt)
        .setFooter({ text: footer });

      // Handle images
      const attachment = message.attachments.first();
      if (attachment && attachment.contentType?.startsWith('image')) {
        embed.setImage(attachment.url);
      } else if (message.embeds.length > 0 && message.embeds[0].image) {
        embed.setImage(message.embeds[0].image.url);
      }

      const sent = await starChannel.send({ embeds: [embed] });
      messagePosted[message.id].psm = sent.id;
    }
  }
});

client.login(settings.token);
