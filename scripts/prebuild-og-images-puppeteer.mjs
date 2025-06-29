#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname, basename, extname } from 'path'
import matter from 'gray-matter'

const projectRoot = dirname(new URL(import.meta.url).pathname)
const outputDir = join(projectRoot, '..', 'public', 'og')
const logoPath = join(projectRoot, '..', 'Namefi.png')
const logoBase64 = readFileSync(logoPath).toString('base64')
const logoDataUrl = `data:image/png;base64,${logoBase64}`

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

async function generateOGWithPuppeteer(title, lang, relativePathWithoutExt) {
  const config = languageConfigs[lang] || languageConfigs.default
  const { fontUrl, fontFamily, isRTL } = config
  
  const outDir = join(outputDir, lang, 'blog', dirname(relativePathWithoutExt))
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

  const browser = await puppeteer.launch({ headless: 'new', args: ['--font-render-hinting=none'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle0' })
  // Wait for font to load
  await page.evaluate(async () => { await document.fonts.ready })

  // PNG
  await page.screenshot({ path: outBase + '.png', type: 'png', })
  // JPG
  await page.screenshot({ path: outBase + '.jpg', type: 'jpeg', quality: 66 })

  await browser.close()
  console.log(`✅ Generated: ${lang}/blog/${relativePathWithoutExt}.png and .jpg (${title})`)
}

// 处理所有语言下 blog 目录的所有 .md 文件（包括子目录）
const languages = ['en', 'zh', 'ar', 'de', 'es', 'fr', 'hi', 'fa']

async function main() {
  for (const lang of languages) {
    const blogDir = join(projectRoot, '..', 'src', lang, 'blog')
    let markdownFiles
    try {
      markdownFiles = getAllMarkdownFiles(blogDir)
    } catch (e) {
      console.warn(`No blog dir for language: ${lang}`)
      continue
    }
    
    console.log(`Found ${markdownFiles.length} markdown files in ${lang}/blog/`)
    
    for (const fileInfo of markdownFiles) {
      const raw = readFileSync(fileInfo.fullPath, 'utf-8')
      const { data } = matter(raw)
      const title = data.title || 'Untitled'
      
      // 获取相对路径（不包含文件扩展名）用于输出路径
      const relativePathWithoutExt = fileInfo.relativePath.replace(/\.md$/, '')
      
      try {
        await generateOGWithPuppeteer(title, lang, relativePathWithoutExt)
      } catch (e) {
        console.error(`❌ Failed: ${lang}/blog/${relativePathWithoutExt}.png/.jpg (${title})`)
        console.error(`   Reason: ${e.message}`)
      }
    }
  }
  console.log('🎉 Puppeteer OG images generated!')
}

main() 