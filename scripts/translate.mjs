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
    
    // Optimized batch sizes for different content types
    const optimalBatchSizes = {
      'glossary': Math.min(maxItems, 15), // Small files, can batch more
      'tld': Math.min(maxItems, 8),       // Medium files
      'partners': Math.min(maxItems, 6),  // Medium files
      'blog': Math.min(maxItems, 3),      // Large files
      'general': Math.min(maxItems, 5)
    };
    
    // Minimum batch sizes to prevent too many API calls
    const minBatchSizes = {
      'glossary': 8,  // Increased for glossary optimization
      'tld': 4,
      'partners': 4, 
      'blog': 2,
      'general': 3
    };
    
    const optimal = optimalBatchSizes[contentType] || optimalBatchSizes.general;
    const minimum = minBatchSizes[contentType] || minBatchSizes.general;
    
    return Math.max(optimal, minimum);
  }
  
  createBatches(tasks, options = {}) {
    const { 
      maxBatchSize, 
      groupByContentType = true, 
      enableMultiLanguage = true, 
      enableTokenAwareBatching = false,
      maxContextRatio = 0.75,
      tokenExpansionFactor = 1.2
    } = options;
    
    if (tasks.length === 0) return [];
    
    // Use token-aware batching for maximum efficiency when enabled
    if (enableTokenAwareBatching) {
      console.log('🚀 Using advanced token-aware batching for maximum context utilization');
      const tokenAwareBuilder = new TokenAwareBatchBuilder(this.modelName, {
        maxContextRatio,
        tokenExpansionFactor
      });
      return tokenAwareBuilder.createOptimalBatches(tasks, options);
    }
    
    // Use specialized glossary optimization if most tasks are glossary
    const glossaryTasks = tasks.filter(task => task.contentType === 'glossary');
    const isGlossaryDominated = glossaryTasks.length > tasks.length * 0.7;
    
    if (isGlossaryDominated && enableMultiLanguage) {
      return this.createGlossaryOptimizedBatches(tasks, options);
    } else if (enableMultiLanguage) {
      return this.createOptimizedMultiLanguageBatches(tasks, options);
    } else {
      return this.createSingleLanguageBatches(tasks, options);
    }
  }
  
  createGlossaryOptimizedBatches(tasks, options = {}) {
    console.log('🔤 Using glossary-optimized batching strategy');
    
    const { maxBatchSize } = options;
    
    // Group by content type first
    const tasksByType = {
      glossary: tasks.filter(t => t.contentType === 'glossary'),
      other: tasks.filter(t => t.contentType !== 'glossary')
    };
    
    const batches = [];
    
    // Process glossary tasks with high-density batching
    if (tasksByType.glossary.length > 0) {
      const glossaryBatches = this.createHighDensityGlossaryBatches(tasksByType.glossary, maxBatchSize);
      batches.push(...glossaryBatches);
    }
    
    // Process other content types normally
    if (tasksByType.other.length > 0) {
      const otherBatches = this.createOptimizedMultiLanguageBatches(tasksByType.other, options);
      batches.push(...otherBatches);
    }
    
    return batches;
  }
  
  createHighDensityGlossaryBatches(glossaryTasks, maxBatchSize = 15) {
    // Group glossary tasks by source file for multi-language optimization
    const sourceFileGroups = {};
    
    for (const task of glossaryTasks) {
      const sourceFileKey = task.sourceFile;
      
      if (!sourceFileGroups[sourceFileKey]) {
        sourceFileGroups[sourceFileKey] = {
          sourceFile: task.sourceFile,
          sourceLang: task.sourceLang,
          contentType: 'glossary',
          targetLanguages: [],
          tasks: [],
          estimatedTokens: task.estimatedTokens || TokenEstimator.getExpectedTokens('glossary')
        };
      }
      
      sourceFileGroups[sourceFileKey].targetLanguages.push(task.targetLang);
      sourceFileGroups[sourceFileKey].tasks.push(task);
    }
    
    const sourceFileItems = Object.values(sourceFileGroups);
    
    // Sort by token count (smaller first for better packing)
    sourceFileItems.sort((a, b) => a.estimatedTokens - b.estimatedTokens);
    
    // Create high-density batches (more files per batch for glossary)
    const batches = [];
    let currentBatch = null;
    const maxTokensForGlossaryBatch = this.getMaxTokensForBatch('glossary') * 1.2; // 20% more for glossary
    
    for (const item of sourceFileItems) {
      const tokensPerSourceFile = item.estimatedTokens;
      
      // Check if we need a new batch (more aggressive packing for glossary)
      if (!currentBatch || 
          currentBatch.sourceFiles.length >= maxBatchSize ||
          currentBatch.estimatedTokens + tokensPerSourceFile > maxTokensForGlossaryBatch) {
        
        // Finalize current batch if exists
        if (currentBatch) {
          batches.push(currentBatch);
        }
        
        // Start new batch
        currentBatch = {
          id: `glossary-batch-${batches.length + 1}`,
          contentType: 'glossary',
          type: 'multi-language-glossary',
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
      currentBatch.estimatedTokens += tokensPerSourceFile;
      currentBatch.estimatedTime = this.estimateProcessingTime(currentBatch.estimatedTokens, 'glossary');
    }
    
    // Add final batch
    if (currentBatch) {
      batches.push(currentBatch);
    }
    
    return batches;
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
      
      if (batch.type === 'multi-language' || batch.type === 'multi-language-glossary') {
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
        const size = batch.size || (batch.tasks ? batch.tasks.length : 0);
        const targetLang = batch.targetLang || 'unknown';
        console.log(`   Batch ${index + 1}: ${size} ${batch.contentType} → ${targetLang} (~${timeStr})`);
      }
      
      totalTasks += batch.totalTasks || batch.size || (batch.tasks ? batch.tasks.length : 0);
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

// Token-aware batch builder for maximum context window utilization
class TokenAwareBatchBuilder {
  constructor(modelName = 'gemini-2.5-flash', options = {}) {
    this.modelName = modelName;
    this.contextLimit = MODEL_LIMITS[modelName] || MODEL_LIMITS['gemini-2.5-flash'];
    this.maxContextRatio = options.maxContextRatio || 0.75; // Use 75% of context window
    this.tokenExpansionFactor = options.tokenExpansionFactor || 1.2; // Translation expansion
    this.promptOverhead = options.promptOverhead || 2000; // Conservative prompt overhead
    this.formattingOverhead = options.formattingOverhead || 500; // Delimiters and structure
  }

  /**
   * Estimate total tokens needed for a file in multiple languages
   */
  estimateFileTokens(filePath, fileContent, targetLanguages, contentType = 'general') {
    const inputTokens = this.estimateInputTokens(fileContent, contentType);
    const outputTokens = this.estimateOutputTokens(inputTokens, targetLanguages.length);
    
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      languages: targetLanguages.length,
      contentType
    };
  }

  /**
   * Estimate input tokens for source content
   */
  estimateInputTokens(content, contentType = 'general') {
    if (!content || typeof content !== 'string') return 0;
    
    // More precise token estimation based on content analysis
    const charCount = content.length;
    const markdownOverhead = (content.match(/[#*`\[\]()]/g) || []).length * 0.5;
    const urlCount = (content.match(/https?:\/\/\S+/g) || []).length * 3; // URLs are token-heavy
    
    // Base token estimation (~3.5 chars per token for English, adjusted for content type)
    const contentTypeMultipliers = {
      'glossary': 3.2,  // Technical terms are more token-dense
      'tld': 3.4,
      'partners': 3.6,
      'blog': 3.8,      // More natural language
      'general': 3.5
    };
    
    const charsPerToken = contentTypeMultipliers[contentType] || 3.5;
    const baseTokens = Math.ceil(charCount / charsPerToken);
    
    return Math.ceil(baseTokens + markdownOverhead + urlCount);
  }

  /**
   * Estimate output tokens for translated content
   */
  estimateOutputTokens(inputTokens, languageCount) {
    // Account for language expansion, formatting, and multiple outputs
    const expandedTokens = inputTokens * this.tokenExpansionFactor;
    const totalOutputTokens = expandedTokens * languageCount;
    
    // Add overhead for structured output formatting
    const structureOverhead = languageCount * 100; // Headers and delimiters per language
    
    return Math.ceil(totalOutputTokens + structureOverhead);
  }

  /**
   * Calculate available tokens for batch content
   */
  getAvailableTokens() {
    const maxUsableTokens = Math.floor(this.contextLimit * this.maxContextRatio);
    return maxUsableTokens - this.promptOverhead - this.formattingOverhead;
  }

  /**
   * Check if a file can fit in the current batch
   */
  canFitInBatch(currentBatchTokens, fileTokens) {
    const availableTokens = this.getAvailableTokens();
    return (currentBatchTokens + fileTokens.totalTokens) <= availableTokens;
  }

  /**
   * Create optimal batches using greedy bin-packing algorithm
   */
  createOptimalBatches(tasks, options = {}) {
    const { enableUnifiedBatching = true, maxFilesPerBatch = 5 } = options;
    
    if (!enableUnifiedBatching) {
      // Fallback to traditional batching
      return this.createTraditionalBatches(tasks, options);
    }

    console.log(`🧠 Creating token-aware batches with ${this.maxContextRatio * 100}% context utilization`);
    
    // Group tasks by source file
    const sourceFileGroups = this.groupTasksBySourceFile(tasks);
    
    // Sort by file size (smallest first for better packing)
    const sortedFiles = Object.values(sourceFileGroups).sort((a, b) => 
      a.estimatedInputTokens - b.estimatedInputTokens
    );

    const batches = [];
    let currentBatch = null;
    let currentBatchTokens = 0;

    for (const fileGroup of sortedFiles) {
      // Calculate token requirements for this file + all its target languages
      const fileTokens = this.estimateFileTokens(
        fileGroup.sourceFile,
        fileGroup.content || '',
        fileGroup.targetLanguages,
        fileGroup.contentType
      );

      // Check if we can fit this file in the current batch
      if (!currentBatch || !this.canFitInBatch(currentBatchTokens, fileTokens) || 
          currentBatch.sourceFiles.length >= maxFilesPerBatch) {
        
        // Finalize current batch if it exists
        if (currentBatch) {
          batches.push(this.finalizeBatch(currentBatch));
        }

        // Start new batch
        currentBatch = this.createNewBatch(batches.length + 1, fileGroup.contentType);
        currentBatchTokens = 0;
      }

      // Add file to current batch
      this.addFileToBatch(currentBatch, fileGroup, fileTokens);
      currentBatchTokens += fileTokens.totalTokens;
    }

    // Add final batch
    if (currentBatch) {
      batches.push(this.finalizeBatch(currentBatch));
    }

    this.printTokenOptimizationReport(batches);
    return batches;
  }

  /**
   * Group tasks by source file to enable unified processing
   */
  groupTasksBySourceFile(tasks) {
    const groups = {};
    
    for (const task of tasks) {
      const sourceFileKey = task.sourceFile;
      
      if (!groups[sourceFileKey]) {
        groups[sourceFileKey] = {
          sourceFile: task.sourceFile,
          sourceLang: task.sourceLang,
          contentType: task.contentType,
          targetLanguages: [],
          tasks: [],
          estimatedInputTokens: task.estimatedTokens || TokenEstimator.getExpectedTokens(task.contentType)
        };
      }
      
      groups[sourceFileKey].targetLanguages.push(task.targetLang);
      groups[sourceFileKey].tasks.push(task);
    }
    
    return groups;
  }

  /**
   * Create a new empty batch
   */
  createNewBatch(batchNumber, contentType) {
    return {
      id: `unified-batch-${batchNumber}`,
      type: 'unified-multi-language',
      contentType,
      sourceFiles: [],
      allTargetLanguages: new Set(),
      totalTasks: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedTokens: 0,
      estimatedTime: 0,
      contextUtilization: 0
    };
  }

  /**
   * Add a file group to a batch
   */
  addFileToBatch(batch, fileGroup, fileTokens) {
    batch.sourceFiles.push({
      ...fileGroup,
      tokenEstimate: fileTokens
    });
    
    fileGroup.targetLanguages.forEach(lang => batch.allTargetLanguages.add(lang));
    batch.totalTasks += fileGroup.tasks.length;
    batch.totalInputTokens += fileTokens.inputTokens;
    batch.totalOutputTokens += fileTokens.outputTokens;
    batch.estimatedTokens += fileTokens.totalTokens;
  }

  /**
   * Finalize batch with computed metrics
   */
  finalizeBatch(batch) {
    const availableTokens = this.getAvailableTokens();
    batch.contextUtilization = (batch.estimatedTokens / availableTokens) * 100;
    batch.estimatedTime = this.estimateProcessingTime(batch.estimatedTokens);
    
    return batch;
  }

  /**
   * Estimate processing time based on token count
   */
  estimateProcessingTime(tokens) {
    const baseRates = {
      'gemini-2.5-flash': 0.002, // ~2ms per token
      'gemini-2.5-pro': 0.005,   // ~5ms per token  
      'gpt-4o-mini': 0.001,      // ~1ms per token
      'gpt-4o': 0.003            // ~3ms per token
    };
    
    const rate = baseRates[this.modelName] || baseRates['gemini-2.5-flash'];
    return Math.ceil(tokens * rate);
  }

  /**
   * Create traditional batches as fallback
   */
  createTraditionalBatches(tasks, options) {
    // Use existing BatchOptimizer logic as fallback
    const optimizer = new BatchOptimizer(this.modelName);
    return optimizer.createBatches(tasks, options);
  }

  /**
   * Print detailed token optimization report
   */
  printTokenOptimizationReport(batches) {
    if (batches.length === 0) return;
    
    console.log(`🎯 Token-Optimized Batching Report:`);
    console.log(`   Model: ${this.modelName} (${this.contextLimit.toLocaleString()} tokens)`);
    console.log(`   Context Utilization Target: ${this.maxContextRatio * 100}%`);
    console.log(`   Available Tokens: ${this.getAvailableTokens().toLocaleString()}\n`);
    
    let totalTasks = 0;
    let totalTime = 0;
    let totalTokens = 0;
    let totalContextUtilization = 0;

    batches.forEach((batch, index) => {
      const timeStr = batch.estimatedTime < 60 ? 
        `${batch.estimatedTime}s` : 
        `${Math.ceil(batch.estimatedTime / 60)}m${batch.estimatedTime % 60}s`;
      
      const languages = Array.from(batch.allTargetLanguages).join(',');
      const utilization = batch.contextUtilization.toFixed(1);
      
      console.log(`   Batch ${index + 1}: ${batch.sourceFiles.length} files → [${languages}] (${batch.totalTasks} translations)`);
      console.log(`      Tokens: ${batch.estimatedTokens.toLocaleString()} / ${this.getAvailableTokens().toLocaleString()} (${utilization}% utilization)`);
      console.log(`      Time: ~${timeStr}`);
      
      totalTasks += batch.totalTasks;
      totalTime += batch.estimatedTime;
      totalTokens += batch.estimatedTokens;
      totalContextUtilization += batch.contextUtilization;
    });
    
    const avgUtilization = (totalContextUtilization / batches.length).toFixed(1);
    const totalTimeStr = totalTime < 60 ? `${totalTime}s` : `${Math.floor(totalTime / 60)}m${totalTime % 60}s`;
    
    console.log(`\n📊 Summary: ${batches.length} batches, ${totalTasks} tasks, ~${totalTimeStr}`);
    console.log(`💡 Average Context Utilization: ${avgUtilization}%`);
    
    if (parseFloat(avgUtilization) > 60) {
      console.log(`✨ Excellent token efficiency! Using ${avgUtilization}% of available context.`);
    }
    
    console.log('');
  }
}

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

// Parallel file processor for concurrent batch processing
class ParallelFileProcessor extends FileProcessor {
  constructor(translationService, options = {}) {
    super(translationService, options);
    this.parallelFiles = options.parallelFiles || 5;
    this.batchSize = options.batchSize || 10;
    this.fallbackSequential = options.fallbackSequential || true;
    this.enableUnified = options.enableUnified || false;
    this.maxContextRatio = options.maxContextRatio || 0.75;
    this.tokenExpansionFactor = options.tokenExpansionFactor || 1.2;
    this.fileLimit = pLimit(this.parallelFiles);
  }

  async translateMultipleFiles(sourceFiles, targetLangs, sourceLang = 'en', skipCache = false) {
    console.log(`🚀 Starting parallel translation: ${sourceFiles.length} files × ${targetLangs.length} languages`);
    console.log(`⚙️  Parallel files: ${this.parallelFiles}, Batch size: ${this.batchSize}`);
    
    const startTime = Date.now();
    
    // Create translation planner and batch optimizer
    const planner = new TranslationPlanner(this);
    const optimizer = new BatchOptimizer(this.translationService.modelName);
    
    // Analyze pending work
    const analysis = await planner.analyzePendingWork(sourceFiles, targetLangs, sourceLang, skipCache);
    
    if (analysis.pending.length === 0) {
      console.log('✅ All translations are cached - nothing to process');
      return { completed: 0, skipped: analysis.skipped.length, errors: [], totalTime: Date.now() - startTime };
    }
    
    // Create optimized batches with token-aware batching
    const batches = optimizer.createBatches(analysis.pending, {
      groupByContentType: true,
      enableMultiLanguage: true,
      enableTokenAwareBatching: this.enableUnified || true,
      maxBatchSize: this.batchSize,
      maxContextRatio: this.maxContextRatio || 0.75,
      tokenExpansionFactor: this.tokenExpansionFactor || 1.2
    });
    
    optimizer.printBatchPlan(batches);
    
    // Process batches in parallel
    try {
      return await this.processBatchesInParallel(batches, skipCache);
    } catch (error) {
      if (this.fallbackSequential) {
        console.warn(`⚠️  Parallel processing failed: ${error.message}`);
        console.log('🔄 Falling back to sequential processing...');
        return await this.processBatchesSequentially(batches, skipCache);
      } else {
        throw error;
      }
    }
  }

  async processBatchesInParallel(batches, skipCache = false) {
    const startTime = Date.now();
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    // Create progress tracking
    const totalTasks = batches.reduce((sum, batch) => sum + (batch.totalTasks || batch.size || batch.tasks?.length || 0), 0);
    const progressBar = new cliProgress.SingleBar({
      format: 'Parallel Translation |{bar}| {percentage}% | {value}/{total} | {batch}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });
    
    progressBar.start(totalTasks, 0, { batch: 'Starting...' });
    
    // Process batches with concurrency limit
    const batchPromises = batches.map((batch, index) => 
      this.fileLimit(async () => {
        const batchStartTime = Date.now();
        progressBar.update(completed, { batch: `Batch ${index + 1}/${batches.length}` });
        
        try {
          const result = await this.processBatch(batch, skipCache);
          
          completed += result.completed;
          skipped += result.skipped;
          errors.push(...result.errors);
          
          const batchTime = Date.now() - batchStartTime;
          console.log(`✅ Batch ${index + 1} completed: ${result.completed} translations [${batchTime}ms]`);
          
          return result;
        } catch (error) {
          const batchError = {
            batch: index + 1,
            error: error.message,
            type: 'batch_failure'
          };
          errors.push(batchError);
          console.error(`❌ Batch ${index + 1} failed: ${error.message}`);
          return { completed: 0, skipped: 0, errors: [batchError] };
        }
      })
    );
    
    // Wait for all batches to complete
    const results = await Promise.all(batchPromises);
    progressBar.stop();
    
    const totalTime = Date.now() - startTime;
    
    return {
      completed,
      skipped,
      errors,
      totalTime,
      batchResults: results
    };
  }

  async processBatch(batch, skipCache = false) {
    if (batch.type === 'unified-multi-language') {
      return await this.processUnifiedBatch(batch, skipCache);
    } else if (batch.type === 'multi-language' || batch.type === 'multi-language-glossary') {
      return await this.processMultiLanguageBatch(batch, skipCache);
    } else {
      return await this.processSingleLanguageBatch(batch, skipCache);
    }
  }

  async processUnifiedBatch(batch, skipCache = false) {
    const startTime = Date.now();
    let completed = 0;
    let skipped = 0;
    let errors = [];

    console.log(`🔥 Processing unified batch: ${batch.sourceFiles.length} files → ${Array.from(batch.allTargetLanguages).join(',')} (${batch.totalTasks} translations)`);
    console.log(`🧠 Context utilization: ${batch.contextUtilization.toFixed(1)}% (${batch.estimatedTokens.toLocaleString()} tokens)`);

    try {
      // Prepare source files for unified translation
      const sourceFiles = await this.prepareSourceFilesForUnified(batch);
      const targetLanguages = Array.from(batch.allTargetLanguages);
      const sourceLang = sourceFiles[0].sourceLang || 'en';

      // Create unified prompt
      const promptCreator = new UnifiedPromptCreator();
      const unifiedPrompt = promptCreator.createUnifiedPrompt(sourceFiles, targetLanguages, sourceLang);

      console.log(`📝 Making unified API call for ${sourceFiles.length} files × ${targetLanguages.length} languages...`);
      console.log(`📏 Prompt length: ${unifiedPrompt.length.toLocaleString()} chars`);

      // Make single unified API call
      const translatedResult = await this.translationService.translateText(
        unifiedPrompt,
        targetLanguages[0], // Primary target language for API structure
        sourceLang,
        '',
        'unified-glossary-batch'
      );

      // Parse the unified response
      const responseParser = new StructuredResponseParser();
      const parseResults = responseParser.parseUnifiedResponse(translatedResult, sourceFiles, targetLanguages, sourceLang);

      if (parseResults.errors.length > 0) {
        console.warn(`⚠️  Parsing encountered ${parseResults.errors.length} issues`);
        parseResults.errors.forEach(error => {
          console.warn(`   - ${error.error}`);
        });
      }

      // Save parsed translations
      const saveResults = await responseParser.saveTranslations(parseResults, sourceFiles, targetLanguages, sourceLang);
      
      completed = saveResults.completed;
      errors = saveResults.errors;
      
      // Update cache for all processed files
      this.updateUnifiedBatchCache(batch, sourceLang);

      console.log(`🎯 Unified batch completed: ${completed} translations from single API call`);

    } catch (error) {
      errors.push({
        error: `Unified batch processing failed: ${error.message}`,
        type: 'unified_batch_failure'
      });
      console.error(`❌ Unified batch failed: ${error.message}`);
    }

    const elapsed = Date.now() - startTime;
    return { completed, skipped, errors, elapsed };
  }

  async prepareSourceFilesForUnified(batch) {
    const sourceFiles = [];

    for (const sourceFileItem of batch.sourceFiles) {
      try {
        // Read source file content
        const content = await fs.readFile(sourceFileItem.sourceFile, 'utf8');
        const { data: frontMatter, content: markdownBody } = matter(content);

        sourceFiles.push({
          filePath: sourceFileItem.sourceFile,
          fileName: path.basename(sourceFileItem.sourceFile, '.md'),
          frontMatter,
          content: markdownBody,
          targetLanguages: sourceFileItem.targetLanguages,
          sourceLang: sourceFileItem.sourceLang || 'en',
          contentType: sourceFileItem.contentType
        });
      } catch (error) {
        throw new Error(`Failed to read source file ${sourceFileItem.sourceFile}: ${error.message}`);
      }
    }

    return sourceFiles;
  }

  updateUnifiedBatchCache(batch, sourceLang) {
    // Update cache for all files in the unified batch
    const promptHash = this.getTranslationPromptHash(sourceLang, Array.from(batch.allTargetLanguages)[0]);
    const dependenciesHash = getDependenciesHash([], `${SCRIPT_VERSION}-unified-${promptHash}`);

    batch.sourceFiles.forEach(sourceFileItem => {
      const targetPaths = sourceFileItem.targetLanguages.map(lang => 
        this.generateTargetPath(sourceFileItem.sourceFile, lang, sourceLang)
      );
      updateCacheEntry(sourceFileItem.sourceFile, 'translations', targetPaths, dependenciesHash);
    });
  }

  async processMultiLanguageBatch(batch, skipCache = false) {
    const startTime = Date.now();
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    // Check if we can use true batch translation (single API call for ALL files and languages)
    const canUseBatchTranslation = batch.sourceFiles.length <= 3 && 
                                  batch.totalTasks <= 10 && 
                                  batch.contentType === 'glossary' &&
                                  Array.from(batch.allTargetLanguages).length <= 3;
    
    if (canUseBatchTranslation && !this.dryRun) {
      console.log(`🔥 Using single API call for ${batch.sourceFiles.length} files → ${Array.from(batch.allTargetLanguages).length} languages`);
      
      try {
        const result = await this.processBatchTranslationSingleCall(batch, skipCache);
        return result;
      } catch (error) {
        console.warn(`⚠️  Single API call failed: ${error.message}, falling back to individual translations`);
        // Fall through to individual file processing
      }
    }
    
    // Process each source file in the batch to all target languages (existing approach)
    for (const sourceFileItem of batch.sourceFiles) {
      try {
        // Ensure targetLanguages exists and is an array
        if (!sourceFileItem.targetLanguages || !Array.isArray(sourceFileItem.targetLanguages)) {
          errors.push({
            file: sourceFileItem.sourceFile,
            error: 'Missing target languages for source file',
            type: 'config_error'
          });
          continue;
        }
        
        // Translate to all target languages for this source file
        const fileResults = await Promise.all(
          sourceFileItem.targetLanguages.map(async (targetLang) => {
            try {
              const result = await this.translateFile(
                sourceFileItem.sourceFile, 
                targetLang, 
                sourceFileItem.sourceLang, 
                skipCache
              );
              
              if (result.success) {
                return result.skipped ? { skipped: 1 } : { completed: 1 };
              } else {
                return { 
                  error: { 
                    file: sourceFileItem.sourceFile, 
                    targetLang, 
                    error: result.error 
                  } 
                };
              }
            } catch (error) {
              return { 
                error: { 
                  file: sourceFileItem.sourceFile, 
                  targetLang, 
                  error: error.message 
                } 
              };
            }
          })
        );
        
        // Aggregate results for this source file
        fileResults.forEach(result => {
          if (result.completed) completed += result.completed;
          if (result.skipped) skipped += result.skipped;
          if (result.error) errors.push(result.error);
        });
        
      } catch (error) {
        errors.push({
          file: sourceFileItem.sourceFile,
          error: error.message,
          type: 'source_file_failure'
        });
      }
    }
    
    const elapsed = Date.now() - startTime;
    return { completed, skipped, errors, elapsed };
  }

  async processBatchTranslationSingleCall(batch, skipCache = false) {
    const startTime = Date.now();
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    try {
      // Prepare all source files and target languages
      const sourceFiles = batch.sourceFiles;
      const targetLanguages = Array.from(batch.allTargetLanguages);
      const sourceLang = sourceFiles[0].sourceLang;
      
      // Read all source files
      const sourceContents = await Promise.all(
        sourceFiles.map(async (sourceFileItem) => {
          const content = await fs.readFile(sourceFileItem.sourceFile, 'utf8');
          const { data: frontMatter, content: markdownBody } = matter(content);
          return {
            filePath: sourceFileItem.sourceFile,
            fileName: path.basename(sourceFileItem.sourceFile, '.md'),
            frontMatter,
            content: markdownBody,
            targetLanguages: sourceFileItem.targetLanguages,
            sourceLang
          };
        })
      );
      
      // Process one API call per target language (but all files in one call)
      for (const targetLang of targetLanguages) {
        try {
          const langResult = await this.processBatchForSingleLanguage(sourceContents, targetLang, sourceLang, skipCache);
          completed += langResult.completed;
          skipped += langResult.skipped;
          errors.push(...langResult.errors);
        } catch (error) {
          errors.push({
            error: `Failed to process batch for ${targetLang}: ${error.message}`,
            type: 'language_batch_failure'
          });
        }
      }
      
      console.log(`🎯 Batch processing completed ${completed} translations across ${targetLanguages.length} languages`);
      
    } catch (error) {
      errors.push({
        error: `Batch translation failed: ${error.message}`,
        type: 'batch_translation_failure'
      });
    }
    
    const elapsed = Date.now() - startTime;
    return { completed, skipped, errors, elapsed };
  }

  async processBatchForSingleLanguage(sourceContents, targetLang, sourceLang, skipCache = false) {
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    try {
      // Create combined prompt for all files in this language
      const combinedPrompt = this.createCombinedPrompt(sourceContents, targetLang, sourceLang);
      
      console.log(`📝 Translating ${sourceContents.length} files to ${targetLang} in single API call...`);
      
      // Make single API call for all files to this target language
      const translatedResult = await this.translationService.translateText(
        combinedPrompt,
        targetLang,
        sourceLang,
        '',
        'glossary-batch'
      );
      
      // Parse the combined result and save individual files
      const parseResult = await this.parseCombinedResult(translatedResult, sourceContents, targetLang, sourceLang);
      
      completed = parseResult.completed;
      skipped = parseResult.skipped;
      errors = parseResult.errors;
      
    } catch (error) {
      errors.push({
        error: `Single language batch failed for ${targetLang}: ${error.message}`,
        type: 'single_language_batch_failure'
      });
    }
    
    return { completed, skipped, errors };
  }

  createCombinedPrompt(sourceContents, targetLang, sourceLang) {
    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
    
    let prompt = `Please translate the following ${sourceContents.length} glossary entries from ${sourceLangName} to ${targetLangName}.\n\n`;
    
    prompt += `CRITICAL REQUIREMENTS:\n`;
    prompt += `• Translate all entries to ${targetLangName}\n`;
    prompt += `• Preserve all markdown formatting, HTML tags, and structure exactly\n`;
    prompt += `• Keep code blocks, URLs, domain names, and file extensions unchanged\n`;
    prompt += `• Brand names (Namefi, Ethereum, etc.) should remain unchanged\n`;
    prompt += `• Translate keywords and descriptions appropriately for SEO\n`;
    prompt += `• Update all localized URLs: change /${sourceLang}/ to /${targetLang}/ in URLs like {{ '/${sourceLang}/glossary/term/' | url }}\n`;
    prompt += `• Return each entry in the exact format: ENTRY_START [filename] ENTRY_END\n\n`;
    
    // Add source entries with localized URLs
    sourceContents.forEach((source, index) => {
      // Localize URLs in the content
      const localizedContent = URLLocalizer.localizeURLs(source.content, targetLang, sourceLang);
      
      prompt += `ENTRY_START ${source.fileName}\n`;
      prompt += `---\n`;
      prompt += `title: ${source.frontMatter.title}\n`;
      prompt += `date: '${source.frontMatter.date}'\n`;
      prompt += `language: ${targetLang}\n`;
      prompt += `tags: ${JSON.stringify(source.frontMatter.tags)}\n`;
      prompt += `authors: ${JSON.stringify(source.frontMatter.authors)}\n`;
      prompt += `description: ${source.frontMatter.description}\n`;
      if (source.frontMatter.keywords) {
        const keywords = Array.isArray(source.frontMatter.keywords) ? source.frontMatter.keywords : [source.frontMatter.keywords];
        prompt += `keywords: ${JSON.stringify(keywords)}\n`;
      }
      prompt += `---\n\n`;
      prompt += `${localizedContent}\n`;
      prompt += `ENTRY_END\n\n`;
    });
    
    prompt += `Please translate each entry completely and return them in the same ENTRY_START [filename] ... ENTRY_END format.`;
    
    return prompt;
  }

  async parseCombinedResult(translatedResult, sourceContents, targetLang, sourceLang) {
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    try {
      // Split the result into individual entries
      const entryPattern = /ENTRY_START\s+([^\n]+)\s*\n(.*?)\nENTRY_END/gs;
      const matches = [...translatedResult.matchAll(entryPattern)];
      
      if (matches.length !== sourceContents.length) {
        throw new Error(`Expected ${sourceContents.length} entries, but found ${matches.length}`);
      }
      
      // Process each translated entry
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const fileName = match[1].trim();
        const translatedContent = match[2].trim();
        
        // Find corresponding source file
        const sourceFile = sourceContents.find(s => s.fileName === fileName);
        if (!sourceFile) {
          errors.push({
            error: `Could not find source file for translated entry: ${fileName}`,
            type: 'file_matching_error'
          });
          continue;
        }
        
        try {
          // Generate target file path
          const targetFilePath = this.generateTargetPath(sourceFile.filePath, targetLang, sourceLang);
          
          // Ensure target directory exists
          await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
          
          // Write translated file
          await fs.writeFile(targetFilePath, translatedContent, 'utf8');
          
          completed++;
          console.log(`✅ Batch translated: ${fileName} -> ${targetLang} (${i+1}/${matches.length})`);
          
        } catch (writeError) {
          errors.push({
            file: sourceFile.filePath,
            targetLang,
            error: `Failed to write translated file: ${writeError.message}`,
            type: 'write_error'
          });
        }
      }
      
    } catch (parseError) {
      errors.push({
        error: `Failed to parse combined translation result: ${parseError.message}`,
        type: 'parse_error'
      });
    }
    
    return { completed, skipped, errors };
  }

  createBatchTranslationPrompt(sourceContents, targetLanguages, sourceLang) {
    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangNames = targetLanguages.map(lang => LANGUAGE_NAMES[lang] || lang);
    
    let prompt = `Please translate the following glossary entries from ${sourceLangName} to ${targetLangNames.join(' and ')}.\n\n`;
    
    prompt += `CRITICAL REQUIREMENTS:\n`;
    prompt += `• Translate each entry to ALL target languages: ${targetLangNames.join(', ')}\n`;
    prompt += `• Preserve all markdown formatting, HTML tags, and structure exactly\n`;
    prompt += `• Keep code blocks, URLs, domain names, and file extensions unchanged\n`;
    prompt += `• Brand names (Namefi, Ethereum, etc.) should remain unchanged\n`;
    prompt += `• Translate keywords and descriptions appropriately for SEO\n`;
    prompt += `• Return results in the exact format specified below\n\n`;
    
    // Add source entries
    sourceContents.forEach((source, index) => {
      prompt += `=== ENTRY ${index + 1}: ${source.fileName} ===\n`;
      prompt += `TITLE: ${source.frontMatter.title}\n`;
      prompt += `DESCRIPTION: ${source.frontMatter.description}\n`;
      prompt += `KEYWORDS: ${Array.isArray(source.frontMatter.keywords) ? source.frontMatter.keywords.join(', ') : source.frontMatter.keywords}\n`;
      prompt += `CONTENT:\n${source.content}\n\n`;
    });
    
    // Add output format specification
    prompt += `OUTPUT FORMAT:\n`;
    targetLanguages.forEach(targetLang => {
      const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
      prompt += `\n=== ${targetLangName.toUpperCase()} TRANSLATIONS ===\n`;
      sourceContents.forEach((source, index) => {
        prompt += `ENTRY ${index + 1} (${source.fileName}):\n`;
        prompt += `TITLE: [translated title]\n`;
        prompt += `DESCRIPTION: [translated description]\n`;
        prompt += `KEYWORDS: [translated keywords]\n`;
        prompt += `CONTENT:\n[translated content]\n\n`;
      });
    });
    
    return prompt;
  }

  async parseBatchTranslationResult(batchResult, sourceContents, targetLanguages, sourceLang) {
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    try {
      // This is a simplified parser - in a real implementation, you'd need more robust parsing
      // For now, fall back to individual file processing
      console.log(`📋 Batch result received, parsing ${targetLanguages.length} language sets...`);
      
      // For this demo, we'll fall back to individual processing
      // In a production implementation, you'd parse the structured response
      throw new Error('Batch parsing not implemented - falling back to individual translations');
      
    } catch (error) {
      errors.push({
        error: `Failed to parse batch translation result: ${error.message}`,
        type: 'batch_parsing_failure'
      });
    }
    
    return { completed, skipped, errors };
  }

  async processSingleLanguageBatch(batch, skipCache = false) {
    const startTime = Date.now();
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    // Process all tasks in the batch
    const results = await Promise.all(
      batch.tasks.map(async (task) => {
        try {
          const result = await this.translateFile(
            task.sourceFile, 
            task.targetLang, 
            task.sourceLang, 
            skipCache
          );
          
          if (result.success) {
            return result.skipped ? { skipped: 1 } : { completed: 1 };
          } else {
            return { 
              error: { 
                file: task.sourceFile, 
                targetLang: task.targetLang, 
                error: result.error 
              } 
            };
          }
        } catch (error) {
          return { 
            error: { 
              file: task.sourceFile, 
              targetLang: task.targetLang, 
              error: error.message 
            } 
          };
        }
      })
    );
    
    // Aggregate results
    results.forEach(result => {
      if (result.completed) completed += result.completed;
      if (result.skipped) skipped += result.skipped;
      if (result.error) errors.push(result.error);
    });
    
    const elapsed = Date.now() - startTime;
    return { completed, skipped, errors, elapsed };
  }

  async processBatchesSequentially(batches, skipCache = false) {
    console.log('📦 Processing batches sequentially as fallback...');
    
    const startTime = Date.now();
    let completed = 0;
    let skipped = 0;
    let errors = [];
    
    for (const [index, batch] of batches.entries()) {
      console.log(`🔄 Processing batch ${index + 1}/${batches.length}...`);
      
      try {
        const result = await this.processBatch(batch, skipCache);
        completed += result.completed;
        skipped += result.skipped;
        errors.push(...result.errors);
        
        console.log(`✅ Batch ${index + 1} completed: ${result.completed} translations`);
      } catch (error) {
        const batchError = {
          batch: index + 1,
          error: error.message,
          type: 'sequential_batch_failure'
        };
        errors.push(batchError);
        console.error(`❌ Batch ${index + 1} failed: ${error.message}`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    return { completed, skipped, errors, totalTime };
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
  .option('--concurrent-batches <number>', 'Number of concurrent batches (default: 5)', '5')
  .option('--batch-size <number>', 'Max files per batch (default: 10)', '10')
  .option('--max-context-ratio <ratio>', 'Maximum context window utilization ratio (default: 0.75)', '0.75')
  .option('--token-expansion-factor <factor>', 'Translation token expansion factor (default: 1.2)', '1.2')
  .option('--no-fallback', 'Disable fallback to individual file processing on batch failures')
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

    // Create universal batch processor options
    const processorOptions = {
      dryRun: options.dryRun,
      backup: options.backup,
      skipCache: options.skipCache,
      parallelFiles: parseInt(options.concurrentBatches) || 5,
      batchSize: parseInt(options.batchSize) || 10,
      fallbackSequential: !options.noFallback,
      enableUnified: true, // Always enabled now
      maxContextRatio: parseFloat(options.maxContextRatio) || 0.75,
      tokenExpansionFactor: parseFloat(options.tokenExpansionFactor) || 1.2
    };
    
    // Always use ParallelFileProcessor for unified batch + concurrent processing
    const fileProcessor = new ParallelFileProcessor(translationService, processorOptions);

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
    
    console.log(`🔥 Universal batch processing: Token-aware unified translation with intelligent batching`);
    console.log(`🧠 Context utilization: ${(processorOptions.maxContextRatio * 100).toFixed(0)}%, Token expansion: ${processorOptions.tokenExpansionFactor}x`);
    console.log(`⚡ Concurrent batches: ${processorOptions.parallelFiles}, Max files per batch: ${processorOptions.batchSize}`);
    
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
    const scriptStartTime = Date.now();

    let result;
    
    // Universal batch + concurrent processing
    console.log('🚀 Using unified batch + concurrent processing...\n');
    result = await fileProcessor.translateMultipleFiles(sourceFiles, targetLangs, options.from, options.skipCache);

    const scriptEndTime = Date.now();
    const totalScriptTime = scriptEndTime - scriptStartTime;
    
    // Results summary
    console.log('\n✅ Translation completed!');
    console.log(`📊 Translation Summary:`);
    console.log(`   Total possible: ${totalTranslations} translations`);
    console.log(`   Completed: ${result.completed}`);
    console.log(`   Skipped: ${result.skipped}`);
    console.log(`   Errors: ${result.errors.length}`);
    console.log(`⏱️  Processing time: ${result.totalTime || 0}ms`);
    console.log(`⏱️  Total script time: ${totalScriptTime}ms`);
    
    if (options.parallel && result.batchResults) {
      console.log(`🚀 Parallel processing: ${result.batchResults.length} batches completed`);
    }
    
    if (result.errors.length > 0) {
      console.log(`\n❌ Errors encountered:`);
      result.errors.forEach(error => {
        if (error.type === 'batch_failure') {
          console.log(`  - Batch ${error.batch}: ${error.error}`);
        } else if (error.file && error.targetLang) {
          console.log(`  - ${error.file} -> ${error.targetLang}: ${error.error}`);
        } else {
          console.log(`  - ${error.error || JSON.stringify(error)}`);
        }
      });
    }

    const mode = options.parallel ? 'parallel' : 'sequential';
    console.log(`\n🎉 ${mode.charAt(0).toUpperCase() + mode.slice(1)} translation with ${serviceName.toUpperCase()} (${modelName}) finished!`);
  });

program.parse(process.argv);