#!/usr/bin/env node

import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, extname, basename } from 'path'
import matter from 'gray-matter'
import { fileURLToPath } from 'url'

// 用于生成图片的 ImageResponse（需安装 @vercel/og）
import { ImageResponse } from '@vercel/og'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const outputDir = join(projectRoot, 'public', 'og')

// 读取 Namefi.png 并转为 base64 DataURL
const logoPath = join(projectRoot, 'Namefi.png')
const logoBuffer = readFileSync(logoPath)
const logoBase64 = logoBuffer.toString('base64')
const logoDataUrl = `data:image/png;base64,${logoBase64}`

// OG image 生成组件，logo 用 Namefi.png
function generateOGImageJSX(title, language) {
  // RTL 语言列表
  const rtlLanguages = ['ar', 'fa', 'he']
  const isRTL = rtlLanguages.includes(language)
  
  // 为 RTL 语言使用简化的字体配置
  const fontFamily = isRTL 
    ? 'system-ui, -apple-system, sans-serif'
    : 'Inter, "Segoe UI", system-ui, sans-serif'
  
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isRTL ? 'flex-end' : 'flex-start',
        justifyContent: 'space-between',
        padding: '80px',
        fontFamily: fontFamily,
        position: 'relative',
        background: 'radial-gradient(ellipse 120% 120% at 30% 70%, #0f3d2e 0%, #000000 100%)',
        direction: isRTL ? 'rtl' : 'ltr',
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
              letterSpacing: isRTL ? '0' : '-0.02em',
              textAlign: isRTL ? 'right' : 'left',
              direction: isRTL ? 'rtl' : 'ltr',
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
              justifyContent: isRTL ? 'flex-start' : 'flex-end',
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

// 简化版本的 OG 图片生成（用于复杂文字系统的后备方案）
function generateSimpleOGImageJSX(title, language) {
  return {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        position: 'relative',
        background: 'radial-gradient(ellipse 120% 120% at 30% 70%, #0f3d2e 0%, #000000 100%)',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              fontSize: 48,
              fontWeight: 700,
              color: '#ffffff',
              lineHeight: 1.2,
              textAlign: 'center',
              maxWidth: '90%',
              marginBottom: '40px',
              textShadow: '0 2px 20px rgba(0, 0, 0, 0.5)',
            },
            children: 'Namefi Blog',
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: 24,
              color: '#cccccc',
              textAlign: 'center',
              maxWidth: '80%',
            },
            children: `Content in ${language.toUpperCase()}`,
          },
        },
        {
          type: 'img',
          props: {
            src: logoDataUrl,
            style: {
              height: '60px',
              marginTop: '40px',
              display: 'block'
            }
          }
        }
      ],
    },
  }
}

async function generateOGImage(title, language) {
  try {
    const jsx = generateOGImageJSX(title, language)
    const imageResponse = new ImageResponse(jsx, {
      width: 1200,
      height: 630,
    })
    const arrayBuffer = await imageResponse.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    // 对于复杂文字系统，尝试使用简化版本
    if (['ar', 'fa'].includes(language) && error.message.includes('lookupType')) {
      console.warn(`⚠️  Using simplified OG image for ${language} due to text rendering limitations`)
      try {
        const simpleJsx = generateSimpleOGImageJSX(title, language)
        const imageResponse = new ImageResponse(simpleJsx, {
          width: 1200,
          height: 630,
        })
        const arrayBuffer = await imageResponse.arrayBuffer()
        return Buffer.from(arrayBuffer)
      } catch (fallbackError) {
        console.error(`Fallback also failed for "${title}" (${language}):`, fallbackError)
        throw fallbackError
      }
    }
    console.error(`Error generating OG image for "${title}" (${language}):`, error)
    throw error
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

// 处理所有语言下 blog 目录的所有 .md 文件（包括子目录）
const languages = ['en', 'zh', 'ar', 'de', 'es', 'fr', 'hi', 'fa']

async function main() {
  for (const lang of languages) {
    const blogDir = join(projectRoot, 'src', lang, 'blog')
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
      const outDir = join(outputDir, lang, 'blog', dirname(relativePathWithoutExt))
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, `${basename(relativePathWithoutExt)}.png`)
      
      try {
        const imageBuffer = await generateOGImage(title, lang)
        writeFileSync(outPath, imageBuffer)
        console.log(`✅ Generated: ${lang}/blog/${relativePathWithoutExt}.png (${title})`)
      } catch (e) {
        console.error(`❌ Failed: ${lang}/blog/${relativePathWithoutExt}.png (${title})`)
        console.error(`   Reason: ${e.message}`)
        
        // 对于RTL语言的字体问题，提供额外说明
        if (['ar', 'fa'].includes(lang) && e.message.includes('lookupType')) {
          console.error(`   Note: ${lang} language has complex text rendering requirements that may not be fully supported.`)
        }
      }
    }
  }
  console.log('🎉 Done!')
}

main() 