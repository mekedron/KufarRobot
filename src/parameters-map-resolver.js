const { getCached, setCached } = require('./cache-storage')
const defaultParamsMap = require('./default-parameters-map')
const https = require('https')
const zlib = require('zlib')

function prepareUrl (url) {
  return url.replace(/^https?:\/\/(www\.)?([^\/]*)\/.*/ig, '$2')
}

async function fetchPage (url) {
  const requestOptions = Object.assign({
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8,fr;q=0.7',
      'Cache-Control': 'no-cache',
      'Cookie': 'fullscreen_cookie=1',
      'Dnt': '1',
      'Pragma': 'no-cache',
      'Referer': 'https://www.kufar.by/listings',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.129 Safari/537.36',
    },
  })

  return new Promise((resolve, reject) => https.get(
    url,
    requestOptions,
    (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(
          'Cannot fetch filter map. Status code is not 200, response is: ' +
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
        resolve(buffer.join(''))
      }).on('error', function (e) {
        reject(new Error(e))
      })
    }).on('error', err => reject(new Error(err))),
  )
}

function extractAppConfig (pageHtml) {
  if (!pageHtml) {
    return false
  }

  const startTag = '<script id="__NEXT_DATA__" type="application/json">'
  const endTag = '</script><script nomodule=""'
  const startPosition = pageHtml.indexOf(startTag) + startTag.length
  const endPosition = pageHtml.indexOf(endTag, startPosition)

  let result = pageHtml.slice(startPosition, endPosition)

  if (!result) {
    return false
  }

  result = JSON.parse(result)

  return result;
}

function buildFiltersMaps (appConfig) {
  let refs = appConfig
    .props
    .initialState
    .filters
    .filtersData
    .metadata
    .parameters
    .refs

  return Object.keys(refs).reduce((carry, key) => {
    let ref = refs[key]
    carry[ref.url_name] = ref.name
    return carry
  }, [])
}

function extractParamsMap (appConfig) {
  let builtMap = appConfig.props.initialState.filters.parametersMap

  if (builtMap) {
    return builtMap
  }

  return buildFiltersMaps(appConfig)
}

async function resolve (url) {
  let preparedUrl = prepareUrl(url)

  let result = await getCached(preparedUrl)

  if (result) {
    return result
  }

  const pageHtml = await fetchPage(url)
  const appConfig = extractAppConfig(pageHtml)

  result = extractParamsMap(appConfig)

  if (!appConfig || !result) {
    console.error(
      'We cannot extract app config from the page with url and content: ',
      url,
      pageHtml,
    )
    return defaultParamsMap
  }

  await setCached(result)

  return result
}

module.exports = resolve
