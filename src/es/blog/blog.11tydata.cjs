module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => {
      // 从 filePathStem 中提取 blog 目录后的相对路径
      // 例如: /es/blog/tutorials/basic -> tutorials/basic
      const pathStem = data.page.filePathStem
      const blogPath = pathStem.replace(/^\/es\/blog\//, '')
      return `/og/es/blog/${blogPath}.png`
    }
  }
} 