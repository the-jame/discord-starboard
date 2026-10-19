const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

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

function footerFor(count, sourceId, emojiDisplay) {
  return `${count} ${emojiDisplay} (${sourceId})`;
}

function buildAuthor(message, member) {
  const authorMember = member ?? message.member;
  return {
    // Guild nickname when available, then global display name, then username.
    name: authorMember?.displayName || message.author.displayName || message.author.username,
    // Guild-specific avatar when available, then the global avatar.
    iconURL: authorMember?.displayAvatarURL?.({ size: 128 }) ||
      message.author.displayAvatarURL({ size: 128 }),
    url: message.url,
  };
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

function buildEmbeds(message, count, { hexcolor, channelId, emojiDisplay, member }) {
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
  if (message.channel?.id && message.channel.id !== channelId) {
    // Zero-width field name: show the channel link without a "Source" label.
    fields.push({ name: '\u200B', value: `<#${message.channel.id}>`, inline: true });
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

  const main = new EmbedBuilder()
    .setAuthor(buildAuthor(message, member))
    .setColor(hexcolor)
    .setTimestamp(message.createdAt)
    .setFooter({ text: footerFor(count, message.id, emojiDisplay) });

  if (content) main.setDescription(content);
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
      .setColor(hexcolor)
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

module.exports = {
  buildEmbeds,
  buildComponents,
  buildAuthor,
  footerFor,
  MAX_GALLERY_IMAGES,
  MAX_CONTENT_LENGTH,
};
