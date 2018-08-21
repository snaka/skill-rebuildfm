const assert = require('assert')
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
  assert(process.env.S3_BUCKET_EPISODE, 'S3_BUCKET_EPISODE is not defined.')

  const episode = await podcast.getEpisodeInfo(podcast.config.ID, 0, { useOriginalUrl: true })
  console.log('episode.url:', episode.url)

  const episodeBody = await fetchEpisode(episode.url)
  const bucket = process.env.S3_BUCKET_EPISODE
  const key = path.basename(episode.url)

  try {
    let head = await s3.headObject({ Bucket: bucket, Key: key }).promise()
    console.log(`Episode ${key} is already exist.`)
    return
  } catch(err) {
    console.log('Episode file is not exist yet. It will download.')
  }

  await s3.putObject({ Bucket: bucket, Key: key, Body: episodeBody }).promise()
  await s3.putObjectAcl({ Bucket: bucket, Key: key, ACL: 'public-read' }).promise()
}
