import { promises as fs } from 'fs';
import path from 'path';
import { LANGUAGE_NAMES } from './config.mjs';

// Structured response parser for unified multi-language translations
class StructuredResponseParser {
  constructor() {
    this.languageDelimiter = /=== ([A-Z\s]+) TRANSLATIONS ===/g;
    this.fileDelimiter = /FILE (\d+) \(([^)]+)\):\s*\n(.*?)(?=FILE \d+|\n===|$)/gs;
  }

  /**
   * Parse unified translation response containing multiple files and languages
   */
  parseUnifiedResponse(translatedResult, sourceFiles, targetLanguages, sourceLang) {
    const results = {
      translations: {},
      errors: [],
      completed: 0,
      partial: 0
    };

    try {
      // Initialize results structure
      targetLanguages.forEach(lang => {
        results.translations[lang] = {};
      });

      // Split response by language sections
      const languageSections = this.extractLanguageSections(translatedResult, targetLanguages);
      
      if (Object.keys(languageSections).length === 0) {
        throw new Error('No language sections found in response');
      }

      // Process each language section
      for (const [language, sectionContent] of Object.entries(languageSections)) {
        try {
          const fileTranslations = this.parseLanguageSection(sectionContent, sourceFiles);
          results.translations[language] = fileTranslations;
          
          // Count successful translations
          Object.keys(fileTranslations).forEach(fileName => {
            if (fileTranslations[fileName] && fileTranslations[fileName].trim()) {
              results.completed++;
            }
          });
          
        } catch (error) {
          results.errors.push({
            language,
            error: `Failed to parse ${language} section: ${error.message}`,
            type: 'language_parsing_error'
          });
        }
      }

      // Validate completeness
      this.validateCompleteness(results, sourceFiles, targetLanguages);

    } catch (error) {
      results.errors.push({
        error: `Failed to parse unified response: ${error.message}`,
        type: 'response_parsing_error'
      });
    }

    return results;
  }

  /**
   * Extract language sections from the unified response
   */
  extractLanguageSections(response, targetLanguages) {
    const sections = {};
    
    // Create language patterns based on expected target languages
    const languagePatterns = targetLanguages.map(lang => {
      const langName = LANGUAGE_NAMES[lang]?.toUpperCase() || lang.toUpperCase();
      return { code: lang, name: langName, pattern: new RegExp(`=== ${langName} TRANSLATIONS ===(.*?)(?==== |$)`, 'is') };
    });

    for (const { code, name, pattern } of languagePatterns) {
      const match = response.match(pattern);
      if (match) {
        sections[code] = match[1].trim();
        console.log(`📋 Found ${name} section (${match[1].length} chars)`);
      } else {
        console.warn(`⚠️  No ${name} section found in response`);
      }
    }

    return sections;
  }

  /**
   * Parse individual file translations within a language section
   */
  parseLanguageSection(sectionContent, sourceFiles) {
    const fileTranslations = {};
    
    // Extract individual file translations
    const fileMatches = [...sectionContent.matchAll(this.fileDelimiter)];
    
    if (fileMatches.length === 0) {
      // Fallback: try alternative parsing
      return this.parseLanguageSectionFallback(sectionContent, sourceFiles);
    }

    for (const match of fileMatches) {
      const fileIndex = parseInt(match[1]) - 1; // Convert to 0-based index
      const fileName = match[2].trim();
      const translatedContent = match[3].trim();

      if (fileIndex >= 0 && fileIndex < sourceFiles.length) {
        const sourceFile = sourceFiles[fileIndex];
        const expectedFileName = sourceFile.fileName || path.basename(sourceFile.filePath, '.md');
        
        if (fileName === expectedFileName || sourceFile.filePath.includes(fileName)) {
          fileTranslations[expectedFileName] = translatedContent;
        } else {
          console.warn(`⚠️  File name mismatch: expected ${expectedFileName}, got ${fileName}`);
          fileTranslations[fileName] = translatedContent;
        }
      }
    }

    return fileTranslations;
  }

  /**
   * Fallback parsing for less structured responses
   */
  parseLanguageSectionFallback(sectionContent, sourceFiles) {
    const fileTranslations = {};
    
    // Try to split by obvious file boundaries
    const sections = sectionContent.split(/\n\s*\n/).filter(section => section.trim());
    
    if (sections.length >= sourceFiles.length) {
      sourceFiles.forEach((sourceFile, index) => {
        if (sections[index]) {
          const fileName = sourceFile.fileName || path.basename(sourceFile.filePath, '.md');
          fileTranslations[fileName] = sections[index].trim();
        }
      });
    }

    return fileTranslations;
  }

  /**
   * Validate that all expected translations are present
   */
  validateCompleteness(results, sourceFiles, targetLanguages) {
    const expectedTotal = sourceFiles.length * targetLanguages.length;
    const actualTotal = results.completed;
    
    if (actualTotal < expectedTotal) {
      results.partial = expectedTotal - actualTotal;
      results.errors.push({
        error: `Incomplete translation: expected ${expectedTotal}, got ${actualTotal}`,
        type: 'completeness_validation_error'
      });
    }

    // Check for missing files in each language
    targetLanguages.forEach(lang => {
      const langTranslations = results.translations[lang] || {};
      sourceFiles.forEach(sourceFile => {
        const fileName = sourceFile.fileName || path.basename(sourceFile.filePath, '.md');
        if (!langTranslations[fileName]) {
          results.errors.push({
            language: lang,
            file: fileName,
            error: `Missing translation for ${fileName} in ${lang}`,
            type: 'missing_translation_error'
          });
        }
      });
    });
  }

  /**
   * Save parsed translations to files
   */
  async saveTranslations(parseResults, sourceFiles, targetLanguages, sourceLang) {
    let completed = 0;
    let errors = [];

    for (const targetLang of targetLanguages) {
      const langTranslations = parseResults.translations[targetLang] || {};
      
      for (const sourceFile of sourceFiles) {
        const fileName = sourceFile.fileName || path.basename(sourceFile.filePath, '.md');
        const translatedContent = langTranslations[fileName];
        
        if (translatedContent && translatedContent.trim()) {
          try {
            // Generate target file path
            const targetFilePath = this.generateTargetPath(sourceFile.filePath, targetLang, sourceLang);
            
            // Ensure target directory exists
            await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
            
            // Write translated file
            await fs.writeFile(targetFilePath, translatedContent, 'utf8');
            
            completed++;
            console.log(`✅ Unified translation saved: ${fileName} -> ${targetLang}`);
            
          } catch (writeError) {
            errors.push({
              file: sourceFile.filePath,
              targetLang,
              error: `Failed to write unified translation: ${writeError.message}`,
              type: 'write_error'
            });
          }
        } else {
          errors.push({
            file: sourceFile.filePath,
            targetLang,
            error: `No translation content found for ${fileName}`,
            type: 'missing_content_error'
          });
        }
      }
    }

    return { completed, errors };
  }

  /**
   * Generate target file path
   */
  generateTargetPath(sourcePath, targetLang, sourceLang) {
    return sourcePath.replace(`/${sourceLang}/`, `/${targetLang}/`);
  }
}

export { StructuredResponseParser };