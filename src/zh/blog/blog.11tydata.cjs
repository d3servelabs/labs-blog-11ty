module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => `/og/zh/blog/${data.page.fileSlug}.png`
  }
} 