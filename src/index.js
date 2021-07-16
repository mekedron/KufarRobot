const Telegraf = require('telegraf')
const { TelegrafMongoSession } = require('telegraf-session-mongodb')
const { MongoClient } = require('mongodb')

const bot = new Telegraf(process.env.BOT_TOKEN)
const session = {}
bot.use((...args) => session.middleware(...args))

bot.start((ctx) => {
  return ctx.reply(
    (!ctx.session || !ctx.session.url)
      ? ('Please, send a link from the Kufar.by with preselected filters.')
      : ('Current link is:\n\n' + ctx.session.url),
    {
      disable_web_page_preview: true,
    },
  )
})

bot.command('stop', (ctx) => {
  ctx.session.url = null

  return ctx.reply(
    'Sorry if you were insulted by this bot, I\'ve just tried to make this world a bit better.',
  )
})

bot.hears(/https:\/\/(\w+)\.kufar\.by\//ig, (ctx) => {
  ctx.session.url = ctx.message.text

  return ctx.reply('Thanks, the link has been updated.')
})

MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true }).
  then(async (client) => {
    const db = client.db()
    const mongoSession = new TelegrafMongoSession(db, {
      collectionName: process.env.SESSIONS_COLLECTION,
    })

    session.middleware = mongoSession.middleware.bind(mongoSession)

    try {
      await bot.launch()
    } catch (e) {
      console.error(e);

      if (e.message.indexOf('socket hang up' > -1)) {
        process.abort();
      }
    }
  }).
  catch(console.error)

bot.catch((e) => {
  if (e.message.indexOf('socket hang up' > -1)) {
    return process.abort();
  }
  throw e;
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
