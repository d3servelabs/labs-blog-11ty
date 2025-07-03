export default {
  meta: {
    ogImage: function(data) {
      const pathStem = data.page.filePathStem;
      
      // Extract language and content path from filePathStem
      // Examples:
      // /en/blog/some-post -> /og/en/blog/some-post.png
      // /en/tld/com -> /og/en/tld/com.png
      // /en/glossary/nft -> /og/en/glossary/nft.png
      // /en/partners/blockeden -> /og/en/partners/blockeden.png
      const match = pathStem.match(/^\/([a-z]{2})\/(.+)$/);
      if (match) {
        const [, lang, path] = match;
        return `/og/${lang}/${path}.png`;
      }
      
      // Fallback for unexpected paths or homepage
      return `/opengraph.jpg`;
    }
  }
};