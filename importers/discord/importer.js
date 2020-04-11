const { posts, lookup } = require('../../db');
const Promise = require('bluebird');
const cloudscraper = require('cloudscraper')
  .defaults({
    onCaptcha: require('../../captcha')()
  });
const request = require('request').defaults({ encoding: null });
const fs = require('fs-extra');
const nl2br = require('nl2br');
const range = require('node-num-range');
const retry = require('p-retry');
const isImage = require('is-image');
const { SnowflakeUtil } = require('discord.js');
// port of https://github.com/Dracovian/Discord-Scraper
const random = (min, max) => Math.floor(Math.random() * (max - min) + min);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const toUnix = ts => Date.parse(ts); // formatted time to unix time
const getDay = (month, day, year) => {
  const minTime = toUnix(`${month} ${day} ${year} 00:00:00`);
  const maxTime = minTime + 86400000;
  return {
    '00:00': SnowflakeUtil.generate(minTime),
    '23:59': SnowflakeUtil.generate(maxTime)
  };
};

async function scraper (key, server, channels) {
  const date = new Date();
  const channelArray = channels.split(',');
  // validate server and create lookup indexes
  const nfo = await cloudscraper.get(`https://discordapp.com/api/v6/guilds/${server}`, {
    json: true,
    simple: false,
    resolveWithFullResponse: true,
    headers: {
      authorization: key,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.305 Chrome/69.0.3497.128 Electron/4.0.8 Safari/537.36'
    }
  });
  if (nfo.statusCode !== 200) return;
  const indexExists = await lookup.findOne({ id: nfo.body.id, service: 'discord' });
  if (!indexExists) {
    await lookup.insertOne({
      version: 3,
      service: 'discord',
      id: nfo.body.id,
      name: nfo.body.name,
      icon: nfo.body.icon
    });
  }
  Promise.map(channelArray, async (channel) => {
    const channelnfo = await cloudscraper.get(`https://discordapp.com/api/v6/channels/${channel}`, {
      json: true,
      simple: false,
      resolveWithFullResponse: true,
      headers: {
        authorization: key,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.305 Chrome/69.0.3497.128 Electron/4.0.8 Safari/537.36'
      }
    });
    if (channelnfo.statusCode !== 200) return;
    const channelExists = await lookup.findOne({ id: channelnfo.body.id, service: 'discord-channel' });
    if (!channelExists) {
      await lookup.insertOne({
        version: 3,
        service: 'discord-channel',
        name: channelnfo.body.name,
        topic: channelnfo.body.topic,
        id: channelnfo.body.id,
        server: server
      });
    }
    await Promise.mapSeries(range(date.getFullYear(), 2015), async (year) => {
      await Promise.mapSeries(range(12, 1), async (month) => {
        await Promise.mapSeries(range(31, 1), async (day) => {
          // skip date if future
          if (month > date.getMonth() && year === date.getFullYear()) return;
          if (month === date.getMonth() && day > date.getDate()) return;
          const snowflakes = getDay(month, day, year);
          const discord = await retry(() => {
            return new Promise((resolve, reject) => {
              cloudscraper
                .get(
                  `https://discordapp.com/api/v6/guilds/${server}/messages/search?channel_id=${channel}` +
                  `&min_id=${snowflakes['00:00']}&max_id=${snowflakes['23:59']}` +
                  '&include_nsfw=true',
                  {
                    json: true,
                    headers: {
                      authorization: key,
                      referer: `https://discordapp.com/channels/${server}/${channel}`,
                      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.305 Chrome/69.0.3497.128 Electron/4.0.8 Safari/537.36'
                    }
                  }
                )
                .then(res => resolve(res))
                .catch(async (err) => {
                  if (err.statusCode === 429) await sleep(err.error.retry_after);
                  return reject(err);
                });
            });
          });
          await Promise.mapSeries(discord.messages, async (block) => {
            await Promise.mapSeries(block, async (msg) => {
              const attachmentsKey = `attachments/discord/${server}/${msg.channel_id}/${msg.id}`;
              const existing = await posts.findOne({ id: msg.id, service: 'discord' });
              if (existing) return;
              const model = {
                version: 3,
                service: 'discord',
                content: nl2br(msg.content),
                id: msg.id,
                author: msg.author,
                user: server,
                channel: channelnfo.body.id,
                published_at: msg.timestamp,
                edited_at: msg.edited_timestamp,
                added_at: new Date().getTime(),
                mentions: msg.mentions,
                embeds: [],
                attachments: []
              };

              await Promise.map(msg.embeds, async (embed) => model.embeds.push(embed));
              await Promise.map(msg.attachments, async (attachment) => {
                await fs.ensureFile(`${process.env.DB_ROOT}/${attachmentsKey}/${attachment.filename}`);
                await new Promise(resolve => {
                  request.get({ url: attachment.proxy_url, encoding: null })
                    .on('complete', () => resolve())
                    .pipe(fs.createWriteStream(`${process.env.DB_ROOT}/${attachmentsKey}/${attachment.filename}`));
                });
                model.attachments.push({
                  isImage: isImage(attachment.filename),
                  name: attachment.filename,
                  path: `/${attachmentsKey}/${attachment.filename}`
                });
              });

              await posts.insertOne(model);
            });
          });
          await sleep(random(500, 1250));
        });
      });
    });
  });
}

module.exports = data => scraper(data.key, data.server, data.channels);
