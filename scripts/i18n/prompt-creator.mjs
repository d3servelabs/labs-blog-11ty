import { LANGUAGE_NAMES } from './config.mjs';

// Unified multi-language prompt creator
class UnifiedPromptCreator {
  constructor() {
    this.maxPromptLength = 50000; // Conservative limit for prompt size
  }

  /**
   * Create unified prompt for multiple files and multiple languages
   */
  createUnifiedPrompt(sourceFiles, targetLanguages, sourceLang) {
    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangNames = targetLanguages.map(lang => LANGUAGE_NAMES[lang] || lang);
    
    let prompt = this.buildPromptHeader(sourceFiles.length, sourceLangName, targetLangNames);
    prompt += this.buildCriticalRequirements(sourceLang, targetLanguages);
    prompt += this.buildSourceFilesSection(sourceFiles, sourceLang, targetLanguages);
    prompt += this.buildOutputFormatSection(sourceFiles, targetLanguages);
    
    // Validate prompt length
    if (prompt.length > this.maxPromptLength) {
      console.warn(`⚠️  Prompt length (${prompt.length}) exceeds recommended limit (${this.maxPromptLength})`);
    }
    
    return prompt;
  }

  /**
   * Build the prompt header with overview
   */
  buildPromptHeader(fileCount, sourceLangName, targetLangNames) {
    return `Please translate the following ${fileCount} glossary entries from ${sourceLangName} to ${targetLangNames.join(' and ')}.

This is a batch translation request that will process multiple files to multiple target languages simultaneously for maximum efficiency.

`;
  }

  /**
   * Build critical requirements section
   */
  buildCriticalRequirements(sourceLang, targetLanguages) {
    let requirements = `CRITICAL REQUIREMENTS:
• Translate each file to ALL target languages: ${targetLanguages.map(lang => LANGUAGE_NAMES[lang] || lang).join(', ')}
• Preserve all markdown formatting, HTML tags, and structure exactly
• Keep code blocks, URLs, domain names, and file extensions unchanged
• Brand names (Namefi, Ethereum, etc.) should remain unchanged
• Update localized URLs: change /${sourceLang}/ to /${targetLanguages[0]}/ (and other target languages) in template URLs
• Translate keywords and descriptions appropriately for SEO and discoverability
• Use natural, fluent translations that read well in the target language
• Maintain consistent terminology across all files
• Follow the exact output format specified below

`;
    return requirements;
  }

  /**
   * Build source files section with localized URLs
   */
  buildSourceFilesSection(sourceFiles, sourceLang, targetLanguages) {
    let section = `SOURCE FILES:\n\n`;
    
    sourceFiles.forEach((sourceFile, index) => {
      // Apply URL localization to content
      let localizedContent = sourceFile.content;
      
      // For unified prompts, we'll include the localized URLs in the source
      // so the AI sees the pattern for each target language
      targetLanguages.forEach(targetLang => {
        const pattern = new RegExp(`\\{\\{\\s*['"]\\/${sourceLang}\\/([^'"]*?)['"]\\s*\\|\\s*url\\s*\\}\\}`, 'g');
        localizedContent = localizedContent.replace(pattern, 
          `{{ '/${targetLang}/$1' | url }}`
        );
      });
      
      section += `=== FILE ${index + 1}: ${sourceFile.fileName} ===\n`;
      section += `---\n`;
      section += `title: ${sourceFile.frontMatter.title}\n`;
      section += `date: '${sourceFile.frontMatter.date}'\n`;
      section += `language: [TARGET_LANGUAGE]\n`;
      section += `tags: ${JSON.stringify(sourceFile.frontMatter.tags)}\n`;
      section += `authors: ${JSON.stringify(sourceFile.frontMatter.authors)}\n`;
      section += `description: ${sourceFile.frontMatter.description}\n`;
      
      if (sourceFile.frontMatter.keywords) {
        const keywords = Array.isArray(sourceFile.frontMatter.keywords) 
          ? sourceFile.frontMatter.keywords 
          : [sourceFile.frontMatter.keywords];
        section += `keywords: ${JSON.stringify(keywords)}\n`;
      }
      
      section += `---\n\n`;
      section += `${localizedContent}\n\n`;
    });
    
    return section;
  }

  /**
   * Build output format specification
   */
  buildOutputFormatSection(sourceFiles, targetLanguages) {
    let section = `OUTPUT FORMAT:\n`;
    section += `Please provide translations in this exact structure:\n\n`;
    
    targetLanguages.forEach(targetLang => {
      const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
      section += `=== ${targetLangName.toUpperCase()} TRANSLATIONS ===\n\n`;
      
      sourceFiles.forEach((sourceFile, index) => {
        section += `FILE ${index + 1} (${sourceFile.fileName}):\n`;
        section += `---\n`;
        section += `title: [TRANSLATED TITLE]\n`;
        section += `date: '${sourceFile.frontMatter.date}'\n`;
        section += `language: ${targetLang}\n`;
        section += `tags: ${JSON.stringify(sourceFile.frontMatter.tags)}\n`;
        section += `authors: ${JSON.stringify(sourceFile.frontMatter.authors)}\n`;
        section += `description: [TRANSLATED DESCRIPTION]\n`;
        section += `keywords: [TRANSLATED KEYWORDS ARRAY]\n`;
        section += `---\n\n`;
        section += `[TRANSLATED CONTENT WITH PROPER MARKDOWN FORMATTING]\n\n`;
      });
      
      section += `\n`;
    });
    
    return section;
  }
}

export { UnifiedPromptCreator };