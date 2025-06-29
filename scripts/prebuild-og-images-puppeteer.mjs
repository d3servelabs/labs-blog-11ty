#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import matter from 'gray-matter'

const projectRoot = dirname(new URL(import.meta.url).pathname)
const outputDir = join(projectRoot, '..', 'public', 'og-puppeteer')
const logoPath = join(projectRoot, '..', 'Namefi.png')
const logoBase64 = readFileSync(logoPath).toString('base64')
const logoDataUrl = `data:image/png;base64,${logoBase64}`

const files = [
  {
    lang: 'ar',
    path: join(projectRoot, '..', 'src', 'ar', 'blog', 'domain-terminology-guide.md'),
    fontUrl: 'https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@700&display=swap',
    fontFamily: 'Noto Naskh Arabic, system-ui, sans-serif',
    isRTL: true,
  },
  {
    lang: 'en',
    path: join(projectRoot, '..', 'src', 'en', 'blog', 'domain-terminology-guide.md'),
    fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@800&display=swap',
    fontFamily: 'Inter, Segoe UI, system-ui, sans-serif',
    isRTL: false,
  },
]

async function generateOGWithPuppeteer({ lang, path, fontUrl, fontFamily, isRTL }) {
  const raw = readFileSync(path, 'utf-8')
  const { data } = matter(raw)
  const title = data.title || 'Untitled'
  const outDir = join(outputDir, lang, 'blog')
  mkdirSync(outDir, { recursive: true })
  const outBase = join(outDir, 'domain-terminology-guide')

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
  console.log(`Generated: ${outBase}.png and .jpg (${lang})`)
}

async function main() {
  for (const file of files) {
    await generateOGWithPuppeteer(file)
  }
  console.log('🎉 Puppeteer OG images generated!')
}

main() 