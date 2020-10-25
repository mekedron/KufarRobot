const Telegraf = require('telegraf')
const https = require('https')
const zlib = require('zlib')
const { MongoClient } = require('mongodb')
const ParametersMapResolver = require('./parameters-map-resolver')

class Sender {
  constructor (
    botToken,
    mongoUri = 'mongodb://localhost:27017',
    sessionsCollectionName = 'session',
    itemsCollectionName = 'item',
    schedule = null,
    mongoOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  ) {
    this.botToken = botToken
    this.mongoUri = mongoUri
    this.sessionsCollectionName = sessionsCollectionName
    this.itemsCollectionName = itemsCollectionName
    this.schedule = schedule
    this.mongoOptions = mongoOptions

    this.inited = false
  }

  async launch () {
    if (this.inited) {
      return
    }

    this.client = await MongoClient.connect(this.mongoUri, this.mongoOptions)
    this.db = this.client.db()
    this.sessions = this.db.collection(this.sessionsCollectionName)
    this.items = this.db.collection(this.itemsCollectionName)

    await this.items.createIndex({ kufar_id: 1 })

    this.bot = new Telegraf(this.botToken)

    if (this.schedule) {
      const cron = require('node-cron')
      cron.schedule(this.schedule, this.exec.bind(this))
    }

    this.inited = true

    return this.exec()
  }

  async exec () {
    let users = await this.sessions.find().toArray()

    // @todo batch
    for (var i = 0; i < users.length; i++) {
      await this.processUser(users[i])
    }
  }

  async processUser (user) {
    if (!user.data || !user.data.url) {
      return
    }

    let chatId = user.key.split(':')[0]
    let items = [];

    try {
      items = await this.fetchItems(user.data.url)
    } catch (e) {
      console.error(
        'An error has occurred for user with key "' + user.key + '".',
        e
      );
    }

    if (!items.length) {
      return
    }

    for (var i = 0; i < items.length; i++) {
      let item = items[i]
      item.kufar_id = item.ad_id
      delete item.ad_id

      let existingItem = await this.items.findOne({
        kufar_id: item.kufar_id,
      })

      item.has_sent_to = existingItem
        ? (existingItem.has_sent_to || {})
        : {}

      if (item.has_sent_to[chatId]) {
        continue
      } else {
        item.has_sent_to[chatId] = 1
      }

      this.sendItem(chatId, item)
      .then(() => {
        this.items.findOneAndUpdate({
          kufar_id: item.kufar_id,
        }, { $set: item }, { upsert: true })
      })
      .catch(e => {
        if (parseInt(e.code, 10) === 403) {
          this.unsubscribe(user._id)
        } else {
          console.error(
            'Can\'t send the item to the user: \'' +
            user.key + '\', item: \'' +
            JSON.stringify(item) + '\'\n' +
            '    Reason: ' + e.message,
          )
        }
      })
    }
  }

  async sendItem (chatId, item) {
    let createdAt = new Date(item.list_time).toLocaleString('en-US')
    let message = ''

    const priceBYN = (parseInt(item.price_byn) / 100).toFixed(2)
    const priceUSD = (parseInt(item.price_usd) / 100).toFixed(2)

    const accountParams = (item.account_parameters || []).reduce((carry, item) => {
      carry[item.p] = item.v;
      return carry;
    }, {})

    if (item.subject) {
      message += '<b>' + item.subject + '</b>\n\n'
    }

    message += `💵 $${priceUSD}, или ${priceBYN} руб.\n`
    if (item.rooms) {
      message += `🚪 Комнаты: ${item.rooms}\n`
    }
    message += `🌟 ${createdAt}\n\n`

    message += `👤 ${accountParams.contact_person || accountParams.name || 'Без имени'}` +
      (item.company_ad ? ` ⚠️ Агент\n` : `\n`)
    message += !item.phone
      ? '📵 Телефон не указан\n'
      : item.phone.split(',').map(phone => {
        var formattedPhone = phone.trim().replace(
          /(375)(29|25|33|44)(\d{3})(\d{2})(\d{2})/,
          '+$1 ($2) $3-$4-$5',
        )

        return `📱 ${formattedPhone}`
      }).join('\n')

    const replyMarkup = JSON.stringify({
      inline_keyboard: [
        [{ text: 'View', url: item.ad_link }],
      ],
    })

    if (item.images && item.images.length) {
      const imageObj = item.images[0]
      const type = imageObj.id.slice(0, 2)
      const name = imageObj.id + '.jpg'
      const isYams = imageObj.yams_storage || false;
      const imageUrl = isYams
        ? 'https://yams.kufar.by/api/v1/kufar-ads/images/' + type + '/' + name + '?rule=gallery'
        : 'https://cache1.kufar.by/gallery/' + type.slice(0, 2) + '/' + name

      await this.bot.telegram.sendPhoto(chatId, imageUrl, {
        caption: message,
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: 'View', url: item.ad_link }],
          ],
        }),
      })
    } else {
      await this.bot.telegram.sendMessage(
        chatId,
        message,
        {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        },
      )
    }
  }

  async fetchItems (url) {
    const API_URL = 'https://cre-api.kufar.by/ads-search/v1/engine/v1/search/rendered-paginated?'

    const paramsString = url.slice(url.indexOf('?') + 1)
    const searchParams = new URLSearchParams(paramsString)
    const { paramsMap, query } = await ParametersMapResolver(url)
    const paramsToKeep = [
      'size',
      'sort',
      'cursor',
      'query',
      'ot'
    ].concat(Object.keys(paramsMap))
    const paramsToDelete = []
    for (var key of searchParams.keys()) {
      if (paramsToKeep.indexOf(key) < 0) {
        paramsToDelete.push(key)
      }
    }

    if (!query) {
      console.warn("CHECK THIS URL: ", url, API_URL + searchParams.toString());
    }

    Object.keys(query || {}).forEach(param => {
      searchParams.append(param, query[param]);
    });

    paramsToDelete.forEach(param => searchParams.delete(param))

    searchParams.set('size', 30)

    try {
      // @todo support pagination
      let result = await this.callAPI(
        API_URL + searchParams.toString(), {
          referer: url,
          referrerPolicy: "strict-origin-when-cross-origin",
          method: "GET",
          mode: "cors",
        })

      return result.ads || []

    } catch (e) {
      console.error('Can\'t get the items by the url = ' + url, e)

      return []
    }
  }

  async callAPI (url, options) {
    let requestOptions = Object.assign({
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9,ru;q=0.8,fr;q=0.7,de;q=0.6",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "pragma": "no-cache",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "x-segmentation": "routing=web_re;platform=web;application=ad_view"
        // 'Accept': 'application/json, text/plain, */*',
        // 'Connection': 'keep-alive',
        // 'Pragma': 'no-cache',
        // 'Cache-Control': 'no-cache',
        // 'Upgrade-Insecure-Requests': '1',
        // 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36',
        // 'Sec-Fetch-Mode': 'navigate',
        // 'Sec-Fetch-User': '"?1',
        // 'DNT': '1',
        // 'Sec-Fetch-Site': 'none',
        // 'Accept-Encoding': 'deflate, br',
        // 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
    }, options)

    return new Promise((resolve, reject) => https.get(
      url,
      requestOptions,
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(
            'Status code is not 200, response is: ' +
            JSON.stringify(res.rawHeaders),
          ))
        }

        // const handleResponse = (res, resolve, reject) => {
        //   let buffer = [];
        //   return (() => {
        //     res.on('data', function (data) {
        //       // decompression chunk ready, add it to the buffer
        //       buffer.push(data.toString())
        //     }).on('end', function () {
        //       // response and decompression complete, join the buffer and return
        //       resolve(JSON.parse(buffer.join('')))
        //     }).on('error', function (e) {
        //       reject(new Error(e))
        //     })
        //   })();
        // };

        // pipe the response into the gunzip to decompress
        const gunzip = zlib.createGunzip()
        // res.pipe(gunzip)

        let buffer = []
        res.on('data', function (data) {
          // decompression chunk ready, add it to the buffer
          buffer.push(data.toString())
        }).on('end', function () {
          // response and decompression complete, join the buffer and return
          resolve(JSON.parse(buffer.join('')))
        }).on('error', function (e) {
          reject(new Error(e))
        })
      }).on('error', err => reject(new Error(err))),
    )
  }

  async unsubscribe (userId) {
    return this.sessions.findOneAndUpdate(
      { _id: userId },
      { $set: { data: { url: null } } },
    )
  }
}

const sender = new Sender(
  process.env.BOT_TOKEN,
  process.env.MONGO_URI,
  process.env.SESSIONS_COLLECTION,
  process.env.ITEMS_COLLECTION,
  process.env.SCHEDULE,
)

sender.launch().catch(
  console.error,
)
