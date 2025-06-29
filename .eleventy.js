import {EleventyI18nPlugin} from '@11ty/eleventy';

export default async function (eleventyConfig) {
  eleventyConfig.addPlugin(EleventyI18nPlugin, {
    defaultLanguage: 'en', // Required
    errorMode: 'allow-fallback' // Opting out of "strict"
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
    pathPrefix: '/b/'
  };
}
