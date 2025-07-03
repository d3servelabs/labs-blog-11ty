import { promises as fs } from 'fs';
import matter from 'gray-matter';
import pLimit from 'p-limit';
import { CONTENT_TYPE_TOKENS } from './config.mjs';

// Term extraction utilities
export class TermExtractor {
  static extractGlossaryTerms(content) {
    // Extract terms from {{ '/en/glossary/term-name/' | url }} format
    const termRegex = /\{\{\s*['"][^'"]*\/glossary\/([^/]+)\/['"]\s*\|\s*url\s*\}\}/g;
    const terms = new Set();
    let match;
    
    while ((match = termRegex.exec(content)) !== null) {
      terms.add(match[1]); // Extract the term slug
    }
    
    return Array.from(terms);
  }
  
  static extractLocalizedURLs(content) {
    // Extract all localized URLs with language codes
    // Pattern: {{ '/en/path/to/content/' | url }} or {{ "/en/path/to/content/" | url }}
    const urlRegex = /\{\{\s*['"]\/([a-z]{2})\/([^'"]*)['"]\s*\|\s*url\s*\}\}/g;
    const urls = [];
    let match;
    
    while ((match = urlRegex.exec(content)) !== null) {
      urls.push({
        fullMatch: match[0],
        language: match[1],
        path: match[2],
        startIndex: match.index,
        endIndex: match.index + match[0].length
      });
    }
    
    return urls;
  }
}

// Term mapping utilities
export class TermMapper {
  static async loadTermMappings(sourceTerms, sourceLang, targetLang) {
    const mappings = {
      existing: {},
      missing: []
    };
    
    for (const termSlug of sourceTerms) {
      try {
        // Check if source term exists
        const sourcePath = `src/${sourceLang}/glossary/${termSlug}.md`;
        const targetPath = `src/${targetLang}/glossary/${termSlug}.md`;
        
        // Read source term
        const sourceContent = await fs.readFile(sourcePath, 'utf8');
        const sourceData = matter(sourceContent);
        
        try {
          // Try to read target term
          const targetContent = await fs.readFile(targetPath, 'utf8');
          const targetData = matter(targetContent);
          
          mappings.existing[sourceData.data.title || termSlug] = {
            target: targetData.data.title,
            slug: termSlug,
            sourceTitle: sourceData.data.title
          };
        } catch (error) {
          // Target term doesn't exist
          mappings.missing.push({
            slug: termSlug,
            sourceTitle: sourceData.data.title || termSlug
          });
        }
      } catch (error) {
        console.warn(`⚠️  Warning: Source term not found: ${termSlug}`);
      }
    }
    
    return mappings;
  }
  
  static generateTermConstraints(mappings, sourceLang, targetLang) {
    const constraints = [];
    
    if (Object.keys(mappings.existing).length > 0) {
      constraints.push('\n**CRITICAL TERMINOLOGY REQUIREMENTS:**');
      constraints.push('The following terms MUST use these exact translations:');
      
      for (const [sourceTitle, mapping] of Object.entries(mappings.existing)) {
        constraints.push(`- "${sourceTitle}" → "${mapping.target}"`);
      }
    }
    
    if (mappings.missing.length > 0) {
      constraints.push('\n**CONSISTENCY REQUIREMENTS:**');
      constraints.push('The following terms are not yet translated. Please translate them and use consistently throughout:');
      
      for (const missing of mappings.missing) {
        constraints.push(`- "${missing.sourceTitle}" (maintain consistency in translation)`);
      }
    }
    
    return constraints.join('\n');
  }
}

// URL localization utilities
export class URLLocalizer {
  static localizeURLs(content, targetLang, sourceLang = 'en') {
    if (!content || typeof content !== 'string') return content;
    if (targetLang === sourceLang) return content;
    
    // Extract all localized URLs
    const urls = TermExtractor.extractLocalizedURLs(content);
    
    if (urls.length === 0) return content;
    
    console.log(`🔗 Found ${urls.length} localized URLs to update`);
    
    // Process URLs from end to start to maintain string indices
    let localizedContent = content;
    const sortedUrls = urls.sort((a, b) => b.startIndex - a.startIndex);
    
    for (const url of sortedUrls) {
      if (url.language === sourceLang) {
        // Replace source language with target language
        const newUrl = url.fullMatch.replace(
          `'/${sourceLang}/`,
          `'/${targetLang}/`
        ).replace(
          `"/${sourceLang}/`,
          `"/${targetLang}/`
        );
        
        localizedContent = localizedContent.slice(0, url.startIndex) + 
                          newUrl + 
                          localizedContent.slice(url.endIndex);
        
        console.log(`  ✅ ${url.language}/${url.path} → ${targetLang}/${url.path}`);
      }
    }
    
    return localizedContent;
  }
  
  static analyzeURLs(content) {
    const urls = TermExtractor.extractLocalizedURLs(content);
    const analysis = {
      total: urls.length,
      byLanguage: {},
      paths: []
    };
    
    urls.forEach(url => {
      if (!analysis.byLanguage[url.language]) {
        analysis.byLanguage[url.language] = 0;
      }
      analysis.byLanguage[url.language]++;
      analysis.paths.push(`${url.language}/${url.path}`);
    });
    
    return analysis;
  }
}

// Token estimation utilities
export class TokenEstimator {
  static estimateTokens(text, contentType = 'general') {
    if (!text || typeof text !== 'string') return 0;
    
    // Rough token estimation: ~4 characters per token for English
    // Add buffer for markdown formatting and multilingual content
    const charCount = text.length;
    const baseTokens = Math.ceil(charCount / 3.5); // Conservative estimate
    
    // Content type adjustments
    const typeMultiplier = {
      'glossary': 1.0,   // Simple definitions
      'tld': 1.1,        // Structured content
      'partners': 1.1,   // Business content
      'blog': 1.2,       // Complex articles
      'general': 1.15
    };
    
    return Math.ceil(baseTokens * (typeMultiplier[contentType] || 1.15));
  }
  
  static async estimateTokensFromFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const contentType = this.getContentTypeFromPath(filePath);
      return this.estimateTokens(content, contentType);
    } catch (error) {
      console.warn(`⚠️ Could not read ${filePath} for token estimation, using default`);
      const contentType = this.getContentTypeFromPath(filePath);
      return this.getExpectedTokens(contentType);
    }
  }
  
  static async estimateTokensFromFiles(filePaths) {
    const results = {};
    
    // Process files in parallel for better performance
    const limit = pLimit(10); // Limit concurrent file reads
    
    const promises = filePaths.map(filePath => 
      limit(async () => {
        const tokens = await this.estimateTokensFromFile(filePath);
        results[filePath] = tokens;
        return { filePath, tokens };
      })
    );
    
    await Promise.all(promises);
    return results;
  }
  
  static getContentTypeFromPath(filePath) {
    if (filePath.includes('/blog/')) return 'blog';
    if (filePath.includes('/tld/')) return 'tld';
    if (filePath.includes('/glossary/')) return 'glossary';
    if (filePath.includes('/partners/')) return 'partners';
    return 'general';
  }
  
  static getExpectedTokens(contentType) {
    return CONTENT_TYPE_TOKENS[contentType] || CONTENT_TYPE_TOKENS.general;
  }
}