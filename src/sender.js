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
    let items = await this.fetchItems(user.data.url)

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
        ? existingItem.has_sent_to
        : {}

      if (item.has_sent_to[chatId]) {
        continue
      } else {
        item.has_sent_to[chatId] = 1
      }

      try {
        await this.sendItem(chatId, item)
        await this.items.findOneAndUpdate({
          kufar_id: item.kufar_id,
        }, { $set: item }, { upsert: true })
      } catch (e) {
        console.error(
          'Can\'t send the item to the user = ' +
          user.id + ', item = ' +
          JSON.stringify(item),
          e,
        )
      }
    }
  }

  async sendItem (chatId, item) {
    let createdAt = new Date(item.list_time).toLocaleString('en-US')
    let message = ''

    const priceBYN = (parseInt(item.price_byn) / 100).toFixed(2)
    const priceUSD = (parseInt(item.price_usd) / 100).toFixed(2)

    if (item.subject) {
      message += '<b>' + item.subject + '</b>\n\n'
    }

    message += `💵 $${priceUSD}, или ${priceBYN} руб.\n`
    if (item.rooms) {
      message += `🚪 Комнаты: ${item.rooms}\n`
    }
    message += `🌟 ${createdAt}\n\n`

    message += `👤 ${item.name}` +
      (item.company_ad ? `⚠️ Агент\n` : `\n`)
    message += !item.phone ? '📵 Телефон не указан\n' :
      item.phone.split(',\n').map(phone => {
        var formattedPhone = phone.replace(
          /(375)(29|25|33|44)(\d{3})(\d{2})(\d{2})/,
          '+$1 ($2) $3-$4-$5',
        )

        return `📱 ${formattedPhone}`
      })

    const replyMarkup = JSON.stringify({
      inline_keyboard: [
        [{ text: 'View', url: item.ad_link }],
      ],
    })

    if (item.images && item.images.length) {
      const imageObj = item.images[0]
      const type = imageObj.id.slice(0, 2)
      const name = imageObj.id + '.jpg'
      const imageUrl = 'https://yams.kufar.by/api/v1/kufar-ads/images/' + type +
        '/' + name + '?rule=gallery'

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
    const API_URL = 'https://re.kufar.by/api/search/ads-search/v1/engine/v1/search/raw?'

    const paramsString = url.slice(url.indexOf('?') + 1)
    const searchParams = new URLSearchParams(paramsString)
    const paramsMap = await ParametersMapResolver(url)
    const paramsToKeep = ['size', 'sort', 'cursor'].concat(
      Object.keys(paramsMap))
    const paramsToDelete = []

    for (var key of searchParams.keys()) {
      if (paramsToKeep.indexOf(key) < 0) {
        paramsToDelete.push(key)
      }
    }

    paramsToDelete.forEach(param => searchParams.delete(param))

    searchParams.set('size', 200)

    try {
      // @todo support pagination
      let result = await this.callAPI(
        API_URL + searchParams.toString(), {
          referer: url,
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
        'Accept': 'application/json, text/plain, */*',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '"?1',
        'DNT': '1',
        'Sec-Fetch-Site': 'none',
        'Accept-Encoding': 'deflate, br',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
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

        // pipe the response into the gunzip to decompress
        const gunzip = zlib.createGunzip()
        res.pipe(gunzip)

        let buffer = []
        gunzip.on('data', function (data) {
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
