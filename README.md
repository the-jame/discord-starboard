# Discord Starboard (v14)
A modern, lightweight Starboard bot for Discord built with Node.js and Discord.js v14.

## Features
- **Modern Discord.js v14**: Uses the latest features and security updates.
- **Persistent Memory**: Looks back at previous starboard posts to avoid duplicates.
- **Image Support**: Automatically handles images from attachments and embeds.
- **Live Updates**: Updates the star count on the starboard message in real-time.
- **Date Cutoff**: Prevents users from starring ancient messages.

---

## Installation (Linux/Ubuntu)

### 1. Requirements
- **Node.js 18.0.0 or higher** (Recommended: v20 or v24)
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
"fetchLimit": 100
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
| `fetchLimit` | Integer | How many messages to scan for duplicates on startup |

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
