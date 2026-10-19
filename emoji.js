function normalizeEmojiName(name) {
  // Strip variation selectors so "⭐" and "⭐️" compare equal.
  return String(name ?? '').replace(/[\uFE0E\uFE0F]/g, '');
}

function parseConfiguredEmoji(input) {
  const value = String(input).trim();
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

function matchesEmoji(configured, emoji) {
  if (!emoji) return false;
  if (configured.id) return emoji.id === configured.id;
  return normalizeEmojiName(emoji.name) === configured.name;
}

module.exports = { parseConfiguredEmoji, matchesEmoji };
