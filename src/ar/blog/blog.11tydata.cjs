module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => {
      // 从 filePathStem 中提取 blog 目录后的相对路径
      // 例如: /ar/blog/tutorials/basic -> tutorials/basic
      const pathStem = data.page.filePathStem
      const blogPath = pathStem.replace(/^\/ar\/blog\//, '')
      return `/og/ar/blog/${blogPath}.png`
    }
  }
} 