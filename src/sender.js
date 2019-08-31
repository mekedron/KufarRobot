const Telegraf = require('telegraf')
const https = require('https')
const zlib = require('zlib');
const { MongoClient } = require('mongodb')

class Sender {
  constructor (
    botToken,
    mongoUri = 'mongodb://localhost:27017',
    sessionsCollectionName = 'session',
    apartmentsCollectionName = 'apartment',
    schedule = null,
    mongoOptions = {
      useNewUrlParser: true,
    },
  ) {
    this.botToken = botToken
    this.mongoUri = mongoUri
    this.sessionsCollectionName = sessionsCollectionName
    this.apartmentsCollectionName = apartmentsCollectionName
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
    this.apartments = this.db.collection(this.apartmentsCollectionName)

    await this.apartments.createIndex({ kufar_id: 1 })

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
    let apartments = await this.fetchApartments(user.data.url)

    if (!apartments.length) {
      return
    }

    for (var i = 0; i < apartments.length; i++) {
      let apartment = apartments[i]
      apartment.kufar_id = apartment.ad_id
      delete apartment.ad_id

      let existingApartment = await this.apartments.findOne({
        kufar_id: apartment.kufar_id,
      })

      apartment.has_sent_to = existingApartment
        ? existingApartment.has_sent_to
        : {}

      if (apartment.has_sent_to[chatId]) {
        continue
      } else {
        apartment.has_sent_to[chatId] = 1
      }

      try {
        await this.sendApartment(chatId, apartment)
        await this.apartments.findOneAndUpdate({
          kufar_id: apartment.kufar_id,
        }, { $set: apartment }, { upsert: true })
      } catch (e) {
        console.error(
          'Can\'t send the apartment to the user = ' +
          user.id + ', apartment = ' +
          JSON.stringify(apartment),
          e,
        )
      }
    }
  }

  async sendApartment (chatId, apartment) {
    let createdAt = new Date(apartment.list_time).toLocaleString('en-US')

    let message = ''
    let priceBYN = (parseInt(apartment.price_byn) / 100).toFixed(2)
    let priceUSD = (parseInt(apartment.price_usd) / 100).toFixed(2)

    message += `💵 $${priceUSD}, или ${priceBYN} руб.\n`
    message += `🚪 Комнаты: ${apartment.rooms}\n`
    message += `🌟 ${createdAt}\n\n`

    message += `👤 ${apartment.name}` + (apartment.company_ad ? `⚠️ Агент\n` : `\n`)
    message += !apartment.phone ? '📵 Телефон не указан\n' :
      apartment.phone.split(',').map(phone => {
        var formattedPhone = phone.replace(
          /(375)(29|25|33|44)(\d{3})(\d{2})(\d{2})/,
          '+$1 ($2) $3-$4-$5'
        )

        return `📱 ${formattedPhone}\n`
      })

    await this.bot.telegram.sendVenue(
      chatId,
      apartment.coordinates[1],
      apartment.coordinates[0],
      apartment.subject,
      apartment.address,
      {
        disable_notification: true
      }
    );

    for (let i = 0; i < Math.ceil(apartment.images.length / 10); i++) {
      let images = apartment.images.slice(i * 10, i * 10 + 10)
      await this.bot.telegram.sendMediaGroup(
        chatId,
        images.map(img => {
          return {
            type: 'photo',
            media: 'https://cache1.kufar.by/gallery/' + img.id.slice(0, 2) + '/' + img.id + '.jpg'
          }
        }),
        {
          disable_notification: true
        }
      )
    }

    await this.bot.telegram.sendMessage(
      chatId,
      message,
      {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: 'View', url: apartment.ad_link }],
          ],
        })
      }
    );
  }

  static formatRentType (rentType) {
    return rentType === 'room' ? 'Комната' : 'Комнаты: ' + rentType.split('_')[0];
  }

  async fetchApartments (url) {
    const API_URL = 'https://re.kufar.by/api/search/ads-search/v1/engine/v1/search/raw?'

    const paramsString = url.slice(url.indexOf('?') + 1)
    const searchParams = new URLSearchParams(paramsString)
    const paramsToDelete = [
      'center',
      'zoom',
      'prc_min',
      'prc_max'
    ]

    searchParams.set('size', 200);

    paramsToDelete.forEach(param => searchParams.delete(param))

    try {
      // @todo support pagination
      let result = await this.callAPI(
        API_URL + searchParams.toString(), {
          referer: url,
        })

      return result.ads || []

    } catch (e) {
      console.error('Can\'t get the apartments by the url = ' + url, e)

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
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);

        let buffer = []
        gunzip.on('data', function(data) {
          // decompression chunk ready, add it to the buffer
          buffer.push(data.toString())
        }).on("end", function() {
          // response and decompression complete, join the buffer and return
          resolve(JSON.parse(buffer.join("")));
        }).on("error", function(e) {
          reject(new Error(e));
        })
      }).on('error', err => reject(new Error(err))),
    )
  }
}

const sender = new Sender(
  process.env.BOT_TOKEN,
  process.env.MONGO_URI,
  process.env.SESSIONS_COLLECTION,
  process.env.APARTMENTS_COLLECTION,
  process.env.SCHEDULE,
)

sender.launch().catch(
  console.error,
)
