/**
 * Server-Side GitHub Actions Wallpaper Archiver
 * 
 * Runs in yashpreeto7/aetherflow-community with zero client exposure.
 * Moves user-submitted community media from Supabase staging storage to
 * GitHub Releases (wallpapers-v1) and updates the static index.json.
 * 
 * Free tier preservation: Immediately frees Supabase storage so permanent
 * storage remains at 0 MB, leveraging GitHub Releases' free 2 GB-per-asset CDN.
 */

const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vmuutmdmjjaricfosoqz.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'yashpreeto7/aetherflow-community'
const RELEASE_TAG = 'wallpapers-v1'

if (!GITHUB_TOKEN) {
  console.error('Missing GITHUB_TOKEN in environment')
  process.exit(1)
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY in environment')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  console.log('== AetherFlow Server-Side Wallpaper Archiver ==')
  const [owner, repo] = GITHUB_REPOSITORY.split('/')

  // 1. Get release info
  const releaseRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${RELEASE_TAG}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'AetherFlow-Server-Archiver',
    },
  })

  if (!releaseRes.ok) {
    console.error(`Failed to locate GitHub Release "${RELEASE_TAG}" on ${GITHUB_REPOSITORY}: HTTP ${releaseRes.status}`)
    process.exit(1)
  }

  const releaseData = await releaseRes.json()
  const releaseId = releaseData.id
  console.log(`Located release ${RELEASE_TAG} (ID: ${releaseId}) with ${releaseData.assets?.length || 0} existing assets.`)

  // 2. Query Supabase for staged media submissions
  const { data: rows, error: subErr } = await supabase
    .from('submissions')
    .select('*')
    .in('status', ['published', 'approved'])

  if (subErr) {
    console.error('Failed to query Supabase submissions:', subErr.message)
    process.exit(1)
  }

  console.log(`Found ${rows?.length || 0} active community submissions in Supabase.`)

  const stagedRows = (rows || []).filter(r => r.source && r.source.includes('community-uploads'))
  console.log(`Found ${stagedRows.length} wallpapers in Supabase temporary staging storage to archive.`)

  let archivedCount = 0

  for (const row of stagedRows) {
    try {
      console.log(`\nArchiving submission ${row.id} ("${row.title}")...`)
      const assetUrl = row.source
      const rawAssetName = assetUrl.split('/').pop()?.split('?')[0] || `wallpaper_${row.id}.mp4`

      // Check if already in release assets
      const existingAsset = releaseData.assets?.find(a => a.name === rawAssetName)
      let finalDownloadUrl = existingAsset?.browser_download_url

      if (!finalDownloadUrl) {
        console.log(`Downloading staged media from Supabase: ${assetUrl}`)
        const mediaRes = await fetch(assetUrl)
        if (!mediaRes.ok) {
          console.warn(`Could not download media from ${assetUrl} (HTTP ${mediaRes.status}) - skipping.`)
          continue
        }

        const arrayBuffer = await mediaRes.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const contentType = mediaRes.headers.get('content-type') || 'application/octet-stream'

        console.log(`Uploading ${buffer.length} bytes to GitHub Release "${RELEASE_TAG}" as ${rawAssetName}...`)
        const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(rawAssetName)}`

        const upRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            'Content-Type': contentType,
            'User-Agent': 'AetherFlow-Server-Archiver',
            Accept: 'application/vnd.github.v3+json',
          },
          body: buffer,
        })

        if (!upRes.ok) {
          const errText = await upRes.text()
          console.error(`Failed to upload asset to GitHub Release: HTTP ${upRes.status} - ${errText}`)
          continue
        }

        const upData = await upRes.json()
        finalDownloadUrl = upData.browser_download_url || `https://github.com/${owner}/${repo}/releases/download/${RELEASE_TAG}/${rawAssetName}`
      }

      // Check companion thumbnail
      let finalPreviewUrl = row.preview_url
      if (row.preview_url && row.preview_url.includes('community-uploads')) {
        try {
          const rawThumbName = row.preview_url.split('/').pop()?.split('?')[0] || `thumb_${row.id}.jpg`
          const existingThumb = releaseData.assets?.find(a => a.name === rawThumbName)

          if (existingThumb) {
            finalPreviewUrl = existingThumb.browser_download_url
          } else {
            const thumbRes = await fetch(row.preview_url)
            if (thumbRes.ok) {
              const thumbBuf = Buffer.from(await thumbRes.arrayBuffer())
              const thumbUpUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(rawThumbName)}`
              const thumbUpRes = await fetch(thumbUpUrl, {
                method: 'POST',
                headers: {
                  Authorization: `token ${GITHUB_TOKEN}`,
                  'Content-Type': 'image/jpeg',
                  'User-Agent': 'AetherFlow-Server-Archiver',
                  Accept: 'application/vnd.github.v3+json',
                },
                body: thumbBuf,
              })
              if (thumbUpRes.ok) {
                const thumbData = await thumbUpRes.json()
                finalPreviewUrl = thumbData.browser_download_url
              }
            }
          }
        } catch (tErr) {
          console.warn('Thumb archive notice:', tErr.message)
        }
      }

      // Update Supabase row with GitHub Release CDN URLs
      console.log(`Updating Supabase record ${row.id} with GitHub Releases CDN URL...`)
      await supabase
        .from('submissions')
        .update({
          source: finalDownloadUrl,
          github_asset_url: finalDownloadUrl,
          preview_url: finalPreviewUrl,
        })
        .eq('id', row.id)

      // Purge media from Supabase Storage to restore 0 MB free-tier storage
      console.log(`Purging temporary file from Supabase Storage: public/${rawAssetName}`)
      const { error: remErr } = await supabase.storage
        .from('community-uploads')
        .remove([`public/${rawAssetName}`])

      if (remErr) {
        console.warn('Storage purge notice:', remErr.message)
      }

      archivedCount++
      console.log(`Successfully archived ${row.id} to GitHub Releases!`)
    } catch (rowErr) {
      console.error(`Error processing row ${row.id}:`, rowErr)
    }
  }

  // 3. Sync index.json with active catalog & takedowns
  const indexPath = fs.existsSync(path.join(process.cwd(), 'index.json'))
    ? path.join(process.cwd(), 'index.json')
    : (fs.existsSync(path.join(__dirname, '..', 'index.json'))
        ? path.join(__dirname, '..', 'index.json')
        : path.join(__dirname, '..', '..', 'index.json'))
  let indexData = { version: 4, updatedAt: new Date().toISOString(), wallpapers: [] }

  if (fs.existsSync(indexPath)) {
    try {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    } catch {}
  }

  // Fetch active takedowns
  const takedowns = new Set()
  try {
    const { data: tdRows } = await supabase.from('community_takedowns').select('wallpaper_id')
    if (Array.isArray(tdRows)) {
      tdRows.forEach(r => takedowns.add(String(r.wallpaper_id)))
    }
  } catch {}

  // Filter indexData wallpapers
  const existingMap = new Map()
  for (const w of indexData.wallpapers || []) {
    if (!takedowns.has(String(w.id))) {
      existingMap.set(String(w.id), w)
    }
  }

  // Merge in active Supabase wallpapers
  for (const r of rows || []) {
    if (takedowns.has(String(r.id))) continue
    existingMap.set(String(r.id), {
      id: String(r.id),
      name: r.title || 'Untitled Wallpaper',
      title: r.title || 'Untitled Wallpaper',
      description: r.description || '',
      author: r.author_name || 'Community Contributor',
      authorPortfolio: r.author_portfolio || '',
      license: r.license || 'CC BY-NC-ND 4.0',
      type: r.type,
      source: r.source,
      preview: r.preview_url || '',
      tags: r.tags || ['community'],
      downloads: r.downloads_count || 0,
      likes: r.likes_count || 0,
      createdAt: r.created_at,
    })
  }

  indexData.wallpapers = Array.from(existingMap.values())
  indexData.updatedAt = new Date().toISOString()

  fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2) + '\n', 'utf8')
  console.log(`Updated index.json with ${indexData.wallpapers.length} total wallpapers.`)
  console.log(`\nArchival complete. Archived ${archivedCount} media files from Supabase staging to GitHub Releases CDN.`)
}

run().catch(err => {
  console.error('Fatal archival runner error:', err)
  process.exit(1)
})
