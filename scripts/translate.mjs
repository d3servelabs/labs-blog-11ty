#!/usr/bin/env node

import dotenv from 'dotenv';
import { Command } from 'commander';

// Load environment variables
dotenv.config();
import matter from 'gray-matter';
import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Configuration
const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'zh', 'ar', 'fr', 'hi'];
const CONTENT_TYPES = ['blog', 'tld', 'glossary', 'partners'];

// Language names for Gemini prompts
const LANGUAGE_NAMES = {
  'en': 'English',
  'de': 'German',
  'es': 'Spanish', 
  'zh': 'Chinese (Simplified)',
  'ar': 'Arabic',
  'fr': 'French',
  'hi': 'Hindi'
};

// Gemini client
let genAI;
let model;

function initializeGemini() {
  if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
  }
}

class GeminiTranslationService {
  constructor() {
    this.limit = pLimit(2); // Conservative rate limiting for Gemini
  }

  async translateText(text, targetLang, sourceLang = 'en') {
    if (!text || typeof text !== 'string' || text.trim() === '') return text;
    if (targetLang === sourceLang) return text;
    
    return this.limit(async () => {
      try {
        if (!model) {
          console.warn(`No Gemini API configured, returning original text`);
          return text;
        }

        const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
        const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

        const prompt = `Please translate the following technical content from ${sourceLangName} into ${targetLangName}, with the goal of producing a natural, fluent, and high-quality technical blog post.

Requirements:

• Preserve the original meaning, but feel free to restructure for better flow in ${targetLangName}.
• Use the natural tone and style of technical blog posts in ${targetLangName}—avoid overly literal or robotic translation.
• Keep the tone clear, confident, and easy to read for developers.
• Avoid repetitive phrasing or generic AI-style introductions like "This article will show you…" unless it fits the local convention.
• Do not translate terms that are better left in English (e.g., function names, code keywords, common tech acronyms).
• Preserve all markdown formatting, HTML tags, and structure exactly.
• Keep code blocks, URLs, domain names, and file extensions unchanged.
• Brand names (Namefi, Ethereum, etc.) should remain unchanged.
• Translate keywords, tags, and topic sections to ${targetLangName} where appropriate for SEO and discoverability.

【Content starts】

${text}

【Content ends】

Response format: Provide ONLY the translated text with preserved formatting.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const translatedText = response.text().trim();
        
        return translatedText;
      } catch (error) {
        console.error(`Gemini translation error for ${targetLang}:`, error.message);
        return text; // Return original text on error
      }
    });
  }

  async translateMarkdown(content, targetLang, sourceLang = 'en') {
    // For longer content, we might want to split it or use a more specific prompt
    if (content.length > 30000) {
      console.warn(`Content very long (${content.length} chars), splitting...`);
      // Could implement chunking here if needed
    }
    
    return await this.translateText(content, targetLang, sourceLang);
  }

  async translateWithContext(text, targetLang, sourceLang = 'en', contentType = 'general') {
    if (!text || typeof text !== 'string' || text.trim() === '') return text;
    if (targetLang === sourceLang) return text;

    return this.limit(async () => {
      try {
        if (!model) {
          console.warn(`No Gemini API configured, returning original text`);
          return text;
        }

        const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
        const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

        // Context-specific prompts
        const contextPrompts = {
          blog: "This is content from a Web3/blockchain blog post about domain names and tokenization.",
          tld: "This is technical content about top-level domains (TLD) and domain extensions.",
          glossary: "This is a definition from a Web3/blockchain glossary explaining technical terms.",
          partners: "This is content about business partnerships in the Web3/domain space."
        };

        const contextInfo = contextPrompts[contentType] || "This is Web3/blockchain related content.";

        const prompt = `Please translate the following technical content from ${sourceLangName} into ${targetLangName}, with the goal of producing a natural, fluent, and high-quality technical blog post.

Requirements:

• Preserve the original meaning, but feel free to restructure for better flow in ${targetLangName}.
• Use the natural tone and style of technical blog posts in ${targetLangName}—avoid overly literal or robotic translation.
• Keep the tone clear, confident, and easy to read for developers.
• Avoid repetitive phrasing or generic AI-style introductions like "This article will show you…" unless it fits the local convention.
• Do not translate terms that are better left in English (e.g., function names, code keywords, common tech acronyms).
• Preserve all markdown formatting, HTML tags, and structure exactly.
• Keep code blocks, URLs, domain names, and file extensions unchanged.
• Brand names (Namefi, Ethereum, etc.) should remain unchanged.
• Translate keywords, tags, and topic sections to ${targetLangName} where appropriate for SEO and discoverability.
• ${contextInfo}

【Content starts】

${text}

【Content ends】

Response format: Provide ONLY the translated text with preserved formatting.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const translatedText = response.text().trim();
        
        return translatedText;
      } catch (error) {
        console.error(`Gemini translation error for ${targetLang}:`, error.message);
        return text;
      }
    });
  }
}

class FileProcessor {
  constructor(translationService, options = {}) {
    this.translationService = translationService;
    this.dryRun = options.dryRun || false;
    this.backup = options.backup || false;
  }

  async discoverFiles(sourcePattern) {
    const files = await glob(sourcePattern, { 
      cwd: process.cwd(),
      ignore: ['**/node_modules/**', '**/dist/**']
    });
    return files;
  }

  getContentType(filePath) {
    if (filePath.includes('/blog/')) return 'blog';
    if (filePath.includes('/tld/')) return 'tld';
    if (filePath.includes('/glossary/')) return 'glossary';
    if (filePath.includes('/partners/')) return 'partners';
    return 'general';
  }

  async translateFile(filePath, targetLang, sourceLang = 'en') {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const { data: frontMatter, content: markdownBody } = matter(content);
      const contentType = this.getContentType(filePath);

      // Translate frontmatter fields with context
      const translatedFrontMatter = { ...frontMatter };
      
      if (frontMatter.title) {
        translatedFrontMatter.title = await this.translationService.translateWithContext(
          frontMatter.title, targetLang, sourceLang, contentType
        );
      }
      
      if (frontMatter.description) {
        translatedFrontMatter.description = await this.translationService.translateWithContext(
          frontMatter.description, targetLang, sourceLang, contentType
        );
      }
      
      if (frontMatter.keywords && contentType !== 'tld') {
        // For most content types, translate keywords, but keep TLD keywords technical
        translatedFrontMatter.keywords = await this.translationService.translateWithContext(
          frontMatter.keywords, targetLang, sourceLang, contentType
        );
      }

      // Translate markdown content with full context
      const translatedBody = await this.translationService.translateWithContext(
        markdownBody, targetLang, sourceLang, contentType
      );

      // Update language-specific data
      translatedFrontMatter.language = targetLang;

      // Reconstruct file
      const newContent = matter.stringify(translatedBody, translatedFrontMatter);

      // Generate target file path
      const targetFilePath = this.generateTargetPath(filePath, targetLang, sourceLang);
      
      if (this.dryRun) {
        console.log(`[DRY RUN] Would translate: ${filePath} -> ${targetFilePath}`);
        return { success: true, filePath: targetFilePath, dryRun: true };
      }

      // Create backup if requested
      if (this.backup && await this.fileExists(targetFilePath)) {
        await fs.copyFile(targetFilePath, `${targetFilePath}.backup`);
      }

      // Ensure target directory exists
      await fs.mkdir(path.dirname(targetFilePath), { recursive: true });

      // Write translated file
      await fs.writeFile(targetFilePath, newContent, 'utf8');

      return { success: true, filePath: targetFilePath };
    } catch (error) {
      return { success: false, filePath, error: error.message };
    }
  }

  generateTargetPath(sourcePath, targetLang, sourceLang) {
    // Convert: src/en/blog/post.md -> src/de/blog/post.md
    return sourcePath.replace(`/${sourceLang}/`, `/${targetLang}/`);
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// CLI Commands
const program = new Command();

program
  .name('translate')
  .description('Batch translation tool using Gemini 2.5 Pro for multilingual Eleventy site')
  .version('2.0.0');

program
  .option('--from <lang>', 'Source language', 'en')
  .option('--to <langs>', 'Target languages (comma-separated or "all")', 'all')
  .option('--files <patterns>', 'Specific file patterns (comma-separated)')
  .option('--dry-run', 'Preview what would be translated without making changes')
  .option('--backup', 'Create backup files before overwriting')
  .option('--content-type <types>', 'Content types to translate (comma-separated): blog,tld,glossary,partners')
  .option('--force', 'Overwrite existing translated files')
  .action(async (options) => {
    console.log('🌍 Batch Translation Tool (Gemini 2.5 Pro) Starting...\n');

    // Initialize Gemini
    initializeGemini();
    
    if (!model) {
      console.error('❌ Gemini API not configured. Please set GEMINI_API_KEY');
      if (!options.dryRun) {
        process.exit(1);
      } else {
        console.log('🔍 DRY RUN MODE - Continuing to show what would be translated...\n');
      }
    }

    const translationService = new GeminiTranslationService();
    const fileProcessor = new FileProcessor(translationService, {
      dryRun: options.dryRun,
      backup: options.backup
    });

    // Parse target languages
    let targetLangs;
    if (options.to === 'all') {
      targetLangs = SUPPORTED_LANGUAGES.filter(lang => lang !== options.from);
    } else {
      targetLangs = options.to.split(',').map(lang => lang.trim());
    }

    console.log(`📝 Source language: ${options.from}`);
    console.log(`🎯 Target languages: ${targetLangs.join(', ')}`);
    console.log(`🤖 Translation engine: Gemini 2.5 Pro`);
    
    if (options.dryRun) {
      console.log('🔍 DRY RUN MODE - No files will be modified');
    }

    // Determine files to translate
    let sourceFiles = [];
    
    if (options.files) {
      // Specific files provided
      const patterns = options.files.split(',').map(p => p.trim());
      for (const pattern of patterns) {
        const files = await fileProcessor.discoverFiles(pattern);
        sourceFiles.push(...files);
      }
    } else {
      // Discover all content files for source language
      const contentTypes = options.contentType ? 
        options.contentType.split(',').map(t => t.trim()) : 
        CONTENT_TYPES;
      
      for (const contentType of contentTypes) {
        const pattern = `src/${options.from}/${contentType}/**/*.md`;
        const files = await fileProcessor.discoverFiles(pattern);
        sourceFiles.push(...files);
      }
    }

    if (sourceFiles.length === 0) {
      console.log('❌ No source files found to translate');
      return;
    }

    console.log(`📁 Found ${sourceFiles.length} source files\n`);

    // Calculate total translations needed
    const totalTranslations = sourceFiles.length * targetLangs.length;
    
    // Progress tracking
    const progressBar = new cliProgress.SingleBar({
      format: 'Translation Progress |{bar}| {percentage}% | {value}/{total} | {filename}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });

    progressBar.start(totalTranslations, 0, { filename: '' });

    let completed = 0;
    let errors = [];

    // Process translations
    for (const sourceFile of sourceFiles) {
      for (const targetLang of targetLangs) {
        try {
          progressBar.update(completed, { 
            filename: path.basename(sourceFile) + ` -> ${targetLang}` 
          });

          // Check if target file already exists
          const targetPath = fileProcessor.generateTargetPath(sourceFile, targetLang, options.from);
          const targetExists = await fileProcessor.fileExists(targetPath);
          
          if (targetExists && !options.force) {
            console.log(`\n⚠️  Skipping ${targetPath} (already exists)`);
            completed++;
            continue;
          }

          const result = await fileProcessor.translateFile(sourceFile, targetLang, options.from);
          
          if (result.success) {
            completed++;
          } else {
            errors.push({
              file: sourceFile,
              targetLang,
              error: result.error
            });
            completed++;
          }

        } catch (error) {
          errors.push({
            file: sourceFile,
            targetLang,
            error: error.message
          });
          completed++;
        }
      }
    }

    progressBar.stop();

    // Results summary
    console.log('\n✅ Translation completed!');
    console.log(`📊 Processed: ${completed}/${totalTranslations} translations`);
    
    if (errors.length > 0) {
      console.log(`\n❌ Errors encountered: ${errors.length}`);
      errors.forEach(error => {
        console.log(`  - ${error.file} -> ${error.targetLang}: ${error.error}`);
      });
    }

    console.log('\n🎉 Batch translation with Gemini 2.5 Pro finished!');
  });

program.parse(process.argv);