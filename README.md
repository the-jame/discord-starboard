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
