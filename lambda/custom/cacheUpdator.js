const AWS = require('aws-sdk')
const request = require('request')
const podcast = require('podcast')
const path = require('path')

const s3 = new AWS.S3()

exports.handler = async (event) => {
  const episode = await podcast.getEpisodeInfo(podcast.config.ID, 0, { useOriginalUrl: true })
  console.log('episode.url:', episode.url)

  return new Promise((resolve, reject) => {
    // binary の場合 encoding: null としなければならない
    request.get(episode.url, {encoding: null}, (err, res, body) => {
      console.log('RESPONSE CODE:', res.statusCode)
      console.log('RESPONSE HEADERS:', res.headers)

      s3.putObject({
        Body: body,
        Bucket: process.env.S3_BUCKET_EPISODE,
        Key: path.basename(episode.url)
      }, (err, data) => {
        if (err) {
          console.log('S3 PUT ERROR: ', err)
          reject(err)
          return
        }
        console.log('S3 PUT OBJECT: ', data)
        s3.putObjectAcl({
          Bucket: process.env.S3_BUCKET_EPISODE,
          Key: path.basename(episode.url),
          ACL: 'public-read'
        }, (err, data) => {
          console.log('S3 PUT ACL: ', data)
          resolve()
        })
      })
    })
  })
}
