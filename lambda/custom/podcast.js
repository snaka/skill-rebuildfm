'use strict'

const request = require('request')
const FeedParser = require('feedparser')
const AWS = require('aws-sdk')

AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1'
})
const dynamoDb = new AWS.DynamoDB.DocumentClient()

const targetPodcast = exports.config = {
  FEED_URL: 'http://feeds.rebuild.fm/rebuildfm',
  TABLE_NAME: 'alexa-skill-podcasts-player',
  ID: 'rebuild.fm',
  NAME: 'Rebuild.fm',
  NAME_LOCALIZED: 'リビルドエフエム',
  MAX_EPISODE_COUNT: 100
}

function pickSslMediaUrl (enclosures) {
  const sslMedia = enclosures.find(item => item.url.startsWith('https'))
  if (sslMedia) return sslMedia.url

  const nonSslMedia = enclosures[0]
  // Alexa Skill の AudioPlayer は https: で提供されるURLしか対応していないため強引に書き換える
  if (nonSslMedia) return nonSslMedia.url.replace(/^http:/, 'https:')

  throw new Error('Media not found.')
}

async function fetchHead (url) {
  return new Promise((resolve, reject) => {
    request.head(url)
      .on('response', (res) => {
        resolve(res)
      })
      .on('error', (err) => {
        reject(err)
      })
  })
}

async function saveToCache (podcastId, episodes, headers) {
  const timeStamp = Math.floor((new Date()).getTime() / 1000)
  try {
    console.log(`saveToCache: ${podcastId} => ${targetPodcast.TABLE_NAME}`)
    await dynamoDb.put({
      TableName: targetPodcast.TABLE_NAME,
      Item: { podcastId, episodes, timeStamp, headers }
    }).promise()
  } catch (e) {
    console.log(e)
  }
}

async function restoreFromCache (podcastId, etag) {
  try {
    console.log(`restoreFromCache: ${targetPodcast.TABLE_NAME} ${podcastId}`)
    const restored = await dynamoDb.get({ TableName: targetPodcast.TABLE_NAME, Key: { podcastId } }).promise()
    // console.log(`restored: ${JSON.stringify(restored)}`);
    const cachedEtag = (((restored || {}).Item || {}).headers || {}).etag
    if (cachedEtag !== etag) {
      console.log(`ETag changed cache:${cachedEtag} !== current:${etag}`)
      return undefined
    }
    return restored.Item.episodes
  } catch (e) {
    console.error(e)
  }
}

exports.getEpisodeInfo = (podcastId, index) => {
  return new Promise(async (resolve, reject) => {
    if (!targetPodcast) throw new Error('INVALID PODCAST ID')

    const head = await fetchHead(targetPodcast.FEED_URL)

    const cachedFeed = await restoreFromCache(podcastId, head.headers.etag)
    if (cachedFeed) {
      resolve(cachedFeed[index])
      return
    }

    console.log('CACHE INVALIDATED')

    const feedparser = new FeedParser()
    const episodes = []
    let resolved = false

    request.get(targetPodcast.FEED_URL)
      .on('error', (err, res) => {
        if (err) {
          console.error(err)
          return
        }
        console.error(`Bad status res ${res} from ${targetPodcast.FEED_URL}`)
        if (res && res.code) {
          reject(new Error(`Bad status ${res.code} from ${targetPodcast.FEED_URL}`))
        }
      }).pipe(feedparser)

    feedparser.on('data', async (data) => {
      console.log('on data:', data.title)
      if (episodes.length < targetPodcast.MAX_EPISODE_COUNT) {
        const audioUrl = pickSslMediaUrl(data.enclosures)
        episodes.push({
          title: data.title,
          url: audioUrl,
          published_at: data.pubDate.toISOString()
        })
      } else {
        if (!resolved) {
          console.log(`data resolved ${data.title}`)
          resolved = true
          try {
            await saveToCache(podcastId, episodes, head.headers)
            console.log('episodes[index]:', episodes[index])
            resolve(episodes[index])
          } catch (e) {
            console.log(e)
          }
        }
      }
    })

    feedparser.on('end', async () => {
      console.log('on end')
      try {
        await saveToCache(podcastId, episodes, head.headers)
        console.log('episodes[index]:', episodes[index])
        resolve(episodes[index])
      } catch (e) {
        console.log(e)
      }
    })

    feedparser.on('error', () => {
      console.log('on error')
    })
  })
}
