'use strict'

const path = require('path')
const request = require('request')
const FeedParser = require('feedparser')
const awsXRay = require('aws-xray-sdk')
const AWS = awsXRay.captureAWS(require('aws-sdk'))

AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1'
})
const dynamoDb = new AWS.DynamoDB.DocumentClient()
const s3 = new AWS.S3()

const targetPodcast = exports.config = {
  FEED_URL: 'http://feeds.rebuild.fm/rebuildfm',
  TABLE_NAME: 'alexa-skill-podcasts-player',
  ID: 'rebuild.fm',
  NAME: 'Rebuild.fm',
  NAME_LOCALIZED: 'リビルドエフエム',
  MAX_EPISODE_COUNT: 100
}

function pickSslMediaUrl (enclosures, disableUseSsl = false) {
  const sslMedia = enclosures.find(item => item.url.startsWith('https'))
  if (sslMedia) return sslMedia.url

  const nonSslMedia = enclosures[0]
  // Alexa Skill の AudioPlayer は https: で提供されるURLしか対応していないため強引に書き換える
  console.log('disableUseSsl:', disableUseSsl)
  if (nonSslMedia && !disableUseSsl) return nonSslMedia.url.replace(/^http:/, 'https:')

  return nonSslMedia.url
}

async function fetchHead (url) {
  console.log(`FETCH HEAD FOR FEED: ${url}`)
  return new Promise((resolve, reject) => {
    awsXRay.captureAsyncFunc('fetchHead', (subsegment) => {
      request.head(url)
        .on('response', (res) => {
          resolve(res)
          subsegment.close()
        })
        .on('error', (err) => {
          reject(err)
          subsegment.close()
        })
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

async function restoreFromCache (podcastId, etag, forceUseCache = false) {
  try {
    console.log(`restoreFromCache: ${targetPodcast.TABLE_NAME} ${podcastId}`)
    const restored = await dynamoDb.get({ TableName: targetPodcast.TABLE_NAME, Key: { podcastId } }).promise()
    // console.log(`restored: ${JSON.stringify(restored)}`);
    const cachedEtag = (((restored || {}).Item || {}).headers || {}).etag
    if (!forceUseCache && cachedEtag !== etag) {
      console.log(`ETag changed cache:${cachedEtag} !== current:${etag}`)
      return undefined
    }
    return restored.Item.episodes
  } catch (e) {
    console.error(e)
  }
}

async function fetchEpisode(url) {
  console.log(`FETCH EPISODE: ${url}`)
  return new Promise((resolve, reject) => {
    // 対象が binary の場合 encoding: null としなければならない
    request.get(url, { encoding: null }, (err, res, body) => {
      console.log('RESPONSE CODE:', res.statusCode)
      console.log('RESPONSE HEADERS:', res.headers)

      if (err) {
        reject(err)
        return
      }
      resolve(body)
    })
  })
}

async function downloadEpisodeToS3(originalUrl) {
  const bucket = process.env.S3_BUCKET_EPISODE
  const key = path.basename(originalUrl)

  try {
    let head = await s3.headObject({ Bucket: bucket, Key: key }).promise()
    console.log(`Episode ${key} already downloaded.`)
    return `https://s3-ap-northeast-1.amazonaws.com/${bucket}/${key}`
  } catch(err) {
    console.log('The episode does not exist in S3, the episode will be downloaded.')
  }

  const episodeBody = await fetchEpisode(originalUrl)
  await s3.putObject({ Bucket: bucket, Key: key, Body: episodeBody, StorageClass: "REDUCED_REDUNDANCY" }).promise()
  await s3.putObjectAcl({ Bucket: bucket, Key: key, ACL: 'public-read' }).promise()
  return `https://s3-ap-northeast-1.amazonaws.com/${bucket}/${key}`
}

exports.getEpisodeInfo = (podcastId, index, option={ useOriginalScheme: false, forceUseCache: true }) => {
  return new Promise(async (resolve, reject) => {
    awsXRay.captureAsyncFunc('getEpisodeInfo', async (segGetEpisodeInfo) => {
      if (!targetPodcast) throw new Error('INVALID PODCAST ID')

      let etag = ''
      let head = {}
      if (!option.forceUseCache) {
        head = await fetchHead(targetPodcast.FEED_URL)
        etag = head.headers.etag
      }

      const cachedFeed = await restoreFromCache(podcastId, etag, option.forceUseCache)
      if (cachedFeed) {
        const episode = cachedFeed[index]
        episode.url = await downloadEpisodeToS3(episode.url)
        console.log('episode:', episode)
        resolve(episode)
        segGetEpisodeInfo.close()
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
          const audioUrl = pickSslMediaUrl(data.enclosures, option.useOriginalScheme)
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
              const episode = episodes[index]
              episode.url = await downloadEpisodeToS3(episode.url)
              console.log('episode:', episode)
              resolve(episode)
              segGetEpisodeInfo.close()
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
          const episode = episodes[index]
          episode.url = await downloadEpisodeToS3(episode.url)
          console.log('episode:', episode)
          resolve(episode)
          segGetEpisodeInfo.close()
        } catch (e) {
          console.log(e)
        }
      })

      feedparser.on('error', () => {
        console.log('on error')
      })
    })
  })
}
