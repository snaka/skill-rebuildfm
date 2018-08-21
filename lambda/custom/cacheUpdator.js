const AWS = require('aws-sdk')
const request = require('request')
const podcast = require('podcast')
const path = require('path')

const s3 = new AWS.S3()

async function fetchEpisode(url) {
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

exports.handler = async (event) => {
  const episode = await podcast.getEpisodeInfo(podcast.config.ID, 0, { useOriginalUrl: true })
  console.log('episode.url:', episode.url)

  const episodeBody = await fetchEpisode(episode.url)

  await s3.putObject({
    Body: episodeBody,
    Bucket: process.env.S3_BUCKET_EPISODE,
    Key: path.basename(episode.url)
  }).promise()

  await s3.putObjectAcl({
    Bucket: process.env.S3_BUCKET_EPISODE,
    Key: path.basename(episode.url),
    ACL: 'public-read'
  }).promise()
}
