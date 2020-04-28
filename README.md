
# Discord Starboard (js)
This is a simple Node.js starboard bot for Discord. Full instructions included for those not familiar with the process.


## Full Installation (Linux)

* `sudo apt-get install npm -y && sudo apt-get install git -y`  (prepare environment)
* `git clone git://github.com/the-jame/discord-starboard.git && cd discord-starboard` (download code)  
* `npm install`  (install dependencies)
* `cp sample-settings.json settings.json && nano settings.json` (create settings. ctrl + x to close, y to confirm, enter)
* `node app.js` (run program)
* [pm2 is recommended](https://pm2.keymetrics.io/docs/usage/quick-start/) to keep the bot running



## Options & Config.
### Basic variables.
| Option | Type | Description |
| --- | --- | --- |
| token | String | Your discord bot token |
| serverID | String | Your server ID |
| channelID | String | Your starboard channel ID |
| reactionEmoji | Emoji | The emoji which will be tallied for the starboard |
| threshold | Integer | The number of stars before the message is pinned |
| hexcolor | Hex | The color of the embed for the pinned message |
| dateCutoff | Integer | The maximum age of messages eligible to be starred |
| fetchLimit | Integer | Number of previously pinned messages to load to avoid duplicates |



## How to get server/channel IDs.
User Settings -> Advanced -> Developer Mode
![developer_mode](http://theja.me/s/c9kf.png "Developer Mode")

Server ID (right click server name):

![serverID](http://theja.me/s/Usxp.png "Server ID")

Channel ID (right click channel name):

![channelID](http://theja.me/s/S95V.png "Channel ID")

# upstar
