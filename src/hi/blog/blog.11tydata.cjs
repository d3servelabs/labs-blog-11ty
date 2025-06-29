module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => {
      // 从 filePathStem 中提取 blog 目录后的相对路径
      // 例如: /hi/blog/tutorials/basic -> tutorials/basic
      const pathStem = data.page.filePathStem
      const blogPath = pathStem.replace(/^\/hi\/blog\//, '')
      return `/og/hi/blog/${blogPath}.png`
    }
  }
} 