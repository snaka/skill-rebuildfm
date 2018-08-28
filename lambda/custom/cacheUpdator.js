const assert = require('assert')
const podcast = require('podcast')

exports.handler = async (event) => {
  assert(process.env.S3_BUCKET_EPISODE, 'S3_BUCKET_EPISODE is not defined.')

  const episode = await podcast.getEpisodeInfo(podcast.config.ID, 0, { useOriginalScheme: true, forceUseCache: false })
  console.log('episode.url:', episode.url)

  return episode.url
}
