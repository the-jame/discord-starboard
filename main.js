require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const STATE_FILE = path.join(__dirname, 'data', 'starboard.json');
const UPDATE_DEBOUNCE_MS = 1500;
// Bump this to force a full re-scan of the starboard channel after changing
// the backfill format/logic.
const BACKFILL_VERSION = 2;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

function timestamp() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(timestamp(), ...args);
}

function warn(...args) {
  console.warn(timestamp(), ...args);
}

function fatal(message) {
  console.error(timestamp(), message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function requireSnowflake(value, name) {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value.trim())) {
    fatal(`settings.json: "${name}" must be a Discord ID string (17-20 digits).`);
  }
  return value.trim();
}

function intOption(value, name, fallback, min) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    fatal(`settings.json: "${name}" must be an integer >= ${min}.`);
  }
  return value;
}

function boolOption(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    fatal(`settings.json: "${name}" must be true or false.`);
  }
  return value;
}

function normalizeColor(value) {
  const color = String(value).trim();
  if (!/^#?[0-9a-f]{6}$/i.test(color)) {
    fatal('settings.json: "hexcolor" must be a 6-digit hex color, e.g. "d4af37".');
  }
  return color.startsWith('#') ? color : `#${color}`;
}

function loadSettings() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
  } catch (e) {
    fatal(`Could not load settings.json: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fatal('settings.json must contain a JSON object.');
  }
  if (typeof raw.reactionEmoji !== 'string' || raw.reactionEmoji.trim() === '') {
    fatal('settings.json: "reactionEmoji" must be a non-empty string.');
  }

  return {
    serverID: requireSnowflake(raw.serverID, 'serverID'),
    channelID: requireSnowflake(raw.channelID, 'channelID'),
    reactionEmoji: raw.reactionEmoji.trim(),
    threshold: intOption(raw.threshold, 'threshold', 3, 1),
    hexcolor: normalizeColor(raw.hexcolor ?? 'd4af37'),
    dateCutoff: intOption(raw.dateCutoff, 'dateCutoff', 30, 0),
    // Safety cap for the initial import. 0 = scan the entire channel.
    fetchLimit: intOption(raw.fetchLimit, 'fetchLimit', 0, 0),
    // Re-check the N newest tracked posts on startup. 0 = disabled.
    reconcileLimit: intOption(raw.reconcileLimit, 'reconcileLimit', 50, 0),
    deleteBelowThreshold: boolOption(raw.deleteBelowThreshold, 'deleteBelowThreshold', true),
    ignoreBots: boolOption(raw.ignoreBots, 'ignoreBots', true),
    token: typeof raw.token === 'string' ? raw.token : null,
  };
}

const settings = loadSettings();

// ---------------------------------------------------------------------------
// Emoji matching
// ---------------------------------------------------------------------------

function parseConfiguredEmoji(input) {
  const value = input.trim();
  if (/^\d{17,20}$/.test(value)) {
    return { id: value, name: null, display: value };
  }

  const custom = value.match(/^<?(a)?:?([a-zA-Z0-9_~]+):(\d{17,20})>?$/);
  if (custom) {
    const animated = custom[1] === 'a';
    return {
      id: custom[3],
      name: custom[2],
      display: `<${animated ? 'a' : ''}:${custom[2]}:${custom[3]}>`,
    };
  }

  return { id: null, name: normalizeEmojiName(value), display: value };
}

function normalizeEmojiName(name) {
  // Strip variation selectors so "⭐" and "⭐️" compare equal.
  return String(name ?? '').replace(/[\uFE0E\uFE0F]/g, '');
}

const configuredEmoji = parseConfiguredEmoji(settings.reactionEmoji);
let emojiDisplay = configuredEmoji.display;

function matchesEmoji(emoji) {
  if (!emoji) return false;
  if (configuredEmoji.id) return emoji.id === configuredEmoji.id;
  return normalizeEmojiName(emoji.name) === configuredEmoji.name;
}

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

let state = null;
let saveTimer = null;
let writeChain = Promise.resolve();

function freshState() {
  return {
    version: 2,
    guildId: settings.serverID,
    channelId: settings.channelID,
    backfillVersion: 0,
    posts: {},
  };
}

function sanitizeState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.posts || typeof parsed.posts !== 'object' || Array.isArray(parsed.posts)) return null;

  const posts = {};
  for (const [sourceId, entry] of Object.entries(parsed.posts)) {
    if (!/^\d{17,20}$/.test(sourceId)) continue;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.starMessageId !== 'string' || !/^\d{17,20}$/.test(entry.starMessageId)) continue;
    posts[sourceId] = {
      starMessageId: entry.starMessageId,
      channelId:
        typeof entry.channelId === 'string' && /^\d{17,20}$/.test(entry.channelId)
          ? entry.channelId
          : null,
      count: Number.isInteger(entry.count) ? entry.count : 0,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    };
  }

  return {
    version: 2,
    guildId: typeof parsed.guildId === 'string' ? parsed.guildId : null,
    channelId: typeof parsed.channelId === 'string' ? parsed.channelId : null,
    backfillVersion: Number.isInteger(parsed.backfillVersion) ? parsed.backfillVersion : 0,
    posts,
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const sanitized = sanitizeState(JSON.parse(raw));
    if (sanitized) return sanitized;
    warn(`State file ${STATE_FILE} is invalid; starting fresh.`);
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`Could not read state file: ${e.message}`);
  }
  return freshState();
}

function getPost(sourceId) {
  return state.posts[sourceId];
}

function setPost(sourceId, starMessageId, count, channelId) {
  state.posts[sourceId] = {
    starMessageId,
    channelId: channelId ?? null,
    count,
    updatedAt: new Date().toISOString(),
  };
  scheduleSave();
}

function setPostCount(sourceId, count) {
  const post = state.posts[sourceId];
  if (!post) return;
  post.count = count;
  post.updatedAt = new Date().toISOString();
  scheduleSave();
}

function removePost(sourceId) {
  if (!state.posts[sourceId]) return;
  delete state.posts[sourceId];
  scheduleSave();
}

async function writeState() {
  if (!state) return;
  const snapshot = JSON.stringify(state, null, 2);
  const dir = path.dirname(STATE_FILE);
  const tmp = `${STATE_FILE}.tmp`;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(tmp, snapshot);
  await fs.promises.rename(tmp, STATE_FILE);
}

function queueWrite() {
  writeChain = writeChain
    .then(writeState)
    .catch((e) => warn(`Could not save state: ${e.message}`));
  return writeChain;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    queueWrite();
  }, 250);
}

async function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await queueWrite();
}

function flushStateSync() {
  if (!state) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const dir = path.dirname(STATE_FILE);
    const tmp = `${STATE_FILE}.sync.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    warn(`Could not flush state on shutdown: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Starboard helpers
// ---------------------------------------------------------------------------

let starChannel = null;
let ready = false;
const pendingUpdates = new Map();
const processing = new Set();

function footerFor(count, sourceId) {
  return `${count} ${emojiDisplay} (${sourceId})`;
}

function getStarCount(message, fallback = 0) {
  const reaction = message.reactions.cache.find((r) => matchesEmoji(r.emoji));
  return reaction ? reaction.count : fallback;
}

function isExpired(message) {
  const daysOld = (Date.now() - message.createdAt.getTime()) / 86_400_000;
  return daysOld >= settings.dateCutoff;
}

const MAX_GALLERY_IMAGES = 4;
const MAX_ATTACHMENT_LINKS = 8;
// Leave room for fields inside Discord's 6000-character embed budget.
const MAX_CONTENT_LENGTH = 3500;

function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(attachment.name ?? attachment.url ?? '');
}

function truncateText(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function escapeLinkText(text) {
  return String(text).replace(/([\[\]])/g, '\\$1');
}

function buildReplyField(message) {
  const reference = message.reference;
  if (!reference?.messageId) return null;

  const channelId = reference.channelId ?? message.channel?.id;
  const guildId = reference.guildId ?? message.guild?.id;
  if (!channelId || !guildId) return null;

  const url = `https://discord.com/channels/${guildId}/${channelId}/${reference.messageId}`;
  const user = message.mentions?.repliedUser;
  const name = user ? user.displayName ?? user.username : 'a message';
  return {
    name: 'Reply',
    value: `[Replying to ${escapeLinkText(name)}](${url})`,
    inline: false,
  };
}

function buildAttachmentField(attachments) {
  if (attachments.length === 0) return null;

  const lines = attachments.slice(0, MAX_ATTACHMENT_LINKS).map((attachment) => {
    const size = formatBytes(attachment.size);
    const label = escapeLinkText(attachment.name ?? 'attachment');
    return `[${label}](${attachment.url})${size ? ` • ${size}` : ''}`;
  });
  if (attachments.length > MAX_ATTACHMENT_LINKS) {
    lines.push(`…and ${attachments.length - MAX_ATTACHMENT_LINKS} more`);
  }

  return {
    name: `Attachments (${attachments.length})`,
    value: truncateText(lines.join('\n'), 1024),
    inline: false,
  };
}

function buildEmbeds(message, count) {
  const attachments = [...(message.attachments?.values?.() ?? [])];
  const imageAttachments = attachments.filter(isImageAttachment);
  const gallery = imageAttachments.slice(0, MAX_GALLERY_IMAGES);
  const galleryIds = new Set(gallery.map((attachment) => attachment.id));
  const otherAttachments = attachments.filter((attachment) => !galleryIds.has(attachment.id));

  let content = message.content ?? '';
  if (content.length > MAX_CONTENT_LENGTH) {
    content = `${content.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
  }

  const fields = [];
  if (message.channel?.id && message.channel.id !== settings.channelID) {
    fields.push({ name: 'Source', value: `<#${message.channel.id}>`, inline: true });
  }

  const reply = buildReplyField(message);
  if (reply) fields.push(reply);

  const attachmentField = buildAttachmentField(otherAttachments);
  if (attachmentField) fields.push(attachmentField);

  const stickers = [...(message.stickers?.values?.() ?? [])];
  if (stickers.length > 0) {
    fields.push({
      name: `Stickers (${stickers.length})`,
      value: truncateText(stickers.map((sticker) => sticker.name ?? 'sticker').join(', '), 1024),
      inline: false,
    });
  }

  const link = `→ [original message](${message.url})`;
  const main = new EmbedBuilder()
    .setAuthor({
      name: message.member?.displayName || message.author.displayName || message.author.username,
      iconURL: message.author.displayAvatarURL(),
      url: message.url,
    })
    .setColor(settings.hexcolor)
    .setDescription(content ? `${content}\n\n${link}` : link)
    .setTimestamp(message.createdAt)
    .setFooter({ text: footerFor(count, message.id) });

  if (fields.length > 0) main.addFields(fields);

  const stickerImage = stickers
    .find((sticker) => /\.(png|apng|gif|webp)(\?|$)/i.test(sticker.url ?? ''))
    ?.url;
  const mainImage =
    gallery[0]?.url ??
    message.embeds[0]?.image?.url ??
    message.embeds[0]?.thumbnail?.url ??
    stickerImage;
  if (mainImage) main.setImage(mainImage);

  const extras = gallery.slice(1).map((attachment) =>
    new EmbedBuilder()
      .setURL(message.url)
      .setColor(settings.hexcolor)
      .setImage(attachment.url),
  );

  return [main, ...extras];
}

function buildComponents(message) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Jump to message')
      .setURL(message.url),
  );
  return [row];
}

function extractSourceChannelId(embed) {
  const text = `${embed?.description ?? ''}\n${embed?.url ?? ''}`;
  const match = text.match(/\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/);
  return match ? match[2] : null;
}

function extractSourceInfo(starMessage) {
  const embed = starMessage.embeds?.[0];
  const footerId = embed?.footer?.text?.match(/\((\d{17,20})\)\s*$/);
  const contentId = starMessage.content?.match(/\((\d{17,20})\)/);
  const sourceId = footerId?.[1] ?? contentId?.[1];

  if (sourceId) return { sourceId, channelId: extractSourceChannelId(embed) };

  // Older/customised posts may only have the jump link in the embed.
  const link = `${embed?.description ?? ''}\n${embed?.url ?? ''}`
    .match(/\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/);
  if (link) return { sourceId: link[3], channelId: link[2] };

  return null;
}

function extractCount(starMessage) {
  const footer = starMessage.embeds?.[0]?.footer?.text;
  const match = footer?.match(/^(\d+)\s/);
  return match ? Number(match[1]) : 0;
}

async function createStarPost(message, count) {
  if (getPost(message.id)) return;

  const sent = await starChannel.send({
    embeds: buildEmbeds(message, count),
    components: buildComponents(message),
    allowedMentions: { parse: [] },
  });
  setPost(message.id, sent.id, count, message.channel.id);

  // Persist the mapping immediately so a crash cannot produce a duplicate post.
  await flushState();
}

async function updateStarPost(sourceId, message, count, post) {
  try {
    const starMessage = await starChannel.messages.fetch(post.starMessageId);
    const oldEmbeds = starMessage.embeds;
    const embeds = oldEmbeds.length > 0
      ? oldEmbeds.map((embed, index) => (index === 0
        ? EmbedBuilder.from(embed).setFooter({ text: footerFor(count, sourceId) })
        : EmbedBuilder.from(embed)))
      : buildEmbeds(message, count);

    await starMessage.edit({
      embeds,
      components: buildComponents(message),
      allowedMentions: { parse: [] },
    });
    setPostCount(sourceId, count);
  } catch (e) {
    if (e.code === 10008) {
      // The starboard post was deleted manually; recreate it if still eligible.
      removePost(sourceId);
      if (count >= settings.threshold) await createStarPost(message, count);
      return;
    }
    throw e;
  }
}

async function removeStarPost(sourceId) {
  const post = getPost(sourceId);
  if (!post) return;

  try {
    const starMessage = await starChannel.messages.fetch(post.starMessageId);
    await starMessage.delete();
  } catch (e) {
    if (e.code !== 10008) throw e;
  }
  removePost(sourceId);
  await flushState();
}

function queueUpdate(message) {
  const existing = pendingUpdates.get(message.id);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pendingUpdates.delete(message.id);
    flushUpdate(message).catch((e) => warn(`Could not update ${message.id}: ${e.message}`));
  }, UPDATE_DEBOUNCE_MS);

  pendingUpdates.set(message.id, { timer, message });
}

// Bring the starboard post for `sourceId` in line with the current state of
// the source message. Shared by live reaction updates and startup reconciliation.
async function syncPost(sourceId, fresh) {
  const count = getStarCount(fresh);
  const post = getPost(sourceId);

  if (post) {
    if (count < settings.threshold && settings.deleteBelowThreshold) {
      await removeStarPost(sourceId);
      return;
    }
    if (post.count === count) return;
    await updateStarPost(sourceId, fresh, count, post);
    return;
  }

  // No post yet: only board messages that still meet the threshold and cutoff.
  if (count < settings.threshold) return;
  if (isExpired(fresh)) return;
  await createStarPost(fresh, count);
}

async function flushUpdate(message) {
  const sourceId = message.id;

  // A flush is already running for this message; retry after the current one.
  if (processing.has(sourceId)) {
    queueUpdate(message);
    return;
  }

  processing.add(sourceId);
  try {
    let fresh;
    try {
      fresh = await message.channel.messages.fetch(sourceId, { force: true });
    } catch (e) {
      if (e.code === 10008) {
        await removeStarPost(sourceId);
        return;
      }
      throw e;
    }

    await syncPost(sourceId, fresh);
  } finally {
    processing.delete(sourceId);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function fetchWithRetry(fn, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // Do not retry errors that cannot resolve themselves.
      if ([10008, 40001, 50001, 50013].includes(e.code)) break;
      if (attempt === attempts) break;
      const delay = 500 * 2 ** (attempt - 1);
      warn(`${label} failed (${e.message}); retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function backfill() {
  if (state.backfillVersion >= BACKFILL_VERSION) return;

  const limit = settings.fetchLimit; // 0 = scan the whole channel
  log(limit > 0
    ? `Backfilling up to ${limit} starboard messages...`
    : 'Backfilling the entire starboard channel...');

  let lastId = null;
  let totalFetched = 0;
  let added = 0;
  let duplicates = 0;

  while (limit === 0 || totalFetched < limit) {
    const pageSize = limit === 0 ? 100 : Math.min(100, limit - totalFetched);
    const options = { limit: pageSize };
    if (lastId) options.before = lastId;

    const messages = await fetchWithRetry(
      () => starChannel.messages.fetch(options),
      'Backfill page',
    );
    if (messages.size === 0) break;

    for (const starMessage of messages.values()) {
      const info = extractSourceInfo(starMessage);
      if (!info) continue;

      const existing = state.posts[info.sourceId];
      if (existing) {
        if (!existing.channelId && info.channelId) existing.channelId = info.channelId;
        if (existing.starMessageId !== starMessage.id) duplicates += 1;
        continue;
      }

      state.posts[info.sourceId] = {
        starMessageId: starMessage.id,
        channelId: info.channelId,
        count: extractCount(starMessage),
        updatedAt: new Date().toISOString(),
      };
      added += 1;
    }

    const nextId = messages.lastKey();
    totalFetched += messages.size;
    if (totalFetched % 500 === 0 || messages.size < pageSize) {
      log(`Backfill progress: ${totalFetched} scanned, ${added} added...`);
    }

    // Stop on the end of the channel or if pagination stops making progress.
    if (!nextId || nextId === lastId) break;
    lastId = nextId;
    if (messages.size < pageSize) break;
  }

  state.backfillVersion = BACKFILL_VERSION;
  await flushState();
  log(
    `Backfill complete: ${totalFetched} messages scanned, ${added} added, ` +
    `${Object.keys(state.posts).length} posts tracked.`,
  );
  if (duplicates > 0) {
    warn(`Found ${duplicates} extra starboard post(s) for already-tracked messages.`);
  }
}

function compareSnowflakes(a, b) {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

async function reconcileRecentPosts() {
  if (settings.reconcileLimit === 0) return;

  const entries = Object.entries(state.posts)
    .sort((a, b) => compareSnowflakes(b[0], a[0]))
    .slice(0, settings.reconcileLimit);
  if (entries.length === 0) return;

  log(`Reconciling counts for ${entries.length} recent post(s)...`);

  let checked = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;

  for (const [sourceId, post] of entries) {
    try {
      let channelId = post.channelId;

      if (!channelId) {
        // Recover the source channel from the jump link in the starboard embed.
        let starMessage;
        try {
          starMessage = await fetchWithRetry(
            () => starChannel.messages.fetch(post.starMessageId),
            `Fetching starboard post ${post.starMessageId}`,
          );
        } catch (e) {
          if (e.code === 10008) {
            removePost(sourceId);
            removed += 1;
            continue;
          }
          throw e;
        }

        channelId = extractSourceInfo(starMessage)?.channelId ?? null;
        if (!channelId) {
          skipped += 1;
          continue;
        }
        post.channelId = channelId;
        scheduleSave();
      }

      const channel = client.channels.cache.get(channelId) ??
        (await client.channels.fetch(channelId).catch(() => null));
      if (!channel || typeof channel.messages?.fetch !== 'function') {
        skipped += 1;
        continue;
      }

      let sourceMessage;
      try {
        sourceMessage = await fetchWithRetry(
          () => channel.messages.fetch(sourceId, { force: true }),
          `Fetching source message ${sourceId}`,
        );
      } catch (e) {
        if (e.code === 10008) {
          await removeStarPost(sourceId);
          removed += 1;
          continue;
        }
        throw e;
      }

      const previousCount = post.count;
      await syncPost(sourceId, sourceMessage);
      checked += 1;

      if (!getPost(sourceId)) {
        removed += 1;
      } else if (getPost(sourceId).count !== previousCount) {
        updated += 1;
      }
    } catch (e) {
      skipped += 1;
      warn(`Could not reconcile ${sourceId}: ${e.message}`);
    }
  }

  await flushState();
  log(
    `Reconciliation complete: ${checked} checked, ${updated} updated, ` +
    `${removed} removed, ${skipped} skipped.`,
  );
}

async function init() {
  const guild =
    client.guilds.cache.get(settings.serverID) ??
    (await client.guilds.fetch(settings.serverID).catch(() => null));
  if (!guild) fatal(`Guild ${settings.serverID} not found; is the bot invited?`);

  const channel =
    client.channels.cache.get(settings.channelID) ??
    (await client.channels.fetch(settings.channelID).catch(() => null));
  if (!channel || typeof channel.send !== 'function' || typeof channel.messages?.fetch !== 'function') {
    fatal(`Starboard channel ${settings.channelID} not found or is not a text channel.`);
  }
  if (channel.guildId !== settings.serverID) {
    fatal('settings.json: channelID does not belong to serverID.');
  }
  starChannel = channel;

  // If the configured emoji was a bare custom emoji ID, resolve it so the
  // footer can render the real emoji instead of the raw ID.
  if (configuredEmoji.id && !configuredEmoji.name) {
    const emoji = guild.emojis.cache.get(configuredEmoji.id) ??
      (await guild.emojis.fetch(configuredEmoji.id).catch(() => null));
    if (emoji) emojiDisplay = emoji.toString();
  }

  state = loadState();
  if (state.guildId !== settings.serverID || state.channelId !== settings.channelID) {
    if (Object.keys(state.posts).length > 0) {
      warn('Guild or starboard channel changed; resetting stored post mappings.');
    }
    state = freshState();
    scheduleSave();
  }

  try {
    await backfill();
  } catch (e) {
    warn(`Backfill failed (will retry on next start): ${e.message}`);
  }

  try {
    await reconcileRecentPosts();
  } catch (e) {
    warn(`Startup reconciliation failed: ${e.message}`);
  }

  const me = guild.members.me;
  const permissions = me ? starChannel.permissionsFor(me) : null;
  if (permissions) {
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];
    if (settings.deleteBelowThreshold) required.push(PermissionFlagsBits.ManageMessages);

    const missing = required.filter((permission) => !permissions.has(permission));
    if (missing.length > 0) {
      warn('The bot is missing required permissions in the starboard channel. Check View Channel, ' +
        'Read Message History, Send Messages, Embed Links, and Manage Messages.');
    }
  }

  log(
    `Starboard ready: ${guild.name} -> #${channel.name} ` +
    `(${Object.keys(state.posts).length} tracked posts, threshold ${settings.threshold}).`,
  );
}

client.once('clientReady', () => {
  init()
    .then(() => {
      ready = true;
    })
    .catch((e) => {
      console.error(timestamp(), 'Startup failed:', e);
      process.exit(1);
    });
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleReaction(reaction, user, action) {
  if (!ready) return;

  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const { message } = reaction;
  if (!message.guild || message.guild.id !== settings.serverID) return;
  if (message.channel.id === settings.channelID) return;
  if (!matchesEmoji(reaction.emoji)) return;
  if (settings.ignoreBots && user.bot) return;

  const post = getPost(message.id);

  if (!post) {
    if (action !== 'add') return;
    if (isExpired(message)) return;

    // The cached message can occasionally lag behind the event payload.
    const count = Math.max(getStarCount(message, 0), reaction.count ?? 0);
    if (count < settings.threshold) return;
  }

  queueUpdate(message);
}

client.on('messageReactionAdd', (reaction, user) => {
  handleReaction(reaction, user, 'add').catch((e) => warn(`Reaction add failed: ${e.message}`));
});

client.on('messageReactionRemove', (reaction, user) => {
  handleReaction(reaction, user, 'remove').catch((e) => warn(`Reaction remove failed: ${e.message}`));
});

async function handleBulkReactionChange(message) {
  if (!ready) return;
  if (message.partial) await message.fetch();
  if (!message.guild || message.guild.id !== settings.serverID) return;
  if (message.channel.id === settings.channelID) return;
  if (!getPost(message.id)) return;
  queueUpdate(message);
}

client.on('messageReactionRemoveAll', (message) => {
  handleBulkReactionChange(message).catch((e) => warn(`Reaction clear failed: ${e.message}`));
});

client.on('messageReactionRemoveEmoji', (reaction) => {
  if (!matchesEmoji(reaction.emoji)) return;
  handleBulkReactionChange(reaction.message).catch((e) => warn(`Reaction clear failed: ${e.message}`));
});

client.on('messageDelete', (message) => {
  if (!ready) return;
  if (message.channelId === settings.channelID) return;
  if (!getPost(message.id)) return;
  removeStarPost(message.id).catch((e) => warn(`Could not remove starboard post: ${e.message}`));
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

client.on('error', (e) => warn(`Discord client error: ${e.message}`));

process.on('unhandledRejection', (reason) => {
  warn('Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (e) => {
  console.error(timestamp(), 'Uncaught exception:', e);
  flushStateSync();
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}; shutting down...`);

  for (const { timer } of pendingUpdates.values()) clearTimeout(timer);
  pendingUpdates.clear();
  await flushState();

  try {
    await client.destroy();
  } catch (e) {
    warn(`Error while closing the Discord client: ${e.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const token = process.env.DISCORD_TOKEN || settings.token;
if (!token) {
  fatal('No token found. Set DISCORD_TOKEN in your environment or .env file.');
}
if (!process.env.DISCORD_TOKEN && settings.token) {
  warn('Using a token from settings.json; prefer DISCORD_TOKEN in .env.');
}

client.login(token).catch((e) => fatal(`Discord login failed: ${e.message}`));
