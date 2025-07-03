#!/usr/bin/env node

import dotenv from 'dotenv';
import { Command } from 'commander';

// Load environment variables
dotenv.config();

import { SUPPORTED_LANGUAGES, CONTENT_TYPES } from './config.mjs';
import { TranslationServiceFactory } from './translation-services.mjs';
import { ParallelFileProcessor } from './file-processor.mjs';
import {
  initializeCache,
  cleanCache,
  displayCacheStats,
  cleanStaleEntries
} from '../cache-utils.mjs';

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
  .option('--max-context-ratio <ratio>', 'Maximum context window utilization ratio (default: 0.25)', '0.25')
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
    
    // Initialize translation service
    const translationService = TranslationServiceFactory.createService(serviceName, modelName);
    
    // Create universal batch processor options
    const processorOptions = {
      dryRun: options.dryRun,
      backup: options.backup,
      skipCache: options.skipCache,
      parallelFiles: parseInt(options.concurrentBatches) || 5,
      batchSize: parseInt(options.batchSize) || 10,
      fallbackSequential: !options.noFallback,
      enableUnified: true, // Always enabled now
      maxContextRatio: parseFloat(options.maxContextRatio) || 0.25,
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