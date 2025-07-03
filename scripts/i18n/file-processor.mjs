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

  async translateFile(filePath, targetLang, sourceLang = 'en', skipCache = false) {
    const startTime = Date.now();
    
    try {
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

export { FileProcessor, ParallelFileProcessor };