import {EleventyI18nPlugin} from '@11ty/eleventy';

export default async function (eleventyConfig) {
  eleventyConfig.addPlugin(EleventyI18nPlugin, {
    defaultLanguage: 'en', // Required
    errorMode: 'allow-fallback' // Opting out of "strict"
  });

  eleventyConfig.addCollection('blog_en', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/en/blog/**/*.md');
  });
  eleventyConfig.addCollection('blog_ar', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/ar/blog/**/*.md');
  });
  eleventyConfig.addCollection('blog_de', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/de/blog/**/*.md');
  });
  eleventyConfig.addCollection('blog_es', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/es/blog/**/*.md');
  });
  eleventyConfig.addCollection('blog_fr', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/fr/blog/**/*.md');
  });
  eleventyConfig.addCollection('blog_hi', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/hi/blog/**/*.md');
  });
  eleventyConfig.addCollection('blog_zh', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/zh/blog/**/*.md');
  });

  // Copy individual files that should be in the output
  eleventyConfig.addPassthroughCopy('src/favicon.ico');
  eleventyConfig.addPassthroughCopy('src/opengraph.jpg');

  // Always copy public directory for static assets like OG images
  eleventyConfig.addPassthroughCopy({
    'public': '.'
  });

  // Configure dev server to also serve static files from public directory
  eleventyConfig.setServerOptions({
    // Serve additional directories during development
    additional: ["./public"],
    port: process.env.PORT ? Number(process.env.PORT) : 8080
  });

  return {
    dir: {
      input: 'src',
      output: 'dist'
    },
    markdownTemplateEngine: 'njk',
    htmlTemplateEngine: 'njk',
    pathPrefix: '/r/'
  };
}
