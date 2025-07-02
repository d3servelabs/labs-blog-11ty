import {EleventyI18nPlugin} from '@11ty/eleventy';

export default async function (eleventyConfig) {
  eleventyConfig.addPlugin(EleventyI18nPlugin, {
    defaultLanguage: 'en', // Required
    errorMode: 'allow-fallback' // Opting out of "strict"
  });

  // Blog collections (excluding moved directories)
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

  // TLD collections
  eleventyConfig.addCollection('tld_en', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/en/tld/**/*.md');
  });
  eleventyConfig.addCollection('tld_ar', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/ar/tld/**/*.md');
  });
  eleventyConfig.addCollection('tld_de', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/de/tld/**/*.md');
  });
  eleventyConfig.addCollection('tld_es', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/es/tld/**/*.md');
  });
  eleventyConfig.addCollection('tld_fr', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/fr/tld/**/*.md');
  });
  eleventyConfig.addCollection('tld_hi', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/hi/tld/**/*.md');
  });
  eleventyConfig.addCollection('tld_zh', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/zh/tld/**/*.md');
  });

  // Glossary collections
  eleventyConfig.addCollection('glossary_en', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/en/glossary/**/*.md');
  });
  eleventyConfig.addCollection('glossary_ar', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/ar/glossary/**/*.md');
  });
  eleventyConfig.addCollection('glossary_de', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/de/glossary/**/*.md');
  });
  eleventyConfig.addCollection('glossary_es', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/es/glossary/**/*.md');
  });
  eleventyConfig.addCollection('glossary_fr', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/fr/glossary/**/*.md');
  });
  eleventyConfig.addCollection('glossary_hi', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/hi/glossary/**/*.md');
  });
  eleventyConfig.addCollection('glossary_zh', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/zh/glossary/**/*.md');
  });

  // Partners collections
  eleventyConfig.addCollection('partners_en', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/en/partners/**/*.md');
  });
  eleventyConfig.addCollection('partners_ar', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/ar/partners/**/*.md');
  });
  eleventyConfig.addCollection('partners_de', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/de/partners/**/*.md');
  });
  eleventyConfig.addCollection('partners_es', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/es/partners/**/*.md');
  });
  eleventyConfig.addCollection('partners_fr', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/fr/partners/**/*.md');
  });
  eleventyConfig.addCollection('partners_hi', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/hi/partners/**/*.md');
  });
  eleventyConfig.addCollection('partners_zh', function(collectionApi) {
    return collectionApi.getFilteredByGlob('src/zh/partners/**/*.md');
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
