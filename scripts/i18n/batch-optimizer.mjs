import { MODEL_LIMITS, CONTENT_TYPE_TOKENS } from './config.mjs';
import { TokenEstimator } from './utils.mjs';

// Batch optimizer for creating efficient translation batches
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

export { BatchOptimizer, TokenAwareBatchBuilder };