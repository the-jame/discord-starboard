require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');
const { buildEmbeds, buildComponents } = require('./embeds');
const { parseConfiguredEmoji, matchesEmoji } = require('./emoji');

const STATE_FILE = path.join(__dirname, 'data', 'starboard.json');
const PROGRESS_FILE = path.join(__dirname, 'data', 'rebuild-progress.json');
const SAVE_EVERY = 10;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rebuildAll = args.includes('--all');
const verbose = args.includes('--verbose');

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const limitArg = Number.parseInt(argValue('--limit') ?? '', 10);
const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 0;

const concurrencyArg = Number.parseInt(argValue('--concurrency') ?? '', 10);
const concurrency = Number.isInteger(concurrencyArg) && concurrencyArg > 0
  ? Math.min(concurrencyArg, 10)
  : 5;

function log(...values) {
  console.log(new Date().toISOString(), ...values);
}

function warn(...values) {
  console.warn(new Date().toISOString(), ...values);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function compareSnowflakes(a, b) {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeColor(value) {
  const color = String(value ?? 'd4af37').trim();
  return color.startsWith('#') ? color : `#${color}`;
}

function loadProgress() {
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    if (Array.isArray(data.completed)) {
      return new Set(data.completed.filter((id) => typeof id === 'string'));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`Could not read progress file: ${e.message}`);
  }
  return new Set();
}

function saveProgress(completed) {
  try {
    const dir = path.dirname(PROGRESS_FILE);
    const tmp = `${PROGRESS_FILE}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          completed: [...completed].sort(),
        },
        null,
        2,
      ),
    );
    fs.renameSync(tmp, PROGRESS_FILE);
  } catch (e) {
    warn(`Could not save progress: ${e.message}`);
  }
}

function getStarCount(message, configuredEmoji) {
  const reaction = message.reactions.cache.find((r) => matchesEmoji(configuredEmoji, r.emoji));
  return reaction ? reaction.count : 0;
}

async function main() {
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  if (!state.posts || typeof state.posts !== 'object') {
    throw new Error('state file has no posts');
  }
  if (state.guildId !== settings.serverID || state.channelId !== settings.channelID) {
    throw new Error('state file belongs to a different guild or starboard channel');
  }

  const configuredEmoji = parseConfiguredEmoji(settings.reactionEmoji);
  let emojiDisplay = configuredEmoji.display;

  const completed = loadProgress();
  const entries = Object.entries(state.posts)
    .filter(([, post]) => post?.starMessageId)
    .sort((a, b) => compareSnowflakes(b[0], a[0])); // newest first
  const todo = entries.filter(([sourceId]) => rebuildAll || !completed.has(sourceId));
  const runLimit = limit > 0 ? Math.min(limit, todo.length) : todo.length;
  const batch = todo.slice(0, runLimit);

  log(
    `Rebuild ${dryRun ? '(dry run) ' : ''}starting: ${entries.length} tracked, ` +
    `${completed.size} already completed, ${batch.length} in this run, ` +
    `concurrency ${Math.min(concurrency, batch.length)}.`,
  );
  if (batch.length === 0) {
    log('Nothing left to rebuild.');
    return;
  }

  const token = process.env.DISCORD_TOKEN || settings.token;
  if (!token) throw new Error('No token found. Set DISCORD_TOKEN in .env.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on('error', (e) => warn(`Discord client error: ${e.message}`));

  let interrupted = false;
  function shutdown(signal) {
    if (interrupted) return;
    interrupted = true;
    warn(`Received ${signal}; saving progress and stopping...`);
    saveProgress(completed);
    client.destroy().finally(() => process.exit(0));
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const ready = new Promise((resolve) => client.once('clientReady', resolve));
  await client.login(token);
  await ready;

  const guild = client.guilds.cache.get(settings.serverID) ??
    (await client.guilds.fetch(settings.serverID).catch(() => null));
  if (!guild) throw new Error(`Guild ${settings.serverID} not found`);

  const starChannel = client.channels.cache.get(settings.channelID) ??
    (await client.channels.fetch(settings.channelID).catch(() => null));
  if (!starChannel || typeof starChannel.messages?.edit !== 'function') {
    throw new Error(`Starboard channel ${settings.channelID} not found or not editable`);
  }

  if (configuredEmoji.id && !configuredEmoji.name) {
    const emoji = guild.emojis.cache.get(configuredEmoji.id) ??
      (await guild.emojis.fetch(configuredEmoji.id).catch(() => null));
    if (emoji) emojiDisplay = emoji.toString();
  }

  const embedOptions = {
    hexcolor: normalizeColor(settings.hexcolor),
    channelId: settings.channelID,
    emojiDisplay,
  };

  const channelCache = new Map();
  function getChannel(channelId) {
    if (!channelCache.has(channelId)) {
      channelCache.set(
        channelId,
        (async () => client.channels.cache.get(channelId) ??
          (await client.channels.fetch(channelId).catch(() => null)))(),
      );
    }
    return channelCache.get(channelId);
  }

  const memberCache = new Map();
  async function getMember(user) {
    if (!user) return null;
    if (memberCache.has(user.id)) return memberCache.get(user.id);

    let member = guild.members.cache.get(user.id);
    if (!member) {
      member = await guild.members.fetch({ user: user.id, force: true }).catch(() => null);
    }
    memberCache.set(user.id, member);
    return member;
  }

  const startedAt = Date.now();
  let attempted = 0;
  let finished = 0;
  let edited = 0;
  let missingSource = 0;
  let missingPost = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stopped = false;
  let nextIndex = 0;

  function logProgress() {
    const elapsed = Date.now() - startedAt;
    const rate = finished / Math.max(elapsed, 1);
    const remaining = batch.length - finished;
    log(
      `Progress ${finished}/${batch.length} | ${edited} rebuilt | ` +
      `${missingSource + missingPost} skipped | ${failed} failed | ` +
      `ETA ${formatDuration(remaining / rate)}`,
    );
  }

  function markDone(sourceId) {
    completed.add(sourceId);
    finished += 1;
    consecutiveFailures = 0;
    if (finished % SAVE_EVERY === 0) saveProgress(completed);
    if (finished % 25 === 0) logProgress();
  }

  async function processPost(sourceId, post) {
    attempted += 1;

    if (!post.channelId) {
      missingSource += 1;
      if (verbose) warn(`Skipping ${sourceId}: no source channel recorded`);
      markDone(sourceId);
      return;
    }

    const sourceChannel = await getChannel(post.channelId);
    if (!sourceChannel || typeof sourceChannel.messages?.fetch !== 'function') {
      missingSource += 1;
      if (verbose) warn(`Skipping ${sourceId}: source channel unavailable`);
      markDone(sourceId);
      return;
    }

    let sourceMessage;
    try {
      sourceMessage = await sourceChannel.messages.fetch(sourceId, { force: true });
    } catch (e) {
      if (e.code === 10008) {
        missingSource += 1;
        if (verbose) warn(`Skipping ${sourceId}: source message was deleted`);
        markDone(sourceId);
      } else {
        failed += 1;
        consecutiveFailures += 1;
        warn(`Could not fetch source ${sourceId}: ${e.message}`);
        if (consecutiveFailures >= 5) {
          warn('Aborting after 5 consecutive failures.');
          stopped = true;
        }
      }
      return;
    }

    const count = getStarCount(sourceMessage, configuredEmoji);
    const member = await getMember(sourceMessage.author);

    if (dryRun) {
      finished += 1;
      consecutiveFailures = 0;
      if (verbose) log(`Dry run ${finished}/${batch.length}: would rebuild ${sourceId} (${count} stars)`);
      if (finished % 25 === 0) logProgress();
      return;
    }

    try {
      await starChannel.messages.edit(post.starMessageId, {
        embeds: buildEmbeds(sourceMessage, count, { ...embedOptions, member }),
        components: buildComponents(sourceMessage),
        allowedMentions: { parse: [] },
      });
      edited += 1;
      if (verbose) log(`Rebuilt ${sourceId} (${count} stars)`);
      markDone(sourceId);
    } catch (e) {
      if (e.code === 10008) {
        missingPost += 1;
        if (verbose) warn(`Skipping ${sourceId}: starboard post was deleted`);
        markDone(sourceId);
      } else {
        failed += 1;
        consecutiveFailures += 1;
        warn(`Could not rebuild ${sourceId}: ${e.message}`);
        if (consecutiveFailures >= 5) {
          warn('Aborting after 5 consecutive failures.');
          stopped = true;
        }
      }
    }
  }

  async function worker() {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batch.length) return;
      await processPost(...batch[index]);
    }
  }

  const workerCount = Math.min(concurrency, batch.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  saveProgress(completed);

  const elapsed = Date.now() - startedAt;
  log(
    `${dryRun ? 'Dry run complete' : 'Rebuild complete'}: ${finished} finished, ` +
    `${edited} rebuilt, ${missingSource} missing sources, ${missingPost} missing posts, ` +
    `${failed} failures in ${formatDuration(elapsed)}.`,
  );
  if (!dryRun) {
    log(`Progress saved to ${PROGRESS_FILE}. Delete it to force a full rebuild.`);
  }

  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(new Date().toISOString(), 'Rebuild failed:', e);
    process.exit(1);
  });
