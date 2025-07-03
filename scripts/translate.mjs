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
import OpenAI from 'openai';
import {
  initializeCache,
  shouldRegenerate,
  updateCacheEntry,
  getDependenciesHash,
  cleanCache,
  displayCacheStats,
  cleanStaleEntries
} from './cache-utils.mjs';

// Configuration
const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'zh', 'ar', 'fr', 'hi'];
const CONTENT_TYPES = ['blog', 'tld', 'glossary', 'partners'];

// Script version for cache invalidation
const SCRIPT_VERSION = '3.2.0';

// Model context limits (tokens)
const MODEL_LIMITS = {
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-pro': 2000000,
  'gpt-4o-mini': 128000,
  'gpt-4o': 128000
};

// Content type token estimates (conservative)
const CONTENT_TYPE_TOKENS = {
  'glossary': 300,
  'tld': 800,
  'partners': 600,
  'blog': 3000,
  'general': 1500
};

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

// Term extraction utilities
class TermExtractor {
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
class TermMapper {
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
class URLLocalizer {
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
class TokenEstimator {
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

// Translation planning utilities
class TranslationPlanner {
  constructor(fileProcessor) {
    this.fileProcessor = fileProcessor;
  }
  
  async analyzePendingWork(sourceFiles, targetLangs, sourceLang = 'en', skipCache = false) {
    const startTime = Date.now();
    console.log(`📋 Analyzing cache status for ${sourceFiles.length} files × ${targetLangs.length} languages...`);
    
    const pendingTasks = [];
    const skippedTasks = [];
    
    // Group by content type for analysis
    const byContentType = {
      blog: [],
      tld: [],
      glossary: [],
      partners: [],
      general: []
    };
    
    for (const sourceFile of sourceFiles) {
      const contentType = TokenEstimator.getContentTypeFromPath(sourceFile);
      
      for (const targetLang of targetLangs) {
        const task = {
          sourceFile,
          targetLang,
          sourceLang,
          contentType,
          targetPath: this.fileProcessor.generateTargetPath(sourceFile, targetLang, sourceLang)
        };
        
        // Check if translation is needed
        const isNeeded = await this.isTranslationNeeded(sourceFile, targetLang, sourceLang, skipCache);
        
        if (isNeeded) {
          pendingTasks.push(task);
          byContentType[contentType].push(task);
        } else {
          skippedTasks.push(task);
        }
      }
    }
    
    // Estimate actual tokens for pending source files
    console.log(`🔢 Estimating tokens for ${pendingTasks.length} pending translations...`);
    const uniqueSourceFiles = [...new Set(pendingTasks.map(t => t.sourceFile))];
    const tokenEstimates = await TokenEstimator.estimateTokensFromFiles(uniqueSourceFiles);
    
    // Add token estimates to tasks
    pendingTasks.forEach(task => {
      task.estimatedTokens = tokenEstimates[task.sourceFile] || TokenEstimator.getExpectedTokens(task.contentType);
    });
    
    const elapsed = Date.now() - startTime;
    
    // Generate analysis report with actual token estimates
    const analysis = {
      pending: pendingTasks,
      skipped: skippedTasks,
      byContentType,
      tokenEstimates,
      summary: {
        totalPossible: sourceFiles.length * targetLangs.length,
        pending: pendingTasks.length,
        skipped: skippedTasks.length,
        byType: Object.entries(byContentType).map(([type, tasks]) => {
          const actualTokens = tasks.reduce((sum, task) => {
            return sum + (tokenEstimates[task.sourceFile] || TokenEstimator.getExpectedTokens(type));
          }, 0);
          return {
            type,
            count: tasks.length,
            estimatedTokens: actualTokens,
            avgTokensPerFile: tasks.length > 0 ? Math.round(actualTokens / tasks.length) : 0
          };
        })
      },
      elapsed
    };
    
    this.printAnalysisReport(analysis);
    return analysis;
  }
  
  async isTranslationNeeded(filePath, targetLang, sourceLang, skipCache) {
    if (skipCache) return true;
    
    // Quick file existence check
    const targetPath = this.fileProcessor.generateTargetPath(filePath, targetLang, sourceLang);
    const targetExists = await this.fileProcessor.fileExists(targetPath);
    
    if (!targetExists) return true;
    
    // Deep cache validation
    const promptHash = this.fileProcessor.getTranslationPromptHash(sourceLang, targetLang);
    const dependenciesHash = getDependenciesHash([], `${SCRIPT_VERSION}-${promptHash}`);
    
    return shouldRegenerate(filePath, 'translations', dependenciesHash);
  }
  
  printAnalysisReport(analysis) {
    console.log(`✅ Cache analysis complete [${analysis.elapsed}ms]`);
    console.log(`📊 Translation Status:`);
    console.log(`   Total: ${analysis.summary.totalPossible} possible translations`);
    console.log(`   Pending: ${analysis.summary.pending} translations needed`);
    console.log(`   Cached: ${analysis.summary.skipped} already completed\n`);
    
    if (analysis.summary.pending > 0) {
      console.log(`📦 Pending Work by Content Type (actual file sizes):`);
      analysis.summary.byType.forEach(({ type, count, estimatedTokens, avgTokensPerFile }) => {
        if (count > 0) {
          console.log(`   ${type.charAt(0).toUpperCase() + type.slice(1)}: ${count} files (~${estimatedTokens.toLocaleString()} tokens, avg ${avgTokensPerFile}/file)`);
        }
      });
      console.log('');
    }
  }
}

// Batch optimization utilities
class BatchOptimizer {
  constructor(modelName = 'gemini-2.5-flash') {
    this.modelName = modelName;
    this.contextLimit = MODEL_LIMITS[modelName] || MODEL_LIMITS['gemini-2.5-flash'];
    this.promptOverhead = 1500; // Conservative estimate for prompt tokens
    this.safetyMargin = 0.5; // 50% safety buffer
  }
  
  calculateOptimalBatchSize(contentType, customLimit = null) {
    const limit = customLimit || this.contextLimit;
    const availableTokens = Math.floor(limit * (1 - this.safetyMargin)) - this.promptOverhead;
    const tokensPerItem = TokenEstimator.getExpectedTokens(contentType);
    
    const maxItems = Math.floor(availableTokens / tokensPerItem);
    
    // Conservative minimum batch sizes to prevent too many API calls
    const minBatchSizes = {
      'glossary': 10,
      'tld': 5,
      'partners': 5, 
      'blog': 2,
      'general': 5
    };
    
    return Math.max(maxItems, minBatchSizes[contentType] || 2);
  }
  
  createBatches(tasks, options = {}) {
    const { maxBatchSize, groupByContentType = true, enableMultiLanguage = true } = options;
    
    if (tasks.length === 0) return [];
    
    if (enableMultiLanguage) {
      return this.createOptimizedMultiLanguageBatches(tasks, options);
    } else {
      return this.createSingleLanguageBatches(tasks, options);
    }
  }
  
  createOptimizedMultiLanguageBatches(tasks, options = {}) {
    const { maxBatchSize, groupByContentType = true } = options;
    
    // Group by source file and content type for multi-language optimization
    const sourceFileGroups = {};
    
    for (const task of tasks) {
      const contentTypeKey = groupByContentType ? task.contentType : 'mixed';
      const sourceFileKey = `${task.sourceFile}-${contentTypeKey}`;
      
      if (!sourceFileGroups[sourceFileKey]) {
        sourceFileGroups[sourceFileKey] = {
          sourceFile: task.sourceFile,
          sourceLang: task.sourceLang,
          contentType: task.contentType,
          targetLanguages: [],
          tasks: [],
          estimatedTokens: task.estimatedTokens || TokenEstimator.getExpectedTokens(task.contentType)
        };
      }
      
      sourceFileGroups[sourceFileKey].targetLanguages.push(task.targetLang);
      sourceFileGroups[sourceFileKey].tasks.push(task);
    }
    
    // Convert to array and sort by content type priority and then by token count (smaller first)
    const sourceFileItems = Object.values(sourceFileGroups);
    const priorityOrder = ['glossary', 'tld', 'partners', 'blog', 'mixed', 'general'];
    
    sourceFileItems.sort((a, b) => {
      const aPriority = priorityOrder.indexOf(a.contentType);
      const bPriority = priorityOrder.indexOf(b.contentType);
      if (aPriority !== bPriority) return aPriority - bPriority;
      
      // Within same content type, sort by token count (smaller first for better packing)
      return a.estimatedTokens - b.estimatedTokens;
    });
    
    // Create batches optimized for multi-language processing
    const batches = [];
    let currentBatch = null;
    
    for (const item of sourceFileItems) {
      const tokensPerSourceFile = item.estimatedTokens;
      const maxTokensForBatch = this.getMaxTokensForBatch(item.contentType);
      
      // Check if we need a new batch
      if (!currentBatch || 
          currentBatch.contentType !== item.contentType ||
          currentBatch.estimatedTokens + tokensPerSourceFile > maxTokensForBatch) {
        
        // Finalize current batch if exists
        if (currentBatch) {
          batches.push(currentBatch);
        }
        
        // Start new batch
        currentBatch = {
          id: `batch-${batches.length + 1}`,
          contentType: item.contentType,
          type: 'multi-language',
          sourceFiles: [],
          allTargetLanguages: new Set(),
          totalTasks: 0,
          estimatedTokens: 0,
          estimatedTime: 0
        };
      }
      
      // Add source file to current batch
      currentBatch.sourceFiles.push(item);
      item.targetLanguages.forEach(lang => currentBatch.allTargetLanguages.add(lang));
      currentBatch.totalTasks += item.tasks.length;
      currentBatch.estimatedTokens += tokensPerSourceFile; // Only count source content once!
      currentBatch.estimatedTime = this.estimateProcessingTime(currentBatch.estimatedTokens, item.contentType);
    }
    
    // Add final batch
    if (currentBatch) {
      batches.push(currentBatch);
    }
    
    return batches;
  }
  
  createSingleLanguageBatches(tasks, options = {}) {
    const { maxBatchSize, groupByContentType = true } = options;
    
    // Group tasks by content type and target language
    const groups = {};
    
    for (const task of tasks) {
      const contentTypeKey = groupByContentType ? task.contentType : 'mixed';
      const languageKey = task.targetLang;
      const groupKey = `${contentTypeKey}-${languageKey}`;
      
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(task);
    }
    
    // Create optimized batches for each group using actual token counts
    const batches = [];
    
    for (const [groupKey, groupTasks] of Object.entries(groups)) {
      const [contentType, targetLang] = groupKey.split('-');
      const maxTokensForBatch = this.getMaxTokensForBatch(contentType);
      
      // Pack tasks into batches using actual token estimates
      let currentBatch = null;
      
      for (const task of groupTasks) {
        const taskTokens = task.estimatedTokens || TokenEstimator.getExpectedTokens(contentType);
        
        // Check if we need a new batch
        if (!currentBatch || 
            currentBatch.estimatedTokens + taskTokens > maxTokensForBatch) {
          
          // Finalize current batch
          if (currentBatch) {
            batches.push(currentBatch);
          }
          
          // Start new batch
          currentBatch = {
            id: `batch-${batches.length + 1}`,
            contentType: contentType === 'mixed' ? 'mixed' : contentType,
            targetLang: targetLang === 'mixed' ? 'mixed' : targetLang,
            type: 'single-language',
            tasks: [],
            size: 0,
            estimatedTokens: 0,
            estimatedTime: 0
          };
        }
        
        // Add task to current batch
        currentBatch.tasks.push(task);
        currentBatch.size++;
        currentBatch.estimatedTokens += taskTokens;
        currentBatch.estimatedTime = this.estimateProcessingTime(currentBatch.estimatedTokens, contentType);
      }
      
      // Add final batch for this group
      if (currentBatch) {
        batches.push(currentBatch);
      }
    }
    
    // Sort batches by processing priority (small content types first)
    const priorityOrder = ['glossary', 'tld', 'partners', 'blog', 'mixed', 'general'];
    batches.sort((a, b) => {
      const aPriority = priorityOrder.indexOf(a.contentType);
      const bPriority = priorityOrder.indexOf(b.contentType);
      return aPriority - bPriority;
    });
    
    return batches;
  }
  
  getMaxTokensForBatch(contentType) {
    const availableTokens = Math.floor(this.contextLimit * (1 - this.safetyMargin)) - this.promptOverhead;
    return Math.floor(availableTokens * 0.9); // Additional 10% buffer for multi-language overhead
  }
  
  estimateProcessingTime(tokens, contentType) {
    // Rough estimates based on model performance (seconds)
    const baseRates = {
      'gemini-2.5-flash': 0.002, // ~2ms per token
      'gemini-2.5-pro': 0.005,   // ~5ms per token  
      'gpt-4o-mini': 0.001,      // ~1ms per token
      'gpt-4o': 0.003            // ~3ms per token
    };
    
    const rate = baseRates[this.modelName] || baseRates['gemini-2.5-flash'];
    return Math.ceil(tokens * rate);
  }
  
  printBatchPlan(batches) {
    if (batches.length === 0) {
      console.log('📦 No batches needed - all translations are cached\n');
      return;
    }
    
    console.log(`📦 Created ${batches.length} optimized batches:`);
    
    let totalTasks = 0;
    let totalTime = 0;
    let totalTokensSaved = 0;
    
    batches.forEach((batch, index) => {
      const timeStr = batch.estimatedTime < 60 ? 
        `${batch.estimatedTime}s` : 
        `${Math.ceil(batch.estimatedTime / 60)}m${batch.estimatedTime % 60}s`;
      
      if (batch.type === 'multi-language') {
        const languages = Array.from(batch.allTargetLanguages).join(',');
        const sourceCount = batch.sourceFiles.length;
        const taskCount = batch.totalTasks;
        
        // Calculate token savings from multi-language optimization
        const wouldBeTokens = taskCount * TokenEstimator.getExpectedTokens(batch.contentType);
        const actualTokens = batch.estimatedTokens;
        const tokensSaved = wouldBeTokens - actualTokens;
        totalTokensSaved += tokensSaved;
        
        console.log(`   Batch ${index + 1}: ${sourceCount} ${batch.contentType} files → [${languages}] (${taskCount} translations, ~${timeStr})`);
        console.log(`      Token optimization: ${actualTokens.toLocaleString()} vs ${wouldBeTokens.toLocaleString()} (-${tokensSaved.toLocaleString()})`);
      } else {
        // Single-language batch (backward compatibility)
        const size = batch.size || batch.tasks.length;
        console.log(`   Batch ${index + 1}: ${size} ${batch.contentType} → ${batch.targetLang} (~${timeStr})`);
      }
      
      totalTasks += batch.totalTasks || batch.size || batch.tasks.length;
      totalTime += batch.estimatedTime;
    });
    
    const totalTimeStr = totalTime < 60 ? 
      `${totalTime}s` : 
      `${Math.floor(totalTime / 60)}m${totalTime % 60}s`;
    
    console.log(`   Total: ${totalTasks} translations, ~${totalTimeStr} estimated`);
    
    if (totalTokensSaved > 0) {
      const savingsPercent = Math.round((totalTokensSaved / (totalTokensSaved + batches.reduce((sum, b) => sum + b.estimatedTokens, 0))) * 100);
      console.log(`   Token savings: ${totalTokensSaved.toLocaleString()} tokens (~${savingsPercent}% reduction)`);
    }
    
    console.log('');
  }
}

// Abstract translation service
class TranslationService {
  constructor() {
    this.limit = pLimit(4); // Default concurrency
  }
  
  async translateText(text, targetLang, sourceLang = 'en', termConstraints = '') {
    throw new Error('translateText must be implemented by subclass');
  }
  
  async translateWithTerms(text, targetLang, sourceLang = 'en', contentType = 'general') {
    // Extract terms from content
    const terms = TermExtractor.extractGlossaryTerms(text);
    
    if (terms.length > 0) {
      console.log(`🔍 Found ${terms.length} glossary terms: ${terms.join(', ')}`);
      
      // Load term mappings
      const mappings = await TermMapper.loadTermMappings(terms, sourceLang, targetLang);
      
      // Generate constraints
      const termConstraints = TermMapper.generateTermConstraints(mappings, sourceLang, targetLang);
      
      // Report term status
      if (Object.keys(mappings.existing).length > 0) {
        console.log(`✅ ${Object.keys(mappings.existing).length} terms have existing translations`);
      }
      if (mappings.missing.length > 0) {
        console.log(`⚠️  ${mappings.missing.length} terms need translation: ${mappings.missing.map(m => m.sourceTitle).join(', ')}`);
      }
      
      return await this.translateText(text, targetLang, sourceLang, termConstraints, contentType);
    } else {
      return await this.translateText(text, targetLang, sourceLang, '', contentType);
    }
  }
  
  async translateKeywords(keywords, targetLang, sourceLang = 'en', contentType = 'general') {
    if (!keywords || targetLang === sourceLang) return keywords;
    
    // Handle both array and string formats
    let keywordArray;
    if (Array.isArray(keywords)) {
      keywordArray = keywords;
    } else if (typeof keywords === 'string') {
      keywordArray = keywords.split(',').map(k => k.trim());
    } else {
      return keywords; // Return as-is if not array or string
    }
    
    if (keywordArray.length === 0) return keywords;
    
    console.log(`🏷️ Translating ${keywordArray.length} keywords: ${keywordArray.join(', ')}`);
    
    // Join keywords into a single string for translation with special formatting
    const keywordsText = keywordArray.map(k => `"${k}"`).join(', ');
    
    try {
      const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
      const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
      
      const prompt = `Translate the following SEO keywords from ${sourceLangName} to ${targetLangName}. 

CRITICAL REQUIREMENTS:
• Each keyword must be translated to ${targetLangName}
• Maintain SEO value and search intent in ${targetLangName}
• Keep technical terms appropriately localized (e.g. "DNS" may stay "DNS" but "domain name" should be translated)
• Preserve keyword format as individual terms
• Return ONLY the translated keywords in the same quoted format

Content context: ${contentType}

Keywords to translate: ${keywordsText}

Expected output format: "translated keyword 1", "translated keyword 2", etc.`;

      const translatedText = await this.translateText(prompt, targetLang, sourceLang, '', 'keywords');
      
      // Parse the translated result back into array
      const translatedKeywords = translatedText
        .split(',')
        .map(k => k.trim().replace(/^["']|["']$/g, '')) // Remove quotes
        .filter(k => k.length > 0);
      
      if (translatedKeywords.length > 0) {
        console.log(`✅ Keywords translated: ${translatedKeywords.join(', ')}`);
        return translatedKeywords;
      } else {
        console.warn(`⚠️ Keywords translation failed, keeping original`);
        return keywordArray;
      }
    } catch (error) {
      console.error(`❌ Keywords translation error: ${error.message}`);
      return keywordArray; // Return original on error
    }
  }
}

// Gemini translation service
class GeminiTranslationService extends TranslationService {
  constructor(model = 'gemini-2.5-flash') {
    super();
    this.modelName = model;
    this.limit = pLimit(model === 'gemini-2.5-flash' ? 6 : 2);
    this.genAI = null;
    this.model = null;
    
    if (process.env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.model = this.genAI.getGenerativeModel({ model: this.modelName });
    }
  }

  async translateText(text, targetLang, sourceLang = 'en', termConstraints = '', contentType = 'general') {
    if (!text || typeof text !== 'string' || text.trim() === '') return text;
    if (targetLang === sourceLang) return text;
    
    return this.limit(async () => {
      try {
        if (!this.model) {
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
• ${contextInfo}${termConstraints}

【Content starts】

${text}

【Content ends】

Response format: Provide ONLY the translated text with preserved formatting.`;

        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        const translatedText = response.text().trim();
        
        return translatedText;
      } catch (error) {
        console.error(`Gemini translation error for ${targetLang}:`, error.message);
        return text; // Return original text on error
      }
    });
  }
}

// OpenAI translation service
class OpenAITranslationService extends TranslationService {
  constructor(model = 'gpt-4o-mini') {
    super();
    this.modelName = model;
    this.limit = pLimit(8); // OpenAI can handle higher concurrency
    this.client = null;
    
    if (process.env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
  }

  async translateText(text, targetLang, sourceLang = 'en', termConstraints = '', contentType = 'general') {
    if (!text || typeof text !== 'string' || text.trim() === '') return text;
    if (targetLang === sourceLang) return text;
    
    return this.limit(async () => {
      try {
        if (!this.client) {
          console.warn(`No OpenAI API configured, returning original text`);
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
• ${contextInfo}${termConstraints}

【Content starts】

${text}

【Content ends】

Response format: Provide ONLY the translated text with preserved formatting.`;

        const completion = await this.client.chat.completions.create({
          model: this.modelName,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.3
        });
        
        return completion.choices[0].message.content.trim();
      } catch (error) {
        console.error(`OpenAI translation error for ${targetLang}:`, error.message);
        return text; // Return original text on error
      }
    });
  }
}

// Service factory
class TranslationServiceFactory {
  static create(service = 'gemini', model = null) {
    switch (service.toLowerCase()) {
      case 'openai':
        return new OpenAITranslationService(model || 'gpt-4o-mini');
      case 'gemini':
      default:
        return new GeminiTranslationService(model || 'gemini-2.5-flash');
    }
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

  async translateFile(filePath, targetLang, sourceLang = 'en', skipCache = false) {
    try {
      const startTime = Date.now();
      
      // Generate current translation prompt hash for cache comparison
      const promptHash = this.getTranslationPromptHash(sourceLang, targetLang);
      const dependenciesHash = getDependenciesHash([], `${SCRIPT_VERSION}-${promptHash}`);
      
      // Check if translation is needed
      if (!skipCache && !shouldRegenerate(filePath, 'translations', dependenciesHash)) {
        const targetFilePath = this.generateTargetPath(filePath, targetLang, sourceLang);
        const elapsed = Date.now() - startTime;
        console.log(`⏭️  Skipping: ${path.basename(filePath)} -> ${targetLang} (unchanged) [${elapsed}ms]`);
        return { success: true, filePath: targetFilePath, skipped: true, elapsed };
      }
      
      const content = await fs.readFile(filePath, 'utf8');
      const { data: frontMatter, content: markdownBody } = matter(content);
      const contentType = this.getContentType(filePath);

      // First, localize URLs in the markdown content
      const localizedBody = URLLocalizer.localizeURLs(markdownBody, targetLang, sourceLang);

      // Translate frontmatter fields with terms
      const translatedFrontMatter = { ...frontMatter };
      
      if (frontMatter.title) {
        translatedFrontMatter.title = await this.translationService.translateWithTerms(
          frontMatter.title, targetLang, sourceLang, contentType
        );
      }
      
      if (frontMatter.description) {
        translatedFrontMatter.description = await this.translationService.translateWithTerms(
          frontMatter.description, targetLang, sourceLang, contentType
        );
      }
      
      if (frontMatter.keywords && contentType !== 'tld') {
        // For most content types, translate keywords using specialized method, but keep TLD keywords technical
        translatedFrontMatter.keywords = await this.translationService.translateKeywords(
          frontMatter.keywords, targetLang, sourceLang, contentType
        );
      }

      // Translate the URL-localized markdown content with full term awareness
      const translatedBody = await this.translationService.translateWithTerms(
        localizedBody, targetLang, sourceLang, contentType
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
      
      // Update cache
      updateCacheEntry(filePath, 'translations', [targetFilePath], dependenciesHash);
      
      const elapsed = Date.now() - startTime;
      console.log(`✅ Translated: ${path.basename(filePath)} -> ${targetLang} [${elapsed}ms]`);
      return { success: true, filePath: targetFilePath, elapsed };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      return { success: false, filePath, error: error.message, elapsed };
    }
  }
  
  /**
   * Generate hash for translation prompts to detect prompt changes
   * @param {string} sourceLang - Source language
   * @param {string} targetLang - Target language
   * @returns {string} Hash of translation prompts
   */
  getTranslationPromptHash(sourceLang, targetLang) {
    // Include key parts of the translation prompt that affect output
    // v3.0 includes URL localization functionality
    const promptKey = `${sourceLang}-${targetLang}-v3.0-url-localization`;
    const promptContent = `
      Please translate the following technical content from ${sourceLang} into ${targetLang}
      Preserve the original meaning, but feel free to restructure for better flow
      Use the natural tone and style of technical blog posts
      Keep the tone clear, confident, and easy to read for developers
      Avoid repetitive phrasing or generic AI-style introductions
      Do not translate terms that are better left in English
      Preserve all markdown formatting, HTML tags, and structure exactly
      Keep code blocks, URLs, domain names, and file extensions unchanged
      Brand names (Namefi, Ethereum, etc.) should remain unchanged
      Translate keywords, tags, and topic sections where appropriate
    `;
    return getDependenciesHash([], promptKey + promptContent);
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
  .description('Multi-service batch translation tool with intelligent term consistency and URL localization')
  .version('3.1.0');

program
  .option('--from <lang>', 'Source language', 'en')
  .option('--to <langs>', 'Target languages (comma-separated or "all")', 'all')
  .option('--files <patterns>', 'Specific file patterns (comma-separated)')
  .option('--dry-run', 'Preview what would be translated without making changes')
  .option('--backup', 'Create backup files before overwriting')
  .option('--content-type <types>', 'Content types to translate (comma-separated): blog,tld,glossary,partners')
  .option('--service <service>', 'Translation service (gemini|openai)', 'gemini')
  .option('--model <model>', 'Model to use (flash|pro|gpt-4o-mini|gpt-4o)')
  .option('--skip-cache', 'Bypass cache and regenerate all files')
  .option('--clean-cache', 'Clean the translation cache and exit')
  .option('--cache-stats', 'Display cache statistics and exit')
  .option('--lint-yaml', 'Run YAML linting before translation')
  .action(async (options) => {
    const serviceName = options.service || 'gemini';
    const modelName = options.model || (serviceName === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash');
    
    console.log(`🌍 Multi-Service Translation Tool Starting...`);
    console.log(`🔧 Service: ${serviceName.toUpperCase()}`);
    console.log(`🤖 Model: ${modelName}\n`);

    // Initialize cache system
    initializeCache();
    
    // Handle cache management commands
    if (options.cleanCache) {
      cleanCache();
      return;
    }
    
    if (options.cacheStats) {
      displayCacheStats();
      return;
    }
    
    // Clean stale entries
    cleanStaleEntries();
    
    // Optional YAML linting
    if (options.lintYaml) {
      console.log('🔍 Running YAML linting before translation...');
      try {
        const { execSync } = await import('child_process');
        execSync('npm run lint:yaml -- --fix', { stdio: 'inherit' });
        console.log('✅ YAML linting completed\n');
      } catch (error) {
        console.error('❌ YAML linting failed:', error.message);
        if (!options.dryRun) process.exit(1);
      }
    }

    // Create translation service
    const translationService = TranslationServiceFactory.create(serviceName, modelName);
    
    // Check if service is available
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    
    if (serviceName === 'gemini' && !hasGeminiKey) {
      console.error('❌ Gemini API not configured. Please set GEMINI_API_KEY');
      if (!options.dryRun) process.exit(1);
    }
    
    if (serviceName === 'openai' && !hasOpenAIKey) {
      console.error('❌ OpenAI API not configured. Please set OPENAI_API_KEY');
      if (!options.dryRun) process.exit(1);
    }

    const fileProcessor = new FileProcessor(translationService, {
      dryRun: options.dryRun,
      backup: options.backup,
      skipCache: options.skipCache
    });

    // Parse target languages
    let targetLangs;
    if (options.to === 'all') {
      targetLangs = SUPPORTED_LANGUAGES.filter(lang => lang !== options.from).reverse();
    } else {
      targetLangs = options.to.split(',').map(lang => lang.trim()).reverse();
    }

    console.log(`📝 Source language: ${options.from}`);
    console.log(`🎯 Target languages: ${targetLangs.join(', ')}`);
    console.log(`🤖 Translation engine: ${serviceName.toUpperCase()} (${modelName})`);
    
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
    let skipped = 0;
    let errors = [];
    let totalTime = 0;
    const scriptStartTime = Date.now();

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
          
          if (targetExists && !options.skipCache) {
            console.log(`\n⚠️  Skipping ${targetPath} (already exists)`);
            completed++;
            continue;
          }

          const result = await fileProcessor.translateFile(sourceFile, targetLang, options.from, options.skipCache);
          
          if (result.success) {
            if (result.skipped) {
              skipped++;
            }
            if (result.elapsed) {
              totalTime += result.elapsed;
            }
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

    const scriptEndTime = Date.now();
    const totalScriptTime = scriptEndTime - scriptStartTime;
    
    // Results summary
    console.log('\n✅ Translation completed!');
    console.log(`📊 Translation Summary:`);
    console.log(`   Total: ${totalTranslations} translations`);
    console.log(`   Processed: ${completed - skipped}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Completed: ${completed}`);
    console.log(`⏱️  Processing time: ${totalTime}ms`);
    console.log(`⏱️  Total script time: ${totalScriptTime}ms`);
    
    if (errors.length > 0) {
      console.log(`\n❌ Errors encountered: ${errors.length}`);
      errors.forEach(error => {
        console.log(`  - ${error.file} -> ${error.targetLang}: ${error.error}`);
      });
    }

    console.log(`\n🎉 Multi-service translation with ${serviceName.toUpperCase()} (${modelName}) finished!`);
  });

program.parse(process.argv);