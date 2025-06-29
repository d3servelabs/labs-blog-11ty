#!/usr/bin/env node

import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, extname, basename } from 'path'
import matter from 'gray-matter'
import { fileURLToPath } from 'url'

// 用于生成图片的 ImageResponse（需安装 @vercel/og）
import { ImageResponse } from '@vercel/og'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const outputDir = join(projectRoot, 'dist', 'og')

// 读取 Namefi.png 并转为 base64 DataURL
const logoPath = join(projectRoot, 'Namefi.png')
const logoBuffer = readFileSync(logoPath)
const logoBase64 = logoBuffer.toString('base64')
const logoDataUrl = `data:image/png;base64,${logoBase64}`

// OG image 生成组件，logo 用 Namefi.png
function generateOGImageJSX(title) {
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '80px',
        fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
        position: 'relative',
        background: 'radial-gradient(ellipse 120% 120% at 30% 70%, #0f3d2e 0%, #000000 100%)',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              fontSize: 72,
              fontWeight: 800,
              color: '#ffffff',
              lineHeight: 1.1,
              marginBottom: 'auto',
              maxWidth: '85%',
              wordWrap: 'break-word',
              textShadow: '0 2px 20px rgba(0, 0, 0, 0.5)',
              letterSpacing: '-0.02em',
            },
            children: title,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              width: '100%',
            },
            children: [
              {
                type: 'img',
                props: {
                  src: logoDataUrl,
                  style: {
                    height: '80px',
                    display: 'block'
                  }
                }
              }
            ],
          },
        },
      ],
    },
  }
}

async function generateOGImage(title, language) {
  try {
    const jsx = generateOGImageJSX(title)
    const imageResponse = new ImageResponse(jsx, {
      width: 1200,
      height: 630,
    })
    const arrayBuffer = await imageResponse.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error(`Error generating OG image for "${title}" (${language}):`, error)
    throw error
  }
}

// 只处理 en 和 zh 下 blog 目录的前两篇文章
const languages = ['en', 'zh']

async function main() {
  for (const lang of languages) {
    const blogDir = join(projectRoot, 'src', lang, 'blog')
    let files
    try {
      files = readdirSync(blogDir).filter(f => extname(f) === '.md')
    } catch (e) {
      console.warn(`No blog dir for language: ${lang}`)
      continue
    }
    // 只取前两篇
    for (const file of files) {
      const filePath = join(blogDir, file)
      const raw = readFileSync(filePath, 'utf-8')
      const { data } = matter(raw)
      const title = data.title || 'Untitled'
      const slug = basename(file, '.md')
      const outDir = join(outputDir, lang, 'blog')
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, `${slug}.png`)
      try {
        const imageBuffer = await generateOGImage(title, lang)
        writeFileSync(outPath, imageBuffer)
        console.log(`✅ Generated: ${lang}/blog/${slug}.png (${title})`)
      } catch (e) {
        console.error(`❌ Failed: ${lang}/blog/${slug}.png (${title})`, e.message)
      }
    }
  }
  console.log('🎉 Done!')
}

main() 