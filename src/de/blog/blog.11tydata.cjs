module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => {
      // 从 filePathStem 中提取 blog 目录后的相对路径
      // 例如: /de/blog/tutorials/basic -> tutorials/basic
      const pathStem = data.page.filePathStem
      const blogPath = pathStem.replace(/^\/de\/blog\//, '')
      return `/og/de/blog/${blogPath}.png`
    }
  }
} 