import matter from 'gray-matter';
import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';
import { 
  shouldRegenerate, 
  updateCacheEntry, 
  getDependenciesHash 
} from '../cache-utils.mjs';
import { TranslationPlanner } from './translation-planner.mjs';
import { BatchOptimizer } from './batch-optimizer.mjs';
import { UnifiedPromptCreator } from './prompt-creator.mjs';
import { StructuredResponseParser } from './response-parser.mjs';
import { URLLocalizer } from './utils.mjs';
import { LANGUAGE_NAMES, SCRIPT_VERSION } from './config.mjs';

// Base file processor class
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

  // Individual translation method removed - using only unified batch processing
  
  /**
   * Generate hash for translation dependencies using Git hashes of script files
   * @param {string} sourceLang - Source language (unused but kept for compatibility)
   * @param {string} targetLang - Target language (unused but kept for compatibility)
   * @returns {string} Hash of translation script dependencies
   */
  getTranslationPromptHash(sourceLang, targetLang) {
    // Use Git hashes of the actual translation script files
    const scriptFiles = [
      'scripts/i18n/main.mjs',
      'scripts/i18n/file-processor.mjs',
      'scripts/i18n/translation-services.mjs',
      'scripts/i18n/prompt-creator.mjs',
      'scripts/i18n/utils.mjs',
      'scripts/i18n/config.mjs'
    ];
    
    // Include script version as additional data
    const versionData = `${SCRIPT_VERSION}-translation-logic`;
    
    return getDependenciesHash(scriptFiles, versionData);
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
    this.maxContextRatio = options.maxContextRatio || 0.25;
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
      maxContextRatio: this.maxContextRatio || 0.25,
      tokenExpansionFactor: this.tokenExpansionFactor || 1.2,
      // Don't pass maxFilesPerBatch to let token-aware batching determine optimal size
      enableUnifiedBatching: true
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

      // Get dependencies hash for immediate cache updates
      const dependenciesHash = this.getTranslationPromptHash(sourceLang, targetLanguages[0]);
      
      // Save parsed translations and update cache immediately for each successful pair
      const saveResults = await responseParser.saveTranslations(parseResults, sourceFiles, targetLanguages, sourceLang, dependenciesHash);
      
      completed = saveResults.completed;
      errors = saveResults.errors;

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
    const dependenciesHash = this.getTranslationPromptHash(sourceLang, Array.from(batch.allTargetLanguages)[0]);
    
    // In unified processing, ALL files get translated to ALL target languages
    const allTargetLanguages = Array.from(batch.allTargetLanguages);

    batch.sourceFiles.forEach(sourceFileItem => {
      const targetPaths = allTargetLanguages.map(lang => 
        this.generateTargetPath(sourceFileItem.sourceFile, lang, sourceLang)
      );
      updateCacheEntry(sourceFileItem.sourceFile, 'translations', targetPaths, dependenciesHash);
    });
  }

  async processMultiLanguageBatch(batch, skipCache = false) {
    // All multi-language batches now use unified processing only
    return await this.processUnifiedBatch(batch, skipCache);
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

  async processSingleLanguageBatch(batch, skipCache = false) {
    // Convert single-language batch to unified batch format and process
    const unifiedBatch = {
      id: batch.id,
      type: 'unified-multi-language',
      contentType: batch.contentType,
      sourceFiles: batch.tasks.map(task => ({
        sourceFile: task.sourceFile,
        sourceLang: task.sourceLang,
        contentType: task.contentType,
        targetLanguages: [task.targetLang],
        tasks: [task]
      })),
      allTargetLanguages: new Set([batch.targetLang]),
      totalTasks: batch.size,
      estimatedTokens: batch.estimatedTokens,
      estimatedTime: batch.estimatedTime,
      contextUtilization: 0
    };
    
    return await this.processUnifiedBatch(unifiedBatch, skipCache);
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

export { FileProcessor, ParallelFileProcessor };