# Discord Starboard (v14)
A modern, lightweight Starboard bot for Discord built with Node.js and Discord.js v14.

## Features
- **Modern Discord.js v14**: Uses the latest features and security updates.
- **Persistent State**: Post mappings are stored in `data/starboard.json`, so restarts don't create duplicates.
- **Full Backfill**: Imports every post from the starboard channel on first run, with pagination and retries.
- **Startup Reconciliation**: Re-checks recent posts so counts are current even if they changed while the bot was offline.
- **Rich Embeds**: Source channel, reply context, attachment links, stickers, up to four images, and a **Jump to message** button.
- **Live Updates**: Debounced star-count updates, with posts removed when they fall below the threshold.
- **Date Cutoff**: Prevents users from starring ancient messages (existing posts still update).
- **Single Guild**: Only reacts to messages in the configured server.

---

## Installation (Linux/Ubuntu)

### 1. Requirements
- **Node.js 24 LTS** (the bot targets the version in `.nvmrc`)
- **npm** (comes with Node)

### 2. Download and Setup
```bash
# Clone the repository
git clone https://github.com/the-jame/discord-starboard.git
cd discord-starboard

# Install dependencies
npm install

# Create your settings file
cp sample-settings.json settings.json

# Add your bot token to a .env file
echo "DISCORD_TOKEN=YOUR_BOT_TOKEN" > .env
```

### 3. Configuration
Open `settings.json` and fill in your bot's details:
```json
{
"serverID": "YOUR_SERVER_ID",
"channelID": "YOUR_STARBOARD_CHANNEL_ID",
"reactionEmoji": "⭐",
"threshold": 3,
"hexcolor": "d4af37",
"dateCutoff": 30,
"fetchLimit": 0,
"reconcileLimit": 50,
"deleteBelowThreshold": true,
"ignoreBots": true
}
```
Your bot token goes in `.env` (loaded automatically via dotenv):
```
DISCORD_TOKEN=YOUR_BOT_TOKEN
```

### 4. Running the Bot
**For testing:**
```bash
npm start
```

**For production (Recommended):**
Keep the bot running 24/7 using [PM2](https://pm2.keymetrics.io/):
```bash
npm install -g pm2
pm2 start main.js --name "Starboard"
pm2 save
```

---

## Options & Config
| Option | Type | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Env var | Your Discord Bot Token (from Developer Portal), set in `.env` |
| `serverID` | String | The ID of the server the bot is in |
| `channelID` | String | The ID of the channel where stars will be posted |
| `reactionEmoji`| String | The emoji the bot should track (usually ⭐) |
| `threshold` | Integer | Stars required before a message is "boarded" |
| `hexcolor` | Hex | The color of the embed (e.g., `d4af37`) |
| `dateCutoff` | Integer | Max age (in days) for a message to be eligible |
| `fetchLimit` | Integer | Safety cap for the first-run import. `0` (default) scans the entire channel |
| `reconcileLimit` | Integer | Number of newest posts to re-check on startup. `0` disables (default `50`) |
| `deleteBelowThreshold` | Boolean | Delete the starboard post when it drops below `threshold` (default `true`) |
| `ignoreBots` | Boolean | Ignore reaction events from bot accounts (default `true`) |

### Embed contents
New starboard posts include:

- Clickable author name and avatar
- **Source** channel mention
- **Reply** context with a jump link when the message is a reply
- **Attachments** as links with file sizes (non-image files and images beyond the gallery limit)
- **Stickers** by name, with sticker artwork as a fallback image
- Up to **4 images**: the first is the main embed image and the rest are additional image embeds
- A **Jump to message** link button
- Message content, timestamp, color, and the live star-count footer

Content is truncated to 3,500 characters to leave room for fields within Discord's embed size limit.

Existing posts are **not** automatically rebuilt: when their count changes they get the refreshed footer and the jump button, but their original embed layout is preserved. Rebuilding old posts requires a one-time edit of each starboard message.

### Bot setup
- Enable the **Message Content** privileged intent in the Discord Developer Portal.
- Invite the bot with **View Channel**, **Read Message History**, **Send Messages**, and **Embed Links**.
- If `deleteBelowThreshold` is enabled, also grant **Manage Messages**.

### State
Post mappings are kept in `data/starboard.json`, which is created automatically and should be included in backups. Do not edit it while the bot is running.

On the first start (or after changing `serverID`/`channelID`), the bot scans the **entire** starboard channel, paginating 100 messages at a time, and records every post it finds. Deleting `data/starboard.json` forces a full rebuild on the next start. `fetchLimit` can be set above `0` to cap that scan if startup time becomes a concern.

On every startup, the newest `reconcileLimit` tracked posts are re-checked against their source messages so the star count is correct even if reactions changed while the bot was offline. Set `reconcileLimit` to `0` to disable this.

---

## How to get Server/Channel IDs
1. Open Discord **Settings**.
2. Go to **Advanced** and enable **Developer Mode**.
3. Right-click on your **Server Name** to "Copy Server ID".
4. Right-click on your **Starboard Channel** to "Copy Channel ID".

---

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>
<p align="center">
  <sub>Copyright © 2026 <a href="https://github.com/the-jame">the-jame</a> · Released under the <a href="LICENSE">MIT License</a></sub>
</p>
