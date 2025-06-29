module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => {
      // 从 filePathStem 中提取 blog 目录后的相对路径
      // 例如: /fr/blog/tutorials/basic -> tutorials/basic
      const pathStem = data.page.filePathStem
      const blogPath = pathStem.replace(/^\/fr\/blog\//, '')
      return `/og/fr/blog/${blogPath}.png`
    }
  }
} 