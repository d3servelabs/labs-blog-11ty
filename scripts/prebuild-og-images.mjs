#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname, basename, extname } from 'path'
import matter from 'gray-matter'
import { Command } from 'commander'
import {
  initializeCache,
  shouldRegenerate,
  updateCacheEntry,
  getDependenciesHash,
  cleanCache,
  displayCacheStats,
  cleanStaleEntries
} from './cache-utils.mjs'

const projectRoot = dirname(new URL(import.meta.url).pathname)
const outputDir = join(projectRoot, '..', 'public', 'og')
const logoPath = join(projectRoot, '..', 'Namefi.png')
const logoBase64 = readFileSync(logoPath).toString('base64')
const logoDataUrl = `data:image/png;base64,${logoBase64}`

// Script version for cache invalidation
const SCRIPT_VERSION = '2.0.0'

// Concurrency limit - adjust based on your system's capability
const CONCURRENCY_LIMIT = 50

// Language configurations
const languageConfigs = {
  ar: {
    fontUrl: 'https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@700&display=swap',
    fontFamily: 'Noto Naskh Arabic, system-ui, sans-serif',
    isRTL: true,
  },
  fa: {
    fontUrl: 'https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@700&display=swap',
    fontFamily: 'Noto Naskh Arabic, system-ui, sans-serif',
    isRTL: true,
  },
  he: {
    fontUrl: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Hebrew:wght@700&display=swap',
    fontFamily: 'Noto Sans Hebrew, system-ui, sans-serif',
    isRTL: true,
  },
  default: {
    fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@800&display=swap',
    fontFamily: 'Inter, Segoe UI, system-ui, sans-serif',
    isRTL: false,
  }
}

// 递归函数：遍历目录下的所有 .md 文件
function getAllMarkdownFiles(dirPath, basePath = '') {
  const files = []
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch (e) {
    return files
  }
  
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    const relativePath = basePath ? join(basePath, entry.name) : entry.name
    
    if (entry.isDirectory()) {
      // 递归处理子目录
      files.push(...getAllMarkdownFiles(fullPath, relativePath))
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push({
        fullPath,
        relativePath
      })
    }
  }
  return files
}

async function generateOGWithPuppeteer(browser, title, lang, contentType, relativePathWithoutExt, sourceFilePath) {
  const startTime = Date.now()
  const config = languageConfigs[lang] || languageConfigs.default
  const { fontUrl, fontFamily, isRTL } = config
  
  const outDir = join(outputDir, lang, contentType, dirname(relativePathWithoutExt))
  mkdirSync(outDir, { recursive: true })
  const outBase = join(outDir, basename(relativePathWithoutExt))

  const html = `
    <html lang="${lang}">
      <head>
        <meta charset="utf-8" />
        <link href="${fontUrl}" rel="stylesheet" />
        <style>
          body {
            margin: 0;
            padding: 0;
            width: 1200px;
            height: 630px;
            display: flex;
            flex-direction: column;
            align-items: ${isRTL ? 'flex-end' : 'flex-start'};
            justify-content: space-between;
            padding: 80px;
            font-family: ${fontFamily};
            /* background: radial-gradient(ellipse 120% 120% at 30% 70%, #0f3d2e 0%, #000 100%); */
            background-color: #0f3d2e;
            direction: ${isRTL ? 'rtl' : 'ltr'};
            box-sizing: border-box;
            position: relative;
          }
          .title {
            font-size: 72px;
            font-weight: 800;
            color: #fff;
            line-height: 1.1;
            margin-bottom: auto;
            max-width: 85%;
            word-wrap: break-word;
            text-shadow: 0 2px 20px rgba(0,0,0,0.5);
            letter-spacing: ${isRTL ? '0' : '-0.02em'};
            text-align: ${isRTL ? 'right' : 'left'};
            direction: ${isRTL ? 'rtl' : 'ltr'};
          }
          .footer {
            display: flex;
            align-items: center;
            justify-content: ${isRTL ? 'flex-start' : 'flex-end'};
            width: 100%;
          }
          .logo {
            height: 80px;
            display: block;
          }
        </style>
      </head>
      <body>
        <div class="title">${title}</div>
        <div class="footer">
          <img class="logo" src="${logoDataUrl}" />
        </div>
      </body>
    </html>
  `

  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'networkidle0' })
    // Wait for font to load
    await page.evaluate(async () => { await document.fonts.ready })

    // PNG
    await page.screenshot({ path: outBase + '.png', type: 'png', })
    // JPG
    await page.screenshot({ path: outBase + '.jpg', type: 'jpeg', quality: 66 })

    // Update cache
    const outputs = [outBase + '.png', outBase + '.jpg']
    const dependenciesHash = getDependenciesHash([logoPath], SCRIPT_VERSION)
    updateCacheEntry(sourceFilePath, 'ogImages', outputs, dependenciesHash)
    
    const elapsed = Date.now() - startTime
    console.log(`✅ Generated: ${lang}/${contentType}/${relativePathWithoutExt}.png and .jpg (${title}) [${elapsed}ms]`)
    
    return { outputs, elapsed }
  } finally {
    await page.close()
  }
}

// Concurrent processing with limited concurrency
async function processConcurrently(tasks, concurrencyLimit) {
  const results = []
  const executing = []

  for (const task of tasks) {
    const promise = task().then(result => {
      executing.splice(executing.indexOf(promise), 1)
      return result
    })
    
    results.push(promise)
    executing.push(promise)

    if (executing.length >= concurrencyLimit) {
      await Promise.race(executing)
    }
  }

  return Promise.all(results)
}

// 处理所有语言下所有内容类型目录的所有 .md 文件（包括子目录）
const languages = ['en', 'zh', 'ar', 'de', 'es', 'fr', 'hi', 'fa']
const contentTypes = ['blog', 'tld', 'glossary', 'partners']

async function main(options = {}) {
  const scriptStartTime = Date.now()
  
  // Initialize cache system
  initializeCache()
  
  // Handle cache management commands
  if (options.cleanCache) {
    cleanCache()
    return
  }
  
  if (options.cacheStats) {
    displayCacheStats()
    return
  }
  
  // Clean stale entries
  cleanStaleEntries()
  console.log('🚀 Starting Puppeteer browser...')
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--font-render-hinting=none', '--no-sandbox', '--disable-setuid-sandbox'] 
  })

  try {
    // Collect all tasks first
    const allTasks = []
    let totalFiles = 0
    let skippedFiles = 0
    let totalProcessingTime = 0
    
    // Calculate dependencies hash once
    const dependenciesHash = getDependenciesHash([logoPath], SCRIPT_VERSION)

    for (const lang of languages) {
      for (const contentType of contentTypes) {
        const contentDir = join(projectRoot, '..', 'src', lang, contentType)
        let markdownFiles
        try {
          markdownFiles = getAllMarkdownFiles(contentDir)
        } catch (e) {
          console.warn(`No ${contentType} dir for language: ${lang}`)
          continue
        }
        
        console.log(`Found ${markdownFiles.length} markdown files in ${lang}/${contentType}/`)
        totalFiles += markdownFiles.length
        
        for (const fileInfo of markdownFiles) {
          const raw = readFileSync(fileInfo.fullPath, 'utf-8')
          const { data } = matter(raw)
          const title = data.title || 'Untitled'
          const relativePathWithoutExt = fileInfo.relativePath.replace(/\.md$/, '')
          
          // Check if generation is needed
          if (!options.skipCache && !shouldRegenerate(fileInfo.fullPath, 'ogImages', dependenciesHash)) {
            console.log(`⏭️  Skipping: ${lang}/${contentType}/${relativePathWithoutExt} (unchanged)`)
            skippedFiles++
            continue
          }
          
          // Create a task function for this file
          allTasks.push(async () => {
            try {
              await generateOGWithPuppeteer(browser, title, lang, contentType, relativePathWithoutExt, fileInfo.fullPath)
            } catch (e) {
              console.error(`❌ Failed: ${lang}/${contentType}/${relativePathWithoutExt}.png/.jpg (${title})`)
              console.error(`   Reason: ${e.message}`)
            }
          })
        }
      }
    }

    if (allTasks.length === 0) {
      console.log(`🎉 All files up to date! (${skippedFiles} files skipped)`)
      return
    }
    
    console.log(`🔄 Processing ${allTasks.length}/${totalFiles} files (${skippedFiles} skipped) with concurrency limit of ${CONCURRENCY_LIMIT}...`)
    
    // Process all tasks concurrently with limit
    await processConcurrently(allTasks, CONCURRENCY_LIMIT)
    
    const scriptEndTime = Date.now()
    const totalScriptTime = scriptEndTime - scriptStartTime
    
    console.log(`\n📊 Generation Summary:`)
    console.log(`   Files processed: ${allTasks.length}`)
    console.log(`   Files skipped: ${skippedFiles}`)
    console.log(`   Total files: ${totalFiles}`)
    console.log(`⏱️  Processing time: ${totalProcessingTime}ms`)
    console.log(`⏱️  Total script time: ${totalScriptTime}ms`)

  } finally {
    console.log('🔒 Closing browser...')
    await browser.close()
  }
  
  console.log('🎉 Puppeteer OG images generated!')
}

// Command line interface
const program = new Command()

program
  .name('prebuild-og-images')
  .description('Generate Open Graph images for blog posts with intelligent caching')
  .version('2.0.0')
  .option('--skip-cache', 'Bypass cache and regenerate all images')
  .option('--clean-cache', 'Clean the cache and exit')
  .option('--cache-stats', 'Display cache statistics and exit')
  .action(async (options) => {
    await main(options)
  })

// If called directly (not imported), run the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse(process.argv)
} 