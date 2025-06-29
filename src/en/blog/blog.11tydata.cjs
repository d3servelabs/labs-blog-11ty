module.exports = {
  eleventyComputed: {
    "meta.ogImage": data => `/og/en/blog/${data.page.fileSlug}.png`
  }
} 